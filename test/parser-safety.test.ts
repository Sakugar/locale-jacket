import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeStoredSettings } from '../src/shared/config-io.js';
import { validateDataset } from '../src/shared/dataset-validate.js';
import { parseIp, type IpAddr } from '../src/shared/ip.js';
import { makeProfile } from '../src/shared/locale.js';
import { countryOf, MmdbError, MmdbReader } from '../src/shared/mmdb.js';
import { defaultSettings } from '../src/shared/presets.js';
import type { Settings } from '../src/shared/types.js';

// ------------------------------------------------------------- mmdb writer

const enc = new TextEncoder();
const MARKER = [0xab, 0xcd, 0xef, ...enc.encode('MaxMind.com')];

/** Control byte(s) plus size for a standard type (1-7) or an extended one (8+). */
function head(type: number, size: number): number[] {
  const ext = type > 7;
  const ctrl = (ext ? 0 : type << 5) | (size < 29 ? size : size < 285 ? 29 : 30);
  const sizeBytes = size < 29 ? [] : size < 285 ? [size - 29] : [((size - 285) >> 8) & 0xff, (size - 285) & 0xff];
  return [ctrl, ...(ext ? [type - 7] : []), ...sizeBytes];
}
const str = (s: string): number[] => {
  const b = [...enc.encode(s)];
  return [...head(2, b.length), ...b];
};
const u32 = (n: number): number[] => [...head(6, 4), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u64 = (n: bigint): number[] => [...head(9, 8), ...Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(56 - i * 8)) & 0xffn))];
/** An 11-bit pointer (offset < 2048). */
const ptr = (off: number): number[] => [(1 << 5) | (off >> 8), off & 0xff];
const arr = (items: number[][]): number[] => [...head(11, items.length), ...items.flat()];
function map(entries: Record<string, number[]> | [number[], number[]][]): number[] {
  const list = Array.isArray(entries) ? entries : Object.entries(entries).map(([k, v]) => [str(k), v] as [number[], number[]]);
  return [...head(7, list.length), ...list.flatMap(([k, v]) => [...k, ...v])];
}
function encode(v: unknown): number[] {
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number') return u32(v);
  if (typeof v === 'bigint') return u64(v);
  if (Array.isArray(v)) return arr(v.map(encode));
  return map(Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, encode(x)])));
}

/**
 * An IPv4 database (record size 24) with one node: 0.0.0.0/1 maps to the record at
 * data offset `recordAt` (or to raw tree record `left`), 128.0.0.0/1 has no data.
 */
function buildDb(o: { data: number[]; recordAt?: number; left?: number; meta?: number[]; metaFields?: Record<string, unknown> } = { data: [] }): Uint8Array {
  const nodeCount = 1;
  const left = o.left ?? nodeCount + 16 + (o.recordAt ?? 0);
  const rec = (v: number) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const tree = [...rec(left), ...rec(nodeCount)];
  const meta = o.meta ?? encode({ node_count: nodeCount, record_size: 24, ip_version: 4, database_type: 'Test-Country', build_epoch: 1700000000, ...o.metaFields });
  return new Uint8Array([...tree, ...new Array(16).fill(0), ...o.data, ...MARKER, ...meta]);
}

const ip = (s: string): IpAddr => parseIp(s)!;
const usRecord = encode({ country: { iso_code: 'US', names: { en: 'United States' } } });

/** Time a call that must finish quickly; returns what it threw (or undefined). */
function fast(fn: () => unknown, ms = 100): unknown {
  const t0 = performance.now();
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  const took = performance.now() - t0;
  assert.ok(took < ms, `took ${took.toFixed(1)} ms`);
  return err;
}

/** A corrupt record: validation refuses the file and a runtime lookup reads it as "no record". */
function assertRecordRefused(db: Uint8Array, pattern: RegExp): void {
  const err = fast(() => validateDataset('geoip', db));
  assert.ok(err instanceof MmdbError, `expected MmdbError, got ${String(err)}`);
  assert.match(err.message, pattern);
  const reader = new MmdbReader(db);
  let res: ReturnType<MmdbReader['lookup']> | undefined;
  assert.equal(fast(() => (res = reader.lookup(ip('8.8.8.8')))), undefined, 'lookup never throws');
  assert.equal(res!.record, null);
  assert.match(res!.error ?? '', pattern);
  assert.equal(reader.lookup(ip('200.1.1.1')).record, null, 'other ranges still work');
}

// ------------------------------------------------------------------- tests

describe('MaxMind DB parser safety', () => {
  it('reads a minimal valid database', () => {
    const db = buildDb({ data: usRecord });
    const r = new MmdbReader(db);
    assert.equal(r.metadata.database_type, 'Test-Country');
    assert.equal(countryOf(r.lookup(ip('8.8.8.8')).record), 'US');
    assert.equal(r.lookup(ip('8.8.8.8')).prefix, 1);
    assert.equal(r.lookup(ip('8.8.8.8')).error, undefined);
    assert.equal(r.lookup(ip('200.1.1.1')).record, null);
    assert.equal(r.lookup(ip('2001:db8::1')).record, null, 'IPv6 in an IPv4 database');
    const v = validateDataset('geoip', db);
    assert.equal(v.summary, 'Test-Country, built 2023-11-14, IPv4');
    assert.deepEqual(v.warnings, []);
  });

  it('decodes shared values through pointers, and a "__proto__" key as plain data', () => {
    // offset 0: the shared country map; the record refers to it twice.
    const shared = encode({ iso_code: 'US' });
    const record = map([[str('country'), ptr(0)], [str('registered_country'), ptr(0)], [str('__proto__'), str('x')]]);
    const r = new MmdbReader(buildDb({ data: [...shared, ...record], recordAt: shared.length }));
    const rec = r.lookup(ip('8.8.8.8')).record as Record<string, unknown>;
    assert.deepEqual(rec.country, { iso_code: 'US' });
    assert.deepEqual(rec.registered_country, { iso_code: 'US' });
    assert.equal(Object.getPrototypeOf(rec), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(rec, '__proto__')?.value, 'x');
  });

  it('fits a large city-style record well within the budget', () => {
    const names = Object.fromEntries(['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh-CN'].map((l) => [l, `Name ${l}`]));
    const place = { geoname_id: 1, names };
    const city = {
      city: place,
      continent: { code: 'NA', ...place },
      country: { iso_code: 'US', ...place },
      registered_country: { iso_code: 'US', ...place },
      location: { accuracy_radius: 5, latitude: 1, longitude: 2, metro_code: 3, time_zone: 'America/Chicago' },
      postal: { code: '60601' },
      subdivisions: [{ iso_code: 'IL', ...place }, { iso_code: 'CK', ...place }],
    };
    const r = new MmdbReader(buildDb({ data: encode(city) }));
    const res = r.lookup(ip('8.8.8.8'));
    assert.equal(res.error, undefined);
    assert.equal(countryOf(res.record), 'US');
  });

  it('stops a pointer bomb fast', () => {
    // Level 0 is a string; each level above is an array of 16 pointers to the level below.
    // Six levels would decode to 16^6 (16.7 million) strings.
    const data: number[] = [...str('x')];
    let below = 0;
    for (let level = 1; level <= 6; level++) {
      const at = data.length;
      data.push(...arr(Array.from({ length: 16 }, () => ptr(below))));
      below = at;
    }
    assert.ok(data.length < 400, `${data.length} bytes`);
    assertRecordRefused(buildDb({ data, recordAt: below }), /more than 10000 values/);
  });

  it('refuses a pointer to itself, in a record and in the metadata', () => {
    assertRecordRefused(buildDb({ data: ptr(0) }), /pointer to a pointer/);
    const err = fast(() => new MmdbReader(buildDb({ data: usRecord, meta: ptr(0) })));
    assert.ok(err instanceof MmdbError, `expected MmdbError, got ${String(err)}`);
    assert.throws(() => validateDataset('geoip', buildDb({ data: usRecord, meta: ptr(0) })), /pointer to a pointer/);
  });

  it('refuses a pointer to a pointer', () => {
    // 0: pointer to 2; 2: pointer to 4; 4: the value.
    assertRecordRefused(buildDb({ data: [...ptr(2), ...ptr(4), ...str('US')] }), /pointer to a pointer/);
  });

  it('refuses a map that contains itself (too deep)', () => {
    assertRecordRefused(buildDb({ data: map([[str('a'), ptr(0)]]) }), /nested more than 32 levels/);
  });

  it('refuses out-of-range pointers and tree records', () => {
    assertRecordRefused(buildDb({ data: [...usRecord, ...ptr(2000)], recordAt: usRecord.length }), /outside its section/);
    // A tree record that points far past the data section, or into the 16-byte separator.
    assertRecordRefused(buildDb({ data: usRecord, left: 1 + 16 + 5000 }), /outside its section/);
    assertRecordRefused(buildDb({ data: usRecord, left: 1 + 3 }), /outside its section/);
  });

  it('refuses values that run past the end of the data section', () => {
    // A string claims 20 bytes, but the data section holds only 3 after its header.
    assertRecordRefused(buildDb({ data: [...head(2, 20), 0x55, 0x53, 0x41] }), /outside its section/);
    // A uint32 that is cut short.
    assertRecordRefused(buildDb({ data: [...head(6, 4), 1, 2] }), /outside its section/);
  });

  it('refuses a truncated file', () => {
    const db = buildDb({ data: usRecord });
    // Cut inside the metadata: the marker is still there, the metadata map is not complete.
    for (const cut of [1, 5, 20]) {
      const err = fast(() => new MmdbReader(db.subarray(0, db.length - cut)));
      assert.ok(err instanceof MmdbError, `cut ${cut}: ${String(err)}`);
      assert.throws(() => validateDataset('geoip', db.subarray(0, db.length - cut)), MmdbError);
    }
    // Cut before the metadata: no marker at all.
    assert.throws(() => validateDataset('geoip', db.subarray(0, 30)), /metadata marker not found/);
  });

  it('refuses unusable metadata', () => {
    const bad = (fields: Record<string, unknown>) => buildDb({ data: usRecord, metaFields: fields });
    assert.throws(() => new MmdbReader(bad({ node_count: 'many' })), /invalid node count/);
    assert.throws(() => new MmdbReader(bad({ ip_version: 5 })), /IP version/);
    assert.throws(() => new MmdbReader(bad({ record_size: 20 })), /record size/);
    assert.throws(() => new MmdbReader(bad({ node_count: 1000 })), /tree overlaps metadata/);
    assert.throws(() => new MmdbReader(buildDb({ data: usRecord, meta: str('not a map') })), /metadata is not a map/);
    // A date beyond what Date can show is not an error.
    assert.match(validateDataset('geoip', bad({ build_epoch: 10n ** 15n })).summary, /unknown date/);
  });
});

// ------------------------------------------------------------ stored settings

describe('Stored settings are sanitised per section', () => {
  function stored(): Settings {
    const s = defaultSettings();
    s.enabled = false;
    s.subscriptions = [
      { id: 'sub-a', name: 'A', url: 'https://example.com/a.yaml', enabled: true, interval: 'weekly' },
      { id: 'sub-b', name: 'B', url: 'https://example.com/b.yaml', enabled: false, interval: 'daily' },
    ];
    s.defaultAction = { action: 'PROFILE', profile: makeProfile('en-GB') };
    s.options = { ...s.options, frameMode: 'per-frame', reloadOnLate: false, uiLanguage: 'ja' };
    return JSON.parse(JSON.stringify(s)) as Settings;
  }

  it('keeps a valid stored value unchanged', () => {
    const s = stored();
    assert.deepEqual(sanitizeStoredSettings(JSON.parse(JSON.stringify(s)), defaultSettings()), { settings: s, problems: [] });
  });

  it('an invalid uiLanguage resets only that option', () => {
    const s = stored();
    (s.options as unknown as Record<string, unknown>).uiLanguage = 'tlh';
    const r = sanitizeStoredSettings(s, defaultSettings());
    assert.equal(r.settings.options.uiLanguage, 'auto');
    assert.equal(r.settings.options.frameMode, 'per-frame', 'other options kept');
    assert.equal(r.settings.options.reloadOnLate, false);
    assert.deepEqual(r.settings.subscriptions, stored().subscriptions);
    assert.deepEqual(r.settings.defaultAction, stored().defaultAction);
    assert.equal(r.settings.enabled, false);
    assert.deepEqual(r.settings.rules, stored().rules);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!, /uiLanguage/);
  });

  it('a bad default action, enabled flag or nested option resets only itself', () => {
    const s = stored() as unknown as Record<string, unknown>;
    s.defaultAction = { action: 'PROFILE', profile: { locale: '!!' } };
    s.enabled = 'yes';
    (s.options as Record<string, unknown>).datasetUpdates = { onStartup: true, interval: 'hourly' };
    const r = sanitizeStoredSettings(s, defaultSettings());
    assert.deepEqual(r.settings.defaultAction, { action: 'SYSTEM' });
    assert.equal(r.settings.enabled, true);
    assert.equal(r.settings.options.datasetUpdates.onStartup, true, 'valid nested field kept');
    assert.equal(r.settings.options.datasetUpdates.interval, 'off');
    assert.equal(r.settings.options.uiLanguage, 'ja');
    assert.deepEqual(r.settings.subscriptions, stored().subscriptions);
    assert.equal(r.problems.length, 3, r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /default action/.test(p)));
    assert.ok(r.problems.some((p) => /"enabled"/.test(p)));
    assert.ok(r.problems.some((p) => /datasetUpdates\.interval/.test(p)));
  });

  it('an unknown default action is reported, not silently changed', () => {
    const s = stored() as unknown as Record<string, unknown>;
    s.defaultAction = { action: 'MAYBE' };
    const r = sanitizeStoredSettings(s, defaultSettings());
    assert.deepEqual(r.settings.defaultAction, { action: 'SYSTEM' });
    assert.equal(r.problems.length, 1);
  });

  it('a bad subscription is skipped and the others kept', () => {
    const s = stored() as unknown as Record<string, unknown>;
    (s.subscriptions as unknown[]).splice(1, 0, { id: 'sub-x', url: 'ftp://example.com/x' }, 42);
    const r = sanitizeStoredSettings(s, defaultSettings());
    assert.deepEqual(r.settings.subscriptions, stored().subscriptions);
    assert.equal(r.settings.options.uiLanguage, 'ja');
    assert.equal(r.problems.length, 2);
    const notList = stored() as unknown as Record<string, unknown>;
    notList.subscriptions = 'https://example.com/a.yaml';
    const r2 = sanitizeStoredSettings(notList, defaultSettings());
    assert.deepEqual(r2.settings.subscriptions, []);
    assert.equal(r2.settings.options.uiLanguage, 'ja');
    assert.equal(r2.problems.length, 1);
  });

  it('options that are not an object reset only the options', () => {
    const s = stored() as unknown as Record<string, unknown>;
    s.options = 'none';
    const r = sanitizeStoredSettings(s, defaultSettings());
    assert.deepEqual(r.settings.options, defaultSettings().options);
    assert.deepEqual(r.settings.subscriptions, stored().subscriptions);
    assert.equal(r.settings.enabled, false);
    assert.equal(r.problems.length, 1);
  });
});
