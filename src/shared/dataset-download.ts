// Download a data set, validate it and store it. Used by the options page (manual
// download) and the service worker (automatic updates). With `conditional`, the
// request carries If-None-Match / If-Modified-Since so an unchanged file is not
// downloaded again (HTTP 304).

import { putDataset, type DatasetKind, type DatasetMeta } from './dataset-store.js';
import { validateDataset } from './dataset-validate.js';

export interface DownloadOptions {
  onProgress?: (got: number, total: number) => void;
  conditional?: { etag?: string; lastModified?: string };
  fetch?: typeof fetch;
  store?: (meta: DatasetMeta, data: ArrayBuffer) => Promise<void>;
  now?: () => number;
}

export type DownloadResult = { status: 'unchanged' } | { status: 'saved'; meta: DatasetMeta; warnings: string[] };

export async function downloadDataset(kind: DatasetKind, url: string, o: DownloadOptions = {}): Promise<DownloadResult> {
  const headers: Record<string, string> = {};
  if (o.conditional?.etag) headers['If-None-Match'] = o.conditional.etag;
  if (o.conditional?.lastModified) headers['If-Modified-Since'] = o.conditional.lastModified;
  const conditional = Object.keys(headers).length > 0;
  // A conditional request must reach the server; otherwise skip the HTTP cache entirely.
  const res = await (o.fetch ?? fetch)(url, { cache: conditional ? 'no-cache' : 'no-store', headers });
  if (res.status === 304) return { status: 'unchanged' };
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    o.onProgress?.(got, total);
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  const v = validateDataset(kind, bytes);
  const meta: DatasetMeta = { kind, source: url, size: got, savedAt: (o.now ?? Date.now)(), summary: v.summary };
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag) meta.etag = etag;
  if (lastModified) meta.lastModified = lastModified;
  await (o.store ?? putDataset)(meta, bytes.buffer);
  return { status: 'saved', meta, warnings: v.warnings };
}
