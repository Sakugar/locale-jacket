// Validate downloaded/imported dataset bytes before they are stored.

import type { DatasetKind } from './dataset-store.js';
import { indexGeosite } from './geosite.js';
import { parseIp } from './ip.js';
import { asnOf, countryOf, MmdbReader } from './mmdb.js';

export interface ValidationResult {
  summary: string;
  warnings: string[];
}

/** Throws with a readable message when the data is not the expected format. */
export function validateDataset(kind: DatasetKind, data: ArrayBuffer | Uint8Array): ValidationResult {
  const warnings: string[] = [];
  if (kind === 'geosite') {
    const idx = indexGeosite(data);
    const common = ['google', 'cn'].filter((c) => !idx.categories.has(c));
    if (common.length) warnings.push(`Common categories missing: ${common.join(', ')}.`);
    return { summary: `${idx.categories.size} categories`, warnings };
  }
  const reader = new MmdbReader(data);
  const m = reader.metadata;
  const built = Number.isFinite(m.build_epoch) ? new Date(m.build_epoch * 1000).toISOString().slice(0, 10) : 'unknown date';
  const probe = reader.lookup(parseIp('8.8.8.8')!).record;
  if (kind === 'geoip' && !countryOf(probe) && !/country|geo/i.test(m.database_type)) {
    throw new Error(`This looks like a "${m.database_type}" database, not a country database.`);
  }
  if (kind === 'asn' && !asnOf(probe) && !/asn/i.test(m.database_type)) {
    throw new Error(`This looks like a "${m.database_type}" database, not an ASN database.`);
  }
  if (kind === 'geoip' && !countryOf(probe)) warnings.push('8.8.8.8 has no country in this database.');
  return { summary: `${m.database_type}, built ${built}, IPv${m.ip_version}`, warnings };
}
