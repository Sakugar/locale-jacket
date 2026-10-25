// Popup: global switch, current-tab status, quick per-site rule, default action.

import { hostFromUrl, toUnicode } from '../shared/domain.js';
import { availableUpdate, EXTENSION_UPDATE_STATE_KEY, type ExtensionUpdateState } from '../shared/extension-update.js';
import { setLanguage, t, translateDocument } from '../shared/i18n.js';
import { describeProfile, makeProfile } from '../shared/locale.js';
import { send, type GlobalStatus, type HostTest, type TabStatus, type VerifyResult } from '../shared/messages.js';
import { newRuleId, resolveHost } from '../shared/rules.js';
import type { LocaleProfile, Rule, RuleType, Settings } from '../shared/types.js';
import { $, chip, clear, h, preserveFocus, toggleSwitch } from '../ui/dom.js';
import { localePicker } from '../ui/locale-picker.js';
import { describeStatus } from '../ui/status.js';
import { loadSettings, onSettingsChanged, updateSettings } from '../ui/store.js';

let settings: Settings;
let tab: chrome.tabs.Tab | undefined;
let status: TabStatus | null = null;
let global: GlobalStatus | null = null;
let verify: VerifyResult | null = null;
let verifying = false;
/** A check was asked for while one was running; run it once the current one ends. */
let verifyPending = false;
/** Bumped on navigation, so a check that started on the previous document is dropped. */
let verifyToken = 0;
/** Checks re-run because the tab still showed the previous document (reset on navigation). */
let verifyRetries = 0;
const MAX_VERIFY_RETRIES = 20;
/** The user asked for a check; keep re-reading it after reloads and navigations. */
let watchVerify = false;
/** "Saved" note of the site card, kept across rebuilds while the host stays the same. */
let savedNote: { host: string; text: string } | null = null;
/** Resolution from the background worker (includes data sets and the observed server address). */
let hostTest: HostTest | null = null;

/** What each card was last built from; a card is rebuilt only when this changes. */
const renderedKeys = new Map<string, string>();

function renderIfChanged(name: string, key: unknown, render: () => void): void {
  const k = JSON.stringify(key);
  if (renderedKeys.get(name) === k) return;
  renderedKeys.set(name, k);
  preserveFocus(document.body, render);
}

// Live regions stay the same nodes across rebuilds, so screen readers announce only real changes.
const liveChip = h('span', { 'aria-live': 'polite', 'aria-atomic': 'true' });
const liveDetail = h('p', { class: 'small muted', 'aria-live': 'polite' });

function setLive(el: HTMLElement, key: string, ...content: (Node | string)[]): HTMLElement {
  if (el.dataset['key'] !== key) {
    el.dataset['key'] = key;
    clear(el);
    el.append(...content);
  }
  return el;
}

function currentHost(): string | null {
  return tab?.url ? hostFromUrl(tab.url) : null;
}

async function refreshStatus(): Promise<void> {
  if (tab?.id === undefined) return;
  try {
    const r = await send({ type: 'getStatus', tabId: tab.id });
    status = r.status;
    global = r.global;
    hostTest = tab.url && hostFromUrl(tab.url) ? await send({ type: 'testHost', host: tab.url }) : null;
  } catch {
    status = null;
  }
}

function renderHeader(): void {
  renderIfChanged('header', [settings.options.uiLanguage, settings.enabled, !!global?.suspended], buildHeader);
}

function buildHeader(): void {
  const slot = $('#globalToggle');
  clear(slot);
  const toggle = toggleSwitch(settings.enabled, (v) => void updateSettings((s) => ({ ...s, enabled: v })), t(settings.enabled ? 'popup.turnOff' : 'popup.turnOn'));
  toggle.querySelector('input')!.dataset['focus'] = 'globalToggle';
  slot.append(toggle);
  const banner = $('#banner');
  banner.hidden = !global?.suspended;
  clear(banner);
  if (global?.suspended) {
    banner.className = 'notice warn row';
    banner.append(
      h('span', { class: 'spacer' }, t('popup.pausedBanner')),
      h('button', {
        class: 'primary',
        'data-focus': 'resume',
        onclick: async () => {
          await send({ type: 'resume' });
          await refresh();
        },
      }, t('common.resume')),
    );
  }
}

function renderTab(): void {
  // updatedAt changes on every status read without anything visible changing.
  const shownStatus = status ? { ...status, updatedAt: 0 } : null;
  const shownGlobal = global ? { enabled: global.enabled, suspended: global.suspended } : null;
  renderIfChanged(
    'tab',
    [settings.options.uiLanguage, tab?.url, shownStatus, shownGlobal, hostTest, settings.rules, settings.defaultAction, verify, verifying],
    buildTab,
  );
}

function buildTab(): void {
  const card = $('#tabCard');
  clear(card);
  const host = currentHost();
  if (!host) {
    card.append(h('div', { class: 'section-title' }, t('popup.thisTab')), h('p', { class: 'muted' }, t('popup.internalPage')));
    return;
  }
  const res = effectiveResolution(host);
  const view = describeStatus(status, global);
  card.append(
    h('div', { class: 'row' }, h('div', { class: 'section-title' }, t('popup.thisTab')), h('span', { class: 'spacer' }), setLive(liveChip, `${view.kind}|${view.label}`, chip(view.label, view.kind))),
    h('div', { class: 'host' }, toUnicode(host)),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, t('popup.matched')),
      h('dd', {}, res.ruleLabel ?? (res.source === 'default' ? t('popup.noRuleDefault') : '—')),
      h('dt', {}, t('popup.profile')),
      h('dd', {}, describeProfile(res.profile)),
      ...(res.profile ? [h('dt', {}, 'Accept-Language'), h('dd', {}, res.profile.acceptLanguage)] : []),
      ...(res.ip ? [h('dt', {}, t('popup.serverAddress')), h('dd', {}, res.ip)] : []),
      ...(status && (status.frames || status.workers)
        ? [h('dt', {}, t('popup.framesWorkers')), h('dd', {}, t('popup.framesWorkersValue', { frames: status.frames, workers: status.workers }))]
        : []),
    ),
    setLive(liveDetail, view.detail, view.detail),
  );
  if (status?.warnings.length && status.warnings.length > 1) {
    card.append(h('div', { class: 'notice warn' }, h('ul', {}, ...status.warnings.map((w) => h('li', {}, w)))));
  }

  const actions = h('div', { class: 'row wrap' });
  if (status && (status.late || (res.profile && status.session !== 'attached'))) {
    actions.append(
      h('button', {
        class: 'primary',
        'data-focus': 'reloadTab',
        onclick: async () => {
          if (tab?.id !== undefined) await send({ type: 'reloadTab', tabId: tab.id });
          window.close();
        },
      }, t('popup.reloadTab')),
    );
  }
  actions.append(
    h('button', {
      disabled: verifying,
      'data-focus': 'checkPage',
      onclick: () => {
        watchVerify = true;
        void runVerify();
      },
    }, t(verifying ? 'popup.checking' : 'popup.checkPage')),
  );
  card.append(actions);
  if (verify) card.append(renderVerify(verify));
}

/**
 * Read what the page sees; once asked for, the report is re-read when the tab reloads or navigates.
 * A request during a running check runs after it; a result from a previous document is dropped.
 */
async function runVerify(): Promise<void> {
  if (tab?.id === undefined) return;
  if (verifying) {
    verifyPending = true;
    return;
  }
  verifying = true;
  const token = verifyToken;
  const url = tab.url;
  renderTab();
  let result: VerifyResult;
  try {
    result = await send({ type: 'verify', tabId: tab.id });
  } catch (e) {
    result = { ok: false, attached: false, source: 'script', frames: [], error: (e as Error).message };
  }
  verifying = false;
  // tab.url can already be the next page while the tab still shows the previous document
  // (a navigation in flight or re-issued): such a report belongs to the old page.
  const readFrom = result.frames.find((f) => f.kind === 'main')?.url;
  const readHost = readFrom ? hostFromUrl(readFrom) : null; // null for error pages: accept those
  const sameDocument = !readHost || !url || readHost === hostFromUrl(url);
  if (token === verifyToken && tab?.url === url && sameDocument) {
    verify = result;
  } else if (token === verifyToken && !sameDocument && verifyRetries < MAX_VERIFY_RETRIES) {
    verifyRetries++;
    setTimeout(() => void runVerify(), 300); // read again once the new page is there
  }
  if (verifyPending) {
    verifyPending = false;
    void runVerify();
    return;
  }
  renderTab();
}

function renderVerify(v: VerifyResult): HTMLElement {
  const box = h('div', { class: 'verify stack' });
  if (v.error) {
    box.append(h('div', { class: 'notice bad' }, v.error));
    return box;
  }
  const rows: [string, (s: NonNullable<VerifyResult['frames'][number]['live']>) => string, boolean][] = [
    ['navigator.language', (s) => s.language, true],
    ['navigator.languages', (s) => s.languages.join(', '), false],
    ['Intl.DateTimeFormat', (s) => s.dateLocale, true],
    ['Intl.NumberFormat', (s) => s.numberLocale, true],
    ['Intl.Collator', (s) => s.collatorLocale, true],
    [t('common.timeZone'), (s) => s.timeZone, false],
  ];
  const withStart = v.source === 'debugger';
  for (const f of v.frames) {
    const title = f.kind === 'main' ? t('common.page') : t('common.frameHost', { host: hostFromUrl(f.url) ?? '' });
    const table = h('table', {}, h('tr', {}, h('th', {}, title), ...(withStart ? [h('th', {}, t('common.atStart'))] : []), h('th', {}, t('common.now'))));
    if (f.error) {
      box.append(h('div', { class: 'notice bad' }, `${f.kind}: ${f.error}`));
      continue;
    }
    for (const [label, get, checked] of rows) {
      const start = f.start ? get(f.start) : 'n/a';
      const live = f.live ? get(f.live) : 'n/a';
      const check = (val: string) => (f.expectedLocale && checked ? (val === f.expectedLocale ? 'ok' : 'bad') : '');
      table.append(h('tr', {}, h('th', {}, label), ...(withStart ? [h('td', { class: check(start) }, start)] : []), h('td', { class: check(live) }, live)));
    }
    box.append(table);
  }
  box.append(h('p', { class: 'small muted' }, t(withStart ? 'popup.verifyNote' : 'popup.verifyNoteScript')));
  return box;
}

/** Prefer the worker's answer; fall back to local hostname rules if it is unavailable. */
function effectiveResolution(host: string): { action: string; source: string; ruleId: string | null; ruleLabel: string | null; profile: LocaleProfile | null; ip: string | null } {
  if (hostTest && hostTest.host === host) return hostTest.resolution;
  const r = resolveHost(host, settings);
  return { action: r.action, source: r.source, ruleId: r.rule?.id ?? null, ruleLabel: null, profile: r.profile, ip: r.ip };
}

function suggestedSuffix(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Rebuilt only when what it shows changed, so a half-made choice or the "Saved" note survives other updates. */
function renderSite(): void {
  const host = currentHost();
  const res = host ? effectiveResolution(host) : null;
  // Only what the card uses: a newly observed server address alone does not rebuild it.
  const shown = res ? [res.ruleId, res.action, res.profile?.locale ?? null] : null;
  renderIfChanged('site', [settings.options.uiLanguage, host, shown, settings.rules], () => buildSite(host, res));
}

function buildSite(host: string | null, res: ReturnType<typeof effectiveResolution> | null): void {
  const card = $('#siteCard');
  clear(card);
  card.hidden = !host;
  if (!host || !res) return;
  const matched = res.ruleId ? settings.rules.find((r) => r.id === res.ruleId) : undefined;

  // Scope choices: the suffix rule that matched (if any), the host without "www.", or this exact host.
  const choices: { type: RuleType; value: string; label: string }[] = [];
  const add = (type: RuleType, value: string, label: string) => {
    if (!choices.some((c) => c.type === type && c.value === value)) choices.push({ type, value, label });
  };
  if (matched?.type === 'DOMAIN-SUFFIX') add('DOMAIN-SUFFIX', matched.value, t('popup.scopeSuffix', { domain: toUnicode(matched.value) }));
  add('DOMAIN-SUFFIX', suggestedSuffix(host), t('popup.scopeSuffix', { domain: toUnicode(suggestedSuffix(host)) }));
  add('DOMAIN', host, t('popup.scopeExact', { host: toUnicode(host) }));
  const msg = h('div', { class: 'hint' }, savedNote?.host === host ? savedNote.text : '');
  const clearNote = () => {
    savedNote = null;
    msg.textContent = '';
  };
  const scope = h('select', { 'aria-label': t('popup.appliesTo'), 'data-focus': 'siteScope', onchange: clearNote }, ...choices.map((c, i) => h('option', { value: String(i) }, c.label)));
  const ownIndex = choices.findIndex((c) => settings.rules.some((r) => r.type === c.type && r.value === c.value));
  if (ownIndex >= 0) scope.value = String(ownIndex);
  const ownRule = ownIndex >= 0 ? settings.rules.find((r) => r.type === choices[ownIndex]!.type && r.value === choices[ownIndex]!.value) : undefined;
  const picker = localePicker(res.action === 'SYSTEM' ? null : res.profile!.locale, { allowSystem: true, onChange: clearNote });
  const save = h('button', {
    class: 'primary',
    'data-focus': 'saveRule',
    onclick: async () => {
      const locale = picker.value();
      if (locale === undefined) return;
      const { type, value } = choices[Number(scope.value)]!;
      await updateSettings((s) => {
        const existing = s.rules.find((r) => r.type === type && r.value === value);
        const patch: Pick<Rule, 'action' | 'profile' | 'enabled'> = locale === null
          ? { action: 'SYSTEM', profile: null, enabled: true }
          : { action: 'PROFILE', profile: existing?.profile?.locale === locale ? existing.profile : makeProfile(locale), enabled: true };
        if (existing) Object.assign(existing, patch);
        else s.rules.push({ id: newRuleId(), type, value, priority: 0, note: '', ...patch });
      });
      // Kept in module state: the save changes the settings, which rebuilds this card.
      savedNote = { host, text: t('popup.saved') };
      msg.textContent = savedNote.text;
    },
  }, t('popup.saveRule'));

  card.append(
    h('div', { class: 'section-title' }, t('popup.ruleForSite')),
    h('label', { class: 'field' }, h('span', {}, t('popup.appliesTo')), scope),
    h('div', { class: 'field' }, h('span', {}, t('popup.reportLocale')), picker.el),
    h('div', { class: 'row wrap' },
      save,
      ownRule
        ? h('button', {
            class: 'danger',
            'data-focus': 'removeRule',
            onclick: async () => {
              savedNote = null;
              await updateSettings((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== ownRule.id) }));
            },
          }, t('popup.removeRule'))
        : null,
    ),
    msg,
  );
}

function renderDefault(): void {
  renderIfChanged('default', [settings.options.uiLanguage, settings.defaultAction], buildDefault);
}

function buildDefault(): void {
  const card = $('#defaultCard');
  clear(card);
  const d = settings.defaultAction;
  const current = d.action === 'SYSTEM' ? null : d.profile.locale;
  const apply = h('button', {
    disabled: true,
    'data-focus': 'applyDefault',
    onclick: () => {
      const v = picker.value();
      if (v === undefined) return;
      void updateSettings((s) => {
        s.defaultAction = v === null ? { action: 'SYSTEM' } : { action: 'PROFILE', profile: s.defaultAction.action === 'PROFILE' && s.defaultAction.profile.locale === v ? s.defaultAction.profile : makeProfile(v) };
      });
    },
  }, t('common.apply'));
  const picker = localePicker(current, {
    allowSystem: true,
    onChange: () => {
      const v = picker.value();
      apply.disabled = v === undefined || v === current;
    },
  });
  card.append(h('div', { class: 'section-title' }, t('popup.otherSites')), picker.el, h('div', { class: 'row' }, apply), h('p', { class: 'small muted' }, t('popup.otherSitesHint')));
}

/** The installed version, and a tip when the last update check found a newer one. */
async function renderVersion(): Promise<void> {
  const version = chrome.runtime.getManifest().version;
  $('#version').textContent = `v${version}`;
  const state = (await chrome.storage.local.get(EXTENSION_UPDATE_STATE_KEY))[EXTENSION_UPDATE_STATE_KEY] as ExtensionUpdateState | undefined;
  const next = availableUpdate(state, version);
  const tip = $('#updateTip');
  tip.hidden = !next;
  clear(tip);
  if (!next) return;
  tip.className = 'notice info row';
  tip.append(
    h('span', { class: 'spacer' }, t('popup.updateTip', { version: next.version })),
    h('button', {
      class: 'link',
      onclick: () => {
        void chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#updates') });
        window.close();
      },
    }, t('popup.updateTipLink')),
  );
}

async function refresh(): Promise<void> {
  settings = await loadSettings();
  setLanguage(settings.options.uiLanguage);
  translateDocument();
  await refreshStatus();
  renderHeader();
  renderTab();
  renderSite();
  renderDefault();
  await renderVersion();
}

async function main(): Promise<void> {
  // ?tabId=N targets a specific tab (used when the popup is opened as a page, e.g. for screenshots).
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  if (forced) tab = await chrome.tabs.get(forced).catch(() => undefined);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#openOptions').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });
  await refresh();
  onSettingsChanged(() => {
    void refresh().then(() => (watchVerify ? runVerify() : undefined));
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id !== tab?.id) return;
    if (change.url && change.url !== tab.url) {
      tab.url = change.url;
      // The shown report and any running check belong to the previous document.
      verify = null;
      verifyToken++;
      verifyRetries = 0;
      if (savedNote && savedNote.host !== currentHost()) savedNote = null;
      renderTab();
      renderSite();
    }
    if (change.status === 'complete' && watchVerify) void runVerify();
  });
  // Keep the status chip current while the popup is open (e.g. after a reload). Cards are
  // rebuilt only when something they show changed, so clicks and focus are not lost.
  setInterval(async () => {
    await refreshStatus();
    renderHeader();
    renderTab();
    renderSite();
  }, 1500);
}

void main();
