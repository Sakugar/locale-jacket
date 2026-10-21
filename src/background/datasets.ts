// In-memory access to the optional datasets for rule matching.
// Only what the current rules reference is loaded: the geosite file is indexed and
// just the referenced categories are decoded; MMDB files are opened on demand.
// Lookups are synchronous so rule resolution stays synchronous.

import { getDatasetBytes, listDatasets, type DatasetKind, type DatasetMeta } from '../shared/dataset-store.js';
import { indexGeosite, loadGeositeCategory, parseGeositeValue, type GeositeIndex, type GeositeList } from '../shared/geosite.js';
import type { IpAddr } from '../shared/ip.js';
import { asnOf, countryOf, MmdbReader } from '../shared/mmdb.js';
import type { MatchContext } from '../shared/rules.js';

export interface Requirements {
  geosite: string[];
  geoip: boolean;
  asn: boolean;
}

export class DatasetRuntime {
  meta: DatasetMeta[] = [];
  private geositeIndex: GeositeIndex | null = null;
  private readonly categories = new Map<string, GeositeList | null>();
  private geoipReader: MmdbReader | null = null;
  private asnReader: MmdbReader | null = null;
  private readonly lookupCache = new Map<string, { country: string | null; asn: number | null }>();
  private problems: string[] = [];

  constructor(private readonly log: (msg: string) => void) {}

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
  }

  /** Load what `req` needs. Safe to call repeatedly; already-loaded data is reused. */
  async ensure(req: Requirements): Promise<void> {
    this.problems = [];
    try {
      this.meta = await listDatasets();
    } catch (e) {
      this.problems.push(`Data sets unavailable: ${(e as Error).message}`);
      return;
    }
    if (req.geosite.length) {
      if (!this.has('geosite')) {
        this.problems.push(`GEOSITE rules (${req.geosite.join(', ')}) need the GeoSite data set.`);
      } else {
        try {
          if (!this.geositeIndex) {
            const bytes = await getDatasetBytes('geosite');
            if (bytes) this.geositeIndex = indexGeosite(bytes);
          }
          for (const value of req.geosite) {
            if (this.categories.has(value) || !this.geositeIndex) continue;
            const { name, filter } = parseGeositeValue(value);
            const list = loadGeositeCategory(this.geositeIndex, name, filter);
            this.categories.set(value, list);
            if (!list) this.problems.push(`GeoSite category "${name}" does not exist in the data set.`);
            else this.log(`GeoSite ${value}: ${list.size} entries`);
          }
        } catch (e) {
          this.problems.push(`GeoSite data set could not be read: ${(e as Error).message}`);
        }
      }
    }
    if (req.geoip) this.geoipReader = await this.openMmdb('geoip', this.geoipReader, 'GEOIP country rules need the GeoIP data set.');
    if (req.asn) this.asnReader = await this.openMmdb('asn', this.asnReader, 'IP-ASN rules need the ASN data set.');
  }

  private async openMmdb(kind: DatasetKind, current: MmdbReader | null, missing: string): Promise<MmdbReader | null> {
    if (current) return current;
    if (!this.has(kind)) {
      this.problems.push(missing);
      return null;
    }
    try {
      const bytes = await getDatasetBytes(kind);
      return bytes ? new MmdbReader(bytes) : null;
    } catch (e) {
      this.problems.push(`${kind} data set could not be read: ${(e as Error).message}`);
      return null;
    }
  }

  /** Problems with the data the current rules need (shown in the UI). */
  get missing(): string[] {
    return [...this.problems];
  }

  geositeCategoryNames(): string[] {
    return this.geositeIndex ? [...this.geositeIndex.categories.keys()].sort() : [];
  }

  /** Load the geosite index (for the category list in the editor) even if no rule needs it yet. */
  async loadGeositeIndex(): Promise<void> {
    if (this.geositeIndex) return;
    const bytes = await getDatasetBytes('geosite');
    if (bytes) this.geositeIndex = indexGeosite(bytes);
  }

  private ipInfo(ip: IpAddr): { country: string | null; asn: number | null } {
    const key = Array.from(ip.bytes).join('.');
    let v = this.lookupCache.get(key);
    if (!v) {
      v = {
        country: this.geoipReader ? countryOf(this.geoipReader.lookup(ip).record) : null,
        asn: this.asnReader ? (asnOf(this.asnReader.lookup(ip).record)?.asn ?? null) : null,
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
