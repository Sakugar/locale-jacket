// Popup: global switch, current-tab status, quick per-site rule, default action.

import { hostFromUrl, toUnicode } from '../shared/domain.js';
import { describeProfile, makeProfile } from '../shared/locale.js';
import { send, type GlobalStatus, type TabStatus, type VerifyResult } from '../shared/messages.js';
import { newRuleId, resolveHost, ruleLabel } from '../shared/rules.js';
import type { Rule, RuleType, Settings } from '../shared/types.js';
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

async function refreshStatus(): Promise<void> {
  if (tab?.id === undefined) return;
  try {
    const r = await send({ type: 'getStatus', tabId: tab.id });
    status = r.status;
    global = r.global;
  } catch {
    status = null;
  }
}

function renderHeader(): void {
  const slot = $('#globalToggle');
  clear(slot);
  slot.append(
    toggleSwitch(settings.enabled, (v) => void updateSettings((s) => ({ ...s, enabled: v })), settings.enabled ? 'Turn spoofing off' : 'Turn spoofing on'),
  );
  const banner = $('#banner');
  banner.hidden = !global?.suspended;
  clear(banner);
  if (global?.suspended) {
    banner.className = 'notice warn row';
    banner.append(
      h('span', { class: 'spacer' }, 'Paused: debugging was canceled from Chrome’s banner.'),
      h('button', {
        class: 'primary',
        onclick: async () => {
          await send({ type: 'resume' });
          await refresh();
        },
      }, 'Resume'),
    );
  }
}

function renderTab(): void {
  const card = $('#tabCard');
  clear(card);
  const host = tab?.url ? hostFromUrl(tab.url) : null;
  if (!host) {
    card.append(
      h('div', { class: 'section-title' }, 'This tab'),
      h('p', { class: 'muted' }, 'Internal or non-web page. Chrome does not allow extensions to change it, and nothing is spoofed here.'),
    );
    return;
  }
  const res = resolveHost(host, settings);
  const view = describeStatus(status, global);
  card.append(
    h('div', { class: 'row' }, h('div', { class: 'section-title' }, 'This tab'), h('span', { class: 'spacer' }), chip(view.label, view.kind)),
    h('div', { class: 'host' }, toUnicode(host)),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Matched'),
      h('dd', {}, res.rule ? ruleLabel(res.rule) : res.source === 'default' ? 'No rule — default action' : '—'),
      h('dt', {}, 'Profile'),
      h('dd', {}, describeProfile(res.profile)),
      ...(res.profile ? [h('dt', {}, 'Accept-Language'), h('dd', {}, res.profile.acceptLanguage)] : []),
      ...(status && (status.frames || status.workers) ? [h('dt', {}, 'Frames / workers'), h('dd', {}, `${status.frames} cross-site frame(s), ${status.workers} worker(s)`)] : []),
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
      }, 'Reload tab'),
    );
  }
  if (status?.session === 'attached') {
    actions.append(
      h('button', {
        disabled: verifying,
        onclick: async () => {
          if (tab?.id === undefined) return;
          verifying = true;
          renderTab();
          try {
            verify = await send({ type: 'verify', tabId: tab.id });
          } catch (e) {
            verify = { ok: false, attached: false, frames: [], error: (e as Error).message };
          }
          verifying = false;
          renderTab();
        },
      }, verifying ? 'Checking…' : 'Check what the page sees'),
    );
  }
  if (actions.childElementCount) card.append(actions);
  if (verify) card.append(renderVerify(verify));
}

function renderVerify(v: VerifyResult): HTMLElement {
  const box = h('div', { class: 'verify stack' });
  if (v.error) {
    box.append(h('div', { class: 'notice bad' }, v.error));
    return box;
  }
  const rows: [string, (s: NonNullable<VerifyResult['frames'][number]['live']>) => string][] = [
    ['navigator.language', (s) => s.language],
    ['navigator.languages', (s) => s.languages.join(', ')],
    ['Intl.DateTimeFormat', (s) => s.dateLocale],
    ['Intl.NumberFormat', (s) => s.numberLocale],
    ['Intl.Collator', (s) => s.collatorLocale],
    ['Time zone', (s) => s.timeZone],
  ];
  for (const f of v.frames) {
    const table = h('table', {}, h('tr', {}, h('th', {}, f.kind === 'main' ? 'Page' : `Frame ${hostFromUrl(f.url) ?? ''}`), h('th', {}, 'At start'), h('th', {}, 'Now')));
    if (f.error) {
      box.append(h('div', { class: 'notice bad' }, `${f.kind}: ${f.error}`));
      continue;
    }
    for (const [label, get] of rows) {
      const start = f.start ? get(f.start) : 'n/a';
      const live = f.live ? get(f.live) : 'n/a';
      const check = (val: string) => (f.expectedLocale && label !== 'Time zone' && !label.endsWith('languages') ? (val === f.expectedLocale ? 'ok' : 'bad') : '');
      table.append(h('tr', {}, h('th', {}, label), h('td', { class: check(start) }, start), h('td', { class: check(live) }, live)));
    }
    box.append(table);
  }
  box.append(
    h('p', { class: 'small muted' }, '“At start” is what the page’s first scripts saw (n/a if the page loaded before the extension attached). Read from an isolated world, invisible to the page.'),
  );
  return box;
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
  const res = resolveHost(host, settings);

  // Scope choices: the suffix rule that matched (if any), the host without "www.", or this exact host.
  const choices: { type: RuleType; value: string; label: string }[] = [];
  const add = (type: RuleType, value: string, label: string) => {
    if (!choices.some((c) => c.type === type && c.value === value)) choices.push({ type, value, label });
  };
  if (res.rule?.type === 'DOMAIN-SUFFIX') add('DOMAIN-SUFFIX', res.rule.value, `${toUnicode(res.rule.value)} and its subdomains`);
  add('DOMAIN-SUFFIX', suggestedSuffix(host), `${toUnicode(suggestedSuffix(host))} and its subdomains`);
  add('DOMAIN', host, `only ${toUnicode(host)}`);
  const scope = h('select', { 'aria-label': 'Rule scope' }, ...choices.map((c, i) => h('option', { value: String(i) }, c.label)));
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
      msg.textContent = 'Saved. The next navigation in this tab uses it; reload to apply it to this page.';
    },
  }, 'Save rule');

  card.append(
    h('div', { class: 'section-title' }, 'Rule for this site'),
    h('label', { class: 'field' }, h('span', {}, 'Applies to'), scope),
    h('div', { class: 'field' }, h('span', {}, 'Report this locale'), picker.el),
    h('div', { class: 'row wrap' },
      save,
      ownRule
        ? h('button', {
            class: 'danger',
            onclick: async () => {
              await updateSettings((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== ownRule.id) }));
            },
          }, 'Remove rule')
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
  }, 'Apply');
  const picker = localePicker(current, {
    allowSystem: true,
    onChange: () => {
      const v = picker.value();
      apply.disabled = v === undefined || v === current;
    },
  });
  card.append(
    h('div', { class: 'section-title' }, 'All other websites'),
    picker.el,
    h('div', { class: 'row' }, apply),
    h('p', { class: 'small muted' }, 'Used when no rule matches. “System locale” leaves unmatched sites untouched (no debugger attached).'),
  );
}

async function refresh(): Promise<void> {
  settings = await loadSettings();
  await refreshStatus();
  renderHeader();
  renderTab();
  renderSite();
  renderDefault();
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
    verify = null;
    void refresh();
  });
  // Keep the status chip current while the popup is open (e.g. after a reload).
  setInterval(async () => {
    await refreshStatus();
    renderHeader();
    renderTab();
  }, 1500);
}

void main();
