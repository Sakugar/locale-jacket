#!/usr/bin/env node
// End-to-end tests: load dist/ into a real Chrome (or Edge) and check what
// websites observe, using the verification server on *.localhost hostnames.
//
//   node e2e/run.mjs [--edge] [--headful] [--only <substring>]
//
// The browser runs with --lang=zh-CN so the "real" locale is Simplified Chinese.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attach, evaluate, findBrowser, launch, sleep, until } from './lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const kind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const headless = !process.argv.includes('--headful');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;

const { importConfigText } = await import(pathToFileURL(path.join(dist, 'shared', 'config-io.js')).href);

const NATIVE = 'zh-CN';
const CONFIG = `
rules:
  - DOMAIN-SUFFIX,google.localhost,en-US
  - DOMAIN,accounts.google.localhost,SYSTEM
  - DOMAIN-SUFFIX,apple.localhost,ja-JP
  - DOMAIN-KEYWORD,microsoft,en-GB
default:
  mode: SYSTEM
`;

function settingsFrom(yaml, patch = {}) {
  const r = importConfigText(yaml);
  if (!r.settings) throw new Error(`bad test config: ${r.errors.join('; ')}`);
  // Tests match English UI text; the Chinese UI has its own test.
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

async function startBrowser(userDataDir, extensionDir = dist) {
  browser = await launch({ executable: findBrowser(kind), headless, userDataDir, keepProfile: Boolean(userDataDir), extraArgs: ['--lang=zh-CN', '--accept-lang=zh-CN,zh'] });
  cdp = browser.cdp;
  ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir }));
  const sw = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
  }, { message: 'extension service worker', timeoutMs: 20000 });
  swSession = await attach(cdp, sw.targetId);
  await until(() => evaluate(cdp, swSession, `typeof localeJacket !== 'undefined' && localeJacket.ready()`), { message: 'worker ready' });
}

const sw = (expr) => evaluate(cdp, swSession, expr);

async function setSettings(settings) {
  await sw(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);
  await sleep(400); // storage.onChanged → updateSettings
}

async function tabIdOf(targetId) {
  return until(async () => (await sw(`chrome.debugger.getTargets()`)).find((t) => t.id === targetId)?.tabId, { message: 'tab id' });
}

let openedInTest = [];
async function openTab(url, { keep = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  if (!keep) openedInTest.push(targetId);
  const s = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, s);
  const tabId = await tabIdOf(targetId);
  return { targetId, s, tabId };
}

async function closeTab(tab) {
  if (!tab) return;
  await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
}

/** Wait until the page has produced its report (and stays on the same document long enough to rule out an auto-reload). */
async function report(tab, { settle = 600 } = {}) {
  return until(async () => {
    const ready = await evaluate(cdp, tab.s, `!!(window.__ljReport && window.__ljReport.done)`).catch(() => false);
    if (!ready) return null;
    const id1 = await evaluate(cdp, tab.s, `performance.timeOrigin`);
    await sleep(settle);
    const id2 = await evaluate(cdp, tab.s, `performance.timeOrigin`).catch(() => null);
    if (id1 !== id2) return null;
    return evaluate(cdp, tab.s, `JSON.parse(JSON.stringify(window.__ljReport))`);
  }, { message: 'page report', timeoutMs: 20000, intervalMs: 150 });
}

async function navigate(tab, url, how = 'typed', finalUrl = url) {
  if (how === 'typed') {
    await cdp.send('Page.navigate', { url, transitionType: 'typed' }, tab.s);
  } else {
    await cdp.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}`, userGesture: true }, tab.s);
  }
  await until(async () => (await evaluate(cdp, tab.s, 'location.href').catch(() => '')) === finalUrl || null, { message: `navigation to ${url}` }).catch(() => undefined);
  return report(tab);
}

const status = (tabId) => sw(`localeJacket.status(${tabId})`);
const globalStatus = () => sw(`localeJacket.global()`);

function expectLocale(r, locale, label) {
  const problems = [];
  const check = (where, snap) => {
    if (!snap) return problems.push(`${where}: missing`);
    if (snap.language !== locale) problems.push(`${where}.language=${snap.language}`);
    if (snap.dateLocale !== locale) problems.push(`${where}.Intl.DateTimeFormat=${snap.dateLocale}`);
    if (snap.numberLocale !== locale) problems.push(`${where}.Intl.NumberFormat=${snap.numberLocale}`);
    if (snap.collatorLocale !== locale) problems.push(`${where}.Intl.Collator=${snap.collatorLocale}`);
    if (snap.pluralRulesLocale !== locale) problems.push(`${where}.Intl.PluralRules=${snap.pluralRulesLocale}`);
    for (const k of ['relativeTimeLocale', 'listFormatLocale', 'segmenterLocale', 'displayNamesLocale']) {
      if (snap[k] !== undefined && snap[k] !== locale) problems.push(`${where}.${k}=${snap[k]}`);
    }
    if (snap.languages?.[0] !== locale) problems.push(`${where}.languages=${snap.languages}`);
  };
  check('start', r.start);
  check('live', r.live);
  if (problems.length) throw new Error(`${label}: expected ${locale}: ${problems.join(', ')}`);
}

function expectHeader(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: Accept-Language ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const HEADER = { 'en-US': 'en-US,en;q=0.9', 'ja-JP': 'ja-JP,ja;q=0.9', 'en-GB': 'en-GB,en;q=0.9', 'fr-FR': 'fr-FR,fr;q=0.9', [NATIVE]: 'zh-CN,zh;q=0.9' };

async function test(name, fn) {
  if (only && !new RegExp(only).test(name)) return;
  const t0 = Date.now();
  openedInTest = [];
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message}`);
  } finally {
    // Tabs left open would share renderer processes with later tests.
    for (const targetId of openedInTest) await cdp?.send('Target.closeTarget', { targetId }).catch(() => undefined);
    openedInTest = [];
  }
}

// ------------------------------------------------------------------- tests

srv = await startServer({ port: 0, quiet: true });
PORT = srv.port;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-e2e-profile-'));
console.log(`Locale Jacket e2e — ${kind}${headless ? ' (headless)' : ''}, server :${PORT}`);

try {
  await startBrowser(profileDir);
  const version = await cdp.send('Browser.getVersion');
  console.log(`  ${version.product}, extension ${extId}\n`);
  const firstRun = {
    settings: await sw(`chrome.storage.local.get('settings').then((r) => r.settings)`),
    log: (await sw('localeJacket.log()')).map((l) => l.msg),
  };
  await setSettings(settingsFrom(CONFIG));

  await test('first run installs the rules from presets/default-rules.yaml (unpacked build)', async () => {
    if (!firstRun.log.some((m) => m.includes('rule(s) from presets/default-rules.yaml'))) throw new Error(`log: ${firstRun.log.join(' | ')}`);
    const values = firstRun.settings?.rules?.map((r) => r.value) ?? [];
    if (!values.includes('google.com') || !values.includes('accounts.google.com')) throw new Error(`rules: ${values.join(', ')}`);
  });

  await test('baseline: unmatched site reports the native zh-CN locale', async () => {
    const tab = await openTab(u('plain.localhost', '/plain.html'));
    const r = await report(tab);
    expectLocale(r, NATIVE, 'plain.localhost');
    expectHeader(r.documentAcceptLanguage, HEADER[NATIVE], 'document');
    const s = await status(tab.tabId);
    if (s.session !== 'none') throw new Error(`expected no debugger session, got ${s.session}`);
    await closeTab(tab);
  });

  let tab;
  await test('new tab: google.localhost reports en-US from document start (page, worker, frames, headers)', async () => {
    tab = await openTab(u('google.localhost', '/'), { keep: true });
    const r = await report(tab);
    expectLocale(r, 'en-US', 'google.localhost');
    expectHeader(r.documentAcceptLanguage, HEADER['en-US'], 'document');
    expectHeader(r.fetchAcceptLanguage, HEADER['en-US'], 'fetch()');
    if (r.worker?.snapshot?.language !== 'en-US') throw new Error(`worker.language=${r.worker?.snapshot?.language}`);
    if (r.worker?.snapshot?.dateLocale !== 'en-US') throw new Error(`worker Intl=${r.worker?.snapshot?.dateLocale}`);
    expectHeader(r.worker?.fetchAcceptLanguage, HEADER['en-US'], 'worker fetch()');
    for (const f of r.frames) {
      if (f.error) throw new Error(`frame ${f.host}: ${f.error}`);
      expectLocale(f, 'en-US', `${f.kind} frame ${f.host}`);
      expectHeader(f.documentAcceptLanguage, HEADER['en-US'], `${f.kind} frame document`);
    }
    if (!r.frames.some((f) => f.kind === 'cross-site')) throw new Error('no cross-site frame tested');
    if (r.live.userAgent !== r.start.userAgent || !r.live.uaBrands || r.live.uaBrands === 'n/a') throw new Error('UA / client hints changed');
  });

  await test('subdomain: mail.google.localhost (DOMAIN-SUFFIX) → en-US', async () => {
    const r = await navigate(tab, u('mail.google.localhost', '/plain.html'), 'link');
    expectLocale(r, 'en-US', 'mail.google.localhost');
    expectHeader(r.documentAcceptLanguage, HEADER['en-US'], 'document');
  });

  await test('switch site: apple.localhost → ja-JP with no stale en-US at document start', async () => {
    const r = await navigate(tab, u('developer.apple.localhost', '/plain.html'), 'link');
    expectLocale(r, 'ja-JP', 'developer.apple.localhost');
    expectHeader(r.documentAcceptLanguage, HEADER['ja-JP'], 'document');
  });

  await test('SYSTEM exception: accounts.google.localhost restores zh-CN (no leak)', async () => {
    const r = await navigate(tab, u('accounts.google.localhost', '/plain.html'), 'typed');
    expectLocale(r, NATIVE, 'accounts.google.localhost');
    expectHeader(r.documentAcceptLanguage, HEADER[NATIVE], 'document');
  });

  await test('unmatched site after spoofed sites → native locale and header', async () => {
    await navigate(tab, u('google.localhost', '/plain.html'), 'link');
    const r = await navigate(tab, u('fakegoogle.localhost', '/plain.html'), 'link');
    expectLocale(r, NATIVE, 'fakegoogle.localhost');
    expectHeader(r.documentAcceptLanguage, HEADER[NATIVE], 'document');
  });

  await test('DOMAIN-KEYWORD: login.microsoftonline.localhost → en-GB', async () => {
    const r = await navigate(tab, u('login.microsoftonline.localhost', '/plain.html'), 'link');
    expectLocale(r, 'en-GB', 'login.microsoftonline.localhost');
  });

  await test('redirect across profiles: google → 302 → apple ends in ja-JP', async () => {
    await navigate(tab, u('google.localhost', '/plain.html'), 'link');
    const target = u('apple.localhost', '/plain.html?redirected=1');
    const r = await navigate(tab, u('google.localhost', `/redirect?to=${encodeURIComponent(target)}`), 'link', target);
    expectLocale(r, 'ja-JP', 'redirect target');
    expectHeader(r.documentAcceptLanguage, HEADER['ja-JP'], 'document after redirect');
  });

  await test('profile switch via link keeps the Referer and adds exactly one history entry', async () => {
    await navigate(tab, u('google.localhost', '/plain.html?from=1'), 'link');
    const before = await evaluate(cdp, tab.s, 'history.length');
    srv.clearLog();
    const r = await navigate(tab, u('apple.localhost', '/plain.html?ref=1'), 'link');
    expectLocale(r, 'ja-JP', 'after switch');
    const after = await evaluate(cdp, tab.s, 'history.length');
    if (after !== before + 1) throw new Error(`history.length ${before} → ${after}`);
    const docs = srv.log.filter((l) => l.search === '?ref=1');
    if (docs.length !== 1) throw new Error(`server saw ${docs.length} document requests (the aborted one must never be sent)`);
    if (!docs[0].referer?.startsWith(u('google.localhost', '/'))) throw new Error(`Referer ${docs[0].referer}`);
  });

  await test('optional time zone override follows the rule and is cleared on SYSTEM sites', async () => {
    const withTz = CONFIG.replace(
      '  - DOMAIN-SUFFIX,apple.localhost,ja-JP\n',
      '  - type: DOMAIN-SUFFIX\n    domain: apple.localhost\n    locale: ja-JP\n    timezone: Asia/Tokyo\n',
    );
    if (withTz === CONFIG) throw new Error('test config replacement failed');
    await setSettings(settingsFrom(withTz));
    const t = await openTab(u('plain.localhost', '/plain.html'));
    const native = (await report(t)).live.timeZone;
    let r = await navigate(t, u('apple.localhost', '/plain.html?tz=1'), 'link');
    if (r.start.timeZone !== 'Asia/Tokyo' || r.live.timezoneOffset !== -540) throw new Error(`apple: ${r.start.timeZone} offset ${r.live.timezoneOffset}`);
    r = await navigate(t, u('accounts.google.localhost', '/plain.html?tz=2'), 'link');
    if (r.start.timeZone !== native) throw new Error(`SYSTEM site time zone ${r.start.timeZone}, expected ${native}`);
    await setSettings(settingsFrom(CONFIG));
  });

  await test('reload keeps the profile; status reports attached and on time', async () => {
    await navigate(tab, u('google.localhost', '/plain.html'), 'link');
    await cdp.send('Page.reload', {}, tab.s);
    await sleep(300);
    const r = await report(tab);
    expectLocale(r, 'en-US', 'reloaded');
    const s = await status(tab.tabId);
    if (s.session !== 'attached' || s.late || s.applied?.locale !== 'en-US') throw new Error(`status ${JSON.stringify(s)}`);
  });

  await test('back/forward between profiles', async () => {
    await navigate(tab, u('apple.localhost', '/plain.html?bf=1'), 'link');
    await cdp.send('Runtime.evaluate', { expression: 'history.back()' }, tab.s);
    await sleep(800);
    const r = await report(tab);
    if (r.host !== 'google.localhost') throw new Error(`back landed on ${r.host}`);
    expectLocale(r, 'en-US', 'after back');
    // A traversal that changes profile must be re-issued as a traversal, not as a new entry.
    const hist = await cdp.send('Page.getNavigationHistory', {}, tab.s);
    const fwd = hist.entries[hist.currentIndex + 1];
    if (!fwd?.url.includes('apple.localhost')) throw new Error(`forward entry lost: ${JSON.stringify(hist.entries.map((e) => e.url))} @${hist.currentIndex}`);
    await cdp.send('Runtime.evaluate', { expression: 'history.forward()' }, tab.s);
    await sleep(800);
    const f = await report(tab);
    if (f.host !== 'apple.localhost') throw new Error(`forward landed on ${f.host}`);
    expectLocale(f, 'ja-JP', 'after forward');
    const hist2 = await cdp.send('Page.getNavigationHistory', {}, tab.s);
    if (hist2.entries.length !== hist.entries.length) throw new Error(`history grew ${hist.entries.length} → ${hist2.entries.length}`);
  });
  await closeTab(tab);

  await test('New Tab Page → typed URL: header via DNR, page auto-reloaded so scripts start with en-US', async () => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://newtab/' });
    await sleep(800);
    const s = await attach(cdp, targetId);
    await cdp.send('Page.enable', {}, s);
    const ntpTab = { targetId, s, tabId: await tabIdOf(targetId) };
    srv.clearLog();
    await cdp.send('Page.navigate', { url: u('google.localhost', '/plain.html?ntp=1'), transitionType: 'typed' }, s);
    await sleep(1500);
    const r = await report(ntpTab, { settle: 1200 });
    expectLocale(r, 'en-US', 'after NTP navigation');
    const docs = srv.log.filter((l) => l.search === '?ntp=1');
    if (!docs.length || docs.some((l) => l.acceptLanguage !== HEADER['en-US'])) {
      throw new Error(`document requests: ${JSON.stringify(docs.map((l) => l.acceptLanguage))}`);
    }
    const st = await status(ntpTab.tabId);
    console.log(`      (document requests: ${docs.length}; auto-reloaded: ${docs.length > 1})`);
    if (st.late) throw new Error('still flagged late after reload');
    await closeTab(ntpTab);
  });

  await test('slow site in a new tab: the load in flight is restarted, so the page renders once with en-US', async () => {
    srv.clearLog();
    const tab = await openTab(u('google.localhost', '/launch.html?slow-tab=1&delay=400'));
    const r = await report(tab, { settle: 1200 });
    expectLocale(r, 'en-US', 'slow new tab');
    if (r.loads.length !== 1) throw new Error(`page scripts ran ${r.loads.length} times: ${JSON.stringify(r.loads)}`);
    const docs = srv.log.filter((l) => l.search.includes('slow-tab=1'));
    if (docs.some((l) => l.acceptLanguage !== HEADER['en-US'])) throw new Error(`document requests: ${JSON.stringify(docs.map((l) => l.acceptLanguage))}`);
    console.log(`      (document requests: ${docs.length})`);
  });

  await test('a form POST into a new tab is never restarted or sent twice', async () => {
    const opener = await openTab(u('google.localhost', '/plain.html?post-opener=1'));
    await report(opener);
    srv.clearLog();
    const action = u('apple.localhost', '/plain.html?post-target=1&delay=400');
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const f = Object.assign(document.createElement('form'), { method: 'POST', action: ${JSON.stringify(action)}, target: '_blank' });
        f.appendChild(Object.assign(document.createElement('input'), { name: 'q', value: '1' }));
        document.body.appendChild(f);
        f.submit();
      })()`,
      userGesture: true,
    }, opener.s);
    try {
      await until(() => srv.log.some((l) => l.search.includes('post-target=1')), { message: 'POST request' });
      await sleep(2500);
      const hits = srv.log.filter((l) => l.search.includes('post-target=1'));
      if (hits.length !== 1 || hits[0].method !== 'POST') throw new Error(`requests: ${JSON.stringify(hits.map((h) => h.method))}`);
    } finally {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const t of targetInfos.filter((x) => x.url.includes('post-target=1'))) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
    }
  });

  await test('per-frame mode: a cross-site iframe gets its own rule (fr-FR) inside an en-US page', async () => {
    const s = settingsFrom(CONFIG.replace('default:', '  - DOMAIN-SUFFIX,xsite-frame.localhost,fr-FR\ndefault:'), { options: { frameMode: 'per-frame' } });
    await setSettings(s);
    const t = await openTab(u('google.localhost', '/?frames=xsite-frame.localhost'));
    const r = await report(t);
    expectLocale(r, 'en-US', 'parent');
    const f = r.frames[0];
    if (!f || f.error) throw new Error(`frame: ${JSON.stringify(f)}`);
    if (f.live.language !== 'fr-FR' || f.live.dateLocale !== 'fr-FR') throw new Error(`frame live ${f.live.language}/${f.live.dateLocale}`);
    console.log(`      (frame at document start: ${f.start.language}/${f.start.dateLocale}; frame document header: ${f.documentAcceptLanguage})`);
    await closeTab(t);
    await setSettings(settingsFrom(CONFIG));
  });

  await test('inherit mode: a cross-site iframe follows the page even if it has its own rule', async () => {
    const s = settingsFrom(CONFIG.replace('default:', '  - DOMAIN-SUFFIX,xsite-frame.localhost,fr-FR\ndefault:'));
    await setSettings(s);
    const t = await openTab(u('apple.localhost', '/?frames=xsite-frame.localhost'));
    const r = await report(t);
    expectLocale(r, 'ja-JP', 'parent');
    expectLocale(r.frames[0], 'ja-JP', 'cross-site frame');
    await closeTab(t);
    await setSettings(settingsFrom(CONFIG));
  });

  await test('DevTools-style conflict: another client holding the locale is reported, not hidden', async () => {
    const t = await openTab(u('plain.localhost', '/plain.html'));
    await report(t);
    await cdp.send('Emulation.setLocaleOverride', { locale: 'de-DE' }, t.s); // what DevTools ▸ Sensors does
    const r = await navigate(t, u('google.localhost', '/plain.html'), 'link');
    const st = await status(t.tabId);
    console.log(`      (page Intl=${r.live.dateLocale}, navigator.language=${r.live.language}; warnings: ${st.warnings.join(' | ') || 'none'})`);
    if (r.live.language !== 'en-US') throw new Error('navigator.language should still be spoofed');
    // Both sessions restore their override into the new renderer process and the first one
    // holds the process-wide lock, so either may win. What must hold: if the page does not
    // show the profile's Intl locale, the status says so instead of claiming success.
    const reported = st.warnings.some((w) => /another tab or DevTools/.test(w));
    if (r.live.dateLocale !== 'en-US' && !reported) throw new Error('conflict not reported');
    if (r.live.dateLocale === 'en-US' && !reported) console.log('      (the extension won the process lock this time)');
    await cdp.send('Emulation.setLocaleOverride', {}, t.s);
    await closeTab(t);
  });

  await test('popup and options pages load without errors; popup "Save rule" drives spoofing', async () => {
    const site = await openTab(u('fr.localhost', '/plain.html'));
    expectLocale(await report(site), NATIVE, 'before rule');
    const errors = [];
    const onException = (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text);
    cdp.on('Runtime.exceptionThrown', onException);
    const opts = await openTab(`chrome-extension://${extId}/options/options.html#rules`);
    await cdp.send('Runtime.enable', {}, opts.s);
    await until(() => evaluate(cdp, opts.s, `document.querySelectorAll('#rules table tr').length > 1`), { message: 'options rules table' });
    for (const page of ['test', 'io', 'settings', 'sessions', 'updates', 'about']) {
      await evaluate(cdp, opts.s, `location.hash = '#${page}'`);
      await until(() => evaluate(cdp, opts.s, `!document.getElementById('${page}').hidden && document.getElementById('${page}').childElementCount > 0`), { message: `options page ${page}` });
    }
    const popup = await openTab(`chrome-extension://${extId}/popup/popup.html?tabId=${site.tabId}`);
    await cdp.send('Runtime.enable', {}, popup.s);
    await until(() => evaluate(cdp, popup.s, `!!document.querySelector('#siteCard select')`), { message: 'popup rendered' });
    await evaluate(cdp, popup.s, `(() => {
      const sel = document.querySelector('#siteCard .stack select');
      sel.value = 'fr-FR'; sel.dispatchEvent(new Event('change'));
      [...document.querySelectorAll('#siteCard button')].find((b) => b.textContent === 'Save rule').click();
    })()`);
    await until(async () => (await sw(`chrome.storage.local.get('settings').then(r => r.settings.rules.some(x => x.value === 'fr.localhost' && x.profile?.locale === 'fr-FR'))`)) || null, { message: 'rule saved from popup' }).catch(async (e) => {
      const html = await evaluate(cdp, popup.s, `document.querySelector('#siteCard').innerText`).catch((x) => x.message);
      throw new Error(`${e.message}; popup: ${html.replace(/s+/g, ' ').slice(0, 300)}; errors: ${errors.join(' | ')}`);
    });
    await sleep(300);
    await cdp.send('Page.reload', {}, site.s);
    await sleep(300);
    expectLocale(await report(site), 'fr-FR', 'after popup rule');
    cdp.off('Runtime.exceptionThrown', onException);
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    await setSettings(settingsFrom(CONFIG));
  });

  await test('popup "Check what the page sees": works without a debugger session and is read again after a reload', async () => {
    const check = async (site, expected) => {
      const popup = await openTab(`chrome-extension://${extId}/popup/popup.html?tabId=${site.tabId}`);
      await until(() => evaluate(cdp, popup.s, `(() => { const b = [...document.querySelectorAll('#tabCard button')].find((x) => x.textContent === 'Check what the page sees'); b?.click(); return !!b; })()`), { message: 'check button' });
      const cells = () => evaluate(cdp, popup.s, `[...(document.querySelector('.verify table')?.rows ?? [])].map((r) => [...r.cells].map((c) => c.textContent))`);
      const rows = await until(async () => ((await cells()).length ? cells() : null), { message: 'verify table' });
      const lang = rows.find((r) => r[0] === 'navigator.language');
      if (lang.at(-1) !== expected) throw new Error(`navigator.language now = ${lang.at(-1)}, want ${expected}`);
      return { popup, rows };
    };
    // A site left at the system language has no debugger session: read via chrome.scripting, no "at start" column.
    const plain = await openTab(u('plain.localhost', '/plain.html'));
    await report(plain);
    const a = await check(plain, NATIVE);
    if (a.rows[0].length !== 2) throw new Error(`expected only a "Now" column: ${JSON.stringify(a.rows[0])}`);
    // A spoofed site: debugger path with both columns; the report follows a reload.
    const site = await openTab(u('www.google.localhost', '/plain.html'));
    await report(site);
    const b = await check(site, 'en-US');
    if (b.rows[0].length !== 3) throw new Error(`expected "At start" and "Now": ${JSON.stringify(b.rows[0])}`);
    await evaluate(cdp, b.popup.s, `document.querySelector('.verify table').dataset.stale = '1'`);
    await cdp.send('Page.reload', {}, site.s);
    await until(() => evaluate(cdp, b.popup.s, `!!document.querySelector('.verify table') && !document.querySelector('.verify table').dataset.stale`), { message: 'report re-read after reload' });
  });

  await test('popup keeps its controls across status polls, and a navigation drops the old page check', async () => {
    const site = await openTab(u('www.google.localhost', '/plain.html'));
    await report(site);
    const popup = await openTab(`chrome-extension://${extId}/popup/popup.html?tabId=${site.tabId}`);
    const checkButton = `[...document.querySelectorAll('#tabCard button')].find((x) => x.textContent === 'Check what the page sees')`;
    await until(() => evaluate(cdp, popup.s, `!!document.querySelector('#globalToggle input') && !!document.querySelector('#siteCard select') && !!${checkButton}`), { message: 'popup rendered' });
    if (await evaluate(cdp, popup.s, `document.querySelector('#tabCard').hasAttribute('aria-live') || !document.querySelector('#tabCard [aria-live]')`)) {
      throw new Error('aria-live should be on the status chip and detail, not the whole card');
    }
    // Let the first poll settle, mark the controls, then wait two more polls (1.5 s each): nothing changed, so nothing is rebuilt.
    await sleep(1600);
    await evaluate(cdp, popup.s, `(() => {
      document.querySelector('#globalToggle input').dataset.mark = '1';
      document.querySelector('#siteCard select').dataset.mark = '1';
      ${checkButton}.dataset.mark = '1';
      document.querySelector('#globalToggle input').focus();
    })()`);
    await sleep(3500);
    const rebuilt = await evaluate(cdp, popup.s, `(() => {
      const out = [];
      if (document.querySelector('#globalToggle input').dataset.mark !== '1') out.push('toggle');
      if (document.querySelector('#siteCard select').dataset.mark !== '1') out.push('site card');
      if (${checkButton}?.dataset.mark !== '1') out.push('check button');
      if (document.activeElement !== document.querySelector('#globalToggle input')) out.push('focus');
      return out;
    })()`);
    if (rebuilt.length) throw new Error(`changed although nothing happened: ${rebuilt.join(', ')}`);
    // Check the page, then navigate to a ja-JP site: the en-US report is dropped and read again for the new page.
    await evaluate(cdp, popup.s, `${checkButton}.click()`);
    const languageNow = () => evaluate(cdp, popup.s, `(() => { const r = [...(document.querySelector('.verify table')?.rows ?? [])].find((x) => x.cells[0].textContent === 'navigator.language'); return r ? r.cells[r.cells.length - 1].textContent : null; })()`);
    await until(async () => ((await languageNow()) === 'en-US') || null, { message: 'en-US report' });
    await cdp.send('Page.navigate', { url: u('www.apple.localhost', '/plain.html') }, site.s);
    let stale = false;
    await until(async () => {
      const v = await languageNow();
      if (v === 'en-US' && (await evaluate(cdp, popup.s, `document.querySelector('#tabCard .host')?.textContent`)) === 'www.apple.localhost') stale = true;
      return v === 'ja-JP' || null;
    }, { message: 'report re-read for the new page', intervalMs: 50 });
    if (stale) throw new Error('the en-US report of the previous page was shown under the new host');
  });

  await test('version tip and Updates page: nothing checked until asked; a newer release shows only a tip (release page link, no update steps)', async () => {
    const version = await sw('chrome.runtime.getManifest().version');
    const releaseUrl = (q) => u('localhost', `/api/release?${q}`);
    const withSource = (q) => settingsFrom(CONFIG, { options: { extensionUpdates: { onStartup: false, interval: 'off', source: releaseUrl(q) } } });
    await sw(`chrome.storage.local.remove('extensionUpdateState').then(() => true)`);
    srv.clearLog();
    await setSettings(withSource(`version=9.9.9&from=${version}`));

    const opts = await openTab(`chrome-extension://${extId}/options/options.html#updates`);
    await until(() => evaluate(cdp, opts.s, `document.querySelector('#navVersion')?.textContent === 'Version ${version}' && !!document.querySelector('#updates button.primary')`), { message: 'Updates page' });
    await sleep(500);
    if (srv.log.some((l) => l.path === '/api/release')) throw new Error('checked for updates without being asked');
    if (!(await evaluate(cdp, opts.s, `document.querySelector('#updateBadge').hidden`))) throw new Error('badge shown before any check');

    const clickCheck = () => evaluate(cdp, opts.s, `document.querySelector('#updates button.primary').click()`);
    await clickCheck();
    await until(() => evaluate(cdp, opts.s, `!!document.querySelector('#newVersion')`), { message: 'new version tip' });
    const page = await evaluate(cdp, opts.s, `({
      badge: document.querySelector('#updateBadge').hidden ? null : document.querySelector('#updateBadge').textContent,
      tip: document.querySelector('#newVersion').textContent,
      links: [...document.querySelectorAll('#updates a')].map((a) => a.href),
      buttons: [...document.querySelectorAll('#updates button')].map((b) => b.textContent),
      lists: document.querySelectorAll('#updates ol').length,
    })`);
    if (page.badge !== '9.9.9' || !page.tip.includes('Version 9.9.9 is available.')) throw new Error(JSON.stringify(page));
    // Only a tip: the release page, no downloads, no update steps, no reload button.
    if (page.links.length !== 1 || !page.links[0].endsWith('/releases/v9.9.9')) throw new Error(`links: ${page.links.join(' ')}`);
    if (page.lists || page.buttons.includes('Reload extension')) throw new Error(`update instructions shown: ${JSON.stringify(page)}`);

    const popup = await openTab(`chrome-extension://${extId}/popup/popup.html`);
    await until(() => evaluate(cdp, popup.s, `document.querySelector('#version').textContent === 'v${version}' && !document.querySelector('#updateTip').hidden && document.querySelector('#updateTip').textContent.includes('9.9.9')`), { message: 'popup version and update tip' });

    // A failed check (private repository) is explained; an equal version is "latest".
    await setSettings(withSource('status=404'));
    await until(() => evaluate(cdp, opts.s, `!!document.querySelector('#updates button.primary')`), { message: 'Updates page re-rendered' });
    await clickCheck();
    await until(() => evaluate(cdp, opts.s, `/private GitHub repository/.test(document.querySelector('#updateStatus')?.textContent ?? '')`), { message: '404 explained' });
    await setSettings(withSource(`version=${version}`));
    await until(() => evaluate(cdp, opts.s, `!!document.querySelector('#updates button.primary')`), { message: 'Updates page re-rendered' });
    await clickCheck();
    await until(() => evaluate(cdp, opts.s, `/You have the latest version/.test(document.querySelector('#updateStatus')?.textContent ?? '') && !document.querySelector('#newVersion') && document.querySelector('#updateBadge').hidden`), { message: 'up to date' });
    await until(() => evaluate(cdp, popup.s, `location.reload(), true`).then(() => sleep(500)).then(() => evaluate(cdp, popup.s, `document.querySelector('#updateTip').hidden`)), { message: 'popup tip gone' });
    if (srv.log.filter((l) => l.path === '/api/release').length !== 3) throw new Error(`expected exactly 3 checks: ${srv.log.filter((l) => l.path === '/api/release').length}`);
    await sw(`chrome.storage.local.remove('extensionUpdateState').then(() => true)`);
    await setSettings(settingsFrom(CONFIG));
  });

  await test('IP-CIDR / IP-CIDR6 rules use the address Chrome connected to (first visit reloads once)', async () => {
    // *.localhost resolves to 127.0.0.1 or ::1, so both families are covered.
    await setSettings(settingsFrom(CONFIG.replace('default:', '  - IP-CIDR,127.0.0.0/8,fr-FR\n  - IP-CIDR6,::1/128,fr-FR\ndefault:')));
    const t = await openTab(u('ip-rule.localhost', '/plain.html'));
    await sleep(1500);
    let r = await report(t, { settle: 1200 });
    expectLocale(r, 'fr-FR', 'first host');
    const st = await status(t.tabId);
    if (!/^IP-CIDR6?,/.test(st.resolution.ruleLabel ?? '')) throw new Error(`decided by ${st.resolution.ruleLabel}`);
    console.log(`      (server address ${st.resolution.ip}, rule ${st.resolution.ruleLabel})`);
    // A second, never-visited host in the same tab: its address is learned on the way.
    r = await navigate(t, u('ip-rule-2.localhost', '/plain.html'), 'link');
    await sleep(1500);
    r = await report(t, { settle: 1200 });
    expectLocale(r, 'fr-FR', 'second host');
    // Hostname rules still win over IP rules.
    r = await navigate(t, u('google.localhost', '/plain.html?ip=1'), 'link');
    expectLocale(r, 'en-US', 'hostname rule beats IP rule');
    await setSettings(settingsFrom(CONFIG));
  });

  await test('GEOIP,LAN needs no data set', async () => {
    await setSettings(settingsFrom(CONFIG.replace('default:', '  - GEOIP,LAN,de-DE\ndefault:')));
    const t = await openTab(u('lan-rule.localhost', '/plain.html'));
    await sleep(1500);
    expectLocale(await report(t, { settle: 1200 }), 'de-DE', 'LAN');
    await setSettings(settingsFrom(CONFIG));
  });

  await test('GEOSITE rule with an imported geosite.dat (also mirrored into DNR)', async () => {
    // Minimal geosite.dat: category "lj-test" with suffix geo.localhost and full www.geo-full.localhost.
    const enc = new TextEncoder();
    const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; };
    const field = (num, bytes) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
    const domain = (type, value) => field(2, [...varint(8), ...varint(type), ...field(2, [...enc.encode(value)])]);
    const site = [...field(1, [...enc.encode('LJ-TEST')]), ...domain(2, 'geo.localhost'), ...domain(3, 'www.geo-full.localhost')];
    const dat = Buffer.from(field(1, site)).toString('base64');
    const opts = await openTab(`chrome-extension://${extId}/options/options.html#data`);
    await until(() => evaluate(cdp, opts.s, `document.querySelectorAll('#data .card').length >= 3`), { message: 'data sets page' });
    await evaluate(cdp, opts.s, `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(dat)}), (c) => c.charCodeAt(0));
      const store = await import('/shared/dataset-store.js');
      await store.putDataset({ kind: 'geosite', source: 'file: e2e.dat', size: bytes.length, savedAt: Date.now(), summary: '1 categories' }, bytes.buffer);
      return chrome.runtime.sendMessage({ type: 'datasetsChanged' });
    })()`);
    await setSettings(settingsFrom(CONFIG.replace('default:', '  - GEOSITE,lj-test,ja-JP\ndefault:')));
    await evaluate(cdp, opts.s, `location.reload()`).catch(() => undefined);
    await until(() => evaluate(cdp, opts.s, `document.querySelector('#data')?.textContent.includes('Installed')`), { message: 'GeoSite shown as installed' });
    srv.clearLog();
    const t = await openTab(u('www.geo.localhost', '/plain.html?geo=1'));
    await sleep(1200);
    const r = await report(t, { settle: 1200 });
    expectLocale(r, 'ja-JP', 'geosite suffix');
    const first = srv.log.find((l) => l.search === '?geo=1');
    expectHeader(first?.acceptLanguage, HEADER['ja-JP'], 'first document request (DNR mirror)');
    const t2 = await openTab(u('www.geo-full.localhost', '/plain.html'));
    await sleep(1200);
    expectLocale(await report(t2, { settle: 1200 }), 'ja-JP', 'geosite full');
    const t3 = await openTab(u('x.www.geo-full.localhost', '/plain.html'));
    await sleep(1200);
    expectLocale(await report(t3, { settle: 800 }), NATIVE, 'full match is exact');
    await evaluate(cdp, opts.s, `import('/shared/dataset-store.js').then((s) => s.deleteDataset('geosite')).then(() => chrome.runtime.sendMessage({ type: 'datasetsChanged' }))`);
    await setSettings(settingsFrom(CONFIG));
  });

  await test('automatic data-set updates: conditional request, update, minimum gap', async () => {
    // A tiny "CDN" serving geosite.dat with an ETag; the category's domain changes between versions.
    const enc = new TextEncoder();
    const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; };
    const field = (num, bytes) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
    const dat = (host) => Buffer.from(field(1, [...field(1, [...enc.encode('LJ-UPD')]), ...field(2, [...varint(8), ...varint(2), ...field(2, [...enc.encode(host)])])]));
    let version = { etag: '"v1"', body: dat('upd-a.localhost') };
    const hits = [];
    const cdn = http.createServer((req, res) => {
      hits.push(req.headers['if-none-match'] ?? null);
      if (req.headers['if-none-match'] === version.etag) { res.writeHead(304, { ETag: version.etag }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: version.etag, 'Content-Length': version.body.length });
      res.end(version.body);
    });
    await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${cdn.address().port}/geosite.dat`;
    try {
      const opts = await openTab(`chrome-extension://${extId}/options/options.html#data`);
      await until(() => evaluate(cdp, opts.s, `document.querySelector('#datasetUpdates') !== null`), { message: 'updates card' });
      const saved = await evaluate(cdp, opts.s, `import('/shared/dataset-download.js').then((d) => d.downloadDataset('geosite', ${JSON.stringify(url)})).then((r) => chrome.runtime.sendMessage({ type: 'datasetsChanged' }).then(() => r.status))`);
      if (saved !== 'saved') throw new Error(`manual download: ${saved}`);
      const base = settingsFrom(CONFIG.replace('default:', '  - GEOSITE,lj-upd,ja-JP\ndefault:'));
      await setSettings({ ...base, options: { ...base.options, datasetUpdates: { onStartup: true, interval: 'weekly', minIntervalHours: 1, onlyNeeded: true } } });
      await until(() => sw(`chrome.alarms.get('dataset-update').then((a) => Boolean(a))`), { message: 'hourly alarm created for the weekly interval' });
      const check = () => evaluate(cdp, opts.s, `chrome.runtime.sendMessage({ type: 'checkDatasetUpdates' }).then((r) => r.outcomes.map((o) => o.kind + ':' + o.result).join(','))`);
      const first = await check();
      if (first !== 'geosite:unchanged') throw new Error(`expected unchanged (304), got ${first}`);
      if (hits.at(-1) !== '"v1"') throw new Error(`conditional request missing If-None-Match: ${hits.at(-1)}`);
      version = { etag: '"v2"', body: dat('upd-b.localhost') };
      const second = await check();
      if (second !== 'geosite:updated') throw new Error(`expected updated, got ${second}`);
      const t = await openTab(u('www.upd-b.localhost', '/plain.html'));
      await sleep(1200);
      expectLocale(await report(t, { settle: 1000 }), 'ja-JP', 'rule uses the updated data set');
      // A browser start right after: blocked by the minimum gap, no request.
      const before = hits.length;
      const startup = await sw(`localeJacket.runDatasetUpdates('startup').then((o) => o.map((x) => x.result + ':' + (x.reason ?? '')).join(','))`);
      if (startup !== 'skipped:too-soon' || hits.length !== before) throw new Error(`startup within the minimum gap: ${startup}, ${hits.length - before} request(s)`);
      await evaluate(cdp, opts.s, `location.reload()`).catch(() => undefined);
      await until(() => evaluate(cdp, opts.s, `document.querySelector('#data')?.textContent.includes('Last checked')`), { message: 'last check shown' });
      await evaluate(cdp, opts.s, `import('/shared/dataset-store.js').then((s) => s.deleteDataset('geosite')).then(() => chrome.runtime.sendMessage({ type: 'datasetsChanged' }))`);
      await setSettings(settingsFrom(CONFIG));
      await until(() => sw(`chrome.alarms.get('dataset-update').then((a) => !a)`), { message: 'alarm cleared when updates are off' });
    } finally {
      cdn.close();
    }
  });

  await test('rule subscriptions: added from the UI, layered under your rules, auto-downloaded GeoSite, conditional updates, web pages refused', async () => {
    // A local "internet": two subscription files, a web page and the GeoSite data they need.
    const enc = new TextEncoder();
    const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; };
    const field = (num, bytes) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
    const geositeDat = Buffer.from(field(1, [...field(1, [...enc.encode('LJ-SUB')]), ...field(2, [...varint(8), ...varint(2), ...field(2, [...enc.encode('sub-geo.localhost')])])]));
    const files = new Map();
    const hits = [];
    const net = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://x').pathname;
      hits.push({ path, inm: req.headers['if-none-match'] ?? null });
      const f = files.get(path);
      if (!f) { res.writeHead(404); res.end('not found'); return; }
      const etag = `"${f.version}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': f.type, ETag: etag });
      res.end(f.body);
    });
    await new Promise((r) => net.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${net.address().port}`;
    const yamlV = (locale) => `datasets:\n  geosite: ${base}/geosite.dat\nrules:\n  - DOMAIN-SUFFIX,sub-a.localhost,${locale}\n  - DOMAIN-SUFFIX,google.localhost,ja-JP\n  - GEOSITE,lj-sub,ko-KR\n  - NOT-A-RULE,x,en-US\n`;
    files.set('/rules.yaml', { type: 'text/plain', version: 1, body: yamlV('fr-FR') });
    files.set('/rules.json', { type: 'application/json', version: 1, body: JSON.stringify({ rules: ['DOMAIN-SUFFIX,sub-a.localhost,de-DE', 'DOMAIN,sub-b.localhost,de-DE'] }) });
    files.set('/page.html', { type: 'text/html; charset=utf-8', version: 1, body: '<!DOCTYPE html><html><body>A repository page</body></html>' });
    files.set('/geosite.dat', { type: 'application/octet-stream', version: 1, body: geositeDat });
    const opts = await openTab(`chrome-extension://${extId}/options/options.html#subs`);
    const datasetsInstalled = () => evaluate(cdp, opts.s, `import('/shared/dataset-store.js').then((s) => s.listDatasets()).then((l) => l.map((m) => m.kind).join(','))`);
    const subData = () => sw(`chrome.storage.local.get('subscriptionData').then((r) => r.subscriptionData ?? {})`);
    try {
      await until(() => evaluate(cdp, opts.s, `!!document.querySelector('#subs input[type=url]')`), { message: 'Subscriptions page' });
      await evaluate(cdp, opts.s, `import('/shared/dataset-store.js').then((s) => s.deleteDataset('geosite')).then(() => chrome.runtime.sendMessage({ type: 'datasetsChanged' }))`);
      await setSettings(settingsFrom(CONFIG));
      // Add the YAML subscription the way a user does.
      await until(() => evaluate(cdp, opts.s, `!!document.querySelector('#subs input[type=url]')`), { message: 'Subscriptions page' });
      await evaluate(cdp, opts.s, `(() => {
        const i = document.querySelector('#subs input[type=url]');
        i.value = ${JSON.stringify(`${base}/rules.yaml`)};
        document.querySelector('#subs input[type=text]').value = 'Team rules';
        [...document.querySelectorAll('#subs button')].find((b) => b.textContent === 'Add').click();
      })()`);
      await until(async () => Object.values(await subData()).some((d) => d.rules?.length === 3), { message: 'subscription fetched', timeoutMs: 15000 });
      await until(async () => (await datasetsInstalled()).includes('geosite'), { message: 'GeoSite downloaded for the subscription', timeoutMs: 15000 });
      if (hits.filter((h) => h.path === '/geosite.dat').length !== 1) throw new Error(`GeoSite requests: ${JSON.stringify(hits)}`);
      await until(() => evaluate(cdp, opts.s, `/3 rule\\(s\\), updated/.test(document.querySelector('#subs').textContent) && /1 entry\\(ies\\) are not valid rules/.test(document.querySelector('#subs').textContent)`), { message: 'status and skipped entry shown' });

      // Layers: own rules win, subscription rules apply elsewhere, GEOSITE uses the downloaded data.
      const t = await openTab(u('sub-a.localhost', '/plain.html'));
      expectLocale(await report(t), 'fr-FR', 'subscription rule');
      expectLocale(await navigate(t, u('google.localhost', '/plain.html?own=1'), 'link'), 'en-US', 'your own rule beats the subscription');
      expectLocale(await navigate(t, u('www.sub-geo.localhost', '/plain.html'), 'link'), 'ko-KR', 'GEOSITE from the auto-downloaded data set');
      const st = await status(t.tabId);
      if (!/GEOSITE,lj-sub · Team rules/.test(st.resolution.ruleLabel ?? '')) throw new Error(`rule label: ${st.resolution.ruleLabel}`);

      const first = (await sw(`chrome.storage.local.get('settings').then((r) => r.settings.subscriptions)`))[0];

      // Tiers: your IP rule (your special rule) beats the subscription's GEOSITE (their special rule),
      // but loses to the subscription's hostname rule.
      await setSettings(settingsFrom(CONFIG.replace('default:', '  - IP-CIDR,127.0.0.0/8,pt-BR\n  - IP-CIDR6,::1/128,pt-BR\ndefault:'), { subscriptions: [first] }));
      await navigate(t, u('www.sub-geo.localhost', '/plain.html?tier=1'), 'link');
      await sleep(1500);
      expectLocale(await report(t, { settle: 1200 }), 'pt-BR', 'your special rule beats the subscription special rule');
      expectLocale(await navigate(t, u('sub-a.localhost', '/plain.html?tier=2'), 'link'), 'fr-FR', 'the subscription hostname rule beats your special rule');
      await setSettings(settingsFrom(CONFIG, { subscriptions: [first] }));

      // A second (JSON) subscription below the first: the first one wins where both match.
      const two = (extra = []) => settingsFrom(CONFIG, { subscriptions: [first, { id: 'json-sub', name: 'JSON', url: `${base}/rules.json`, enabled: true, interval: 'daily' }, ...extra] });
      await setSettings(two());
      await until(async () => (await subData())['json-sub']?.rules?.length === 2, { message: 'JSON subscription fetched' });
      expectLocale(await navigate(t, u('sub-a.localhost', '/plain.html?two=1'), 'link'), 'fr-FR', 'the earlier subscription wins');
      expectLocale(await navigate(t, u('sub-b.localhost', '/plain.html'), 'link'), 'de-DE', 'the JSON subscription');

      // Update: unchanged first (conditional request), then a new version.
      const update = (ids) => evaluate(cdp, opts.s, `chrome.runtime.sendMessage({ type: 'updateSubscriptions', ids: ${JSON.stringify(ids)} }).then((r) => r.outcomes.map((o) => o.result).join(','))`);
      if ((await update([first.id])) !== 'unchanged') throw new Error('expected unchanged');
      if (hits.filter((h) => h.path === '/rules.yaml').at(-1).inm !== '"1"') throw new Error('update was not conditional');
      files.set('/rules.yaml', { type: 'text/plain', version: 2, body: yamlV('es-ES') });
      if ((await update([first.id])) !== 'updated') throw new Error('expected updated');
      expectLocale(await navigate(t, u('sub-a.localhost', '/plain.html?v2=1'), 'link'), 'es-ES', 'after the subscription changed');

      // A link to a web page is refused with an explanation; the other subscriptions keep working.
      await setSettings(two([{ id: 'html-sub', name: 'Page', url: `${base}/page.html`, enabled: true, interval: 'daily' }]));
      await until(async () => /web page/.test((await subData())['html-sub']?.error ?? ''), { message: 'web page refused' });
      await until(() => evaluate(cdp, opts.s, `/returned a web page/.test(document.querySelector('#subs').textContent)`), { message: 'error shown on the page' });
      if (!(await sw(`chrome.alarms.get('subscription-update').then((a) => Boolean(a))`))) throw new Error('no hourly alarm for daily subscriptions');

      // Removing them removes their rules (and what was stored for them).
      await setSettings(settingsFrom(CONFIG));
      await until(async () => Object.keys(await subData()).length === 0, { message: 'subscription data pruned' });
      expectLocale(await navigate(t, u('sub-a.localhost', '/plain.html?gone=1'), 'link'), NATIVE, 'no subscription rules left');
      await until(() => sw(`chrome.alarms.get('subscription-update').then((a) => !a)`), { message: 'alarm cleared' });
    } finally {
      net.close();
      await evaluate(cdp, opts.s, `import('/shared/dataset-store.js').then((s) => s.deleteDataset('geosite')).then(() => chrome.runtime.sendMessage({ type: 'datasetsChanged' }))`).catch(() => undefined);
      await sw(`chrome.storage.local.remove(['subscriptionData', 'subscriptionDatasetState']).then(() => true)`).catch(() => undefined);
      await setSettings(settingsFrom(CONFIG));
    }
  });

  await test('UI follows the browser language (zh-CN) unless set otherwise', async () => {
    await setSettings({ ...settingsFrom(CONFIG), options: { ...settingsFrom(CONFIG).options, uiLanguage: 'auto' } });
    const p = await openTab(`chrome-extension://${extId}/options/options.html#rules`);
    await until(() => evaluate(cdp, p.s, `document.querySelector('nav a[href="#rules"]')?.textContent === '规则' && document.documentElement.lang === 'zh-CN'`), { message: 'Chinese UI' });
    await setSettings({ ...settingsFrom(CONFIG), options: { ...settingsFrom(CONFIG).options, uiLanguage: 'ja' } });
    await until(() => evaluate(cdp, p.s, `document.querySelector('nav a[href="#rules"]')?.textContent === 'ルール' && document.documentElement.lang === 'ja'`), { message: 'Japanese UI' });
    await setSettings(settingsFrom(CONFIG));
    await until(() => evaluate(cdp, p.s, `document.querySelector('nav a[href="#rules"]')?.textContent === 'Rules'`), { message: 'switches to English live' });
  });

  await test('restricted pages are left alone (chrome://version)', async () => {
    const t = await openTab('chrome://version/');
    await sleep(500);
    const st = await status(t.tabId);
    if (st && st.session === 'attached') throw new Error('attached to a chrome:// page');
    await closeTab(t);
  });

  await test('disabling the extension detaches every session and restores native behaviour', async () => {
    const t = await openTab(u('google.localhost', '/plain.html'));
    expectLocale(await report(t), 'en-US', 'before disable');
    await setSettings({ ...settingsFrom(CONFIG), enabled: false });
    const g = await globalStatus();
    if (g.attachedTabs !== 0) throw new Error(`${g.attachedTabs} sessions still attached`);
    const dnrRules = await sw('chrome.declarativeNetRequest.getDynamicRules()');
    if (dnrRules.length) throw new Error(`${dnrRules.length} DNR rules left`);
    await cdp.send('Page.reload', {}, t.s);
    await sleep(300);
    const r = await report(t);
    expectLocale(r, NATIVE, 'after disable');
    expectHeader(r.documentAcceptLanguage, HEADER[NATIVE], 'document after disable');
    await setSettings(settingsFrom(CONFIG));
    await closeTab(t);
  });

  await test('global default profile (original single-locale mode) spoofs unmatched sites', async () => {
    await setSettings(settingsFrom(CONFIG.replace('mode: SYSTEM', 'mode: PROFILE\n  locale: en-US')));
    const t = await openTab(u('random-site.localhost', '/plain.html'));
    expectLocale(await report(t), 'en-US', 'unmatched with default en-US');
    const r = await navigate(t, u('accounts.google.localhost', '/plain.html'), 'link');
    expectLocale(r, NATIVE, 'SYSTEM exception under a PROFILE default');
    await setSettings(settingsFrom(CONFIG));
    await closeTab(t);
  });

  // ------------------------------------------------------------- restart
  await test('settings and spoofing persist across a browser restart', async () => {
    const t = await openTab(u('apple.localhost', '/plain.html'));
    await report(t);
    await browser.close();
    await startBrowser(profileDir);
    const stored = await sw(`chrome.storage.local.get('settings').then(r => r.settings)`);
    if (!stored?.rules?.some((r) => r.value === 'apple.localhost')) throw new Error('settings were not persisted');
    const t2 = await openTab(u('apple.localhost', '/plain.html?after-restart=1'));
    expectLocale(await report(t2), 'ja-JP', 'after restart');
  });

  await test('first run without presets/ (the .crx contents) generates the example preset', async () => {
    const crxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-e2e-crx-'));
    const freshProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-e2e-fresh-'));
    try {
      fs.cpSync(dist, crxDir, { recursive: true, filter: (src) => path.relative(dist, src).split(path.sep)[0] !== 'presets' });
      await browser.close();
      await startBrowser(freshProfile, crxDir);
      const log = (await sw('localeJacket.log()')).map((l) => l.msg);
      if (!log.some((m) => m.includes('no presets/default-rules.yaml in the package'))) throw new Error(`log: ${log.join(' | ')}`);
      const rules = await sw(`chrome.storage.local.get('settings').then((r) => r.settings.rules.map((x) => x.value))`);
      if (rules.length !== 5 || !rules.includes('apple.com')) throw new Error(`rules: ${rules.join(', ')}`);
    } finally {
      await browser.close().catch(() => undefined);
      browser = null;
      fs.rmSync(freshProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      fs.rmSync(crxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
} catch (e) {
  console.error('\nHarness failure:', e);
  results.push({ name: 'harness', ok: false, error: e.message });
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
console.log(`\n${results.length - failed.length}/${results.length} passed (${kind})`);
process.exit(failed.length ? 1 : 0);
