// Popup: global switch, current-tab status, quick per-site rule, default action.

import { hostFromUrl, toUnicode } from '../shared/domain.js';
import { availableUpdate, EXTENSION_UPDATE_STATE_KEY, type ExtensionUpdateState } from '../shared/extension-update.js';
import { setLanguage, t, translateDocument } from '../shared/i18n.js';
import { describeProfile, makeProfile } from '../shared/locale.js';
import { send, type GlobalStatus, type HostTest, type TabStatus, type VerifyResult } from '../shared/messages.js';
import { newRuleId, resolveHost } from '../shared/rules.js';
import type { LocaleProfile, Rule, RuleType, Settings } from '../shared/types.js';
import { $, chip, clear, h, toggleSwitch } from '../ui/dom.js';
import { localePicker } from '../ui/locale-picker.js';
import { describeStatus } from '../ui/status.js';
import { loadSettings, onSettingsChanged, updateSettings } from '../ui/store.js';

let settings: Settings;
let tab: chrome.tabs.Tab | undefined;
let status: TabStatus | null = null;
let global: GlobalStatus | null = null;
let verify: VerifyResult | null = null;
let verifying = false;
/** Resolution from the background worker (includes data sets and the observed server address). */
let hostTest: HostTest | null = null;

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
  const slot = $('#globalToggle');
  clear(slot);
  slot.append(
    toggleSwitch(settings.enabled, (v) => void updateSettings((s) => ({ ...s, enabled: v })), t(settings.enabled ? 'popup.turnOff' : 'popup.turnOn')),
  );
  const banner = $('#banner');
  banner.hidden = !global?.suspended;
  clear(banner);
  if (global?.suspended) {
    banner.className = 'notice warn row';
    banner.append(
      h('span', { class: 'spacer' }, t('popup.pausedBanner')),
      h('button', {
        class: 'primary',
        onclick: async () => {
          await send({ type: 'resume' });
          await refresh();
        },
      }, t('common.resume')),
    );
  }
}

function renderTab(): void {
  const card = $('#tabCard');
  clear(card);
  const host = tab?.url ? hostFromUrl(tab.url) : null;
  if (!host) {
    card.append(h('div', { class: 'section-title' }, t('popup.thisTab')), h('p', { class: 'muted' }, t('popup.internalPage')));
    return;
  }
  const res = effectiveResolution(host);
  const view = describeStatus(status, global);
  card.append(
    h('div', { class: 'row' }, h('div', { class: 'section-title' }, t('popup.thisTab')), h('span', { class: 'spacer' }), chip(view.label, view.kind)),
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
    h('p', { class: 'small muted' }, view.detail),
  );
  if (status?.warnings.length && status.warnings.length > 1) {
    card.append(h('div', { class: 'notice warn' }, h('ul', {}, ...status.warnings.map((w) => h('li', {}, w)))));
  }

  const actions = h('div', { class: 'row wrap' });
  if (status && (status.late || (res.profile && status.session !== 'attached'))) {
    actions.append(
      h('button', {
        class: 'primary',
        onclick: async () => {
          if (tab?.id !== undefined) await send({ type: 'reloadTab', tabId: tab.id });
          window.close();
        },
      }, t('popup.reloadTab')),
    );
  }
  actions.append(h('button', { disabled: verifying, onclick: () => void runVerify() }, t(verifying ? 'popup.checking' : 'popup.checkPage')));
  card.append(actions);
  if (verify) card.append(renderVerify(verify));
}

/** Read what the page sees; once shown, the report is re-read when the tab reloads or navigates. */
async function runVerify(): Promise<void> {
  if (tab?.id === undefined || verifying) return;
  verifying = true;
  renderTab();
  try {
    verify = await send({ type: 'verify', tabId: tab.id });
  } catch (e) {
    verify = { ok: false, attached: false, source: 'script', frames: [], error: (e as Error).message };
  }
  verifying = false;
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

function renderSite(): void {
  const card = $('#siteCard');
  clear(card);
  const host = tab?.url ? hostFromUrl(tab.url) : null;
  card.hidden = !host;
  if (!host) return;
  const res = effectiveResolution(host);
  const matched = res.ruleId ? settings.rules.find((r) => r.id === res.ruleId) : undefined;

  // Scope choices: the suffix rule that matched (if any), the host without "www.", or this exact host.
  const choices: { type: RuleType; value: string; label: string }[] = [];
  const add = (type: RuleType, value: string, label: string) => {
    if (!choices.some((c) => c.type === type && c.value === value)) choices.push({ type, value, label });
  };
  if (matched?.type === 'DOMAIN-SUFFIX') add('DOMAIN-SUFFIX', matched.value, t('popup.scopeSuffix', { domain: toUnicode(matched.value) }));
  add('DOMAIN-SUFFIX', suggestedSuffix(host), t('popup.scopeSuffix', { domain: toUnicode(suggestedSuffix(host)) }));
  add('DOMAIN', host, t('popup.scopeExact', { host: toUnicode(host) }));
  const scope = h('select', { 'aria-label': t('popup.appliesTo') }, ...choices.map((c, i) => h('option', { value: String(i) }, c.label)));
  const ownIndex = choices.findIndex((c) => settings.rules.some((r) => r.type === c.type && r.value === c.value));
  if (ownIndex >= 0) scope.value = String(ownIndex);
  const ownRule = ownIndex >= 0 ? settings.rules.find((r) => r.type === choices[ownIndex]!.type && r.value === choices[ownIndex]!.value) : undefined;
  const picker = localePicker(res.action === 'SYSTEM' ? null : res.profile!.locale, { allowSystem: true });
  const msg = h('div', { class: 'hint' });
  const save = h('button', {
    class: 'primary',
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
      msg.textContent = t('popup.saved');
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
            onclick: async () => {
              await updateSettings((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== ownRule.id) }));
            },
          }, t('popup.removeRule'))
        : null,
    ),
    msg,
  );
}

function renderDefault(): void {
  const card = $('#defaultCard');
  clear(card);
  const d = settings.defaultAction;
  const current = d.action === 'SYSTEM' ? null : d.profile.locale;
  const apply = h('button', {
    disabled: true,
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
    void refresh().then(() => (verify ? runVerify() : undefined));
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id !== tab?.id) return;
    if (change.url) tab.url = change.url;
    if (change.status === 'complete' && verify) void runVerify();
  });
  // Keep the status chip current while the popup is open (e.g. after a reload).
  setInterval(async () => {
    await refreshStatus();
    renderHeader();
    renderTab();
  }, 1500);
}

void main();
