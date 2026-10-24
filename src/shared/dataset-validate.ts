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
  const date = new Date(typeof m.build_epoch === 'number' ? m.build_epoch * 1000 : NaN);
  const built = Number.isNaN(date.getTime()) ? 'unknown date' : date.toISOString().slice(0, 10);
  // Strict lookups, so a corrupt file is refused here instead of reading as "no match" later.
  // The extra probes only check that those records decode.
  const probe = reader.lookupStrict(parseIp('8.8.8.8')!).record;
  for (const extra of ['1.1.1.1', '2001:4860:4860::8888']) reader.lookupStrict(parseIp(extra)!);
  if (kind === 'geoip' && !countryOf(probe) && !/country|geo/i.test(m.database_type)) {
    throw new Error(`This looks like a "${m.database_type}" database, not a country database.`);
  }
  if (kind === 'asn' && !asnOf(probe) && !/asn/i.test(m.database_type)) {
    throw new Error(`This looks like a "${m.database_type}" database, not an ASN database.`);
  }
  if (kind === 'geoip' && !countryOf(probe)) warnings.push('8.8.8.8 has no country in this database.');
  return { summary: `${m.database_type}, built ${built}, IPv${m.ip_version}`, warnings };
}
