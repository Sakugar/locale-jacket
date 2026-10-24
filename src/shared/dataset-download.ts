// Download a data set, validate it and store it. Used by the options page (manual
// download) and the service worker (automatic updates). With `conditional`, the
// request carries If-None-Match / If-Modified-Since so an unchanged file is not
// downloaded again (HTTP 304).

import { putDataset, type DatasetKind, type DatasetMeta } from './dataset-store.js';
import { validateDataset } from './dataset-validate.js';
import { fetchLimited, type NetLimits } from './net.js';

/**
 * Real files are 0.1–25 MB: MetaCubeX country-lite.mmdb (~0.1 MB) and country.mmdb
 * (~8 MB), GeoLite2-Country (~9 MB) and GeoLite2-ASN (~10 MB), geosite.dat (~6–10 MB;
 * geoip.dat, ~20 MB, is not a format used here). GeoLite2-City (~70 MB) also passes as a
 * country database. 128 MB leaves room for all of them while still bounding the memory a
 * misconfigured or hostile address can make the extension buffer.
 */
export const MAX_DATASET_BYTES = 128 * 1024 * 1024;

/**
 * Tens of MB on a slow line take minutes, so the overall limit is generous; a server
 * that stops sending for a minute is treated as gone.
 */
export const DATASET_LIMITS: NetLimits = { totalMs: 15 * 60_000, stallMs: 60_000, maxBytes: MAX_DATASET_BYTES };

export interface DownloadOptions {
  onProgress?: (got: number, total: number) => void;
  conditional?: { etag?: string; lastModified?: string };
  fetch?: typeof fetch;
  store?: (meta: DatasetMeta, data: ArrayBuffer) => Promise<void>;
  now?: () => number;
  /** Overrides of DATASET_LIMITS (tests). */
  limits?: Partial<NetLimits>;
}

export type DownloadResult = { status: 'unchanged' } | { status: 'saved'; meta: DatasetMeta; warnings: string[] };

export async function downloadDataset(kind: DatasetKind, url: string, o: DownloadOptions = {}): Promise<DownloadResult> {
  const headers: Record<string, string> = {};
  if (o.conditional?.etag) headers['If-None-Match'] = o.conditional.etag;
  if (o.conditional?.lastModified) headers['If-Modified-Since'] = o.conditional.lastModified;
  const conditional = Object.keys(headers).length > 0;
  // A conditional request must reach the server; otherwise skip the HTTP cache entirely.
  const { res, body } = await fetchLimited(
    o.fetch ?? fetch,
    url,
    { cache: conditional ? 'no-cache' : 'no-store', headers },
    { ...DATASET_LIMITS, ...o.limits },
    o.onProgress,
  );
  if (res.status === 304) return { status: 'unchanged' };
  if (!res.ok || !body) throw new Error(`HTTP ${res.status}`);
  const v = validateDataset(kind, body);
  const meta: DatasetMeta = { kind, source: url, size: body.byteLength, savedAt: (o.now ?? Date.now)(), summary: v.summary };
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag) meta.etag = etag;
  if (lastModified) meta.lastModified = lastModified;
  // fetchLimited returns a view of exactly its own buffer, so this stores no extra bytes.
  await (o.store ?? putDataset)(meta, body.buffer as ArrayBuffer);
  return { status: 'saved', meta, warnings: v.warnings };
}

