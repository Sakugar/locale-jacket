#!/usr/bin/env node
// End-to-end tests: load dist/ into a real Chrome (or Edge) and check what
// websites observe, using the verification server on *.localhost hostnames.
//
//   node e2e/run.mjs [--edge] [--headful] [--only <substring>]
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
  return { ...r.settings, ...patch, options: { ...r.settings.options, ...(patch.options ?? {}) } };
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

async function startBrowser(userDataDir) {
  browser = await launch({ executable: findBrowser(kind), headless, userDataDir, keepProfile: Boolean(userDataDir), extraArgs: ['--lang=zh-CN', '--accept-lang=zh-CN,zh'] });
  cdp = browser.cdp;
  ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: dist }));
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
  await setSettings(settingsFrom(CONFIG));

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
    if (r.live.language !== 'en-US' || r.live.dateLocale !== 'en-US') throw new Error(`after back: ${r.live.language}/${r.live.dateLocale}`);
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
    for (const page of ['test', 'io', 'settings', 'sessions', 'about']) {
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
