// Optional rule datasets (GeoSite, GeoIP, ASN) stored in the extension's IndexedDB.
// Shared by the options page (download/import) and the service worker (lookups).
// Nothing is downloaded unless the user asks for it.

export type DatasetKind = 'geosite' | 'geoip' | 'asn';
export const DATASET_KINDS: readonly DatasetKind[] = ['geosite', 'geoip', 'asn'];

export interface DatasetMeta {
  kind: DatasetKind;
  /** URL it was downloaded from, or "file: <name>" for imports. */
  source: string;
  size: number;
  savedAt: number;
  /** Human-readable summary, e.g. "1559 categories" or "GeoLite2-Country, built 2026-10-15". */
  summary: string;
}

export interface DatasetInfo {
  label: string;
  description: string;
  defaultUrl: string;
  format: string;
  license: string;
}

const CDN = 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release';

export const DATASETS: Record<DatasetKind, DatasetInfo> = {
  geosite: {
    label: 'GeoSite',
    description: 'Domain categories for GEOSITE rules (google, cn, apple@cn, geolocation-!cn …).',
    defaultUrl: `${CDN}/geosite.dat`,
    format: 'v2ray/mihomo geosite.dat',
    license: 'MetaCubeX meta-rules-dat (from v2fly domain-list-community, MIT); Loyalsoldier/v2ray-rules-dat also works',
  },
  geoip: {
    label: 'GeoIP',
    description: 'IP → country for GEOIP rules (GEOIP,LAN works without it).',
    defaultUrl: `${CDN}/country-lite.mmdb`,
    format: 'MaxMind DB (.mmdb), GeoLite2-Country schema',
    license: 'Contains GeoLite2 data by MaxMind (CC BY-SA 4.0) via MetaCubeX; Loyalsoldier/geoip Country.mmdb also works',
  },
  asn: {
    label: 'ASN',
    description: 'IP → autonomous system number for IP-ASN rules.',
    defaultUrl: `${CDN}/GeoLite2-ASN.mmdb`,
    format: 'MaxMind DB (.mmdb), GeoLite2-ASN schema',
    license: 'GeoLite2-ASN by MaxMind (CC BY-SA 4.0) via MetaCubeX',
  },
};

const DB_NAME = 'locale-jacket';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'kind' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const req = fn(t);
        let result: T | undefined;
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => {
          db.close();
          resolve(result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
        t.onabort = () => {
          db.close();
          reject(t.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

export async function putDataset(meta: DatasetMeta, data: ArrayBuffer): Promise<void> {
  await tx(['meta', 'blobs'], 'readwrite', (t) => {
    t.objectStore('blobs').put(data, meta.kind);
    t.objectStore('meta').put(meta);
  });
}

export async function getDatasetBytes(kind: DatasetKind): Promise<ArrayBuffer | null> {
  return (await tx<ArrayBuffer>(['blobs'], 'readonly', (t) => t.objectStore('blobs').get(kind))) ?? null;
}

export async function listDatasets(): Promise<DatasetMeta[]> {
  return (await tx<DatasetMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) ?? [];
}

export async function deleteDataset(kind: DatasetKind): Promise<void> {
  await tx(['meta', 'blobs'], 'readwrite', (t) => {
    t.objectStore('blobs').delete(kind);
    t.objectStore('meta').delete(kind);
  });
}
