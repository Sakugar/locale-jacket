// Locale Jacket background service worker (Manifest V3).
//
// Every listener is registered synchronously at the top level so Chrome can
// wake the worker for any of them. Handlers wait for `ready`, which loads the
// settings and reconciles open tabs. An attached chrome.debugger session keeps
// the worker alive (Chrome 118+). When nothing is attached, the worker may
// sleep and is revived by the next tab/navigation event.
//
// Privacy: the only network requests made here are data-set updates the user opted
// into (Options ▸ Data sets), to the URL each data set was downloaded from, and
// update checks the user starts or opts into (Options ▸ Updates), to the release
// address shown there, and the rule subscriptions the user added (Options ▸
// Subscriptions), to their URLs. No URLs
// are persisted; the in-memory log keeps only hostnames and is dropped when the
// worker stops.

import { chromeDebuggerPort, errorMessage } from './cdp.js';
import { SessionManager, spoofingPossible } from './manager.js';
import { importConfigText, sanitizeStoredSettings } from '../shared/config-io.js';
import { compileDnrRules } from '../shared/dnr.js';
import { DatasetRuntime } from './datasets.js';
import { DatasetUpdater } from './dataset-updater.js';
import { downloadDataset } from '../shared/dataset-download.js';
import { DATASETS, listDatasets } from '../shared/dataset-store.js';
import { autoUpdatesEnabled, type DatasetUpdateState } from '../shared/dataset-schedule.js';
import {
  checkDue,
  compareVersions,
  EXTENSION_UPDATE_STATE_KEY,
  fetchLatestRelease,
  type CheckTrigger,
  type ExtensionUpdateState,
} from '../shared/extension-update.js';
import { IpCache } from './ip-cache.js';
import { verifyWithScripting } from './probe.js';
import { hostFromUrl, normalizeHost } from '../shared/domain.js';
import { setLanguage, t } from '../shared/i18n.js';
import { parseIp } from '../shared/ip.js';
import type { GlobalStatus, HostTest, LogEntry, Request, TabStatus } from '../shared/messages.js';
import { describeAction, needsServerIp, requiredDatasets, resolveHost, ruleLabel } from '../shared/rules.js';
import { defaultSettings } from '../shared/presets.js';
import {
  datasetDownloadDue,
  datasetsToDownload,
  fetchSubscription,
  rawUrl,
  SUBSCRIPTION_DATASET_STATE_KEY,
  SUBSCRIPTION_DATA_KEY,
  subscriptionDue,
  subscriptionLabel,
  withSubscriptions,
  type SubscriptionData,
  type SubscriptionDataMap,
  type SubscriptionDatasetState,
  type SubscriptionOutcome,
  type SubscriptionTrigger,
} from '../shared/subscriptions.js';
import type { ExtensionUpdateOptions, Settings } from '../shared/types.js';

const SETTINGS_KEY = 'settings';
const PRESET_FILE = 'presets/default-rules.yaml';
const SUSPENDED_KEY = 'suspended';
const UPDATE_STATE_KEY = 'datasetUpdateState';
const UPDATE_ALARM = 'dataset-update';
const EXTENSION_UPDATE_ALARM = 'extension-update';
const SUBSCRIPTION_ALARM = 'subscription-update';
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

/**
 * Settings for a fresh install. The unpacked build ships an editable rules file,
 * presets/default-rules.yaml; the .crx does not, and generates the example preset instead.
 */
async function firstRunSettings(): Promise<Settings> {
  let text: string | null = null;
  try {
    const res = await fetch(chrome.runtime.getURL(PRESET_FILE));
    if (res.ok) text = await res.text();
  } catch {
    // Not in the package (the .crx build).
  }
  if (text !== null) {
    const r = importConfigText(text, defaultSettings());
    if (r.settings && !r.errors.length) {
      info(`First run: installed ${r.settings.rules.length} rule(s) from ${PRESET_FILE}.`);
      for (const w of r.warnings) log({ t: Date.now(), level: 'warn', tabId: null, msg: `${PRESET_FILE}: ${w}` });
      return r.settings;
    }
    log({ t: Date.now(), level: 'warn', tabId: null, msg: `First run: ${PRESET_FILE} is invalid (${r.errors.join(' ')}); generated the example rule preset instead.` });
  } else {
    info(`First run: no ${PRESET_FILE} in the package; generated the example rule preset.`);
  }
  return defaultSettings();
}

async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  if (stored === undefined) {
    const s = await firstRunSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
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
  if (!enabled) return { text: 'OFF', color: BADGE_COLORS.off, title: t('bg.badge.off') };
  if (suspended) return { text: '||', color: BADGE_COLORS.off, title: t('bg.badge.paused') };
  const p = s.resolution.profile;
  if (!p) return { text: '', color: BADGE_COLORS.off, title: t('bg.badge.system', { host: s.host ?? '' }) };
  const code = (p.locale.split('-')[0] ?? '').toUpperCase().slice(0, 3);
  if (s.session === 'restricted') return { text: '', color: BADGE_COLORS.off, title: t('bg.badge.restricted') };
  if (s.session !== 'attached' || s.late || s.warnings.length) {
    return { text: `${code}!`, color: BADGE_COLORS.warn, title: t('bg.badge.warn', { locale: p.locale, reason: s.late ? t('status.reloadNeeded') : (s.error ?? s.warnings[0] ?? t('status.notActive')) }) };
  }
  return { text: code, color: BADGE_COLORS.ok, title: t('bg.badge.active', { locale: p.locale, host: s.host ?? '' }) };
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

// ------------------------------------------------------ pending navigations

/**
 * Method of each tab's latest top-level request (memory only), so a load that was
 * already in flight when the debugger attached is restarted only if repeating it is
 * safe. Top-level navigations wake the worker through webNavigation anyway, so this
 * listener adds no wake-ups.
 */
const topLevelRequests = new Map<number, { url: string; method: string }>();
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    topLevelRequests.set(d.tabId, { url: d.url, method: d.method });
    if (topLevelRequests.size > 500) topLevelRequests.delete(topLevelRequests.keys().next().value!);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
);

/** When the browser or this extension last started; loads in flight right after are the browser's own. */
const JUST_STARTED_MS = 10_000;
let startedAt: number | null = null;

/** Re-read the data sets after they were downloaded, replaced or deleted. */
async function reloadDatasets(m: SessionManager): Promise<void> {
  datasets.reset();
  await datasets.ensure(requiredDatasets(m.currentSettings.rules));
  await m.updateSettings(m.currentSettings);
  await syncDnr(m.currentSettings, m.isSuspended);
  await refreshGlobalBadge();
}

const updater = new DatasetUpdater({
  now: () => Date.now(),
  options: () => manager!.currentSettings.options.datasetUpdates,
  needed: () => {
    const r = requiredDatasets(manager!.currentSettings.rules);
    return { geosite: r.geosite.length > 0, geoip: r.geoip, asn: r.asn };
  },
  listMetas: () => listDatasets(),
  getState: async () => ((await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] as DatasetUpdateState | undefined) ?? {},
  setState: (s) => chrome.storage.local.set({ [UPDATE_STATE_KEY]: s }),
  onUpdated: async () => {
    await reloadDatasets(manager!);
    info('Data sets updated; rules re-evaluated.');
  },
  log: (level, msg) => log({ t: Date.now(), level, tabId: null, msg }),
  keepAlive: () => {
    // A long download is not an extension event; touch an extension API so Chrome
    // does not stop the idle worker halfway through.
    const timer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
    return () => clearInterval(timer);
  },
});

/** The hourly alarms exist only while a regular interval is chosen; they just check whether one is due. */
async function syncUpdateAlarm(settings: Settings): Promise<void> {
  for (const [name, interval] of [
    [UPDATE_ALARM, settings.options.datasetUpdates.interval],
    [EXTENSION_UPDATE_ALARM, settings.options.extensionUpdates.interval],
    [SUBSCRIPTION_ALARM, settings.subscriptions.some((x) => x.enabled && x.interval !== 'off') ? 'daily' : 'off'],
  ] as const) {
    const want = interval !== 'off';
    const has = await chrome.alarms.get(name);
    if (want && !has) await chrome.alarms.create(name, { delayInMinutes: 1, periodInMinutes: 60 });
    if (!want && has) await chrome.alarms.clear(name);
  }
}

// ------------------------------------------------------------- subscriptions

/** Your settings as stored; the manager works with these plus the subscription rules. */
let ownSettings: Settings | null = null;
/** Rules last fetched for each subscription (mirrors storage.local[SUBSCRIPTION_DATA_KEY]). */
let subscriptionData: SubscriptionDataMap = {};

async function loadSubscriptionData(): Promise<SubscriptionDataMap> {
  return ((await chrome.storage.local.get(SUBSCRIPTION_DATA_KEY))[SUBSCRIPTION_DATA_KEY] as SubscriptionDataMap | undefined) ?? {};
}

/** Apply settings (or new subscription rules) everywhere: data sets, IP watcher, tabs, DNR, badge. */
async function applySettings(m: SessionManager, own: Settings): Promise<Settings> {
  const s = withSubscriptions(own, subscriptionData);
  await datasets.ensure(requiredDatasets(s.rules));
  syncIpWatcher(s);
  await m.updateSettings(s);
  await syncDnr(s, m.isSuspended);
  await refreshGlobalBadge();
  return s;
}

let subscriptionRuns: Promise<unknown> = Promise.resolve();

/** Fetch the subscriptions that are due (or the given ones); runs one after another. */
function runSubscriptions(trigger: SubscriptionTrigger, ids?: string[]): Promise<SubscriptionOutcome[]> {
  const run = subscriptionRuns.then(() => updateSubscriptions(trigger, ids));
  subscriptionRuns = run.catch(() => undefined);
  return run;
}

async function updateSubscriptions(trigger: SubscriptionTrigger, ids?: string[]): Promise<SubscriptionOutcome[]> {
  const m = await ready;
  const own = ownSettings!;
  const persist = () => chrome.storage.local.set({ [SUBSCRIPTION_DATA_KEY]: subscriptionData });
  let rulesChanged = false;
  // Forget what was fetched for subscriptions that were removed.
  for (const id of Object.keys(subscriptionData)) {
    if (own.subscriptions.some((x) => x.id === id)) continue;
    delete subscriptionData[id];
    rulesChanged = true;
  }
  const outcomes: SubscriptionOutcome[] = [];
  for (const sub of own.subscriptions) {
    if (ids && !ids.includes(sub.id)) continue;
    const prev = subscriptionData[sub.id];
    if (!subscriptionDue(sub, prev, trigger, Date.now())) {
      outcomes.push({ id: sub.id, result: 'skipped' });
      continue;
    }
    const url = rawUrl(sub.url);
    // Rules fetched from a previous URL no longer apply.
    const base: SubscriptionData = prev && prev.url === url ? prev : { url, rules: [], skipped: [], skippedCount: 0, ignored: [] };
    if (prev && prev.url !== url) rulesChanged = true;
    // Recorded before fetching, so a failure also counts against the minimum gap.
    subscriptionData[sub.id] = { ...base, lastAttempt: Date.now() };
    await persist();
    const name = subscriptionLabel(sub);
    try {
      const r = await fetchSubscription(sub, base.fetchedAt !== undefined ? base : undefined);
      if (r.status === 'unchanged') {
        const { error: _old, ...rest } = subscriptionData[sub.id]!;
        subscriptionData[sub.id] = { ...rest, fetchedAt: Date.now() };
        outcomes.push({ id: sub.id, result: 'unchanged', count: rest.rules.length });
        info(`Subscription "${name}" is unchanged.`);
      } else {
        subscriptionData[sub.id] = r.data;
        rulesChanged = true;
        outcomes.push({ id: sub.id, result: 'updated', count: r.data.rules.length });
        info(`Subscription "${name}" updated: ${r.data.rules.length} rule(s)${r.data.skippedCount ? `, ${r.data.skippedCount} skipped` : ''}.`);
      }
    } catch (e) {
      const error = errorMessage(e);
      subscriptionData[sub.id] = { ...subscriptionData[sub.id]!, error };
      outcomes.push({ id: sub.id, result: 'failed', error });
      log({ t: Date.now(), level: 'warn', tabId: null, msg: `Subscription "${name}" failed: ${error}` });
    }
  }
  await persist();
  if (rulesChanged && ownSettings) await applySettings(m, ownSettings);
  await downloadSubscriptionDatasets(m);
  return outcomes;
}

/**
 * Download the data sets that subscription rules need and that are not installed
 * (option "Download the data sets subscriptions need", on by default). The URL is the
 * one the subscription names, or the built-in default; failures are retried after an hour.
 */
async function downloadSubscriptionDatasets(m: SessionManager): Promise<void> {
  const own = ownSettings;
  if (!own?.options.subscriptionDatasets) return;
  const installed = (await listDatasets()).map((x) => x.kind);
  const todo = datasetsToDownload(own, subscriptionData, installed);
  if (!todo.length) return;
  const state = ((await chrome.storage.local.get(SUBSCRIPTION_DATASET_STATE_KEY))[SUBSCRIPTION_DATASET_STATE_KEY] as SubscriptionDatasetState | undefined) ?? {};
  let saved = false;
  for (const job of todo) {
    if (!datasetDownloadDue(state[job.kind], job.url, Date.now())) continue;
    const label = DATASETS[job.kind].label;
    info(`Downloading ${label} for subscription "${job.for}" from ${job.url}…`);
    try {
      const r = await downloadDataset(job.kind, job.url);
      state[job.kind] = { url: job.url, for: job.for, at: Date.now(), ok: true };
      if (r.status === 'saved') {
        saved = true;
        info(`${label} downloaded for subscription "${job.for}" (${r.meta.summary}).`);
      }
    } catch (e) {
      state[job.kind] = { url: job.url, for: job.for, at: Date.now(), ok: false, error: errorMessage(e) };
      log({ t: Date.now(), level: 'warn', tabId: null, msg: `${label} download for subscription "${job.for}" failed: ${errorMessage(e)}` });
    }
    await chrome.storage.local.set({ [SUBSCRIPTION_DATASET_STATE_KEY]: state });
  }
  if (saved) await reloadDatasets(m);
}

// --------------------------------------------------------- extension updates

let extensionCheck: Promise<ExtensionUpdateState> | null = null;

async function readExtensionUpdateState(): Promise<ExtensionUpdateState> {
  return ((await chrome.storage.local.get(EXTENSION_UPDATE_STATE_KEY))[EXTENSION_UPDATE_STATE_KEY] as ExtensionUpdateState | undefined) ?? {};
}

/**
 * Ask the release address for the latest version, if a check is due (manual checks
 * always are). One check at a time; the attempt is recorded before fetching, so a
 * failure also counts against the minimum gap between automatic checks.
 */
function checkExtensionUpdate(trigger: CheckTrigger, opts: ExtensionUpdateOptions): Promise<ExtensionUpdateState> {
  extensionCheck ??= (async () => {
    const state = await readExtensionUpdateState();
    const now = Date.now();
    if (!checkDue(opts, state, trigger, now)) return state;
    const next: ExtensionUpdateState = { ...state, lastAttempt: now };
    await chrome.storage.local.set({ [EXTENSION_UPDATE_STATE_KEY]: next });
    const current = chrome.runtime.getManifest().version;
    try {
      next.latest = await fetchLatestRelease(opts.source);
      next.lastChecked = Date.now();
      delete next.lastError;
      info(compareVersions(next.latest.version, current) > 0 ? `Locale Jacket ${next.latest.version} is available (installed: ${current}).` : `Locale Jacket is up to date (${current}).`);
    } catch (e) {
      next.lastError = errorMessage(e);
      log({ t: Date.now(), level: 'warn', tabId: null, msg: `Update check failed: ${next.lastError}` });
    }
    await chrome.storage.local.set({ [EXTENSION_UPDATE_STATE_KEY]: next });
    return next;
  })().finally(() => {
    extensionCheck = null;
  });
  return extensionCheck;
}

const ready: Promise<SessionManager> = (async () => {
  ownSettings = await loadSettings();
  subscriptionData = await loadSubscriptionData();
  const settings = withSubscriptions(ownSettings, subscriptionData);
  const suspended = Boolean((await chrome.storage.session.get(SUSPENDED_KEY))[SUSPENDED_KEY]);
  setLanguage(settings.options.uiLanguage);
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
    // A tab still navigating reports where it is going in pendingUrl.
    listTabs: async () => (await chrome.tabs.query({})).filter((t) => t.id !== undefined).map((t) => ({ id: t.id!, url: t.pendingUrl || t.url || null })),
    pendingNavigation: async (tabId) => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab?.pendingUrl) return null;
      const seen = topLevelRequests.get(tabId);
      return { url: tab.pendingUrl, method: seen && seen.url === tab.pendingUrl ? seen.method : undefined };
    },
    justStarted: () => startedAt !== null && Date.now() - startedAt < JUST_STARTED_MS,
    onStatus: updateBadge,
    onTabGone: (tabId) => topLevelRequests.delete(tabId),
    log,
  });
  // Tabs first: at browser start the startup page is already loading, and every
  // millisecond before the debugger attaches is one its scripts may run unspoofed.
  void manager.reconcileAll();
  return manager;
})();

/** The rest of start-up; event handlers do not wait for it. */
const initialized: Promise<SessionManager> = ready.then(async (m) => {
  const settings = m.currentSettings;
  await syncDnr(settings, m.isSuspended);
  await refreshGlobalBadge();
  await syncUpdateAlarm(settings).catch((e) => log({ t: Date.now(), level: 'warn', tabId: null, msg: `Update alarm: ${errorMessage(e)}` }));
  info(`Service worker ready (${settings.rules.length} rules, ${settings.enabled ? 'enabled' : 'disabled'}${m.isSuspended ? ', paused' : ''}).`);
  // Fetch subscriptions that have no rules yet (for example added by an import while the worker slept).
  void runSubscriptions('changed');
  return m;
});

initialized.catch((e) => log({ t: Date.now(), level: 'error', tabId: null, msg: `Initialization failed: ${errorMessage(e)}` }));

// Diagnostics handle, reachable only from this worker's own DevTools console
// (chrome://extensions → "service worker"). Used by the e2e suite.
(globalThis as unknown as { localeJacket: unknown }).localeJacket = {
  ready: () => initialized.then(() => true),
  status: (tabId: number) => manager?.status(tabId) ?? null,
  statuses: () => manager?.statuses() ?? [],
  global: () => (manager ? globalStatus(manager) : null),
  log: () => [...logEntries],
  /** Run the data-set updater as if triggered by a browser start or the alarm. */
  runDatasetUpdates: (trigger: 'startup' | 'alarm') => ready.then(() => updater.run(trigger)),
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
    const { settings: own, problems } = sanitizeStoredSettings(changes[SETTINGS_KEY]!.newValue, defaultSettings());
    ownSettings = own;
    settingsProblems = problems;
    setLanguage(own.options.uiLanguage);
    const settings = await applySettings(m, own);
    await syncUpdateAlarm(settings).catch(() => undefined);
    info(`Settings updated (${settings.rules.length} rules, ${settings.enabled ? 'enabled' : 'disabled'}).`);
    // A subscription that was just added, or whose URL changed, is fetched right away.
    void runSubscriptions('changed');
  });
});

chrome.runtime.onInstalled.addListener((d) => {
  startedAt = Date.now();
  info(`Installed (${d.reason}${d.previousVersion ? ` from ${d.previousVersion}` : ''}).`);
});
chrome.runtime.onStartup.addListener(() => {
  startedAt = Date.now();
  info('Browser started.');
  withManager((m) => (autoUpdatesEnabled(m.currentSettings.options.datasetUpdates) ? updater.run('startup') : undefined));
  withManager((m) => checkExtensionUpdate('startup', m.currentSettings.options.extensionUpdates));
  withManager(() => runSubscriptions('startup'));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) withManager(() => updater.run('alarm'));
  if (alarm.name === EXTENSION_UPDATE_ALARM) withManager((m) => checkExtensionUpdate('alarm', m.currentSettings.options.extensionUpdates));
  if (alarm.name === SUBSCRIPTION_ALARM) withManager(() => runSubscriptions('alarm'));
});

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
  initialized
    .then(async (m) => {
      switch (msg.type) {
        case 'getStatus':
          return { status: m.status(msg.tabId), global: globalStatus(m) };
        case 'listStatuses':
          return { statuses: m.statuses(), global: globalStatus(m) };
        case 'verify': {
          const r = await m.verify(msg.tabId);
          if (r.attached) return r;
          // No debugger session (e.g. a site left at the system language): read the live values another way.
          return verifyWithScripting(msg.tabId, m.status(msg.tabId)?.resolution.profile?.locale ?? null);
        }
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
          await reloadDatasets(m);
          info('Data sets changed; rules re-evaluated.');
          return { ok: true, problems: datasets.missing };
        case 'updateSubscriptions':
          return { outcomes: await runSubscriptions('manual', msg.ids) };
        case 'checkExtensionUpdate':
          return { state: await checkExtensionUpdate('manual', m.currentSettings.options.extensionUpdates) };
        case 'checkDatasetUpdates':
          return { outcomes: await updater.run('manual'), problems: datasets.missing };
        case 'getDatasetUpdateState':
          return {
            state: ((await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] as DatasetUpdateState | undefined) ?? {},
            busy: updater.busy,
            alarm: Boolean(await chrome.alarms.get(UPDATE_ALARM)),
          };
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
