#!/usr/bin/env node
// Stress and edge-case tests: the situations e2e/run.mjs does not cover, run in a
// real Chrome (or Edge) against the verification server on *.localhost hostnames.
//
//   node e2e/stress.mjs [--edge] [--headful] [--only <regex>] [--rounds <n>]
//
// Two kinds of checks:
//   test   must pass; a failure fails the run.
//   probe  a documented limitation (docs/LIMITATIONS.md). It passes when the page shows
//          the right values, or when the extension reports the problem instead of hiding
//          it. It fails only when the page is wrong *and* the extension claims success.
//
// The browser runs with --lang=zh-CN so the "real" locale is Simplified Chinese.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attach, evaluate, findBrowser, launch, sleep, until } from './lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const kind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const headless = !process.argv.includes('--headful');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const only = arg('--only');
const ROUNDS = Math.max(1, Number(arg('--rounds')) || 1);

const { importConfigText } = await import(pathToFileURL(path.join(dist, 'shared', 'config-io.js')).href);

const NATIVE = 'zh-CN';
const CONFIG = `
rules:
  - DOMAIN-SUFFIX,google.localhost,en-US
  - DOMAIN,accounts.google.localhost,SYSTEM
  - DOMAIN,docs.google.localhost,fr-FR
  - DOMAIN-SUFFIX,apple.localhost,ja-JP
  - DOMAIN-KEYWORD,microsoft,en-GB
  - DOMAIN-SUFFIX,frame-fr.localhost,fr-FR
  - DOMAIN-SUFFIX,frame-de.localhost,de-DE
  - DOMAIN-SUFFIX,frame-ja.localhost,ja-JP
  - DOMAIN-SUFFIX,frame-gb.localhost,en-GB
default:
  mode: SYSTEM
`;

const HEADER = {
  'en-US': 'en-US,en;q=0.9',
  'ja-JP': 'ja-JP,ja;q=0.9',
  'en-GB': 'en-GB,en;q=0.9',
  'fr-FR': 'fr-FR,fr;q=0.9',
  'de-DE': 'de-DE,de;q=0.9',
  [NATIVE]: 'zh-CN,zh;q=0.9',
};

function settingsFrom(yaml, patch = {}) {
  const r = importConfigText(yaml);
  if (!r.settings) throw new Error(`bad test config: ${r.errors.join('; ')}`);
  return { ...r.settings, ...patch, options: { ...r.settings.options, uiLanguage: 'en', ...(patch.options ?? {}) } };
}

// ----------------------------------------------------------------- harness

const results = [];
let srv;
let browser;
let cdp;
let swSession;
let extId;
let PORT;
const u = (host, p = '/') => `http://${host}:${PORT}${p}`;

async function findWorker() {
  const sw = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
  }, { message: 'extension service worker', timeoutMs: 20000 });
  swSession = await attach(cdp, sw.targetId);
  await until(() => evaluate(cdp, swSession, `typeof localeJacket !== 'undefined' && localeJacket.ready()`), { message: 'worker ready', timeoutMs: 20000 });
  return sw.targetId;
}

async function startBrowser(userDataDir) {
  browser = await launch({ executable: findBrowser(kind), headless, userDataDir, keepProfile: Boolean(userDataDir), extraArgs: ['--lang=zh-CN', '--accept-lang=zh-CN,zh'] });
  cdp = browser.cdp;
  ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: dist }));
  await findWorker();
}

const sw = (expr) => evaluate(cdp, swSession, expr);

async function setSettings(settings, { settle = 400 } = {}) {
  await sw(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);
  await sleep(settle); // storage.onChanged → updateSettings
}

async function tabIdOf(targetId) {
  return until(async () => (await sw(`chrome.debugger.getTargets()`)).find((t) => t.id === targetId)?.tabId, { message: 'tab id' });
}

let openedInTest = [];
async function adopt(targetId) {
  openedInTest.push(targetId);
  const s = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, s);
  const tabId = await tabIdOf(targetId);
  return { targetId, s, tabId };
}

async function openTab(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  return adopt(targetId);
}

async function closeTab(tab) {
  if (tab) await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
}

/** Wait until the page has produced its report and stays on the same document (no auto-reload pending). */
async function report(tab, { settle = 600, timeoutMs = 20000 } = {}) {
  return until(async () => {
    const ready = await evaluate(cdp, tab.s, `!!(window.__ljReport && window.__ljReport.done)`).catch(() => false);
    if (!ready) return null;
    const id1 = await evaluate(cdp, tab.s, `performance.timeOrigin`);
    await sleep(settle);
    const id2 = await evaluate(cdp, tab.s, `performance.timeOrigin`).catch(() => null);
    if (id1 !== id2) return null;
    return evaluate(cdp, tab.s, `JSON.parse(JSON.stringify(window.__ljReport))`);
  }, { message: 'page report', timeoutMs, intervalMs: 150 });
}

const hrefOf = (tab) => evaluate(cdp, tab.s, 'location.href').catch(() => '');

async function navigate(tab, url, how = 'typed', finalUrl = url) {
  if (how === 'typed') {
    await cdp.send('Page.navigate', { url, transitionType: 'typed' }, tab.s);
  } else {
    await cdp.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}`, userGesture: true }, tab.s);
  }
  await until(async () => (await hrefOf(tab)) === finalUrl || null, { message: `navigation to ${finalUrl}` }).catch(() => undefined);
  return report(tab);
}

const status = (tabId) => sw(`localeJacket.status(${tabId})`);
const globalStatus = () => sw(`localeJacket.global()`);
const logSince = async (t0) => (await sw('localeJacket.log()')).filter((l) => l.t >= t0);

/** Problems with one snapshot pair ({ start, live }) against an expected locale. */
function localeProblems(r, locale, { start = true } = {}) {
  const problems = [];
  const check = (where, snap) => {
    if (!snap) return problems.push(`${where}: missing`);
    for (const k of ['language', 'dateLocale', 'numberLocale', 'collatorLocale', 'pluralRulesLocale', 'relativeTimeLocale', 'listFormatLocale', 'segmenterLocale', 'displayNamesLocale']) {
      if (snap[k] !== undefined && snap[k] !== locale) problems.push(`${where}.${k}=${snap[k]}`);
    }
    if (snap.languages?.[0] !== locale) problems.push(`${where}.languages=${snap.languages}`);
  };
  if (start) check('start', r?.start);
  check('live', r?.live);
  return problems;
}

function expectLocale(r, locale, label, opts) {
  const problems = localeProblems(r, locale, opts);
  if (problems.length) throw new Error(`${label}: expected ${locale}: ${problems.join(', ')}`);
}

function expectHeader(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: Accept-Language ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

/** True when the tab's status admits the page may be wrong (late, conflict, partial, error). */
function admitsProblem(st) {
  return Boolean(st && (st.late || st.error || st.warnings?.length || st.session === 'conflict' || st.session === 'error'));
}

/** Known limitation: the page must be right, or the extension must say it is not. */
function expectRightOrReported(r, locale, st, label) {
  const problems = localeProblems(r, locale);
  if (!problems.length) return 'right';
  if (admitsProblem(st)) {
    note(`${label}: wrong (${problems.slice(0, 3).join(', ')}) but reported: ${st.lateReason ?? st.warnings?.join(' | ') ?? st.error}`);
    return 'reported';
  }
  throw new Error(`${label}: expected ${locale} or a reported problem: ${problems.join(', ')}; status ${JSON.stringify(st)}`);
}

const note = (msg) => console.log(`      (${msg})`);

/** Error-level log entries from the extension since t0, minus the ones a test expects. */
async function errorsSince(t0, allow = []) {
  return (await logSince(t0)).filter((l) => l.level === 'error' && !allow.some((re) => re.test(l.msg))).map((l) => `${l.tabId ?? '-'} ${l.msg}`);
}

async function run(kindOfCheck, name, fn) {
  if (only && !new RegExp(only).test(name)) return;
  for (let round = 1; round <= ROUNDS; round++) {
    const label = ROUNDS > 1 ? `${name} [${round}/${ROUNDS}]` : name;
    const t0 = Date.now();
    openedInTest = [];
    try {
      const outcome = await fn();
      results.push({ name: label, kind: kindOfCheck, ok: true, ms: Date.now() - t0, outcome });
      const known = outcome === 'reported' || outcome === 'documented';
      console.log(`  ${known ? '◇' : '✔'} ${label} (${Date.now() - t0} ms)${outcome === 'reported' ? ' — known limitation, reported by the extension' : outcome === 'documented' ? ' — documented gap' : ''}`);
    } catch (e) {
      results.push({ name: label, kind: kindOfCheck, ok: false, ms: Date.now() - t0, error: e.message });
      console.log(`  ✖ ${label}\n      ${e.message}`);
    } finally {
      // Tabs left open would share renderer processes with later tests.
      for (const targetId of openedInTest) await cdp?.send('Target.closeTarget', { targetId }).catch(() => undefined);
      openedInTest = [];
      await ensureWorker().catch((e) => console.log(`      (worker lost: ${e.message})`));
      await setSettings(baseSettings, { settle: 300 }).catch(() => undefined);
    }
  }
}
const test = (name, fn) => run('test', name, fn);
const probe = (name, fn) => run('probe', name, fn);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Click the popup's "Check what the page sees" for a tab and return its "Now" column
 * ({ 'navigator.language': …, 'Intl.DateTimeFormat': … }).
 */
async function popupCheck(tabId) {
  const popup = await openTab(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
  await until(() => evaluate(cdp, popup.s, `(() => { const b = [...document.querySelectorAll('#tabCard button')].find((x) => x.textContent === 'Check what the page sees'); b?.click(); return !!b; })()`), { message: 'check button' });
  const cells = () => evaluate(cdp, popup.s, `[...(document.querySelector('.verify table')?.rows ?? [])].map((r) => [...r.cells].map((c) => c.textContent))`);
  const rows = await until(async () => ((await cells()).length > 1 ? cells() : null), { message: 'verify table' });
  await closeTab(popup);
  return Object.fromEntries(rows.slice(1).map((r) => [r[0], r.at(-1)]));
}

/** Differences between the popup's check and what the page's own scripts see right now. */
async function checkDisagrees(tab) {
  const [shown, live] = [await popupCheck(tab.tabId), await evaluate(cdp, tab.s, '__ljSnapshot()')];
  const pairs = [['navigator.language', live.language], ['Intl.DateTimeFormat', live.dateLocale], ['Intl.NumberFormat', live.numberLocale], ['Intl.Collator', live.collatorLocale]];
  return pairs.filter(([k, v]) => shown[k] !== undefined && shown[k] !== v).map(([k, v]) => `${k}: popup says ${shown[k]}, page sees ${v}`);
}

/** Open a new target from inside a page (window.open) and adopt it. */
async function openFromPage(tab, url, features = '') {
  await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(url)}, '_blank', ${JSON.stringify(features)}); true`, userGesture: true }, tab.s);
  const target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === url), { message: `popup ${url}` });
  return adopt(target.targetId);
}

/** The worker handle can be lost (a test restarts the worker or the extension): find it again. */
async function ensureWorker() {
  const alive = await evaluate(cdp, swSession, 'typeof localeJacket !== "undefined"', { timeoutMs: 3000 }).catch(() => false);
  if (alive) return;
  try {
    await findWorker();
  } catch {
    ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: dist }));
    await findWorker();
  }
}

// ------------------------------------------------------------------- tests

srv = await startServer({ port: 0, quiet: true });
PORT = srv.port;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-stress-profile-'));
console.log(`Locale Jacket stress — ${kind}${headless ? ' (headless)' : ''}, server :${PORT}${ROUNDS > 1 ? `, ${ROUNDS} rounds` : ''}`);
const baseSettings = settingsFrom(CONFIG);

try {
  await startBrowser(profileDir);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const version = await cdp.send('Browser.getVersion');
  console.log(`  ${version.product}, extension ${extId}\n`);
  await setSettings(baseSettings);

  // ----------------------------------------------------------- concurrency

  await test('12 tabs opened at once across 5 profiles: each gets its own locale, no leaks', async () => {
    const plan = [
      ['google.localhost', 'en-US'], ['mail.google.localhost', 'en-US'], ['apple.localhost', 'ja-JP'],
      ['developer.apple.localhost', 'ja-JP'], ['login.microsoftonline.localhost', 'en-GB'], ['plain.localhost', NATIVE],
      ['frame-fr.localhost', 'fr-FR'], ['frame-de.localhost', 'de-DE'], ['other.localhost', NATIVE],
      ['frame-ja.localhost', 'ja-JP'], ['frame-gb.localhost', 'en-GB'], ['accounts.google.localhost', NATIVE],
    ];
    const t0 = Date.now();
    const tabs = await Promise.all(plan.map(([host], i) => openTab(u(host, `/plain.html?burst=${i}`))));
    const reports = await Promise.all(tabs.map((t) => report(t)));
    const bad = [];
    for (const [i, [host, locale]] of plan.entries()) {
      const p = localeProblems(reports[i], locale);
      if (p.length) bad.push(`${host} (want ${locale}): ${p.slice(0, 3).join(', ')}`);
      if (reports[i].documentAcceptLanguage !== HEADER[locale]) bad.push(`${host}: header ${reports[i].documentAcceptLanguage}`);
    }
    if (bad.length) throw new Error(bad.join('\n      '));
    const errs = await errorsSince(t0);
    if (errs.length) throw new Error(`extension errors: ${errs.join(' | ')}`);
    note(`all 12 correct in ${Date.now() - t0} ms`);
  });

  await test('ping-pong: one tab switches en-US ⇄ ja-JP 10 times; every document starts right', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?pp=0'));
    expectLocale(await report(tab), 'en-US', 'first');
    for (let i = 1; i <= 10; i++) {
      const [host, locale] = i % 2 ? ['apple.localhost', 'ja-JP'] : ['google.localhost', 'en-US'];
      const r = await navigate(tab, u(host, `/plain.html?pp=${i}`), i % 3 ? 'link' : 'typed');
      expectLocale(r, locale, `hop ${i} → ${host}`);
      expectHeader(r.documentAcceptLanguage, HEADER[locale], `hop ${i} document`);
    }
    const hist = await cdp.send('Page.getNavigationHistory', {}, tab.s);
    if (hist.entries.length !== 11) throw new Error(`history has ${hist.entries.length} entries, expected 11 (a re-issue added or lost one): ${hist.entries.map((e) => new URL(e.url).search.replace('?pp=', '')).join(' ')}`);
  });

  await test('navigation storm: 4 navigations fired without waiting; the last one wins with its own locale', async () => {
    const tab = await openTab(u('plain.localhost', '/plain.html'));
    await report(tab);
    const targets = [
      u('google.localhost', '/plain.html?storm=1&delay=400'),
      u('apple.localhost', '/plain.html?storm=2&delay=300'),
      u('docs.google.localhost', '/plain.html?storm=3&delay=200'),
      u('login.microsoftonline.localhost', '/plain.html?storm=4&delay=100'),
    ];
    const sends = targets.map((url) => cdp.send('Page.navigate', { url, transitionType: 'typed' }, tab.s).catch((e) => e));
    await Promise.all(sends);
    await until(async () => (await hrefOf(tab)) === targets[3] || null, { message: 'storm settles on the last URL', timeoutMs: 15000 });
    const r = await report(tab, { settle: 1000 });
    expectLocale(r, 'en-GB', 'after storm');
    expectHeader(r.documentAcceptLanguage, HEADER['en-GB'], 'storm document');
    const st = await status(tab.tabId);
    if (st.applied?.locale !== 'en-GB') throw new Error(`status applied ${JSON.stringify(st.applied)}`);
  });

  await test('tab closed while the extension is attaching (10×, slow server): no leaked sessions or errors', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      const { targetId } = await cdp.send('Target.createTarget', { url: u(i % 2 ? 'apple.localhost' : 'google.localhost', `/plain.html?close=${i}&delay=1500`) });
      await sleep([0, 20, 60, 150, 400][i % 5]);
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    await sleep(2500); // let the delayed responses and the cleanup finish
    const open = await sw(`chrome.tabs.query({}).then((ts) => ts.map((t) => t.id))`);
    const tracked = (await sw('localeJacket.statuses()')).map((s) => s.tabId);
    const stale = tracked.filter((id) => !open.includes(id));
    if (stale.length) {
      const st = (await sw('localeJacket.statuses()')).filter((s) => stale.includes(s.tabId)).map((s) => `${s.tabId}:${s.session}/${s.host}`);
      throw new Error(`${stale.length} of 10 closed tabs are still tracked: ${st.join(', ')}`);
    }
    const attached = (await sw('chrome.debugger.getTargets()')).filter((t) => t.attached && t.tabId && !open.includes(t.tabId));
    if (attached.length) throw new Error(`debugger still attached to closed tabs: ${JSON.stringify(attached)}`);
    const errs = await errorsSince(t0, [/No tab with given id|Cannot access|tab was closed|No target with given id|Detached/i]);
    if (errs.length) throw new Error(`extension errors: ${errs.join(' | ')}`);
    const t = await openTab(u('google.localhost', '/plain.html?after-close-storm=1'));
    expectLocale(await report(t), 'en-US', 'next tab after the close storm');
  });

  // ---------------------------------------------------------- navigation

  await test('redirect chain across 3 profiles ends in the last site’s locale and header', async () => {
    const final = u('apple.localhost', '/plain.html?chain=1');
    const hop2 = u('login.microsoftonline.localhost', `/redirect?to=${encodeURIComponent(final)}`);
    const hop1 = u('docs.google.localhost', `/redirect?to=${encodeURIComponent(hop2)}`);
    const start = u('google.localhost', `/redirect?to=${encodeURIComponent(hop1)}`);
    const tab = await openTab(u('plain.localhost', '/plain.html'));
    await report(tab);
    srv.clearLog?.();
    const r = await navigate(tab, start, 'link', final);
    expectLocale(r, 'ja-JP', 'end of chain');
    expectHeader(r.documentAcceptLanguage, HEADER['ja-JP'], 'final document');
    // Each hop carried its own site's header.
    const hops = srv.log.filter((l) => l.path === '/redirect' && l.time >= Date.now() - 20000);
    for (const [host, locale] of [['docs.google.localhost', 'fr-FR'], ['login.microsoftonline.localhost', 'en-GB']]) {
      const h = hops.filter((l) => l.host === host).at(-1);
      if (h && h.acceptLanguage !== HEADER[locale]) note(`hop ${host} carried ${h.acceptLanguage} (redirect hops go out before the gate can re-apply)`);
    }
    const r2 = await navigate(tab, u('google.localhost', `/redirect?to=${encodeURIComponent(u('plain.localhost', '/plain.html?chain=2'))}`), 'link', u('plain.localhost', '/plain.html?chain=2'));
    expectLocale(r2, NATIVE, 'spoofed redirect into an unmatched site');
    expectHeader(r2.documentAcceptLanguage, HEADER[NATIVE], 'unmatched final document');
  });

  await test('hash, pushState and replaceState stay in the document: no reload, no re-attach', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?spa=1'));
    const r = await report(tab);
    expectLocale(r, 'en-US', 'before');
    const origin = await evaluate(cdp, tab.s, 'performance.timeOrigin');
    const before = await status(tab.tabId);
    await evaluate(cdp, tab.s, `location.hash = 'a'; history.pushState({}, '', '/spa/route'); history.replaceState({}, '', '/spa/other?x=1'); location.hash = 'b'; true`);
    await sleep(800);
    if ((await evaluate(cdp, tab.s, 'performance.timeOrigin')) !== origin) throw new Error('the document was reloaded');
    const live = await evaluate(cdp, tab.s, '__ljSnapshot()');
    expectLocale({ live }, 'en-US', 'after same-document navigations', { start: false });
    const after = await status(tab.tabId);
    if (after.session !== 'attached' || after.autoReloaded !== before.autoReloaded) throw new Error(`status changed: ${JSON.stringify(after)}`);
  });

  await test('204 No Content, a network error page and a 404 in between do not break the next navigation', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?edge=1'));
    expectLocale(await report(tab), 'en-US', 'start');
    await cdp.send('Page.navigate', { url: u('apple.localhost', '/no-content') }, tab.s).catch(() => undefined);
    await sleep(600);
    if (!(await hrefOf(tab)).includes('google.localhost')) throw new Error('a 204 should leave the page in place');
    const wrong = localeProblems({ live: await evaluate(cdp, tab.s, '__ljSnapshot()') }, 'en-US', { start: false });
    if (wrong.length) {
      const st = await status(tab.tabId);
      const disagree = await checkDisagrees(tab);
      throw new Error(`page after the 204 should still be en-US: ${wrong.slice(0, 3).join(', ')}; status says ${st.applied?.locale}${st.late || st.warnings.length ? ' (with a warning)' : ' with no warning'}${disagree.length ? `; the popup's check disagrees with the page: ${disagree.join('; ')}` : ''}`);
    }
    const disagree = await checkDisagrees(tab);
    if (disagree.length) throw new Error(`after the 204 the popup's check disagrees with the page: ${disagree.join('; ')}`);
    await cdp.send('Page.navigate', { url: 'http://unreachable.apple.localhost:1/' }, tab.s).catch(() => undefined);
    await sleep(1500);
    await cdp.send('Page.navigate', { url: u('docs.google.localhost', '/missing-page') }, tab.s).catch(() => undefined);
    await sleep(800);
    const r = await navigate(tab, u('apple.localhost', '/plain.html?after-errors=1'));
    expectLocale(r, 'ja-JP', 'after the error pages');
    expectHeader(r.documentAcceptLanguage, HEADER['ja-JP'], 'document after the error pages');
  });

  await test('restricted page in the middle: spoofed → chrome://version → another spoofed site', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?r=1'));
    expectLocale(await report(tab), 'en-US', 'before');
    await cdp.send('Page.navigate', { url: 'chrome://version/' }, tab.s);
    await sleep(800);
    const st = await status(tab.tabId);
    if (st?.session === 'attached' && st.host === 'version') throw new Error('attached on chrome://version');
    const r = await navigate(tab, u('apple.localhost', '/plain.html?r=2'));
    // Leaving a restricted page is like leaving the New Tab Page: late, then reloaded once.
    expectLocale(r, 'ja-JP', 'after chrome://version');
  });

  // ------------------------------------------------------- popups, frames

  await test('window.open to a different site (with and without noopener) gets that site’s locale', async () => {
    const opener = await openTab(u('google.localhost', '/plain.html?opener=1'));
    expectLocale(await report(opener), 'en-US', 'opener');
    const popup = await openFromPage(opener, u('apple.localhost', '/plain.html?popup=1'));
    expectLocale(await report(popup), 'ja-JP', 'cross-site popup');
    expectLocale({ live: await evaluate(cdp, opener.s, '__ljSnapshot()') }, 'en-US', 'opener after the popup', { start: false });
    const noopener = await openFromPage(opener, u('login.microsoftonline.localhost', '/plain.html?popup=2'), 'noopener');
    expectLocale(await report(noopener), 'en-GB', 'noopener popup');
  });

  await probe('same-site popup with another profile (OAuth window) shares the renderer: right or reported', async () => {
    const opener = await openTab(u('mail.google.localhost', '/plain.html?oauth=1'));
    expectLocale(await report(opener), 'en-US', 'opener');
    // docs.google.localhost is fr-FR but same-site with the opener, so it shares its process.
    const popup = await openFromPage(opener, u('docs.google.localhost', '/plain.html?oauth=2'), 'popup,width=400,height=400');
    const r = await report(popup);
    await sleep(500);
    return expectRightOrReported(r, 'fr-FR', await status(popup.tabId), 'fr-FR popup in an en-US process');
  });

  await probe('same-site popup to a SYSTEM site (accounts.google) inside a spoofed process: right or reported', async () => {
    const opener = await openTab(u('mail.google.localhost', '/plain.html?oauth=3'));
    await report(opener);
    const popup = await openFromPage(opener, u('accounts.google.localhost', '/plain.html?oauth=4'), 'popup,width=400,height=400');
    const r = await report(popup);
    await sleep(500);
    const st = await status(popup.tabId);
    const problems = localeProblems(r, NATIVE);
    if (!problems.length) return 'right';
    // A SYSTEM tab has no overrides of its own; the opener's process-wide Intl locale leaks in.
    // navigator.language and the header must still be native, since those are per tab.
    if (r.live.language !== NATIVE) throw new Error(`navigator.language leaked: ${r.live.language}`);
    expectHeader(r.documentAcceptLanguage, HEADER[NATIVE], 'SYSTEM popup document');
    if (!admitsProblem(st)) throw new Error(`Intl leaks from the shared process and the tab does not report it (the popup's check shows it only as raw values: ${JSON.stringify(await popupCheck(popup.tabId))}): ${problems.slice(0, 4).join(', ')}; status ${JSON.stringify({ session: st?.session, warnings: st?.warnings })}`);
    note(`Intl leaks from the shared process, reported: ${st.warnings.join(' | ')}`);
    return 'reported';
  });

  await test('per-frame mode with 5 cross-site frames (4 profiles + 1 unmatched) inside an en-US page', async () => {
    await setSettings(settingsFrom(CONFIG, { options: { frameMode: 'per-frame' } }));
    const frames = ['frame-fr.localhost', 'frame-de.localhost', 'frame-ja.localhost', 'frame-gb.localhost', 'unmatched-frame.localhost'];
    const tab = await openTab(u('google.localhost', `/?worker=0&frames=${frames.join(',')}`));
    const r = await report(tab, { settle: 900 });
    expectLocale(r, 'en-US', 'parent');
    const want = { 'frame-fr.localhost': 'fr-FR', 'frame-de.localhost': 'de-DE', 'frame-ja.localhost': 'ja-JP', 'frame-gb.localhost': 'en-GB' };
    const bad = [];
    for (const f of r.frames) {
      if (f.error) { bad.push(`${f.host}: ${f.error}`); continue; }
      const locale = want[f.host];
      if (!locale) { note(`unmatched frame: ${f.live.language} / ${f.live.dateLocale}, header ${f.documentAcceptLanguage}`); continue; }
      if (f.live.language !== locale || f.live.dateLocale !== locale) bad.push(`${f.host}: live ${f.live.language}/${f.live.dateLocale}, want ${locale}`);
    }
    if (bad.length) throw new Error(bad.join('; '));
    const st = await status(tab.tabId);
    note(`frames tracked: ${st.frames}, warnings: ${st.warnings.join(' | ') || 'none'}`);
  });

  await test('same-process contexts follow the page: srcdoc, about:blank and blob: frames; blob:, data: and nested workers', async () => {
    const tab = await openTab(u('apple.localhost', '/plain.html?ctx=1'));
    expectLocale(await report(tab), 'ja-JP', 'page');
    const out = await evaluate(cdp, tab.s, `(async () => {
      const snap = (w) => ({ language: w.navigator.language, languages: [...w.navigator.languages], dateLocale: new w.Intl.DateTimeFormat().resolvedOptions().locale, numberLocale: new w.Intl.NumberFormat().resolvedOptions().locale });
      const out = {};
      const srcdoc = document.createElement('iframe');
      srcdoc.srcdoc = '<p>srcdoc</p>';
      const loaded = new Promise((r) => (srcdoc.onload = r));
      document.body.appendChild(srcdoc);
      await loaded;
      out.srcdoc = snap(srcdoc.contentWindow);
      const blank = document.createElement('iframe');
      document.body.appendChild(blank);
      out.aboutBlank = snap(blank.contentWindow);
      const blobFrame = document.createElement('iframe');
      blobFrame.src = URL.createObjectURL(new Blob(['<p>blob frame</p>'], { type: 'text/html' }));
      await new Promise((r) => { blobFrame.onload = r; document.body.appendChild(blobFrame); });
      out.blobFrame = snap(blobFrame.contentWindow);
      const body = 'postMessage({ language: navigator.language, languages: [...navigator.languages], dateLocale: Intl.DateTimeFormat().resolvedOptions().locale, numberLocale: Intl.NumberFormat().resolvedOptions().locale })';
      const fromWorker = (w) => new Promise((r) => { w.onmessage = (e) => { r(e.data); w.terminate(); }; w.onerror = (e) => r({ error: e.message || 'worker error' }); setTimeout(() => r({ error: 'timeout' }), 5000); });
      out.blobWorker = await fromWorker(new Worker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))));
      out.dataWorker = await fromWorker(new Worker('data:text/javascript,' + encodeURIComponent(body)));
      const outer = 'const inner = new Worker(URL.createObjectURL(new Blob([' + JSON.stringify(body) + '], { type: "text/javascript" }))); inner.onmessage = (e) => postMessage(e.data);';
      out.nestedWorker = await fromWorker(new Worker(URL.createObjectURL(new Blob([outer], { type: 'text/javascript' }))));
      return out;
    })()`);
    const bad = [];
    for (const [where, s] of Object.entries(out)) {
      if (s.error) { bad.push(`${where}: ${s.error}`); continue; }
      for (const k of ['language', 'dateLocale', 'numberLocale']) if (s[k] !== 'ja-JP') bad.push(`${where}.${k}=${s[k]}`);
      if (s.languages?.[0] !== 'ja-JP') bad.push(`${where}.languages=${s.languages}`);
    }
    if (bad.length) throw new Error(bad.join(', '));
  });

  await probe('service worker and shared worker of a spoofed page (documented gap: not overridden)', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?sw=1'));
    expectLocale(await report(tab), 'en-US', 'page');
    const out = await evaluate(cdp, tab.s, `(async () => {
      const out = {};
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const w = reg.active || navigator.serviceWorker.controller;
        out.serviceWorker = await new Promise((r) => {
          navigator.serviceWorker.addEventListener('message', (e) => e.data && e.data.type === 'lj-sw' && r(e.data.snapshot));
          w.postMessage('snap');
          setTimeout(() => r({ error: 'timeout' }), 5000);
        });
        await reg.unregister();
      } catch (e) { out.serviceWorker = { error: e.message }; }
      try {
        const src = 'onconnect = (e) => e.ports[0].postMessage({ language: navigator.language, dateLocale: Intl.DateTimeFormat().resolvedOptions().locale })';
        const sw = new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        out.sharedWorker = await new Promise((r) => { sw.port.onmessage = (e) => r(e.data); sw.port.start(); setTimeout(() => r({ error: 'timeout' }), 5000); });
      } catch (e) { out.sharedWorker = { error: e.message }; }
      return out;
    })()`);
    note(`service worker: ${out.serviceWorker?.language ?? out.serviceWorker?.error} / ${out.serviceWorker?.dateLocale ?? '-'}; shared worker: ${out.sharedWorker?.language ?? out.sharedWorker?.error} / ${out.sharedWorker?.dateLocale ?? '-'}`);
    const right = out.serviceWorker?.language === 'en-US' && out.sharedWorker?.language === 'en-US';
    // The page itself must be unaffected by registering them.
    expectLocale({ live: await evaluate(cdp, tab.s, '__ljSnapshot()') }, 'en-US', 'page after the workers', { start: false });
    return right ? 'right' : 'documented';
  });

  await probe('same-origin prerender activation keeps the profile (documented: flagged if late)', async () => {
    const tab = await openTab(u('google.localhost', `/prerender.html?target=${encodeURIComponent('/plain.html?prerendered=1')}`));
    await until(() => evaluate(cdp, tab.s, 'document.readyState === "complete"'), { message: 'launcher loaded' });
    await sleep(1500); // give the speculation rules time to prerender
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('target').click(); true`, userGesture: true }, tab.s);
    await until(async () => (await hrefOf(tab)).includes('prerendered=1') || null, { message: 'activation' });
    const r = await report(tab);
    const activated = await evaluate(cdp, tab.s, `performance.getEntriesByType('navigation')[0]?.activationStart > 0`).catch(() => false);
    note(activated ? 'page was prerendered and activated' : 'page was not prerendered (loaded normally)');
    return expectRightOrReported(r, 'en-US', await status(tab.tabId), 'prerendered page');
  });

  // --------------------------------------------------- crashes and restarts

  await test('renderer crash: the reloaded page in the new process is spoofed again', async () => {
    const tab = await openTab(u('apple.localhost', '/plain.html?crash=1'));
    expectLocale(await report(tab), 'ja-JP', 'before the crash');
    cdp.send('Page.crash', {}, tab.s).catch(() => undefined);
    await sleep(1500);
    // Like the sad tab's Reload button: a new renderer process for the same URL.
    await cdp.send('Page.navigate', { url: u('apple.localhost', '/plain.html?crash=1'), transitionType: 'reload' }, tab.s).catch(() => undefined);
    await sleep(300);
    const r = await report(tab);
    expectLocale(r, 'ja-JP', 'after the crash');
    const st = await status(tab.tabId);
    if (st.session !== 'attached') throw new Error(`status after the crash: ${st.session}`);
  });

  await test('service worker stopped and woken: open tabs stay spoofed, new tabs and reloads still work', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?wake=1'));
    expectLocale(await report(tab), 'en-US', 'before');
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
    let stopped = await cdp.send('Target.closeTarget', { targetId: target.targetId }).then((r) => r.success !== false, () => false);
    if (!stopped) {
      await cdp.send('ServiceWorker.enable', {}, tab.s);
      stopped = await cdp.send('ServiceWorker.stopAllWorkers', {}, tab.s).then(() => true, () => false);
    }
    if (!stopped) throw new Error('could not stop the extension service worker through CDP');
    await until(async () => !(await cdp.send('Target.getTargets')).targetInfos.some((t) => t.targetId === target.targetId) || null, { message: 'worker stopped', timeoutMs: 8000 }).catch(() => note('worker target still listed after the stop request'));
    // Wake it with a navigation, as a real user would.
    const t2 = await openTab(u('apple.localhost', '/plain.html?wake=2'));
    await findWorker();
    expectLocale(await report(t2), 'ja-JP', 'new tab that woke the worker');
    await cdp.send('Page.reload', {}, tab.s);
    await sleep(300);
    expectLocale(await report(tab), 'en-US', 'reload of a tab from before the stop');
    const r = await navigate(tab, u('login.microsoftonline.localhost', '/plain.html?wake=3'), 'link');
    expectLocale(r, 'en-GB', 'profile switch after the wake');
  });

  await test('extension reloaded (update) with spoofed tabs open: sessions come back, no leftovers', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?reload-ext=1'));
    expectLocale(await report(tab), 'en-US', 'before');
    // Installing the same unpacked folder again is what the reload button and an update do.
    // (chrome.runtime.reload() does not bring back an extension loaded over CDP.)
    const before = extId;
    ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: dist }));
    if (extId !== before) throw new Error(`extension id changed: ${before} → ${extId}`);
    await sleep(1000);
    await findWorker();
    const log = (await sw('localeJacket.log()')).map((l) => l.msg);
    note(`after the reload: ${log.slice(0, 3).join(' | ')}`);
    const stored = await sw(`chrome.storage.local.get('settings').then((r) => r.settings.rules.length)`);
    if (stored !== baseSettings.rules.length) throw new Error(`settings lost on reload: ${stored} rules`);
    await cdp.send('Page.reload', {}, tab.s);
    await sleep(300);
    expectLocale(await report(tab), 'en-US', 'reload after the extension reload');
    const t2 = await openTab(u('apple.localhost', '/plain.html?reload-ext=2'));
    expectLocale(await report(t2), 'ja-JP', 'new tab after the extension reload');
    const dnr = await sw('chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length)');
    if (!dnr) throw new Error('no DNR header rules after the reload');
  });

  // ----------------------------------------------------- settings churn

  await test('rule edited while the tab is open: applied at once, page right after a reload', async () => {
    const tab = await openTab(u('google.localhost', '/plain.html?edit=1'));
    expectLocale(await report(tab), 'en-US', 'before');
    await setSettings(settingsFrom(CONFIG.replace('DOMAIN-SUFFIX,google.localhost,en-US', 'DOMAIN-SUFFIX,google.localhost,de-DE')), { settle: 800 });
    const st = await status(tab.tabId);
    if (st.applied?.locale !== 'de-DE') throw new Error(`status still applies ${st.applied?.locale}`);
    await cdp.send('Page.reload', {}, tab.s);
    await sleep(300);
    const r = await report(tab);
    expectLocale(r, 'de-DE', 'after the edit');
    expectHeader(r.documentAcceptLanguage, HEADER['de-DE'], 'document after the edit');
  });

  await test('enable/disable toggled 12 times without waiting: final state is consistent', async () => {
    const tabs = await Promise.all([openTab(u('google.localhost', '/plain.html?toggle=1')), openTab(u('apple.localhost', '/plain.html?toggle=2'))]);
    await Promise.all(tabs.map((t) => report(t)));
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      sw(`chrome.storage.local.set({ settings: ${JSON.stringify({ ...baseSettings, enabled: i % 2 === 1 })} }).then(() => true)`).catch(() => undefined);
      await sleep(i % 3 === 0 ? 0 : 30);
    }
    // The last write was enabled: true. Then end disabled and check every session is gone.
    await sleep(1500);
    await setSettings({ ...baseSettings, enabled: false }, { settle: 1500 });
    const g = await globalStatus();
    if (g.attachedTabs !== 0) throw new Error(`${g.attachedTabs} sessions still attached after disabling`);
    // (chrome.debugger.getTargets() can't tell: its `attached` also counts this test's own CDP client.)
    const tracked = (await sw('localeJacket.statuses()')).filter((s) => s.session === 'attached' || s.applied);
    if (tracked.length) throw new Error(`tabs still spoofed while disabled: ${tracked.map((s) => `${s.tabId}:${s.session}`).join(', ')}`);
    if ((await sw('chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length)')) !== 0) throw new Error('DNR rules left while disabled');
    await cdp.send('Page.reload', {}, tabs[0].s);
    await sleep(300);
    expectLocale(await report(tabs[0]), NATIVE, 'disabled');
    await setSettings(baseSettings, { settle: 800 });
    await cdp.send('Page.reload', {}, tabs[1].s);
    await sleep(300);
    expectLocale(await report(tabs[1]), 'ja-JP', 're-enabled');
    const errs = await errorsSince(t0, [/canceled|detached|Detached/i]);
    if (errs.length) throw new Error(`extension errors: ${errs.join(' | ')}`);
  });

  // ------------------------------------------------- scale and hostile input

  await test('5,000 rules (incl. 500 regex): the deepest rule matches and navigations stay fast', async () => {
    const tab = await openTab(u('plain.localhost', '/plain.html?scale=0'));
    await report(tab);
    const timeNav = async (host, i) => {
      const t0 = Date.now();
      await navigate(tab, u(host, `/plain.html?scale=${i}`), 'link');
      return Date.now() - t0;
    };
    const small = [];
    for (let i = 1; i <= 5; i++) small.push(await timeNav(i % 2 ? 'google.localhost' : 'apple.localhost', i));
    const locales = ['en-US', 'ja-JP', 'fr-FR', 'de-DE', 'en-GB'];
    const lines = [];
    for (let i = 0; i < 4500; i++) lines.push(`  - DOMAIN-SUFFIX,site${i}.localhost,${locales[i % 5]}`);
    for (let i = 0; i < 500; i++) lines.push(`  - DOMAIN-REGEX,^r${i}-[a-z0-9]+\\.rx\\.localhost$,${locales[(i + 2) % 5]}`);
    const big = settingsFrom(CONFIG.replace('rules:\n', `rules:\n${lines.join('\n')}\n`));
    if (big.rules.length < 5000) throw new Error(`import kept only ${big.rules.length} rules`);
    const t0 = Date.now();
    await setSettings(big, { settle: 1500 });
    const g = await globalStatus();
    if (g.settingsProblems.length) note(`settings problems: ${g.settingsProblems.slice(0, 3).join(' | ')}`);
    const large = [];
    for (let i = 6; i <= 10; i++) large.push(await timeNav(i % 2 ? 'google.localhost' : 'apple.localhost', i));
    expectLocale(await navigate(tab, u('www.site4499.localhost', '/plain.html?deep=1'), 'link'), locales[4499 % 5], 'deepest DOMAIN-SUFFIX rule');
    expectLocale(await navigate(tab, u('r499-abc.rx.localhost', '/plain.html?deep=2'), 'link'), locales[(499 + 2) % 5], 'last regex rule');
    expectLocale(await navigate(tab, u('nomatch.localhost', '/plain.html?deep=3'), 'link'), NATIVE, 'no rule among 5,000');
    note(`median navigation: ${median(small)} ms with ${baseSettings.rules.length} rules, ${median(large)} ms with ${big.rules.length}; settings applied in ${Date.now() - t0} ms`);
    if (median(large) > median(small) + 500) throw new Error(`navigations got ${median(large) - median(small)} ms slower with 5,000 rules`);
    const errs = await errorsSince(t0);
    if (errs.length) throw new Error(`extension errors: ${errs.join(' | ')}`);
  });

  await test('hostile stored regex rules are refused, listed as problems, and never stall navigation', async () => {
    const base = settingsFrom(CONFIG.replace('default:', '  - DOMAIN-REGEX,^ok\\.rx\\.localhost$,fr-FR\ndefault:'));
    const template = base.rules.find((r) => r.type === 'DOMAIN-REGEX');
    const hostile = [
      '^(a+)+\\.evil\\.localhost$',
      '^([a-z]+)*-x\\.localhost$',
      '^(a|aa)+$',
      '^(.*a){12}$',
      '^((a|b)*c?)*d\\.localhost$',
      '(\\w+\\.)+\\w+\\1',
      '^(?:(?:(?:(?:(?:(?:a*)*)*)*)*)*)*$',
      '(?<=a+)b',
    ];
    // Written straight into storage, as an old version or a hand-edited backup could.
    const rules = [...base.rules, ...hostile.map((value, i) => ({ ...template, id: `hostile-${i}`, value, profile: { ...template.profile, locale: 'de-DE' } }))];
    const t0 = Date.now();
    await setSettings({ ...base, rules }, { settle: 1200 });
    const g = await globalStatus();
    // Problems name the rule by position ("Stored rule #12 …"), not by its pattern.
    const listed = g.settingsProblems.filter((p) => /regular expression/i.test(p) && /stored rule/i.test(p));
    note(`${listed.length}/${hostile.length} hostile patterns listed as settings problems`);
    const tab = await openTab(u('plain.localhost', '/plain.html?hostile=0'));
    await report(tab);
    // Hostnames built to make those patterns backtrack, if they ever ran.
    const evil = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil.localhost', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-y.localhost', `${'ab'.repeat(30)}e.localhost`];
    for (const [i, host] of evil.entries()) {
      const t1 = Date.now();
      const r = await navigate(tab, u(host, `/plain.html?hostile=${i + 1}`), 'link');
      const ms = Date.now() - t1;
      expectLocale(r, NATIVE, `${host} (no hostile rule may match)`);
      if (ms > 4000) throw new Error(`navigation to ${host} took ${ms} ms`);
    }
    expectLocale(await navigate(tab, u('ok.rx.localhost', '/plain.html?hostile=ok'), 'link'), 'fr-FR', 'the safe regex next to them still works');
    const worker = await sw('(() => { const t = performance.now(); for (let i = 0; i < 1e5; i++); return performance.now() - t; })()');
    if (worker > 200) throw new Error(`worker busy: a trivial loop took ${worker} ms`);
    if (listed.length < hostile.length - 1) throw new Error(`only ${listed.length} of ${hostile.length} refused patterns are shown as problems`);
    const errs = await errorsSince(t0);
    if (errs.length) throw new Error(`extension errors: ${errs.join(' | ')}`);
  });

  await test('Accept-Language on every request type of a spoofed page: fetch, XHR, image, script, sendBeacon, frame', async () => {
    const tab = await openTab(u('apple.localhost', '/plain.html?req=1'));
    expectLocale(await report(tab), 'ja-JP', 'page');
    srv.clearLog?.();
    const t0 = Date.now();
    const got = await evaluate(cdp, tab.s, `(async () => {
      const out = {};
      out.fetch = (await (await fetch('/api/headers?k=fetch', { cache: 'no-store' })).json()).acceptLanguage;
      out.crossFetch = (await (await fetch(${JSON.stringify(u('other.localhost', '/api/headers?k=cors'))}, { cache: 'no-store' })).json()).acceptLanguage;
      out.xhr = await new Promise((r) => { const x = new XMLHttpRequest(); x.open('GET', '/api/headers?k=xhr'); x.onload = () => r(JSON.parse(x.responseText).acceptLanguage); x.onerror = () => r('ERR'); x.send(); });
      await new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = '/plain.html?k=img'; });
      await new Promise((r) => { const s = document.createElement('script'); s.onload = s.onerror = r; s.src = '/snapshot.js?k=script'; document.head.appendChild(s); });
      navigator.sendBeacon('/api/beacon', JSON.stringify({ k: 'beacon' }));
      await new Promise((r) => { const f = document.createElement('iframe'); f.onload = r; f.src = '/plain.html?k=frame'; document.body.appendChild(f); });
      return out;
    })()`);
    for (const [k, v] of Object.entries(got)) expectHeader(v, HEADER['ja-JP'], k);
    // Image and frame requests to an HTML route are logged by the server.
    const logged = srv.log.filter((l) => l.time >= t0 && l.host === 'apple.localhost' && /k=(img|frame)/.test(l.search));
    if (logged.length < 2) note(`server logged ${logged.length} of the image/frame requests`);
    for (const l of logged) expectHeader(l.acceptLanguage, HEADER['ja-JP'], `${l.dest} request ${l.search}`);
  });

  // --------------------------------------------------------------- restart

  await test('browser restart with 3 spoofed tabs restored: every restored page ends right', async () => {
    // Keep three tabs open so the profile restores them.
    const plan = [['google.localhost', 'en-US'], ['apple.localhost', 'ja-JP'], ['login.microsoftonline.localhost', 'en-GB']];
    for (const [host] of plan) {
      const { targetId } = await cdp.send('Target.createTarget', { url: u(host, '/plain.html?restore=1') });
      const s = await attach(cdp, targetId);
      await until(() => evaluate(cdp, s, `!!(window.__ljReport && window.__ljReport.done)`), { message: `${host} loaded` });
    }
    await sw(`chrome.storage.local.get('settings').then((r) => r.settings)`);
    await browser.close();
    browser = await launch({ executable: findBrowser(kind), headless, userDataDir: profileDir, keepProfile: true, extraArgs: ['--lang=zh-CN', '--accept-lang=zh-CN,zh', '--restore-last-session'], urls: [] });
    cdp = browser.cdp;
    ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: dist }));
    await findWorker();
    await sleep(1500);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const restored = targetInfos.filter((t) => t.type === 'page' && t.url.includes('restore=1'));
    if (restored.length < plan.length) {
      note(`only ${restored.length} tab(s) restored (headless may not restore sessions); opening them instead`);
      for (const [host, locale] of plan) expectLocale(await report(await openTab(u(host, '/plain.html?restore=2'))), locale, `${host} after restart`);
      return;
    }
    for (const t of restored) {
      const tab = await adopt(t.targetId);
      const r = await report(tab, { timeoutMs: 25000 });
      const want = plan.find(([h]) => r.host === h)?.[1];
      const st = await status(tab.tabId);
      expectRightOrReported(r, want, st, `restored ${r.host}`);
    }
  });
} catch (e) {
  console.error('\nHarness failure:', e);
  results.push({ name: 'harness', kind: 'test', ok: false, error: e.message });
} finally {
  if (browser) {
    if (process.env.LJ_E2E_LOG) {
      try {
        console.log((await sw('localeJacket.log()')).map((l) => `${l.tabId ?? '-'} ${l.level} ${l.msg}`).join('\n'));
      } catch {
        /* ignore */
      }
    }
    await browser.close();
  }
  await srv.close();
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const failed = results.filter((r) => !r.ok);
const reported = results.filter((r) => r.ok && (r.outcome === 'reported' || r.outcome === 'documented'));
console.log(`\n${results.length - failed.length}/${results.length} passed (${kind})${reported.length ? `, ${reported.length} known limitation(s) seen and reported` : ''}`);
if (failed.length) console.log(`Failed:\n${failed.map((f) => `  - ${f.name}`).join('\n')}`);
process.exit(failed.length ? 1 : 0);
