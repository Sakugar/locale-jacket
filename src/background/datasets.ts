// In-memory access to the optional datasets for rule matching.
// Only what the current rules reference is loaded: the geosite file is indexed and
// just the referenced categories are decoded; MMDB files are opened on demand.
// Lookups are synchronous so rule resolution stays synchronous.

import { getDatasetBytes, listDatasets, type DatasetKind, type DatasetMeta } from '../shared/dataset-store.js';
import { indexGeosite, loadGeositeCategory, parseGeositeValue, type GeositeIndex, type GeositeList } from '../shared/geosite.js';
import { formatIp, type IpAddr } from '../shared/ip.js';
import { asnOf, countryOf, MmdbReader, type MmdbValue } from '../shared/mmdb.js';
import { t } from '../shared/i18n.js';
import type { MatchContext } from '../shared/rules.js';

export interface Requirements {
  geosite: string[];
  geoip: boolean;
  asn: boolean;
}

/** Where the data sets are read from: the extension's IndexedDB (tests pass their own). */
export interface DatasetSource {
  list(): Promise<DatasetMeta[]>;
  bytes(kind: DatasetKind): Promise<ArrayBuffer | null>;
}

const STORE: DatasetSource = { list: listDatasets, bytes: getDatasetBytes };

/** The data sets read by address lookups (they can find corrupt records). */
export type LookupKind = 'geoip' | 'asn';

export class DatasetRuntime {
  meta: DatasetMeta[] = [];
  private geositeIndex: GeositeIndex | null = null;
  private readonly categories = new Map<string, GeositeList | null>();
  private geoipReader: MmdbReader | null = null;
  private asnReader: MmdbReader | null = null;
  private readonly lookupCache = new Map<string, { country: string | null; asn: number | null }>();
  private problems: string[] = [];
  /**
   * The first corrupt record a lookup found in each data set (that lookup counted as no
   * match). Kept until the data sets are re-read (reset), and logged once.
   */
  private readonly lookupErrorByKind: Partial<Record<LookupKind, string>> = {};

  constructor(
    private readonly log: (msg: string, level?: 'debug' | 'warn') => void,
    private readonly store: DatasetSource = STORE,
  ) {}

  private has(kind: DatasetKind): boolean {
    return this.meta.some((m) => m.kind === kind);
  }

  /** Drop everything (after a dataset was downloaded, replaced or deleted). */
  reset(): void {
    this.geositeIndex = null;
    this.categories.clear();
    this.geoipReader = null;
    this.asnReader = null;
    this.lookupCache.clear();
    delete this.lookupErrorByKind.geoip;
    delete this.lookupErrorByKind.asn;
  }

  /** Load what `req` needs. Safe to call repeatedly; already-loaded data is reused. */
  async ensure(req: Requirements): Promise<void> {
    this.problems = [];
    try {
      this.meta = await this.store.list();
    } catch (e) {
      this.problems.push(t('bg.data.unavailable', { error: (e as Error).message }));
      return;
    }
    if (req.geosite.length) {
      if (!this.has('geosite')) {
        this.problems.push(t('bg.data.needGeosite', { categories: req.geosite.join(', ') }));
      } else {
        try {
          if (!this.geositeIndex) {
            const bytes = await this.store.bytes('geosite');
            if (bytes) this.geositeIndex = indexGeosite(bytes);
          }
          for (const value of req.geosite) {
            if (this.categories.has(value) || !this.geositeIndex) continue;
            const { name, filter } = parseGeositeValue(value);
            const list = loadGeositeCategory(this.geositeIndex, name, filter);
            this.categories.set(value, list);
            if (!list) this.problems.push(t('bg.data.noCategory', { name }));
            else this.log(`GeoSite ${value}: ${list.size} entries`);
          }
        } catch (e) {
          this.problems.push(t('bg.data.unreadable', { name: 'GeoSite', error: (e as Error).message }));
        }
      }
    }
    if (req.geoip) this.geoipReader = await this.openMmdb('geoip', this.geoipReader, t('bg.data.needGeoip'));
    if (req.asn) this.asnReader = await this.openMmdb('asn', this.asnReader, t('bg.data.needAsn'));
  }

  private async openMmdb(kind: DatasetKind, current: MmdbReader | null, missing: string): Promise<MmdbReader | null> {
    if (current) return current;
    if (!this.has(kind)) {
      this.problems.push(missing);
      return null;
    }
    try {
      const bytes = await this.store.bytes(kind);
      return bytes ? new MmdbReader(bytes) : null;
    } catch (e) {
      this.problems.push(t('bg.data.unreadable', { name: kind, error: (e as Error).message }));
      return null;
    }
  }

  /** Problems with the data the current rules need (shown in the UI). */
  get missing(): string[] {
    return [...this.problems];
  }

  /** Corrupt records found by lookups since the data sets were last read, by data set. */
  get lookupErrors(): Partial<Record<LookupKind, string>> {
    return { ...this.lookupErrorByKind };
  }

  /** A lookup that never throws: a corrupt record reads as no match and is reported once per data set. */
  private lookup(kind: LookupKind, reader: MmdbReader, ip: IpAddr): MmdbValue | null {
    const res = reader.lookup(ip);
    if (res.error !== undefined && this.lookupErrorByKind[kind] === undefined) {
      this.lookupErrorByKind[kind] = res.error;
      this.log(`${kind === 'geoip' ? 'GeoIP' : 'ASN'} data set has a corrupt record (looking up ${formatIp(ip)}): ${res.error}. Addresses stored there count as no match.`, 'warn');
    }
    return res.record;
  }

  geositeCategoryNames(): string[] {
    return this.geositeIndex ? [...this.geositeIndex.categories.keys()].sort() : [];
  }

  /** Load the geosite index (for the category list in the editor) even if no rule needs it yet. */
  async loadGeositeIndex(): Promise<void> {
    if (this.geositeIndex) return;
    const bytes = await this.store.bytes('geosite');
    if (bytes) this.geositeIndex = indexGeosite(bytes);
  }

  private ipInfo(ip: IpAddr): { country: string | null; asn: number | null } {
    const key = Array.from(ip.bytes).join('.');
    let v = this.lookupCache.get(key);
    if (!v) {
      v = {
        country: this.geoipReader ? countryOf(this.lookup('geoip', this.geoipReader, ip)) : null,
        asn: this.asnReader ? (asnOf(this.lookup('asn', this.asnReader, ip))?.asn ?? null) : null,
      };
      if (this.lookupCache.size > 5000) this.lookupCache.clear();
      this.lookupCache.set(key, v);
    }
    return v;
  }

  /** Match context for a host, combining these datasets with the server address (if known). */
  context(ip: IpAddr | null): MatchContext {
    return {
      ip,
      geosite: (value) => this.categories.get(value) ?? (this.geositeIndex ? null : undefined),
      geoip: (addr) => (this.geoipReader ? this.ipInfo(addr).country : undefined),
      asn: (addr) => (this.asnReader ? this.ipInfo(addr).asn : undefined),
    };
  }
}
