import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatasetUpdater } from '../src/background/dataset-updater.js';
import { exportConfig, importConfigText } from '../src/shared/config-io.js';
import { downloadDataset } from '../src/shared/dataset-download.js';
import { dueDatasets, planUpdates, type DatasetUpdateState, type Needed } from '../src/shared/dataset-schedule.js';
import type { DatasetMeta } from '../src/shared/dataset-store.js';
import { defaultSettings } from '../src/shared/presets.js';
import type { DatasetUpdateOptions } from '../src/shared/types.js';
import { encodeGeosite } from './fixtures.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 21, 12);
const URL_ = 'https://cdn.example/geosite.dat';

const opts = (o: Partial<DatasetUpdateOptions> = {}): DatasetUpdateOptions => ({ onStartup: false, interval: 'off', minIntervalHours: 24, onlyNeeded: true, ...o });
const meta = (kind: DatasetMeta['kind'], o: Partial<DatasetMeta> = {}): DatasetMeta => ({ kind, source: URL_, size: 1, savedAt: NOW - 2 * DAY, summary: 'x', ...o });
const ALL: Needed = { geosite: true, geoip: true, asn: true };

function due(p: { trigger: 'startup' | 'alarm' | 'manual'; o?: Partial<DatasetUpdateOptions>; metas?: DatasetMeta[]; state?: DatasetUpdateState; needed?: Needed; now?: number }) {
  return dueDatasets({ now: p.now ?? NOW, trigger: p.trigger, opts: opts(p.o), metas: p.metas ?? [meta('geosite')], state: p.state ?? {}, needed: p.needed ?? ALL });
}

describe('data-set update schedule', () => {
  it('does nothing automatically while updates are off (the default)', () => {
    assert.deepEqual(defaultSettings().options.datasetUpdates, opts());
    assert.deepEqual(due({ trigger: 'startup' }), []);
    assert.deepEqual(due({ trigger: 'alarm' }), []);
  });

  it('checks on browser start when enabled, unless the minimum gap has not passed', () => {
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true } }), ['geosite']);
    const recent = { geosite: { lastAttempt: NOW - 3 * H } };
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true }, state: recent }), []);
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true, minIntervalHours: 2 }, state: recent }), ['geosite']);
    const d = planUpdates({ now: NOW, trigger: 'startup', opts: opts({ onStartup: true }), metas: [meta('geosite')], state: recent, needed: ALL })[0]!;
    assert.equal(d.reason, 'too-soon');
    assert.equal(d.notBefore, NOW - 3 * H + 24 * H);
  });

  it('a failed attempt also counts against the minimum gap', () => {
    const failed = { geosite: { lastAttempt: NOW - H, lastResult: 'failed' as const, lastError: 'HTTP 500' } };
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true }, state: failed }), []);
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'daily' }, state: failed }), []);
  });

  it('regular checks run once the interval has passed since the last successful check', () => {
    const checked = (ago: number) => ({ geosite: { lastAttempt: NOW - ago, lastChecked: NOW - ago, lastResult: 'unchanged' as const } });
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'weekly' }, state: checked(3 * DAY) }), []);
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'weekly' }, state: checked(8 * DAY) }), ['geosite']);
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'daily' }, state: checked(25 * H) }), ['geosite']);
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'monthly' }, state: checked(20 * DAY) }), []);
    // Never checked: measured from when the file was saved.
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'daily' }, metas: [meta('geosite', { savedAt: NOW - H })] }), []);
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'daily' } }), ['geosite']);
  });

  it('the minimum gap also limits the regular interval', () => {
    const state = { geosite: { lastAttempt: NOW - 30 * H, lastChecked: NOW - 30 * H } };
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'daily', minIntervalHours: 48 }, state }), []);
    assert.deepEqual(due({ trigger: 'alarm', o: { interval: 'daily', minIntervalHours: 24 }, state }), ['geosite']);
  });

  it('a browser start catches up on an overdue regular check even without "on startup"', () => {
    const state = { geosite: { lastAttempt: NOW - 9 * DAY, lastChecked: NOW - 9 * DAY } };
    assert.deepEqual(due({ trigger: 'startup', o: { interval: 'weekly' }, state }), ['geosite']);
    assert.deepEqual(due({ trigger: 'startup', o: { interval: 'weekly' }, state: { geosite: { lastAttempt: NOW - DAY * 2, lastChecked: NOW - DAY * 2 } } }), []);
  });

  it('skips imported files and, by default, data sets the rules do not use', () => {
    const metas = [meta('geosite'), meta('geoip', { source: 'file: Country.mmdb' }), meta('asn')];
    const needed = { geosite: true, geoip: true, asn: false };
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true }, metas, needed }), ['geosite']);
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true, onlyNeeded: false }, metas, needed }), ['geosite', 'asn']);
  });

  it('a manual check ignores the minimum gap, the interval and the rules condition', () => {
    const metas = [meta('geosite'), meta('asn'), meta('geoip', { source: 'file: x' })];
    const state = { geosite: { lastAttempt: NOW - 60_000 } };
    assert.deepEqual(due({ trigger: 'manual', metas, state, needed: { geosite: false, geoip: false, asn: false } }), ['geosite', 'asn']);
  });

  it('clamps the minimum gap to at least one hour', () => {
    const state = { geosite: { lastAttempt: NOW - 30 * 60_000 } };
    assert.deepEqual(due({ trigger: 'startup', o: { onStartup: true, minIntervalHours: 0 }, state }), []);
  });
});

describe('data-set update options', () => {
  it('import validates and export round-trips datasetUpdates', () => {
    const r = importConfigText('options:\n  datasetUpdates:\n    onStartup: true\n    interval: weekly\n    minIntervalHours: 12\n');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.settings!.options.datasetUpdates, { onStartup: true, interval: 'weekly', minIntervalHours: 12, onlyNeeded: true });
    assert.deepEqual(importConfigText(exportConfig(r.settings!, 'yaml')).settings!.options.datasetUpdates, r.settings!.options.datasetUpdates);
    assert.deepEqual(importConfigText(exportConfig(r.settings!, 'json')).settings!.options.datasetUpdates, r.settings!.options.datasetUpdates);
    const bad = importConfigText(JSON.stringify({ options: { datasetUpdates: { interval: 'hourly', minIntervalHours: 0, onStartup: 'yes' } } }));
    assert.equal(bad.errors.length, 3, bad.errors.join('\n'));
  });
});

// ------------------------------------------------------------------ download

const GEOSITE = new Uint8Array(encodeGeosite({ google: [[2, 'google.com']], cn: [[2, 'cn']] })).buffer;

function fakeFetch(handler: (url: string, headers: Record<string, string>) => Response) {
  const calls: { url: string; headers: Record<string, string>; cache?: RequestCache }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, cache: init?.cache });
    return handler(url, headers);
  }) as typeof fetch;
  return { f, calls };
}

describe('downloadDataset', () => {
  it('stores a validated file with its HTTP validators', async () => {
    const { f, calls } = fakeFetch(() => new Response(GEOSITE, { headers: { etag: '"v1"', 'last-modified': 'Tue, 20 Oct 2026 00:00:00 GMT' } }));
    const stored: DatasetMeta[] = [];
    const r = await downloadDataset('geosite', URL_, { fetch: f, store: async (m) => void stored.push(m), now: () => NOW });
    assert.equal(r.status, 'saved');
    assert.equal(stored[0]!.etag, '"v1"');
    assert.equal(stored[0]!.lastModified, 'Tue, 20 Oct 2026 00:00:00 GMT');
    assert.equal(stored[0]!.summary, '2 categories');
    assert.equal(calls[0]!.cache, 'no-store');
  });

  it('sends a conditional request and treats 304 as unchanged', async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 304 }));
    const r = await downloadDataset('geosite', URL_, { fetch: f, store: async () => assert.fail('must not store'), conditional: { etag: '"v1"', lastModified: 'x' } });
    assert.deepEqual(r, { status: 'unchanged' });
    assert.deepEqual(calls[0]!.headers, { 'If-None-Match': '"v1"', 'If-Modified-Since': 'x' });
    assert.equal(calls[0]!.cache, 'no-cache');
  });

  it('rejects HTTP errors and invalid files without storing', async () => {
    const store = async () => assert.fail('must not store');
    await assert.rejects(downloadDataset('geosite', URL_, { fetch: fakeFetch(() => new Response('x', { status: 500 })).f, store }), /HTTP 500/);
    await assert.rejects(downloadDataset('asn', URL_, { fetch: fakeFetch(() => new Response(GEOSITE)).f, store }));
  });
});

// ------------------------------------------------------------------- updater

function harness(o: Partial<DatasetUpdateOptions>, metas: DatasetMeta[], respond: (url: string, headers: Record<string, string>) => Response, initial: DatasetUpdateState = {}) {
  let now = NOW;
  let state: DatasetUpdateState = structuredClone(initial);
  const saved: DatasetMeta[] = [];
  const logs: string[] = [];
  let updatedCalls = 0;
  const { f, calls } = fakeFetch(respond);
  const updater = new DatasetUpdater({
    now: () => now,
    options: () => opts(o),
    needed: () => ALL,
    listMetas: async () => metas,
    getState: async () => structuredClone(state),
    setState: async (s) => void (state = structuredClone(s)),
    onUpdated: async () => void updatedCalls++,
    log: (_l, m) => void logs.push(m),
    downloadOptions: { fetch: f, store: async (m) => void saved.push(m) },
  });
  return { updater, calls, saved, logs, state: () => state, updated: () => updatedCalls, advance: (ms: number) => void (now += ms) };
}

describe('DatasetUpdater', () => {
  it('updates a changed file, records the result and reloads once', async () => {
    const t = harness({ onStartup: true }, [meta('geosite', { etag: '"v1"' })], () => new Response(GEOSITE, { headers: { etag: '"v2"' } }));
    const out = await t.updater.run('startup');
    assert.deepEqual(out.map((o) => [o.kind, o.result]), [['geosite', 'updated']]);
    assert.equal(t.calls[0]!.headers['If-None-Match'], '"v1"');
    assert.equal(t.saved[0]!.etag, '"v2"');
    assert.deepEqual(t.state().geosite, { lastAttempt: NOW, lastChecked: NOW, lastResult: 'updated' });
    assert.equal(t.updated(), 1);
  });

  it('an unchanged file (304) is not reloaded', async () => {
    const t = harness({ onStartup: true }, [meta('geosite', { etag: '"v1"' })], () => new Response(null, { status: 304 }));
    const out = await t.updater.run('startup');
    assert.equal(out[0]!.result, 'unchanged');
    assert.equal(t.updated(), 0);
    assert.equal(t.state().geosite!.lastResult, 'unchanged');
  });

  it('a failure is recorded and blocks retries until the minimum gap has passed', async () => {
    const t = harness({ onStartup: true, minIntervalHours: 6 }, [meta('geosite')], () => new Response('down', { status: 503 }));
    assert.equal((await t.updater.run('startup'))[0]!.result, 'failed');
    assert.deepEqual(t.state().geosite, { lastAttempt: NOW, lastResult: 'failed', lastError: 'HTTP 503' });
    t.advance(2 * H);
    const again = await t.updater.run('startup');
    assert.deepEqual(again.map((o) => [o.result, o.reason]), [['skipped', 'too-soon']]);
    assert.equal(t.calls.length, 1);
    assert.match(t.logs.at(-1)!, /minimum gap of 6 h/);
    t.advance(5 * H);
    await t.updater.run('startup');
    assert.equal(t.calls.length, 2);
  });

  it('overlapping triggers share one run', async () => {
    const t = harness({ onStartup: true, interval: 'daily' }, [meta('geosite')], () => new Response(null, { status: 304 }));
    const [a, b] = await Promise.all([t.updater.run('startup'), t.updater.run('alarm')]);
    assert.equal(a, b);
    assert.equal(t.calls.length, 1);
  });

  it('nothing is fetched when automatic updates are off', async () => {
    const t = harness({}, [meta('geosite')], () => assert.fail('must not fetch'));
    await t.updater.run('startup');
    await t.updater.run('alarm');
    assert.equal(t.calls.length, 0);
  });
});
