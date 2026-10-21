// Locale Jacket background service worker (Manifest V3).
//
// Every listener is registered synchronously at the top level so Chrome can
// wake the worker for any of them. Handlers wait for `ready`, which loads the
// settings and reconciles open tabs. An attached chrome.debugger session keeps
// the worker alive (Chrome 118+). When nothing is attached, the worker may
// sleep and is revived by the next tab/navigation event.
//
// Privacy: nothing here makes network requests or persists URLs. The in-memory
// log keeps only hostnames and is dropped when the worker stops.

import { chromeDebuggerPort, errorMessage } from './cdp.js';
import { SessionManager, spoofingPossible } from './manager.js';
import { sanitizeStoredSettings } from '../shared/config-io.js';
import { compileDnrRules } from '../shared/dnr.js';
import { DatasetRuntime } from './datasets.js';
import { IpCache } from './ip-cache.js';
import { hostFromUrl, normalizeHost } from '../shared/domain.js';
import { parseIp } from '../shared/ip.js';
import type { GlobalStatus, HostTest, LogEntry, Request, TabStatus } from '../shared/messages.js';
import { describeAction, needsServerIp, requiredDatasets, resolveHost, ruleLabel } from '../shared/rules.js';
import { defaultSettings } from '../shared/presets.js';
import type { Settings } from '../shared/types.js';

const SETTINGS_KEY = 'settings';
const SUSPENDED_KEY = 'suspended';
const LOG_LIMIT = 300;

const logEntries: LogEntry[] = [];
function log(entry: LogEntry): void {
  logEntries.push(entry);
  if (logEntries.length > LOG_LIMIT) logEntries.splice(0, logEntries.length - LOG_LIMIT);
  const line = `[LocaleJacket]${entry.tabId !== null ? ` tab ${entry.tabId}:` : ''} ${entry.msg}`;
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.debug(line);
}
const info = (msg: string) => log({ t: Date.now(), level: 'info', tabId: null, msg });

let settingsProblems: string[] = [];
const dnrState: GlobalStatus['dnr'] = { active: false, ruleCount: 0, skipped: [], error: null };

async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  if (stored === undefined) {
    const s = defaultSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
    info('First run: installed the example rule preset.');
    return s;
  }
  const { settings, problems } = sanitizeStoredSettings(stored, defaultSettings());
  settingsProblems = problems;
  for (const p of problems) log({ t: Date.now(), level: 'warn', tabId: null, msg: p });
  return settings;
}

// ------------------------------------------------------------------ DNR sync

let dnrChain: Promise<void> = Promise.resolve();
function syncDnr(settings: Settings, suspended: boolean): Promise<void> {
  dnrChain = dnrChain.then(async () => {
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const want = settings.options.dnrHeaders && !suspended && spoofingPossible(settings);
      const compiled = want ? compileDnrRules(settings, { geosite: (v) => datasets.context(null).geosite?.(v) }) : { rules: [], skipped: [] };
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((r) => r.id),
        addRules: compiled.rules as unknown as chrome.declarativeNetRequest.Rule[],
      });
      dnrState.active = want;
      dnrState.ruleCount = compiled.rules.length;
      dnrState.skipped = compiled.skipped.map((s) => `${s.rule.type},${s.rule.value}: ${s.reason}`);
      dnrState.error = null;
    } catch (e) {
      dnrState.error = errorMessage(e);
      log({ t: Date.now(), level: 'error', tabId: null, msg: `declarativeNetRequest update failed: ${dnrState.error}` });
    }
  });
  return dnrChain;
}

// --------------------------------------------------------------------- badge

const BADGE_COLORS = { ok: '#1a7f37', warn: '#b54708', off: '#6b6b75' };

function badgeFor(s: TabStatus, suspended: boolean, enabled: boolean): { text: string; color: string; title: string } {
  if (!enabled) return { text: 'OFF', color: BADGE_COLORS.off, title: 'Locale Jacket: off' };
  if (suspended) return { text: '||', color: BADGE_COLORS.off, title: 'Locale Jacket: paused (debugging was canceled)' };
  const p = s.resolution.profile;
  if (!p) return { text: '', color: BADGE_COLORS.off, title: `Locale Jacket: system locale${s.host ? ` on ${s.host}` : ''}` };
  const code = (p.locale.split('-')[0] ?? '').toUpperCase().slice(0, 3);
  if (s.session === 'restricted') return { text: '', color: BADGE_COLORS.off, title: 'Locale Jacket: Chrome does not allow debugging this page' };
  if (s.session !== 'attached' || s.late || s.warnings.length) {
    return { text: `${code}!`, color: BADGE_COLORS.warn, title: `Locale Jacket: ${p.locale} — ${s.late ? 'reload recommended' : s.error ?? s.warnings[0] ?? 'not active'}` };
  }
  return { text: code, color: BADGE_COLORS.ok, title: `Locale Jacket: ${p.locale} on ${s.host}` };
}

function updateBadge(s: TabStatus): void {
  if (!manager) return;
  const b = badgeFor(s, manager.isSuspended, manager.currentSettings.enabled);
  chrome.action.setBadgeText({ tabId: s.tabId, text: b.text }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ tabId: s.tabId, color: b.color }).catch(() => undefined);
  chrome.action.setTitle({ tabId: s.tabId, title: b.title }).catch(() => undefined);
}

async function refreshGlobalBadge(): Promise<void> {
  if (!manager) return;
  const off = !manager.currentSettings.enabled;
  await chrome.action.setBadgeText({ text: off ? 'OFF' : manager.isSuspended ? '||' : '' }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.off }).catch(() => undefined);
  for (const s of manager.statuses()) updateBadge(s);
}

// ---------------------------------------------------------------- bootstrap

let manager: SessionManager | null = null;

// --------------------------------------------------- datasets and server IPs

const datasets = new DatasetRuntime((msg) => log({ t: Date.now(), level: 'debug', tabId: null, msg }));
const ipCache = new IpCache();
let watchingIps = false;

function onResponseStarted(d: chrome.webRequest.OnResponseStartedDetails): void {
  const host = d.ip ? hostFromUrl(d.url) : null;
  if (host && d.ip) ipCache.set(host, d.ip);
}

/**
 * IP rules need the address Chrome connected to. The listener is only registered
 * while such rules exist, so the worker is not woken for every request otherwise.
 */
function syncIpWatcher(settings: Settings): void {
  const want = settings.enabled && needsServerIp(settings.rules);
  if (want === watchingIps) return;
  if (want) chrome.webRequest.onResponseStarted.addListener(onResponseStarted, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] });
  else {
    chrome.webRequest.onResponseStarted.removeListener(onResponseStarted);
    ipCache.clear();
  }
  watchingIps = want;
}

const ready: Promise<SessionManager> = (async () => {
  const settings = await loadSettings();
  const suspended = Boolean((await chrome.storage.session.get(SUSPENDED_KEY))[SUSPENDED_KEY]);
  await datasets.ensure(requiredDatasets(settings.rules));
  syncIpWatcher(settings);
  manager = new SessionManager({
    matchContext: (host) => datasets.context(ipCache.get(host)),
    port: chromeDebuggerPort((method, ms) => log({ t: Date.now(), level: 'warn', tabId: null, msg: `Slow CDP command ${method}: ${ms} ms` })),
    initialSettings: settings,
    suspended,
    reloadTab: (tabId) => chrome.tabs.reload(tabId),
    getTabUrl: async (tabId) => {
      try {
        return (await chrome.tabs.get(tabId)).url ?? null;
      } catch {
        return null;
      }
    },
    listTabs: async () => (await chrome.tabs.query({})).filter((t) => t.id !== undefined).map((t) => ({ id: t.id!, url: t.url ?? t.pendingUrl ?? null })),
    onStatus: updateBadge,
    onTabGone: () => undefined,
    log,
  });
  await syncDnr(settings, suspended);
  await refreshGlobalBadge();
  void manager.reconcileAll();
  info(`Service worker ready (${settings.rules.length} rules, ${settings.enabled ? 'enabled' : 'disabled'}${suspended ? ', paused' : ''}).`);
  return manager;
})();

ready.catch((e) => log({ t: Date.now(), level: 'error', tabId: null, msg: `Initialization failed: ${errorMessage(e)}` }));

// Read-only diagnostics handle, reachable only from this worker's own DevTools console
// (chrome://extensions → "service worker"). Used by the e2e suite.
(globalThis as unknown as { localeJacket: unknown }).localeJacket = {
  ready: () => ready.then(() => true),
  status: (tabId: number) => manager?.status(tabId) ?? null,
  statuses: () => manager?.statuses() ?? [],
  global: () => (manager ? globalStatus(manager) : null),
  log: () => [...logEntries],
};

const withManager = (fn: (m: SessionManager) => unknown) => {
  ready.then(fn).catch((e) => log({ t: Date.now(), level: 'error', tabId: null, msg: errorMessage(e) }));
};

// --------------------------------------------------------------- listeners

const WEB = { url: [{ schemes: ['http', 'https'] }] };

chrome.webNavigation.onBeforeNavigate.addListener((d) => withManager((m) => m.onBeforeNavigate(d.tabId, d.frameId, d.url)), WEB);
chrome.webNavigation.onCommitted.addListener(
  (d) =>
    withManager((m) =>
      m.onCommitted(d.tabId, d.frameId, {
        url: d.url,
        transitionType: d.transitionType,
        transitionQualifiers: d.transitionQualifiers,
        timeStamp: d.timeStamp,
      }),
    ),
  WEB,
);
chrome.webNavigation.onErrorOccurred.addListener((d) => withManager((m) => m.onNavigationError(d.tabId, d.frameId)), WEB);

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  const url = tab.pendingUrl ?? tab.url ?? null;
  withManager((m) => m.onTabCreated(tab.id!, url));
});
chrome.tabs.onRemoved.addListener((tabId) => withManager((m) => m.onTabRemoved(tabId)));
chrome.tabs.onReplaced.addListener((added, removed) =>
  withManager(async (m) => {
    const url = await chrome.tabs.get(added).then((t) => t.url ?? null, () => null);
    m.onTabReplaced(added, removed, url);
  }),
);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) withManager((m) => m.onTabUrlChanged(tabId, change.url!));
});

chrome.debugger.onEvent.addListener((source, method, params) => withManager((m) => m.onDebuggerEvent(source as { tabId?: number; sessionId?: string }, method, params)));
chrome.debugger.onDetach.addListener((source, reason) =>
  withManager(async (m) => {
    m.onDebuggerDetach(source.tabId, reason);
    if (reason === 'canceled_by_user' && !m.isSuspended) {
      // The user dismissed Chrome's "started debugging this browser" banner. Respect it:
      // stop spoofing until they resume from the popup. No automatic re-attach.
      info('Debugging was canceled from Chrome’s banner; spoofing paused.');
      await chrome.storage.session.set({ [SUSPENDED_KEY]: true });
      await m.suspend();
      await syncDnr(m.currentSettings, true);
      await refreshGlobalBadge();
    }
  }),
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  withManager(async (m) => {
    const { settings, problems } = sanitizeStoredSettings(changes[SETTINGS_KEY]!.newValue, defaultSettings());
    settingsProblems = problems;
    await datasets.ensure(requiredDatasets(settings.rules));
    syncIpWatcher(settings);
    await m.updateSettings(settings);
    await syncDnr(settings, m.isSuspended);
    await refreshGlobalBadge();
    info(`Settings updated (${settings.rules.length} rules, ${settings.enabled ? 'enabled' : 'disabled'}).`);
  });
});

chrome.runtime.onInstalled.addListener((d) => info(`Installed (${d.reason}${d.previousVersion ? ` from ${d.previousVersion}` : ''}).`));
chrome.runtime.onStartup.addListener(() => info('Browser started.'));

function globalStatus(m: SessionManager): GlobalStatus {
  return {
    enabled: m.currentSettings.enabled,
    suspended: m.isSuspended,
    attachedTabs: m.attachedCount(),
    settingsProblems,
    dnr: { ...dnrState },
    datasets: { installed: datasets.meta, problems: datasets.missing, ipCacheSize: ipCache.size, watchingIps },
  };
}

/** Resolve a hostname (or URL) the way a tab would, for the options tester and popup. */
function testHost(m: SessionManager, input: string, ipInput?: string): HostTest {
  const raw = input.trim();
  const host = raw.includes('://') ? hostFromUrl(raw) : (normalizeHost(raw)?.ascii ?? null);
  const given = ipInput ? parseIp(ipInput) : null;
  const literal = host ? parseIp(host) : null;
  const observed = host ? ipCache.get(host) : null;
  const ip = given ?? observed;
  const ctx = datasets.context(ip);
  const res = resolveHost(host, m.currentSettings, ctx);
  const addr = literal ?? ip;
  return {
    host,
    resolution: { action: res.action, source: res.source, ruleId: res.rule?.id ?? null, ruleLabel: res.rule ? ruleLabel(res.rule) : null, profile: res.profile, ip: res.ip },
    matches: res.matches.map((r) => ({ label: ruleLabel(r), action: describeAction(r), ruleId: r.id })),
    ipSource: literal ? 'literal' : given ? 'given' : observed ? 'observed' : 'unknown',
    country: addr ? (ctx.geoip?.(addr) ?? null) : null,
    asn: addr ? (ctx.asn?.(addr) ?? null) : null,
    problems: datasets.missing,
  };
}

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  // Only our own extension pages may talk to the worker.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  ready
    .then(async (m) => {
      switch (msg.type) {
        case 'getStatus':
          return { status: m.status(msg.tabId), global: globalStatus(m) };
        case 'listStatuses':
          return { statuses: m.statuses(), global: globalStatus(m) };
        case 'verify':
          return m.verify(msg.tabId);
        case 'reloadTab':
          await chrome.tabs.reload(msg.tabId);
          return { ok: true };
        case 'resume':
          await chrome.storage.session.set({ [SUSPENDED_KEY]: false });
          await m.resume();
          await syncDnr(m.currentSettings, false);
          await refreshGlobalBadge();
          return { ok: true };
        case 'detachAll':
          return { detached: await m.detachAll('requested from options page') };
        case 'testHost':
          return testHost(m, msg.host, msg.ip);
        case 'datasetsChanged':
          datasets.reset();
          await datasets.ensure(requiredDatasets(m.currentSettings.rules));
          await m.updateSettings(m.currentSettings);
          await syncDnr(m.currentSettings, m.isSuspended);
          await refreshGlobalBadge();
          info('Data sets changed; rules re-evaluated.');
          return { ok: true, problems: datasets.missing };
        case 'geositeCategories':
          await datasets.loadGeositeIndex().catch(() => undefined);
          return { names: datasets.geositeCategoryNames() };
        case 'getLog':
          return { entries: [...logEntries] };
        default:
          return { error: 'Unknown request' };
      }
    })
    .then(sendResponse, (e) => sendResponse({ error: errorMessage(e) }));
  return true;
});
