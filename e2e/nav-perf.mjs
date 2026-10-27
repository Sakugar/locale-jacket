#!/usr/bin/env node
// Navigation cost of Locale Jacket in a branded browser: how much slower do pages
// load with the extension than without it, and how much CPU and memory does its
// service worker use per navigation?
//
//   node e2e/nav-perf.mjs [--edge] [--runs 10] [--phase all|loads|cpu] [--only <substring>]
//                         [--rules 5000] [--no-big-loads] [--cpu-navs 40] [--cpu-samples 5]
//                         [--sample-us 200] [--delay 0] [--headful] [--out <file.json>]
//                         [--check-config]
//
// --only <substring> keeps the page-load scenarios whose name contains it and the
// CPU workloads whose "cpu <workload>" does (--only cpu: all CPU workloads, no loads).
//
// Page loads (phase "loads"). Two or three browsers run side by side, all with
// --lang=zh-CN: "none" without the extension, "ext" with it and the 4 e2e test
// rules, and "ext <n>" with the same 4 rules plus 5,000 generated ones (skip it with
// --no-big-loads). The runs are interleaved (one run of a scenario in each browser,
// the order alternating), so drift on the machine hits every side alike. Each
// scenario gets one warm-up run that is not counted, then --runs counted runs.
//   unmatched new tab      new tab on a site no rule matches (example.localhost)
//   spoofed reload         reload of a spoofed page (google.localhost, en-US)
//   spoofed new tab        new tab on the spoofed site; also counts visible reloads
//                          (the page's scripts ran twice), which Edge does most of the time
//   cross-site switch      one tab goes from apple.localhost (ja-JP) to google.localhost
//                          (en-US): a profile switch, so abort, apply and re-issue
//   frame + worker         same-site navigation to verify/public/index.html with one
//                          cross-site iframe (xsite-frame.localhost) and a dedicated worker
// The first four use verify/public/launch.html, which posts its result to the
// verification server (/api/beacon), so the harness never evaluates in the tab; it
// attaches to a tab only to send Page.reload / Page.navigate, in every browser
// alike. "to loaded" is from the harness's command to the final document's
// loadEventEnd (performance.timeOrigin + loadEventEnd; same machine clock), so
// time the extension spends holding, aborting or reloading the load is included.
// For "frame + worker" the harness awaits the page's own report promise (load,
// worker answer, frame answer, fetch) in the tab and reads the time it resolved.
//
// Service-worker CPU and heap (phase "cpu"). A fresh browser with the extension;
// first with the 4 test rules, then with the 4 rules plus --rules (default 5,000)
// generated ones in the unit benchmark's mix (test/perf.test.ts: 40% DOMAIN-SUFFIX,
// 25% DOMAIN, 15% DOMAIN-KEYWORD, 20% DOMAIN-REGEX; every 5th rule SYSTEM). Both
// configs go through importConfigText from dist/, as in the e2e suites, and are
// stored in storage.local['settings'], so the worker's own sanitizing runs on them.
// For each config and workload, --cpu-samples samples of --cpu-navs navigations
// each, in one tab, every navigation to a host not seen before (so the per-host
// match cache never hides the rule matching):
//   spoofed     c<n>.google.localhost → c<n+1>.google.localhost (same profile)
//   unmatched   c<n>.example.localhost → … (no rule, no debugger session)
//   mixed       google (en-US) → example (none) → apple (ja-JP) → google …
// Around each sample the V8 CPU profiler runs on the worker's target
// (Profiler.start/stop over CDP, --sample-us sampling interval). The busy time is
// the samples' time outside "(idle)" and "(program)": JS plus "(garbage collector)";
// "(program)" (native time on the worker thread, e.g. extension API bindings) is
// given separately; both are divided by the number of navigations. The worker
// thread reports its idle time to the profiler, so nothing is subtracted: before
// the samples, a forced GC and a 5 s profile of the idle worker check that it
// really is idle (a warning is printed if it spends over 1 ms/s on JS or GC).
// Subtracting that idle rate was tried and dropped: one stray GC in the idle
// window, scaled to a 12 s sample, made the 5,000-rule figures negative.
// If the worker target supports the Performance domain, TaskDuration/ScriptDuration
// deltas are recorded as well. Heap: Runtime.getHeapUsage on the worker before
// and after HeapProfiler.collectGarbage, once the config is loaded and again after
// its workloads. The harness keeps a DevTools session on the worker, which keeps
// it running: this measures a warm worker, not the first navigation after a wake.
//
// Medians over the runs/samples are printed as tables; the raw data goes to --out
// (default .tmp/nav-perf-<chrome|edge>.json). --check-config only builds and
// validates both rule configs (no browser). Close other browsers' heavy work first:
// the numbers are wall-clock.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attach, evaluate, findBrowser, launch, sleep, until, withTimeout } from './lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const kind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const headless = !process.argv.includes('--headful');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RUNS = Math.max(1, Number(arg('--runs', 10)));
const PHASE = arg('--phase', 'all');
const only = arg('--only');
const BIG_RULES = Math.max(1, Number(arg('--rules', 5000)));
const BIG_LOADS = !process.argv.includes('--no-big-loads');
const CPU_NAVS = Math.max(5, Number(arg('--cpu-navs', 40)));
const CPU_SAMPLES = Math.max(1, Number(arg('--cpu-samples', 5)));
const SAMPLE_US = Math.max(50, Number(arg('--sample-us', 200)));
// Server response time (?delay=) for every measured page; 0 = as fast as loopback.
const DELAY = Math.max(0, Number(arg('--delay', 0)));
const OUT = path.resolve(root, arg('--out', path.join('.tmp', `nav-perf-${kind}.json`)));
if (!['all', 'loads', 'cpu'].includes(PHASE)) {
  console.error(`--phase must be all, loads or cpu (got ${PHASE})`);
  process.exit(2);
}

const { importConfigText } = await import(pathToFileURL(path.join(dist, 'shared', 'config-io.js')).href);

const NATIVE = 'zh-CN';
// The 4 rules of e2e/run.mjs.
const TEST_RULES = [
  'DOMAIN-SUFFIX,google.localhost,en-US',
  'DOMAIN,accounts.google.localhost,SYSTEM',
  'DOMAIN-SUFFIX,apple.localhost,ja-JP',
  'DOMAIN-KEYWORD,microsoft,en-GB',
];

// The benchmark mix of test/perf.test.ts (mixedRules), as compact rule strings.
const WORDS = ['alpha', 'bravo', 'cdn', 'static', 'media', 'shop', 'news', 'mail', 'api', 'img', 'video', 'cloud', 'data', 'auth', 'login', 'app', 'web', 'edge', 'live', 'store'];
const TLDS = ['com', 'net', 'org', 'io', 'co.uk', 'de', 'jp', 'cn', 'fr', 'com.br'];
const domainFor = (i) => `${WORDS[i % WORDS.length]}${i}.${TLDS[(i * 7) % TLDS.length]}`;
function regexFor(i) {
  const d = `${WORDS[i % WORDS.length]}${i}`;
  switch (i % 6) {
    case 0: return `^(.+\\.)?${d}\\.com$`;
    case 1: return `^([a-z0-9-]+\\.)*${d}\\.(com|net|org)$`;
    case 2: return `^api-[a-z]{2}\\d?\\.${d}\\.io$`;
    case 3: return `(^|\\.)${d}\\.(cn|com\\.cn)$`;
    case 4: return `^cdn\\d+\\.${d}\\.net$`;
    default: return `^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*${d}\\.org$`;
  }
}
function generatedRules(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = (i * 37) % 100;
    const [type, value] = x < 20 ? ['DOMAIN-REGEX', regexFor(i)] : x < 35 ? ['DOMAIN-KEYWORD', `kw${i}x`] : x < 60 ? ['DOMAIN', domainFor(i)] : ['DOMAIN-SUFFIX', domainFor(i)];
    out.push(`${type},${value},${i % 5 ? 'en-US' : 'SYSTEM'}`);
  }
  return out;
}

/** Validate a config the way the options page's import does (JSON text through importConfigText). */
function settingsFor(rules) {
  const text = JSON.stringify({ rules, default: { mode: 'SYSTEM' } });
  const r = importConfigText(text);
  if (!r.settings) throw new Error(`bad test config: ${r.errors.slice(0, 5).join('; ')}`);
  if (r.errors.length) throw new Error(`test config has ${r.errors.length} invalid rule(s): ${r.errors.slice(0, 5).join('; ')}`);
  if (r.settings.rules.length !== rules.length) throw new Error(`test config: ${r.settings.rules.length} of ${rules.length} rules imported`);
  const settings = { ...r.settings, options: { ...r.settings.options, uiLanguage: 'en' } };
  return { settings, rules: settings.rules.length, bytes: JSON.stringify(settings).length, unchecked: r.unchecked, warnings: r.warnings.length };
}

const CONFIGS = {
  small: { label: '4 rules', ...settingsFor(TEST_RULES) },
  big: { label: `${TEST_RULES.length + BIG_RULES} rules`, ...settingsFor([...TEST_RULES, ...generatedRules(BIG_RULES)]) },
};

if (process.argv.includes('--check-config')) {
  for (const [name, c] of Object.entries(CONFIGS)) {
    console.log(`${name}: ${c.rules} rules, ${(c.bytes / 1024).toFixed(0)} KiB stored, ${c.unchecked} regex(es) left unchecked by the import budget, ${c.warnings} warning(s)`);
  }
  process.exit(0);
}

const executable = findBrowser(kind);
if (!executable) {
  console.error(`No ${kind} found. Set BROWSER_PATH.`);
  process.exit(2);
}
const BROWSER_ARGS = ['--lang=zh-CN', '--accept-lang=zh-CN,zh'];

// ----------------------------------------------------------------- helpers

let srv;
let PORT;
const u = (host, p) => `http://${host}:${PORT}${p}`;
/** Add the server delay to a query string. */
const qs = (base) => (DELAY ? `${base}&delay=${DELAY}` : base);

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmt = (x, digits = 0) => (x == null ? '—' : x.toFixed(digits));
const range = (xs, digits = 0) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? `${fmt(median(v), digits)} (${fmt(Math.min(...v), digits)}–${fmt(Math.max(...v), digits)})` : '—';
};

/**
 * Start a browser; with `config`, load the extension and store that config.
 * Returns { name, b, cdp, sw (worker session or null), extId }.
 */
async function startSide(name, config) {
  const b = await launch({ executable, headless, extraArgs: BROWSER_ARGS });
  // `id` goes into every query string, so reports from the browsers never mix.
  const side = { name, id: name.replace(/[^a-z0-9]/gi, ''), b, cdp: b.cdp, sw: null, extId: null, config: config?.label ?? null };
  if (config) {
    ({ id: side.extId } = await side.cdp.send('Extensions.loadUnpacked', { path: dist }));
    await connectWorker(side);
    await storeConfig(side, config);
  }
  return side;
}

async function connectWorker(side) {
  const t = await until(async () => {
    const { targetInfos } = await side.cdp.send('Target.getTargets');
    return targetInfos.find((x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${side.extId}/`));
  }, { message: 'extension service worker', timeoutMs: 20000 });
  side.swTarget = t.targetId;
  side.sw = await attach(side.cdp, t.targetId);
  await until(() => evaluate(side.cdp, side.sw, `typeof localeJacket !== 'undefined' && localeJacket.ready()`), { message: 'worker ready', timeoutMs: 20000 });
}

const swEval = (side, expr, opts) => evaluate(side.cdp, side.sw, expr, opts);

/** Store a config and wait until the worker has applied it (its "Settings updated (N rules" log line). */
async function storeConfig(side, config) {
  const since = Date.now() - 1;
  await swEval(side, `chrome.storage.local.set({ settings: ${JSON.stringify(config.settings)} }).then(() => true)`, { timeoutMs: 30000 });
  await until(async () => {
    const log = await swEval(side, `localeJacket.log()`);
    return log.some((l) => l.t >= since && l.msg.startsWith(`Settings updated (${config.rules} rules,`));
  }, { message: `worker to apply ${config.label}`, timeoutMs: 60000, intervalMs: 200 });
  side.config = config.label;
  const problems = (await swEval(side, `localeJacket.global()`))?.settingsProblems ?? [];
  if (problems.length) console.log(`    ${side.name}: ${problems.length} settings problem(s) reported: ${problems.slice(0, 3).join(' | ')}`);
}

/** Wait until the server has a report from `host` with `query` and no further load follows for `quietMs`. */
async function waitBeacon(host, since, query, { quietMs = 600, timeoutMs = 25000 } = {}) {
  const t0 = Date.now();
  let seen = -1;
  let lastChange = Date.now();
  let mine = [];
  while (Date.now() - t0 < timeoutMs) {
    mine = srv.beacons.filter((b) => b.host === host && b.receivedAt >= since && new URL(b.href).search === query);
    const docs = documentRequests(host, since, query).length;
    if (mine.length + docs !== seen) {
      seen = mine.length + docs;
      lastChange = Date.now();
    }
    if (mine.length && Date.now() - lastChange >= quietMs) return mine;
    await sleep(25);
  }
  if (mine.length) return mine;
  throw new Error(`no report from ${host}${query} within ${timeoutMs} ms`);
}

function documentRequests(host, since, query, file = '/launch.html') {
  return srv.log.filter((l) => l.host === host && l.path === file && l.time >= since && l.search === query);
}

/** One measured load of launch.html, from the harness's command at `since`. */
function loadResult(host, since, query, beacons, expected) {
  const last = beacons.at(-1);
  const first = beacons[0];
  const tm = last.timing ?? {};
  const at = (b) => (b.timing?.loadEventEnd != null ? Math.round(b.timeOrigin + b.timing.loadEventEnd - since) : null);
  const loads = (last.loads ?? []).filter((l) => l.at >= since - 5);
  return {
    toLoaded: at(last),
    toFirstLoaded: at(first),
    load: tm.loadEventEnd != null ? Math.round(tm.loadEventEnd) : null,
    fetchToRequest: tm.requestStart != null ? Math.round(tm.requestStart - tm.fetchStart) : null,
    navigationType: tm.type ?? null,
    pageLoads: loads.length,
    documentRequests: documentRequests(host, since, query).length,
    language: last.start?.language ?? null,
    intl: last.start?.dateLocale ?? null,
    header: last.documentAcceptLanguage ?? null,
    ok: last.start?.language === expected && last.start?.dateLocale === expected,
  };
}

const closeTarget = (side, targetId) => side.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
/** Send a navigation without waiting for its answer: the extension may abort and re-issue it. */
const fire = (side, s, method, params) => { side.cdp.send(method, params, s).catch(() => undefined); };

/**
 * Await the page's own report promise in the tab, retrying while the document is
 * not the one asked for (or is replaced during the wait). Returns the time the
 * promise resolved, measured in the page.
 */
async function pageReport(side, s, url, { timeoutMs = 25000, settle = 600 } = {}) {
  const expr = `(() => {
    if (location.href !== ${JSON.stringify(url)} || !window.__ljReportReady || !window.__ljReport) return null;
    const late = !!window.__ljReport.done;
    return window.__ljReportReady.then((r) => {
      const at = performance.timeOrigin + performance.now();
      const n = performance.getEntriesByType('navigation')[0];
      return {
        at, late, timeOrigin: performance.timeOrigin,
        loadEventEnd: n ? n.loadEventEnd : null, fetchStart: n ? n.fetchStart : null, requestStart: n ? n.requestStart : null, type: n ? n.type : null,
        language: r.start.language, intl: r.start.dateLocale,
        worker: r.worker ? (r.worker.snapshot ? r.worker.snapshot.language : r.worker.error) : null,
        frames: (r.frames || []).map((f) => (f.live ? f.host + ':' + f.live.language : f.host + ':' + f.error)),
      };
    });
  })()`;
  const t0 = Date.now();
  let reloads = 0;
  while (Date.now() - t0 < timeoutMs) {
    let r = null;
    try {
      r = await evaluate(side.cdp, s, expr, { timeoutMs: Math.max(1000, timeoutMs - (Date.now() - t0)) });
    } catch {
      r = null; // document replaced while waiting
    }
    if (!r) {
      await sleep(10);
      continue;
    }
    await sleep(settle);
    const origin = await evaluate(side.cdp, s, 'performance.timeOrigin').catch(() => null);
    if (origin === r.timeOrigin) return { ...r, reloads };
    reloads++;
  }
  throw new Error(`no report from ${url} within ${timeoutMs} ms`);
}

// --------------------------------------------------------- page-load phase

const loadRuns = [];

/** Per-side tabs that stay open between runs (reload and switch scenarios). */
async function sideTab(side, key, url, host, query) {
  side.tabs ??= {};
  if (side.tabs[key]) return side.tabs[key];
  const since = Date.now();
  const { targetId } = await side.cdp.send('Target.createTarget', { url });
  const s = await attach(side.cdp, targetId);
  // Long enough to see an automatic reload of that first load go by.
  if (host) await waitBeacon(host, since, query, { quietMs: 1500 });
  side.tabs[key] = { targetId, s };
  return side.tabs[key];
}

const LOAD_SCENARIOS = [
  {
    name: 'unmatched new tab',
    expected: () => NATIVE,
    async run(side, i) {
      const host = 'example.localhost';
      const query = qs(`?nt=${i}&s=${side.id}`);
      const since = Date.now();
      const { targetId } = await side.cdp.send('Target.createTarget', { url: u(host, `/launch.html${query}`) });
      try {
        return loadResult(host, since, query, await waitBeacon(host, since, query, { quietMs: 1000 }), NATIVE);
      } finally {
        await closeTarget(side, targetId);
      }
    },
  },
  {
    name: 'spoofed reload',
    expected: (side) => (side.sw ? 'en-US' : NATIVE),
    async run(side) {
      const host = 'google.localhost';
      const query = qs(`?reload=1&s=${side.id}`);
      const tab = await sideTab(side, 'reload', u(host, `/launch.html${query}`), host, query);
      const since = Date.now();
      fire(side, tab.s, 'Page.reload', {});
      return loadResult(host, since, query, await waitBeacon(host, since, query), this.expected(side));
    },
  },
  {
    name: 'spoofed new tab',
    expected: (side) => (side.sw ? 'en-US' : NATIVE),
    async run(side, i) {
      const host = 'google.localhost';
      const query = qs(`?nt=${i}&s=${side.id}`);
      const since = Date.now();
      const { targetId } = await side.cdp.send('Target.createTarget', { url: u(host, `/launch.html${query}`) });
      try {
        // A long quiet period, so an automatic reload after the first load is counted.
        return loadResult(host, since, query, await waitBeacon(host, since, query, { quietMs: 1500 }), this.expected(side));
      } finally {
        await closeTarget(side, targetId);
      }
    },
  },
  {
    name: 'cross-site switch',
    expected: (side) => (side.sw ? 'en-US' : NATIVE),
    async run(side, i) {
      const from = 'apple.localhost';
      const to = 'google.localhost';
      const tab = await sideTab(side, 'switch', 'about:blank');
      // Put the tab on the ja-JP site first (not measured).
      const fromQuery = qs(`?sw=${i}&s=${side.id}`);
      const t0 = Date.now();
      fire(side, tab.s, 'Page.navigate', { url: u(from, `/launch.html${fromQuery}`), transitionType: 'typed' });
      await waitBeacon(from, t0, fromQuery);
      const query = qs(`?sw=${i}&s=${side.id}`);
      const since = Date.now();
      fire(side, tab.s, 'Page.navigate', { url: u(to, `/launch.html${query}`), transitionType: 'typed' });
      return loadResult(to, since, query, await waitBeacon(to, since, query), this.expected(side));
    },
  },
  {
    name: 'frame + worker',
    expected: (side) => (side.sw ? 'en-US' : NATIVE),
    async run(side, i) {
      const host = 'google.localhost';
      const tab = await sideTab(side, 'frames', 'about:blank');
      const url = u(host, `/index.html${qs(`?frames=xsite-frame.localhost&fw=${i}&s=${side.id}`)}`);
      const since = Date.now();
      fire(side, tab.s, 'Page.navigate', { url, transitionType: 'typed' });
      const r = await pageReport(side, tab.s, url);
      const expected = this.expected(side);
      return {
        toLoaded: r.loadEventEnd != null ? Math.round(r.timeOrigin + r.loadEventEnd - since) : null,
        // Read when the report promise resolved; if it had resolved before the harness
        // first got into the page ("late"), that time is only an upper bound, so drop it.
        toReport: r.late ? null : Math.round(r.at - since),
        load: r.loadEventEnd != null ? Math.round(r.loadEventEnd) : null,
        fetchToRequest: r.requestStart != null ? Math.round(r.requestStart - r.fetchStart) : null,
        navigationType: r.type,
        pageLoads: 1 + r.reloads,
        documentRequests: srv.log.filter((l) => l.host === host && l.path === '/index.html' && l.time >= since && l.search.includes(`fw=${i}&s=${side.id}`)).length,
        language: r.language,
        intl: r.intl,
        worker: r.worker,
        frames: r.frames,
        late: r.late,
        ok: r.language === expected && r.intl === expected && r.worker === expected && r.frames.every((f) => f.endsWith(`:${expected}`)),
      };
    },
  },
];

async function loadPhase() {
  const scenarios = LOAD_SCENARIOS.filter((sc) => !only || sc.name.includes(only));
  if (!scenarios.length) return;
  const sides = [];
  try {
    sides.push(await startSide('none', null));
    sides.push(await startSide('ext', CONFIGS.small));
    if (BIG_LOADS) sides.push(await startSide(`ext ${CONFIGS.big.rules}`, CONFIGS.big));
    // Let the big config's DNR sync and regex precompile finish before timing anything.
    for (const side of sides) if (side.sw) await waitQuiet(side);
    console.log(`Page loads: ${sides.map((s) => s.name).join(' / ')}, 1 warm-up + ${RUNS} runs per scenario\n`);
    for (const sc of scenarios) {
      process.stdout.write(`  ${sc.name} `);
      for (let i = 0; i <= RUNS; i++) {
        // Alternate which browser goes first.
        const order = i % 2 ? [...sides].reverse() : sides;
        for (const side of order) {
          try {
            const r = await sc.run(side, i);
            if (i > 0) loadRuns.push({ scenario: sc.name, side: side.name, run: i, ...r });
          } catch (e) {
            if (i > 0) loadRuns.push({ scenario: sc.name, side: side.name, run: i, error: e.message });
            process.stdout.write('✖');
          }
          await sleep(150);
        }
        process.stdout.write(i ? '.' : 'w');
      }
      console.log('');
    }
  } finally {
    for (const side of sides) await side.b.close();
  }
}

// --------------------------------------------------------------- CPU phase

/** Busy time in a CPU profile, by category, plus self time per function. */
function analyzeProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const totals = { js: 0, gc: 0, program: 0, idle: 0, root: 0 };
  const fns = new Map();
  const { samples, timeDeltas } = profile;
  let t = profile.startTime;
  const stamps = timeDeltas.map((d) => (t += d));
  for (let i = 0; i < samples.length; i++) {
    const next = i + 1 < samples.length ? stamps[i + 1] : profile.endTime;
    const dur = Math.max(0, next - stamps[i]) / 1000; // µs → ms
    const cf = byId.get(samples[i])?.callFrame ?? {};
    const name = cf.functionName ?? '';
    if (name === '(idle)') totals.idle += dur;
    else if (name === '(program)') totals.program += dur;
    else if (name === '(garbage collector)') totals.gc += dur;
    else if (name === '(root)') totals.root += dur;
    else {
      totals.js += dur;
      const key = `${name || '(anonymous)'} ${cf.url ? cf.url.split('/').slice(-2).join('/') : '(native)'}:${(cf.lineNumber ?? -1) + 1}`;
      fns.set(key, (fns.get(key) ?? 0) + dur);
    }
  }
  return { wallMs: (profile.endTime - profile.startTime) / 1000, sampleCount: samples.length, ...totals, fns };
}

async function profileWindow(side, fn) {
  const c = side.cdp;
  await c.send('Profiler.enable', {}, side.sw);
  await c.send('Profiler.setSamplingInterval', { interval: SAMPLE_US }, side.sw);
  const before = await metrics(side);
  await c.send('Profiler.start', {}, side.sw);
  let extra;
  let profile;
  try {
    extra = await fn();
  } finally {
    ({ profile } = await withTimeout(c.send('Profiler.stop', {}, side.sw), 60000, () => 'Profiler.stop timed out'));
  }
  const after = await metrics(side);
  const delta = before && after ? Object.fromEntries(Object.keys(after).filter((k) => k in before).map((k) => [k, (after[k] - before[k]) * 1000])) : null;
  return { ...analyzeProfile(profile), metricsMs: delta, extra };
}

/** Performance.getMetrics on the worker target, if it supports the domain (TaskDuration etc., in seconds). */
async function metrics(side) {
  if (side.perfMetrics === false) return null;
  try {
    if (!side.perfMetrics) {
      await side.cdp.send('Performance.enable', {}, side.sw);
      side.perfMetrics = true;
    }
    const { metrics: m } = await side.cdp.send('Performance.getMetrics', {}, side.sw);
    const pick = Object.fromEntries(m.filter((x) => /Duration$/.test(x.name)).map((x) => [x.name, x.value]));
    return Object.keys(pick).length ? pick : null;
  } catch {
    side.perfMetrics = false;
    return null;
  }
}

/** Wait until the worker's JS is quiet (under 1% busy over 1 s), e.g. after a config change. */
async function waitQuiet(side, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  let p = null;
  while (Date.now() - t0 < timeoutMs) {
    p = await profileWindow(side, () => sleep(1000));
    if (p.js + p.gc < 10) return p;
  }
  console.log(`    ${side.name}: worker still busy after ${timeoutMs} ms (${fmt(p?.js + p?.gc, 1)} ms JS+GC in the last second)`);
  return p;
}

async function heap(side) {
  const used = async () => (await side.cdp.send('Runtime.getHeapUsage', {}, side.sw)).usedSize / 1048576;
  const before = await used();
  await side.cdp.send('HeapProfiler.enable', {}, side.sw).catch(() => undefined);
  await side.cdp.send('HeapProfiler.collectGarbage', {}, side.sw).catch(() => undefined);
  await sleep(200);
  return { usedMB: before, afterGcMB: await used() };
}

let hostCounter = 0;
const CPU_WORKLOADS = {
  spoofed: () => [['google.localhost', 'en-US']],
  unmatched: () => [['example.localhost', NATIVE]],
  mixed: () => [['google.localhost', 'en-US'], ['example.localhost', NATIVE], ['apple.localhost', 'ja-JP']],
};

/** Navigate one tab through `count` new hosts of the workload; returns the number of wrong pages. */
async function navigations(side, tab, workload, count) {
  const cycle = CPU_WORKLOADS[workload]();
  let wrong = 0;
  for (let k = 0; k < count; k++) {
    const [base, expected] = cycle[k % cycle.length];
    const url = u(`c${++hostCounter}.${base}`, `/plain.html${qs('?cpu=1')}`);
    fire(side, tab.s, 'Page.navigate', { url, transitionType: 'typed' });
    const r = await pageReport(side, tab.s, url, { settle: 150 });
    if (r.language !== expected || r.intl !== expected) wrong++;
  }
  return wrong;
}

const cpuRuns = [];
const heapRuns = [];

async function cpuPhase() {
  const workloads = Object.keys(CPU_WORKLOADS).filter((w) => !only || `cpu ${w}`.includes(only));
  if (!workloads.length) return;
  const side = await startSide('ext', CONFIGS.small);
  try {
    const tab = await sideTab(side, 'cpu', 'about:blank');
    console.log(`\nWorker CPU: ${CPU_SAMPLES} samples × ${CPU_NAVS} navigations per config and workload, profiler every ${SAMPLE_US} µs`);
    for (const configName of ['small', 'big']) {
      const config = CONFIGS[configName];
      if (configName !== 'small') await storeConfig(side, config);
      await waitQuiet(side);
      heapRuns.push({ config: config.label, when: 'loaded, idle', ...(await heap(side)) });
      // Warm-up (JIT, first-use checks), not counted.
      await navigations(side, tab, 'mixed', 9);
      await side.cdp.send('HeapProfiler.collectGarbage', {}, side.sw).catch(() => undefined);
      await waitQuiet(side);
      // A check that the worker is idle between samples (and reports idle time to the profiler).
      const idle = await profileWindow(side, () => sleep(5000));
      cpuRuns.push({ config: config.label, workload: '(idle)', wallMs: idle.wallMs, jsMs: idle.js, gcMs: idle.gc, programMs: idle.program, idleMs: idle.idle, metricsMs: idle.metricsMs });
      // If "(program)" takes nearly all of this, the worker thread does not report idle time to the profiler.
      const perS = (ms) => fmt((ms * 1000) / idle.wallMs, 1);
      console.log(`  ${config.label}, idle worker per second: JS+GC ${perS(idle.js + idle.gc)} ms, (program) ${perS(idle.program)} ms, (idle) ${perS(idle.idle)} ms`);
      if ((idle.js + idle.gc + idle.program) / idle.wallMs > 0.001) console.log('    warning: the worker was not idle; the samples below include that background work');
      for (const workload of workloads) {
        process.stdout.write(`  ${config.label}, ${workload} `);
        for (let i = 0; i < CPU_SAMPLES; i++) {
          let p;
          try {
            p = await profileWindow(side, async () => {
              const wrong = await navigations(side, tab, workload, CPU_NAVS);
              await sleep(500); // let the last navigation's events finish inside the window
              return { wrong };
            });
          } catch (e) {
            cpuRuns.push({ config: config.label, workload, sample: i, error: e.message });
            process.stdout.write('✖');
            continue;
          }
          const busy = p.js + p.gc;
          const program = p.program;
          const top = [...p.fns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([fn, ms]) => ({ fn, msPerNav: ms / CPU_NAVS }));
          cpuRuns.push({
            config: config.label,
            workload,
            sample: i,
            navigations: CPU_NAVS,
            wrongPages: p.extra.wrong,
            wallMs: p.wallMs,
            jsMs: p.js,
            gcMs: p.gc,
            programMs: p.program,
            idleMs: p.idle,
            busyPerNav: busy / CPU_NAVS,
            gcPerNav: p.gc / CPU_NAVS,
            programPerNav: program / CPU_NAVS,
            metricsPerNav: p.metricsMs ? Object.fromEntries(Object.entries(p.metricsMs).map(([k, v]) => [k, v / CPU_NAVS])) : null,
            top,
          });
          process.stdout.write('.');
        }
        console.log('');
      }
      heapRuns.push({ config: config.label, when: 'after the workloads', ...(await heap(side)) });
    }
  } finally {
    await side.b.close();
  }
}

// --------------------------------------------------------------------- run

srv = await startServer({ port: 0, quiet: true });
PORT = srv.port;
let product = '';
const harnessErrors = [];
const startedAt = new Date().toISOString();
try {
  {
    const b = await launch({ executable, headless, extraArgs: BROWSER_ARGS });
    product = (await b.cdp.send('Browser.getVersion')).product;
    await b.close();
  }
  console.log(`Locale Jacket navigation cost — ${product}${headless ? ' (headless)' : ''}, server :${PORT}${DELAY ? `, server delay ${DELAY} ms` : ''}`);
  console.log(`Configs: ${CONFIGS.small.label}; ${CONFIGS.big.label} (${(CONFIGS.big.bytes / 1024).toFixed(0)} KiB stored)\n`);
  // A phase that fails still leaves the other phase's results (and its own so far) in the report.
  for (const [want, phase] of [['loads', loadPhase], ['cpu', cpuPhase]]) {
    if (PHASE !== 'all' && PHASE !== want) continue;
    try {
      await phase();
    } catch (e) {
      console.log(`\n  ✖ ${want} phase failed: ${e.message}`);
      harnessErrors.push({ phase: want, error: e.message });
    }
  }
} finally {
  await srv.close();
}

// ------------------------------------------------------------------ report

const loadTable = [];
const sidesSeen = [...new Set(loadRuns.map((r) => r.side))];
for (const sc of LOAD_SCENARIOS) {
  const rs = loadRuns.filter((r) => r.scenario === sc.name);
  if (!rs.length) continue;
  const metric = sc.name === 'frame + worker' ? 'toReport' : 'toLoaded';
  const base = median(rs.filter((r) => r.side === 'none' && !r.error).map((r) => r[metric]));
  for (const side of sidesSeen) {
    const mine = rs.filter((r) => r.side === side);
    const ok = mine.filter((r) => !r.error);
    const m = median(ok.map((r) => r[metric]));
    loadTable.push({
      scenario: sc.name,
      side,
      [`median ms (min–max)`]: range(ok.map((r) => r[metric])),
      'Δ vs none': side === 'none' || m == null || base == null ? '' : `${m - base >= 0 ? '+' : ''}${fmt(m - base)}`,
      'loadEventEnd': range(ok.map((r) => r.load)),
      'fetch→request': range(ok.map((r) => r.fetchToRequest)),
      'reloaded': `${ok.filter((r) => r.pageLoads > 1).length}/${ok.length}`,
      'right locale': `${ok.filter((r) => r.ok).length}/${mine.length}`,
    });
  }
}

const cpuTable = [];
for (const config of [CONFIGS.small.label, CONFIGS.big.label]) {
  for (const workload of Object.keys(CPU_WORKLOADS)) {
    const all = cpuRuns.filter((r) => r.config === config && r.workload === workload);
    const rs = all.filter((r) => !r.error);
    if (!all.length) continue;
    const task = rs.map((r) => r.metricsPerNav?.TaskDuration);
    const script = rs.map((r) => r.metricsPerNav?.ScriptDuration);
    cpuTable.push({
      config,
      workload,
      'JS+GC ms/nav': range(rs.map((r) => r.busyPerNav), 2),
      'GC ms/nav': fmt(median(rs.map((r) => r.gcPerNav)), 2),
      '(program) ms/nav': fmt(median(rs.map((r) => r.programPerNav)), 2),
      'TaskDuration ms/nav': task.some((x) => x != null) ? fmt(median(task), 2) : 'n/a',
      'ScriptDuration ms/nav': script.some((x) => x != null) ? fmt(median(script), 2) : 'n/a',
      'wrong pages': rs.reduce((a, r) => a + r.wrongPages, 0),
      'failed samples': all.length - rs.length,
    });
  }
}

/** Functions with the most self time per navigation, medians over the samples. */
function topFunctions(config, workload, n = 8) {
  const rs = cpuRuns.filter((r) => r.config === config && r.workload === workload && r.top);
  const names = new Set(rs.flatMap((r) => r.top.map((t) => t.fn)));
  return [...names]
    .map((fn) => ({ fn, msPerNav: median(rs.map((r) => r.top.find((t) => t.fn === fn)?.msPerNav ?? 0)) }))
    .sort((a, b) => b.msPerNav - a.msPerNav)
    .slice(0, n);
}

if (loadTable.length) {
  console.log('\nPage loads (ms from the harness command to the final document\'s loadEventEnd; "frame + worker": to the page\'s report with worker and frame answers):');
  console.table(loadTable);
  console.log('"reloaded": the page\'s scripts ran more than once (a visible second load). "loadEventEnd" and "fetch→request" are the final document\'s own navigation timing.');
  for (const r of loadRuns.filter((x) => x.error || x.ok === false)) {
    console.log(`  ${r.scenario} [${r.side}] run ${r.run}: ${r.error ?? `language ${r.language}, Intl ${r.intl}${r.worker !== undefined ? `, worker ${r.worker}, frames ${r.frames?.join(' ')}` : ''}`}`);
  }
}
if (cpuTable.length) {
  console.log(`\nService-worker CPU per navigation (V8 profiler on the worker, median (min–max) over ${CPU_SAMPLES} samples of ${CPU_NAVS} navigations):`);
  console.table(cpuTable);
  console.log('Service-worker heap (MB):');
  console.table(heapRuns.map((h) => ({ config: h.config, when: h.when, used: fmt(h.usedMB, 2), 'after GC': fmt(h.afterGcMB, 2) })));
  for (const config of [CONFIGS.small.label, CONFIGS.big.label]) {
    const top = topFunctions(config, 'mixed');
    if (!top.length) continue;
    console.log(`Most self time, ${config}, mixed (ms/navigation):`);
    for (const t of top) console.log(`  ${fmt(t.msPerNav, 3).padStart(7)}  ${t.fn}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  product,
  browser: kind,
  headless,
  at: startedAt,
  options: { runs: RUNS, phase: PHASE, only, bigRules: BIG_RULES, bigLoads: BIG_LOADS, cpuNavs: CPU_NAVS, cpuSamples: CPU_SAMPLES, sampleUs: SAMPLE_US, delayMs: DELAY },
  configs: Object.fromEntries(Object.entries(CONFIGS).map(([k, c]) => [k, { label: c.label, rules: c.rules, bytes: c.bytes, unchecked: c.unchecked }])),
  summary: { loads: loadTable, cpu: cpuTable, heap: heapRuns },
  harnessErrors,
  loadRuns,
  cpuRuns,
}, null, 2));
console.log(`\nRaw results: ${path.relative(root, OUT)}`);
for (const r of cpuRuns.filter((x) => x.error)) console.log(`  CPU ${r.config}, ${r.workload}, sample ${r.sample}: ${r.error}`);
const failures = harnessErrors.length + loadRuns.filter((r) => r.error || r.ok === false).length + cpuRuns.reduce((a, r) => a + (r.error ? 1 : 0) + (r.wrongPages ?? 0), 0);
process.exit(failures ? 1 : 0);
