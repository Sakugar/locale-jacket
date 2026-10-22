#!/usr/bin/env node
// Initial-launch test and timing: what does a site see when it is the page the
// browser opens at startup, while Locale Jacket's service worker is starting
// too? And what does the extension cost in page-load time?
//
//   node e2e/launch-perf.mjs [--runs 5] [--browser <path>] [--headful] [--only <substring>]
//
// Each "cold" run starts the browser with verify/public/launch.html as its
// startup page (or restores it from the last session), so the extension and
// the first request race as they do for a user. "Worker cold" runs open a tab
// while the extension's service worker is stopped; "warm" runs open a tab in a
// running browser. Baselines run the same page with extensions disabled. The
// page reports back through the verification server (/api/beacon), so the
// harness never attaches to the tab it measures.
//
// Branded Chrome and Edge ignore --load-extension (Chrome 137+) and drop
// extensions loaded over CDP on restart, so a cold launch needs Chromium: by
// default the Playwright build is used if one is installed; pass --browser (or
// BROWSER_PATH) to pick another Chromium. --load-extension installs the
// extension afresh on every start, so cold runs have no header rules or event
// listeners from the previous session: a worst case for the first request.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attach, evaluate, launch, sleep, until } from './lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RUNS = Math.max(1, Number(arg('--runs', 5)));
const WARM_RUNS = RUNS * 2;
const headless = !process.argv.includes('--headful');
const only = arg('--only');

const { importConfigText } = await import(pathToFileURL(path.join(dist, 'shared', 'config-io.js')).href);

const NATIVE = 'zh-CN';
const CONFIG = `
rules:
  - DOMAIN-SUFFIX,google.localhost,en-US
  - DOMAIN-SUFFIX,apple.localhost,ja-JP
default:
  mode: SYSTEM
`;
const HEADER = { 'en-US': 'en-US,en;q=0.9', 'ja-JP': 'ja-JP,ja;q=0.9', [NATIVE]: 'zh-CN,zh;q=0.9' };

function findChromium() {
  const explicit = arg('--browser') ?? process.env.BROWSER_PATH;
  if (explicit) return explicit;
  const bases = [
    path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ];
  const exes = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) for (const e of exes) if (fs.existsSync(path.join(base, d, e))) return path.join(base, d, e);
  }
  return null;
}

const executable = findChromium();
if (!executable) {
  console.error('No Chromium found. Install one (npx playwright install chromium) or pass --browser <path>.\nBranded Chrome/Edge cannot load an unpacked extension at startup.');
  process.exit(2);
}

const BASE_ARGS = ['--lang=zh-CN', '--accept-lang=zh-CN,zh'];
const EXT_ARGS = [`--load-extension=${dist}`, `--disable-extensions-except=${dist}`];

// ----------------------------------------------------------------- helpers

let srv;
let PORT;
const u = (host, query = '') => `http://${host}:${PORT}/launch.html${query}`;

async function serviceWorker(cdp) {
  const sw = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background/sw.js'));
  }, { message: 'extension service worker', timeoutMs: 20000 });
  const s = await attach(cdp, sw.targetId);
  await until(() => evaluate(cdp, s, `typeof localeJacket !== 'undefined' && localeJacket.ready()`), { message: 'worker ready' });
  return s;
}

/** Drop the saved session so a launch does not also reload tabs from an earlier run. */
function forgetSession(profile) {
  fs.rmSync(path.join(profile, 'Default', 'Sessions'), { recursive: true, force: true });
}

function editPreferences(profile, fn) {
  const file = path.join(profile, 'Default', 'Preferences');
  const prefs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fn(prefs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(prefs));
}

/** Install the extension into `profile`, store the test rules, and shut down. */
async function prepareProfile(profile) {
  const b = await launch({ executable, headless, userDataDir: profile, keepProfile: true, extraArgs: [...BASE_ARGS, ...EXT_ARGS] });
  const s = await serviceWorker(b.cdp);
  const r = importConfigText(CONFIG);
  if (!r.settings) throw new Error(`bad test config: ${r.errors.join('; ')}`);
  const settings = { ...r.settings, options: { ...r.settings.options, uiLanguage: 'en' } };
  await evaluate(b.cdp, s, `chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);
  await sleep(500);
  await b.close();
}

/** Wait for the page's report, then make sure no reload follows. */
async function finalBeacon(host, since, query, { quietMs = 2000, timeoutMs = 25000 } = {}) {
  const t0 = Date.now();
  let last = null;
  let lastChange = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    const mine = srv.beacons.filter((b) => b.host === host && b.receivedAt >= since && new URL(b.href).search === query);
    const docs = documentRequests(host, since, query).length;
    if (mine.length + docs !== seen) {
      seen = mine.length + docs;
      lastChange = Date.now();
      last = mine.at(-1) ?? null;
    }
    if (last && Date.now() - lastChange >= quietMs) return last;
    await sleep(100);
  }
  if (last) return last;
  throw new Error(`no report from ${host} within ${timeoutMs} ms`);
}

function documentRequests(host, since, query) {
  return srv.log.filter((l) => l.host === host && l.path === '/launch.html' && l.time >= since && l.search === query);
}

/** Pull the extension's own view of every tab (and its log) after a run. */
async function extensionView(cdp) {
  try {
    const s = await serviceWorker(cdp);
    const statuses = await evaluate(cdp, s, `localeJacket.statuses()`);
    const log = await evaluate(cdp, s, `localeJacket.log()`);
    const dnrRules = (await evaluate(cdp, s, `chrome.declarativeNetRequest.getDynamicRules()`)).length;
    return { statuses, log, dnrRules };
  } catch (e) {
    return { error: e.message };
  }
}

function summarizeRun({ scenario, host, expected, since, query, beacon, ext }) {
  const docs = documentRequests(host, since, query);
  const first = docs[0];
  const loads = beacon.loads.filter((l) => l.at >= since);
  const firstLoad = loads[0] ?? null;
  const tm = beacon.timing ?? {};
  const statusOfTab = ext?.statuses?.find((st) => st.host === host) ?? null;
  const run = {
    scenario,
    host,
    expected,
    documentRequests: docs.length,
    pageLoads: loads.length,
    firstRequestHeader: first?.acceptLanguage ?? null,
    firstLoadLanguage: firstLoad?.language ?? null,
    finalLanguage: beacon.start.language,
    finalIntl: beacon.start.dateLocale,
    finalHeader: beacon.documentAcceptLanguage,
    fetchHeader: beacon.fetchAcceptLanguage,
    // Milliseconds since the harness started the browser (cold runs) or opened the tab (warm runs).
    toFirstRequest: first ? first.time - since : null,
    toLoaded: Math.round(beacon.timeOrigin + (tm.loadEventEnd ?? 0) - since),
    // Navigation timing of the final document.
    fetchToRequest: tm.requestStart != null ? Math.round(tm.requestStart - tm.fetchStart) : null,
    ttfb: tm.responseStart != null ? Math.round(tm.responseStart) : null,
    load: tm.loadEventEnd != null ? Math.round(tm.loadEventEnd) : null,
    navigationType: tm.type ?? null,
    requests: docs.map((l) => ({ ms: l.time - since, search: l.search, acceptLanguage: l.acceptLanguage, dest: l.dest })),
    extension: statusOfTab
      ? { session: statusOfTab.session, applied: statusOfTab.applied?.locale ?? null, late: statusOfTab.late, lateReason: statusOfTab.lateReason, autoReloaded: statusOfTab.autoReloaded }
      : null,
    dnrRules: ext?.dnrRules ?? null,
    timeline: (ext?.log ?? []).filter((l) => l.t >= since).map((l) => `+${l.t - since} ${l.tabId ?? '-'} ${l.msg}`),
  };
  if (expected) {
    const header = HEADER[expected];
    run.firstHeaderOk = run.firstRequestHeader === header;
    run.firstScriptsOk = run.firstLoadLanguage === expected;
    run.finalOk = run.finalLanguage === expected && run.finalIntl === expected && run.finalHeader === header && run.fetchHeader === header;
  }
  return run;
}

// --------------------------------------------------------------- scenarios

const runs = [];

/** One cold start: launch the browser so that `url` is its first page. */
async function coldRun(scenario, profile, { host, expected, extension = true, restore = false, query = '' }) {
  // Only the restore scenario may bring back tabs from an earlier run.
  if (!restore) forgetSession(profile);
  const since = Date.now();
  const b = await launch({
    executable,
    headless,
    userDataDir: profile,
    keepProfile: true,
    extraArgs: [...BASE_ARGS, ...(extension ? EXT_ARGS : ['--disable-extensions'])],
    urls: restore ? [] : [u(host, query)],
  });
  try {
    const beacon = await finalBeacon(host, since, query);
    const ext = extension ? await extensionView(b.cdp) : null;
    const run = summarizeRun({ scenario, host, expected, since, query, beacon, ext });
    runs.push(run);
    return run;
  } finally {
    await b.close();
  }
}

/** Warm: a browser that is already running opens a new tab. */
async function warmRuns(scenario, profile, { host, expected, extension = true, count }) {
  forgetSession(profile);
  const b = await launch({ executable, headless, userDataDir: profile, keepProfile: true, extraArgs: [...BASE_ARGS, ...(extension ? EXT_ARGS : ['--disable-extensions'])] });
  try {
    if (extension) await serviceWorker(b.cdp);
    await sleep(500);
    for (let i = 0; i < count; i++) {
      const since = Date.now();
      const query = `?warm=${i}`;
      const { targetId } = await b.cdp.send('Target.createTarget', { url: u(host, query) });
      const beacon = await finalBeacon(host, since, query, { quietMs: 800 });
      const ext = extension ? await extensionView(b.cdp) : null;
      runs.push(summarizeRun({ scenario, host, expected, since, query, beacon, ext }));
      await b.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      await sleep(200);
    }
  } finally {
    await b.close();
  }
}

/**
 * Service worker cold: the browser is running but Chrome has stopped the
 * extension's idle worker, so the navigation itself has to wake it. Unlike the
 * --load-extension launches, the worker's event listeners and header rules are
 * already registered, as they are for an installed extension at browser start.
 */
async function workerColdRuns(scenario, profile, { host, expected, count }) {
  forgetSession(profile);
  const b = await launch({ executable, headless, userDataDir: profile, keepProfile: true, extraArgs: [...BASE_ARGS, ...EXT_ARGS] });
  try {
    await serviceWorker(b.cdp);
    for (let i = 0; i < count; i++) {
      const { targetInfos } = await b.cdp.send('Target.getTargets');
      for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.endsWith('/background/sw.js'))) {
        await b.cdp.send('Target.closeTarget', { targetId: t.targetId });
      }
      await until(async () => !(await b.cdp.send('Target.getTargets')).targetInfos.some((x) => x.type === 'service_worker' && x.url.endsWith('/background/sw.js')), { message: 'worker stopped' });
      await sleep(300);
      const since = Date.now();
      const query = `?worker-cold=${i}`;
      const { targetId } = await b.cdp.send('Target.createTarget', { url: u(host, query) });
      const beacon = await finalBeacon(host, since, query);
      const ext = await extensionView(b.cdp);
      runs.push(summarizeRun({ scenario, host, expected, since, query, beacon, ext }));
      await b.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      await sleep(200);
    }
  } finally {
    await b.close();
  }
}

const SCENARIOS = [
  { name: 'cold: startup URL, spoofed site (en-US)', kind: 'cold', host: 'google.localhost', expected: 'en-US' },
  { name: 'cold: startup URL, unmatched site (native)', kind: 'cold', host: 'example.localhost', expected: NATIVE },
  { name: 'cold: startup URL, no extension (baseline)', kind: 'cold', host: 'google.localhost', expected: NATIVE, extension: false },
  { name: 'cold: session restore, spoofed site (ja-JP)', kind: 'restore', host: 'apple.localhost', expected: 'ja-JP' },
  { name: 'worker cold: new tab wakes the stopped worker (en-US)', kind: 'worker-cold', host: 'google.localhost', expected: 'en-US' },
  { name: 'warm: new tab, spoofed site (en-US)', kind: 'warm', host: 'google.localhost', expected: 'en-US' },
  { name: 'warm: new tab, unmatched site (native)', kind: 'warm', host: 'example.localhost', expected: NATIVE },
  { name: 'warm: new tab, no extension (baseline)', kind: 'warm', host: 'google.localhost', expected: NATIVE, extension: false },
];

// --------------------------------------------------------------------- run

srv = await startServer({ port: 0, quiet: true });
PORT = srv.port;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-launch-'));
const profile = path.join(work, 'profile');
let product = '';

try {
  {
    const b = await launch({ executable, headless, userDataDir: path.join(work, 'probe'), extraArgs: BASE_ARGS });
    product = (await b.cdp.send('Browser.getVersion')).product;
    await b.close();
  }
  console.log(`Locale Jacket launch test — ${product}${headless ? ' (headless)' : ''}, ${RUNS} cold / ${WARM_RUNS} warm runs per scenario, server :${PORT}\n`);
  await prepareProfile(profile);

  for (const sc of SCENARIOS) {
    if (only && !sc.name.includes(only)) continue;
    process.stdout.write(`  ${sc.name} `);
    const before = runs.length;
    try {
      if (sc.kind === 'cold') {
        for (let i = 0; i < RUNS; i++) {
          await coldRun(sc.name, profile, { ...sc, query: `?run=${i}` });
          process.stdout.write('.');
        }
      } else if (sc.kind === 'restore') {
        // Leave the page open at shutdown with "Continue where you left off" on,
        // so every following start restores it.
        editPreferences(profile, (p) => { p.session = { ...(p.session ?? {}), restore_on_startup: 1 }; });
        await coldRun('(restore setup)', profile, { ...sc, query: '?restore=1' });
        runs.pop();
        for (let i = 0; i < RUNS; i++) {
          await coldRun(sc.name, profile, { ...sc, restore: true, query: '?restore=1' });
          process.stdout.write('.');
        }
        editPreferences(profile, (p) => { p.session = { ...(p.session ?? {}), restore_on_startup: 5 }; });
      } else if (sc.kind === 'worker-cold') {
        await workerColdRuns(sc.name, profile, { ...sc, count: RUNS });
        process.stdout.write('.'.repeat(RUNS));
      } else {
        await warmRuns(sc.name, profile, { ...sc, count: WARM_RUNS });
        process.stdout.write('.'.repeat(WARM_RUNS));
      }
      console.log('');
    } catch (e) {
      console.log(` ✖ ${e.message}`);
      runs.push({ scenario: sc.name, error: e.message });
    }
    if (runs.length === before) console.log('    (no runs recorded)');
  }
} finally {
  await srv.close();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

// ------------------------------------------------------------------ report

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const range = (xs) => {
  const v = xs.filter((x) => typeof x === 'number');
  return v.length ? `${median(v)} (${Math.min(...v)}–${Math.max(...v)})` : '—';
};

const table = [];
let failures = 0;
for (const sc of SCENARIOS) {
  const rs = runs.filter((r) => r.scenario === sc.name && !r.error);
  const errors = runs.filter((r) => r.scenario === sc.name && r.error);
  if (!rs.length && !errors.length) continue;
  const finalOk = rs.filter((r) => r.finalOk).length;
  const headerOk = rs.filter((r) => r.firstHeaderOk).length;
  const scriptsOk = rs.filter((r) => r.firstScriptsOk).length;
  const reloaded = rs.filter((r) => r.pageLoads > 1).length;
  failures += rs.length - finalOk + errors.length;
  table.push({
    scenario: sc.name,
    'final page correct': `${finalOk}/${rs.length + errors.length}`,
    '1st request header ok': `${headerOk}/${rs.length}`,
    '1st page scripts ok': `${scriptsOk}/${rs.length}`,
    reloaded: `${reloaded}/${rs.length}`,
    'to 1st request ms': range(rs.map((r) => r.toFirstRequest)),
    'to loaded ms': range(rs.map((r) => r.toLoaded)),
    'fetch→request ms': range(rs.map((r) => r.fetchToRequest)),
    'load ms': range(rs.map((r) => r.load)),
  });
}

console.log('');
console.table(table);
console.log(`Times are median (min–max). "to …" counts from browser start (cold) or tab creation (warm);
"fetch→request" is fetchStart→requestStart of the final document: connection setup plus any time the extension holds the request;
"load" is that document's loadEventEnd.`);

for (const r of runs.filter((x) => x.error || x.finalOk === false)) {
  console.log(`\n  ${r.scenario}: ${r.error ?? `first request ${r.firstRequestHeader}, first JS ${r.firstLoadLanguage}; final ${r.finalLanguage}/${r.finalIntl}, header ${r.finalHeader}, ${r.documentRequests} document request(s)`}`);
  if (r.requests) console.log(`    document requests: ${r.requests.map((q) => `+${q.ms} ms ${q.acceptLanguage}`).join(', ')}`);
  if (r.extension) console.log(`    extension: ${JSON.stringify(r.extension)}`);
}

const outDir = path.join(root, 'e2e', 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'launch-perf.json');
fs.writeFileSync(out, JSON.stringify({ product, headless, runsPerScenario: RUNS, warmRunsPerScenario: WARM_RUNS, at: new Date().toISOString(), summary: table, runs }, null, 2));
console.log(`\nRaw results: ${path.relative(root, out)}`);
process.exit(failures ? 1 : 0);
