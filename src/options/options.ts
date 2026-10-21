// Options page: rule management, hostname tester, verification, import/export,
// settings, sessions/log and documentation of limitations.

import { exportConfig, importConfigText, mergeRules } from '../shared/config-io.js';
import { DATASET_KINDS, DATASETS, deleteDataset, listDatasets, putDataset, type DatasetMeta } from '../shared/dataset-store.js';
import { validateDataset } from '../shared/dataset-validate.js';
import { compileDnrRules } from '../shared/dnr.js';
import { hostFromUrl, normalizeHost, toUnicode } from '../shared/domain.js';
import { describeProfile, makeProfile } from '../shared/locale.js';
import { send, type HostTest, type TabStatus, type VerifyResult } from '../shared/messages.js';
import { defaultSettings, examplePresetRules, globalEnUsSettings } from '../shared/presets.js';
import { analyzeRules, describeAction, displayDomain, resolveHost, ruleLabel, rulesInPrecedenceOrder, requiredDatasets } from '../shared/rules.js';
import type { Options, Rule, Settings } from '../shared/types.js';
import { $, chip, clear, debounce, h, toggleSwitch } from '../ui/dom.js';
import { getLanguage, setLanguage, t, translateDocument, UI_LANGUAGES, type MessageKey, type UiLanguagePref } from '../shared/i18n.js';
import { describeStatus } from '../ui/status.js';
import { loadSettings, onSettingsChanged, saveSettings } from '../ui/store.js';
import { editProfile, editRule } from './rule-dialog.js';

let settings: Settings;
const dialog = $('#ruleDialog') as HTMLDialogElement;

async function commit(next: Settings): Promise<void> {
  settings = next;
  await saveSettings(next);
  renderAll();
}

// ------------------------------------------------------------------ navigation

const PAGES = ['rules', 'test', 'io', 'data', 'settings', 'sessions', 'about'] as const;
type Page = (typeof PAGES)[number];

function currentPage(): Page {
  const hash = location.hash.replace('#', '').split('=')[0] as Page;
  return PAGES.includes(hash) ? hash : 'rules';
}

function showPage(): void {
  const page = currentPage();
  for (const p of PAGES) $(`#${p}`).hidden = p !== page;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.getAttribute('href') === `#${page}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (page === 'sessions') void renderSessions();
  if (page === 'data') void renderData();
}

// ----------------------------------------------------------------------- rules

let filter = '';

function renderRules(): void {
  const root = $('#rules');
  clear(root);
  const issues = analyzeRules(settings);
  const issueIds = new Map<string, 'error' | 'warning' | 'info'>();
  for (const i of issues) for (const id of i.ruleIds) if (issueIds.get(id) !== 'error') issueIds.set(id, i.level);

  root.append(
    h('h1', {}, t('opt.rules.title')),
    h('p', { class: 'lead' },
      t('opt.rules.lead')),
  );

  // Global switch + default action
  const d = settings.defaultAction;
  root.append(
    h('div', { class: 'card row wrap' },
      toggleSwitch(settings.enabled, (v) => void commit({ ...settings, enabled: v }), t('opt.rules.enable')),
      h('strong', {}, t(settings.enabled ? 'opt.rules.isOn' : 'opt.rules.isOff')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, t('opt.rules.otherSites')),
      chip(d.action === 'SYSTEM' ? t('profile.system') : describeProfile(d.profile), d.action === 'SYSTEM' ? 'off' : 'accent'),
      h('button', {
        onclick: async () => {
          const p = await editProfile(dialog, t('opt.rules.defaultProfileTitle'), d.action === 'PROFILE' ? d.profile : makeProfile('en-US'));
          if (p) await commit({ ...settings, defaultAction: { action: 'PROFILE', profile: p } });
        },
      }, t(d.action === 'SYSTEM' ? 'opt.rules.spoofOthers' : 'opt.rules.editDefault')),
      d.action === 'PROFILE' ? h('button', { onclick: () => void commit({ ...settings, defaultAction: { action: 'SYSTEM' } }) }, t('opt.rules.useSystem')) : null,
    ),
  );

  // Toolbar
  const search = h('input', { type: 'search', placeholder: t('opt.rules.filter'), value: filter, 'aria-label': t('opt.rules.filter') });
  search.addEventListener('input', debounce(() => {
    filter = search.value.trim().toLowerCase();
    renderRuleTable(tableSlot, issueIds);
  }, 120));
  root.append(
    h('div', { class: 'row wrap' },
      h('button', {
        class: 'primary',
        onclick: async () => {
          const r = await editRule(dialog, null);
          if (r) await commit({ ...settings, rules: [...settings.rules, r] });
        },
      }, t('opt.rules.addRule')),
      h('button', {
        onclick: async () => {
          const merged = mergeRules(settings, { ...settings, rules: examplePresetRules() });
          await commit(merged.settings);
          flash(t('opt.rules.presetAdded', { added: merged.added, skipped: merged.skipped }));
        },
      }, t('opt.rules.addPreset')),
      h('button', {
        onclick: async () => {
          if (!confirm(t('opt.rules.globalConfirm'))) return;
          await commit({ ...globalEnUsSettings(), enabled: settings.enabled, options: settings.options });
        },
      }, t('opt.rules.globalPreset')),
      h('span', { class: 'spacer' }),
      search,
    ),
  );

  if (issues.length) {
    const levels = { error: 'issue-error', warning: 'issue-warning', info: 'issue-info' } as const;
    root.append(
      h('div', { class: 'card issues' },
        h('h2', {}, t('opt.rules.checks', { review: issues.filter((i) => i.level !== 'info').length, notes: issues.filter((i) => i.level === 'info').length })),
        h('ul', {}, ...issues.map((i) => h('li', { class: levels[i.level] }, `${i.level === 'error' ? t('opt.rules.conflictPrefix') : i.level === 'warning' ? t('opt.rules.warningPrefix') : ''}${i.message}`))),
      ),
    );
  }

  const tableSlot = h('div', { class: 'card', style: 'padding:0' });
  root.append(tableSlot);
  renderRuleTable(tableSlot, issueIds);

  // Only hostname rules are expected in DNR; IP/regex/GeoSite limits are listed under Sessions & log.
  const skipped = compileDnrRules(settings).skipped.filter((s) => ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(s.rule.type));
  if (skipped.length) {
    root.append(h('div', { class: 'notice warn' }, t('opt.rules.dnrSkipped'), h('ul', {}, ...skipped.map((s) => h('li', {}, `${ruleLabel(s.rule)}: ${s.reason}`)))));
  }
}

function renderRuleTable(slot: HTMLElement, issueIds = new Map<string, string>()): void {
  clear(slot);
  if (!settings.rules.length) {
    slot.append(h('p', { class: 'muted', style: 'padding:14px' }, t('opt.rules.empty')));
    return;
  }
  const order = new Map(rulesInPrecedenceOrder(settings.rules).map((r, i) => [r.id, i + 1]));
  const table = h('table', { class: 'rules' },
    h('tr', {}, h('th', {}, t('opt.rules.colOn')), h('th', {}, t('opt.rules.colType')), h('th', {}, t('opt.rules.colValue')), h('th', {}, t('rule.action')), h('th', { title: t('opt.rules.colRankTitle') }, t('opt.rules.colRank')), h('th', {}, t('opt.rules.colPrio')), h('th', {}, '')),
  );
  settings.rules.forEach((r, index) => {
    const text = `${r.type} ${r.value} ${toUnicode(r.value)} ${describeAction(r)} ${r.note}`.toLowerCase();
    if (filter && !text.includes(filter)) return;
    const issue = issueIds.get(r.id);
    const move = (delta: number) => {
      const rules = [...settings.rules];
      const j = index + delta;
      if (j < 0 || j >= rules.length) return;
      [rules[index], rules[j]] = [rules[j]!, rules[index]!];
      void commit({ ...settings, rules });
    };
    table.append(
      h('tr', { class: r.enabled ? '' : 'disabled' },
        h('td', {}, toggleSwitch(r.enabled, (v) => void commit({ ...settings, rules: settings.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) }), t(r.enabled ? 'opt.rules.disableRule' : 'opt.rules.enableRule'))),
        h('td', {}, h('span', { class: 'type' }, r.type)),
        h('td', { class: 'value' }, r.type === 'DOMAIN-KEYWORD' ? r.value : displayDomain(r.value), r.note ? h('div', { class: 'hint' }, r.note) : null),
        h('td', {}, r.action === 'SYSTEM' ? chip('SYSTEM', 'off') : chip(describeProfile(r.profile), 'accent'), issue && issue !== 'info' ? h('span', { title: t('opt.rules.seeChecks') }, issue === 'error' ? ` ⚠ ${t('opt.rules.conflict')}` : ' ⚠') : null),
        h('td', { class: 'muted' }, r.enabled ? String(order.get(r.id) ?? '') : '—'),
        h('td', { class: 'muted' }, r.priority ? String(r.priority) : ''),
        h('td', { class: 'actions' },
          h('button', { class: 'icon', title: t('opt.rules.moveUp'), disabled: index === 0, onclick: () => move(-1) }, '↑'),
          h('button', { class: 'icon', title: t('opt.rules.moveDown'), disabled: index === settings.rules.length - 1, onclick: () => move(1) }, '↓'),
          h('button', {
            onclick: async () => {
              const edited = await editRule(dialog, r);
              if (edited) await commit({ ...settings, rules: settings.rules.map((x) => (x.id === r.id ? edited : x)) });
            },
          }, t('common.edit')),
          h('button', {
            class: 'danger',
            onclick: () => {
              if (confirm(t('opt.rules.deleteConfirm', { rule: ruleLabel(r) }))) void commit({ ...settings, rules: settings.rules.filter((x) => x.id !== r.id) });
            },
          }, t('common.delete')),
        ),
      ),
    );
  });
  slot.append(table);
}

function flash(text: string): void {
  const n = h('div', { class: 'notice ok', role: 'status' }, text);
  $('#rules').prepend(n);
  setTimeout(() => n.remove(), 4000);
}

// ------------------------------------------------------------------ test page

function renderTest(): void {
  const root = $('#test');
  clear(root);
  const input = h('input', { type: 'text', placeholder: t('opt.test.hostPlaceholder'), style: 'flex:1', spellcheck: false, 'aria-label': t('opt.test.hostPlaceholder') });
  const ipInput = h('input', { type: 'text', placeholder: t('opt.test.ipPlaceholder'), size: 18, spellcheck: false, 'aria-label': t('opt.test.ipPlaceholder') });
  const out = h('div', { class: 'stack' });
  let token = 0;
  const run = async () => {
    const mine = ++token;
    const raw = input.value.trim();
    if (!raw) return clear(out);
    let ht: HostTest;
    try {
      ht = await send({ type: 'testHost', host: raw, ...(ipInput.value.trim() ? { ip: ipInput.value.trim() } : {}) });
    } catch (e) {
      clear(out);
      out.append(h('div', { class: 'notice bad' }, t('opt.workerUnavailable', { error: (e as Error).message })));
      return;
    }
    if (mine !== token) return;
    clear(out);
    const host = ht.host;
    if (!host) {
      out.append(h('div', { class: 'notice bad' }, t('opt.test.invalidHost')));
      return;
    }
    const r = ht.resolution;
    const ipText = r.ip
      ? `${r.ip} (${ht.ipSource === 'unknown' ? '' : t(`opt.test.ipSource.${ht.ipSource}`)})${ht.country ? ` · ${ht.country}` : ''}${ht.asn !== null ? ` · AS${ht.asn}` : ''}`
      : t('opt.test.ipUnknown');
    out.append(
      h('div', { class: 'card stack' },
        h('dl', { class: 'kv' },
          h('dt', {}, t('opt.test.hostname')), h('dd', {}, host === toUnicode(host) ? host : `${toUnicode(host)} (${host})`),
          h('dt', {}, t('popup.serverAddress')), h('dd', {}, ipText),
          h('dt', {}, t('opt.test.decision')), h('dd', {}, r.ruleLabel ?? t('opt.test.noRule')),
          h('dt', {}, t('opt.test.result')), h('dd', {}, r.action === 'SYSTEM' ? t('opt.test.resultSystem') : describeProfile(r.profile)),
          ...(r.profile ? [h('dt', {}, 'Accept-Language'), h('dd', {}, r.profile.acceptLanguage)] : []),
          ...(settings.enabled ? [] : [h('dt', {}, t('rule.note')), h('dd', {}, t('opt.test.spoofingOff'))]),
        ),
        ht.problems.length ? h('div', { class: 'notice warn' }, t('opt.test.cannotMatch'), h('ul', {}, ...ht.problems.map((p) => h('li', {}, p)))) : null,
        ht.matches.length
          ? h('table', { class: 'trace' },
              h('tr', {}, h('th', {}, '#'), h('th', {}, t('opt.test.matchingRule')), h('th', {}, t('rule.action')), h('th', {}, t('opt.test.why'))),
              ...ht.matches.map((m, i) => {
                const rule = settings.rules.find((x) => x.id === m.ruleId);
                return h('tr', { class: i === 0 ? 'winner' : '' },
                  h('td', {}, String(i + 1)),
                  h('td', { class: 'mono' }, m.label),
                  h('td', {}, m.action),
                  h('td', { class: 'small muted' }, rule ? why(rule) : ''),
                );
              }),
            )
          : h('p', { class: 'muted' }, t('opt.test.noMatch')),
      ),
    );
  };
  const trigger = debounce(() => void run(), 150);
  input.addEventListener('input', trigger);
  ipInput.addEventListener('input', trigger);
  root.append(
    h('h1', {}, t('opt.test.title')),
    h('div', { class: 'card stack' }, h('h2', {}, t('opt.test.heading')), h('div', { class: 'row' }, input, ipInput), out),
  );
  root.append(h('div', { class: 'card stack', id: 'verifyCard' }));
  void renderVerifyCard();
}

function why(r: Rule): string {
  switch (r.type) {
    case 'DOMAIN':
      return t('opt.why.domain');
    case 'DOMAIN-SUFFIX':
      return t('opt.why.suffix', { labels: r.value.split('.').length }) + prio(r);
    case 'DOMAIN-KEYWORD':
      return t('opt.why.keyword') + prio(r);
    case 'DOMAIN-REGEX':
      return t('opt.why.regex') + prio(r);
    case 'GEOSITE':
      return t('opt.why.geosite') + prio(r);
    case 'IP-CIDR':
    case 'IP-CIDR6':
      return t('opt.why.cidr', { prefix: r.value.split('/')[1] ?? '' }) + prio(r);
    case 'IP-ASN':
      return t('opt.why.asn') + prio(r);
    case 'GEOIP':
      return t('opt.why.geoip') + prio(r);
  }
}

function prio(r: Rule): string {
  return r.priority ? t('opt.why.priority', { priority: r.priority }) : '';
}

async function renderVerifyCard(): Promise<void> {
  const card = document.getElementById('verifyCard');
  if (!card) return;
  clear(card);
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && t.url && hostFromUrl(t.url));
  const select = h('select', { 'aria-label': t('opt.verify.heading') }, ...tabs.map((t) => h('option', { value: String(t.id) }, `${hostFromUrl(t.url!)} — ${t.title ?? ''}`.slice(0, 90))));
  const out = h('div', { class: 'stack' });
  card.append(
    h('h2', {}, t('opt.verify.heading')),
    h('p', { class: 'hint' }, t('opt.verify.hint')),
    tabs.length
      ? h('div', { class: 'row' }, select, h('button', {
          onclick: async () => {
            clear(out);
            out.append(h('p', { class: 'muted' }, t('popup.checking')));
            const tabId = Number(select.value);
            const [st, v] = await Promise.all([send({ type: 'getStatus', tabId }), send({ type: 'verify', tabId })]);
            clear(out);
            out.append(renderVerification(st.status, v));
          },
        }, t('opt.verify.button')))
      : h('p', { class: 'muted' }, t('opt.verify.noTabs')),
    out,
  );
}

function renderVerification(status: TabStatus | null, v: VerifyResult): HTMLElement {
  const view = describeStatus(status, null);
  const box = h('div', { class: 'stack' }, h('div', { class: 'row' }, chip(view.label, view.kind), h('span', { class: 'small muted' }, view.detail)));
  if (!v.attached) {
    box.append(h('div', { class: 'notice info' }, v.error ?? t('opt.verify.notAttached')));
    return box;
  }
  for (const f of v.frames) {
    if (f.error || !f.live) {
      box.append(h('div', { class: 'notice bad' }, `${f.kind} ${f.url}: ${f.error ?? t('opt.verify.noData')}`));
      continue;
    }
    const exp = f.expectedLocale;
    const cell = (val: string, check: boolean) => h('td', { class: check && exp ? (val === exp ? 'mono' : 'mono issue-error') : 'mono' }, val);
    const rows: [string, (s: NonNullable<typeof f.live>) => string, boolean][] = [
      ['navigator.language', (s) => s.language, true],
      ['navigator.languages', (s) => s.languages.join(', '), false],
      ['Intl.DateTimeFormat', (s) => s.dateLocale, true],
      ['Intl.NumberFormat', (s) => s.numberLocale, true],
      ['Intl.Collator', (s) => s.collatorLocale, true],
      ['Intl.PluralRules', (s) => s.pluralRulesLocale, true],
      ['Intl.RelativeTimeFormat', (s) => s.relativeTimeLocale, true],
      ['Intl.ListFormat', (s) => s.listFormatLocale, true],
      [t('common.timeZone'), (s) => s.timeZone, false],
    ];
    box.append(
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('strong', {}, f.kind === 'main' ? t('common.page') : t('opt.verify.crossSiteFrame')), h('code', {}, f.url), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, t('opt.verify.expected', { locale: exp ?? t('profile.system') }))),
        h('table', {}, h('tr', {}, h('th', {}, 'API'), h('th', {}, t('common.atStart')), h('th', {}, t('common.now'))),
          ...rows.map(([label, get, check]) => h('tr', {}, h('th', {}, label), f.start ? cell(get(f.start), check) : h('td', { class: 'muted' }, 'n/a'), cell(get(f.live!), check))),
        ),
      ),
    );
  }
  return box;
}

// -------------------------------------------------------------- import/export

function renderIO(): void {
  const root = $('#io');
  clear(root);
  const area = h('textarea', { class: 'config', spellcheck: false, 'aria-label': t('opt.io.title') });
  const msg = h('div', { class: 'stack' });
  const mode = h('select', { 'aria-label': t('opt.io.mode') }, h('option', { value: 'replace' }, t('opt.io.replace')), h('option', { value: 'merge' }, t('opt.io.merge')));
  const file = h('input', { type: 'file', accept: '.json,.yaml,.yml,.txt', 'aria-label': t('opt.io.file') });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (f) area.value = await f.text();
  });
  const show = (kind: 'ok' | 'bad' | 'warn', title: string, items: string[] = []) => {
    clear(msg);
    msg.append(h('div', { class: `notice ${kind}` }, title, items.length ? h('ul', {}, ...items.map((i) => h('li', {}, i))) : null));
  };
  const download = (fmt: 'json' | 'yaml') => {
    const text = exportConfig(settings, fmt);
    const url = URL.createObjectURL(new Blob([text], { type: fmt === 'json' ? 'application/json' : 'text/yaml' }));
    h('a', { href: url, download: `locale-jacket.${fmt === 'json' ? 'json' : 'yaml'}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  root.append(
    h('h1', {}, t('opt.io.title')),
    h('p', { class: 'lead' },
      t('opt.io.lead')),
    h('div', { class: 'row wrap' },
      h('button', { onclick: () => { area.value = exportConfig(settings, 'yaml'); show('ok', t('opt.io.shownYaml')); } }, t('opt.io.showYaml')),
      h('button', { onclick: () => { area.value = exportConfig(settings, 'json'); show('ok', t('opt.io.shownJson')); } }, t('opt.io.showJson')),
      h('button', { onclick: () => download('yaml') }, t('opt.io.downloadYaml')),
      h('button', { onclick: () => download('json') }, t('opt.io.downloadJson')),
      h('button', { onclick: async () => { await navigator.clipboard.writeText(area.value); show('ok', t('opt.io.copied')); } }, t('opt.io.copy')),
    ),
    area,
    h('div', { class: 'row wrap' },
      file,
      h('span', { class: 'spacer' }),
      mode,
      h('button', {
        class: 'primary',
        onclick: async () => {
          const r = importConfigText(area.value, settings);
          if (!r.settings) return show('bad', t('opt.io.nothingImported'), r.errors);
          const next = mode.value === 'merge' ? mergeRules(settings, r.settings).settings : r.settings;
          const issues = analyzeRules(next).filter((i) => i.level !== 'info');
          if (!confirm(t(mode.value === 'merge' ? 'opt.io.confirmMerge' : 'opt.io.confirmReplace', { count: r.settings.rules.length }) + (issues.length ? `\n\n${t('opt.io.confirmChecks', { count: issues.length })}` : ''))) return;
          await commit(next);
          show(r.warnings.length || issues.length ? 'warn' : 'ok', t('opt.io.imported', { count: r.settings.rules.length }), [...r.warnings, ...issues.map((i) => i.message)]);
        },
      }, t('opt.io.import')),
    ),
    msg,
  );
}

// -------------------------------------------------------------------- settings

function renderSettings(): void {
  const root = $('#settings');
  clear(root);
  const o = settings.options;
  const set = (patch: Partial<Options>) => void commit({ ...settings, options: { ...settings.options, ...patch } });
  const opt = (control: HTMLElement, title: string, hint: string) => h('div', { class: 'option' }, control, h('strong', {}, title), h('div', { class: 'hint' }, hint));
  const radio = (value: Options['frameMode'], label: string) => {
    const r = h('input', { type: 'radio', name: 'frameMode', value });
    r.checked = o.frameMode === value;
    r.addEventListener('change', () => set({ frameMode: value }));
    return h('label', { class: 'row' }, r, h('span', {}, label));
  };
  root.append(
    h('h1', {}, t('opt.settings.title')),
    languageCard(),
    h('div', { class: 'card stack' },
      h('h2', {}, t('opt.settings.frames')),
      radio('inherit', t('opt.settings.inherit')),
      radio('per-frame', t('opt.settings.perFrame')),
      h('p', { class: 'hint' },
        t('opt.settings.framesHint')),
    ),
    h('div', { class: 'card stack' },
      opt(toggleSwitch(o.keepSessionOnSystem, (v) => set({ keepSessionOnSystem: v }), t('opt.settings.keep')), t('opt.settings.keep'),
        t('opt.settings.keepHint')),
      opt(toggleSwitch(o.reloadOnLate, (v) => set({ reloadOnLate: v }), t('opt.settings.reload')), t('opt.settings.reload'),
        t('opt.settings.reloadHint')),
      opt(toggleSwitch(o.dnrHeaders, (v) => set({ dnrHeaders: v }), t('opt.settings.dnr')), t('opt.settings.dnr'),
        t('opt.settings.dnrHint')),
      opt(toggleSwitch(o.overrideWorkers, (v) => set({ overrideWorkers: v }), t('opt.settings.workers')), t('opt.settings.workers'),
        t('opt.settings.workersHint')),
    ),
    h('div', { class: 'card row wrap' },
      h('div', { class: 'spacer' }, h('strong', {}, t('opt.settings.reset')), h('div', { class: 'hint' }, t('opt.settings.resetHint'))),
      h('button', {
        class: 'danger',
        onclick: () => {
          if (confirm(t('opt.settings.resetConfirm'))) void commit({ ...defaultSettings(), options: { ...defaultSettings().options, uiLanguage: settings.options.uiLanguage } });
        },
      }, t('opt.settings.resetButton')),
    ),
  );
}

function languageCard(): HTMLElement {
  const sel = h('select', { 'aria-label': t('opt.settings.language') },
    h('option', { value: 'auto' }, t('opt.settings.languageAuto')),
    ...UI_LANGUAGES.map((l) => h('option', { value: l.value, lang: l.value }, l.label)));
  sel.value = settings.options.uiLanguage ?? 'auto';
  sel.addEventListener('change', () => void commit({ ...settings, options: { ...settings.options, uiLanguage: sel.value as UiLanguagePref } }));
  return h('div', { class: 'card stack' },
    h('h2', {}, t('opt.settings.language')),
    h('div', { class: 'row' }, sel, h('span', { class: 'hint' }, t('opt.settings.languageCurrent', { lang: UI_LANGUAGES.find((l) => l.value === getLanguage())?.label ?? getLanguage() }))),
    h('p', { class: 'hint' }, t('opt.settings.languageHint')),
  );
}

// -------------------------------------------------------------------- sessions

let sessionsRender = 0;
async function renderSessions(): Promise<void> {
  const token = ++sessionsRender;
  const root = $('#sessions');
  let data;
  let log: { entries: import('../shared/messages.js').LogEntry[] } = { entries: [] };
  try {
    [data, log] = await Promise.all([send({ type: 'listStatuses' }), send({ type: 'getLog' }).catch(() => ({ entries: [] }))]);
  } catch (e) {
    if (token !== sessionsRender) return;
    clear(root);
    root.append(h('h1', {}, t('opt.sessions.title')), h('div', { class: 'notice bad' }, t('opt.workerUnavailable', { error: (e as Error).message })));
    return;
  }
  if (token !== sessionsRender) return; // a newer render started meanwhile
  clear(root);
  root.append(h('h1', {}, t('opt.sessions.title')));
  const g = data.global;
  root.append(
    h('div', { class: 'card row wrap' },
      chip(g.enabled ? (g.suspended ? t('status.paused') : t('common.on')) : t('common.off'), g.enabled && !g.suspended ? 'ok' : 'warn'),
      h('span', {}, t('opt.sessions.attached', { count: g.attachedTabs })),
      chip(g.dnr.active ? t('opt.sessions.dnrOn', { count: g.dnr.ruleCount }) : t('opt.sessions.dnrOff'), g.dnr.error ? 'bad' : 'off'),
      h('span', { class: 'spacer' }),
      g.suspended ? h('button', { class: 'primary', onclick: async () => { await send({ type: 'resume' }); void renderSessions(); } }, t('common.resume')) : null,
      h('button', { onclick: async () => { const r = await send({ type: 'detachAll' }); alert(t('opt.sessions.detached', { count: r.detached })); void renderSessions(); } }, t('opt.sessions.detachAll')),
      h('button', { onclick: () => void renderSessions() }, t('common.refresh')),
    ),
  );
  if (g.dnr.error) root.append(h('div', { class: 'notice bad' }, `declarativeNetRequest: ${g.dnr.error}`));
  if (g.dnr.skipped.length) {
    root.append(
      h('details', { class: 'card' },
        h('summary', {}, t('opt.sessions.dnrSkipped', { count: g.dnr.skipped.length })),
        h('ul', { class: 'small' }, ...g.dnr.skipped.map((s) => h('li', {}, s))),
      ),
    );
  }
  if (g.settingsProblems.length) root.append(h('div', { class: 'notice warn' }, t('opt.sessions.settingsProblems'), h('ul', {}, ...g.settingsProblems.map((p) => h('li', {}, p)))));

  const rows = data.statuses.filter((s) => s.host).sort((a, b) => Number(b.session === 'attached') - Number(a.session === 'attached'));
  root.append(
    h('div', { class: 'card', style: 'padding:0' },
      rows.length
        ? h('table', {},
            h('tr', {}, h('th', {}, t('opt.sessions.colTab')), h('th', {}, t('opt.sessions.colSite')), h('th', {}, t('opt.sessions.colRule')), h('th', {}, t('opt.sessions.colStatus')), h('th', {}, t('popup.framesWorkers'))),
            ...rows.map((s) => {
              const v = describeStatus(s, g);
              return h('tr', {},
                h('td', { class: 'muted' }, String(s.tabId)),
                h('td', { class: 'mono' }, toUnicode(s.host ?? '')),
                h('td', { class: 'mono small' }, s.resolution.ruleLabel ?? (s.resolution.source === 'default' ? t('opt.sessions.default') : '')),
                h('td', { title: v.detail }, chip(v.label, v.kind), s.warnings.length ? h('div', { class: 'hint' }, s.warnings.join(' ')) : null),
                h('td', { class: 'muted' }, `${s.frames} / ${s.workers}`),
              );
            }),
          )
        : h('p', { class: 'muted', style: 'padding:14px' }, t('opt.sessions.noTabs')),
    ),
  );
  root.append(
    h('h2', {}, t('opt.sessions.activity')),
    h('p', { class: 'hint' }, t('opt.sessions.activityHint')),
    h('div', { class: 'log' }, log.entries.length ? log.entries.slice(-200).map((e) => `${new Date(e.t).toLocaleTimeString()}  ${e.level.padEnd(5)} ${e.tabId !== null ? `tab ${e.tabId}: ` : ''}${e.msg}`).join('\n') : t('opt.sessions.nothingLogged')),
  );
}

// ------------------------------------------------------------------- datasets

async function renderData(): Promise<void> {
  const root = $('#data');
  const [metas, status] = await Promise.all([listDatasets().catch(() => [] as DatasetMeta[]), send({ type: 'listStatuses' }).catch(() => null)]);
  clear(root);
  const needed = requiredDatasets(settings.rules);
  root.append(
    h('h1', {}, t('opt.data.title')),
    h('p', { class: 'lead' }, t('opt.data.lead')),
  );
  const problems = status?.global.datasets.problems ?? [];
  if (problems.length) root.append(h('div', { class: 'notice warn' }, t('opt.data.needed'), h('ul', {}, ...problems.map((p) => h('li', {}, p)))));

  for (const kind of DATASET_KINDS) {
    const info = DATASETS[kind];
    const meta = metas.find((m) => m.kind === kind);
    const usedBy = kind === 'geosite' ? needed.geosite.length > 0 : kind === 'geoip' ? needed.geoip : needed.asn;
    const url = h('input', { type: 'url', value: meta && /^https?:/.test(meta.source) ? meta.source : info.defaultUrl, style: 'flex:1', spellcheck: false, 'aria-label': t('opt.data.url', { name: info.label }) });
    const msg = h('div', { class: 'small' });
    const file = h('input', { type: 'file', hidden: true, 'aria-label': t('opt.data.import') });
    const save = async (bytes: ArrayBuffer, source: string) => {
      msg.className = 'small muted';
      msg.textContent = t('opt.data.checking');
      try {
        const v = validateDataset(kind, bytes);
        await putDataset({ kind, source, size: bytes.byteLength, savedAt: Date.now(), summary: v.summary }, bytes);
        const r = await send({ type: 'datasetsChanged' });
        msg.className = 'small';
        msg.textContent = t('opt.data.saved', { summary: v.summary }) + (v.warnings.length ? ' ' + v.warnings.join(' ') : '') + (r.problems.length ? ' ' + t('opt.data.stillMissing', { problems: r.problems.join(' ') }) : '');
        setTimeout(() => void renderData(), 1500);
      } catch (e) {
        msg.className = 'error-text';
        msg.textContent = t('opt.data.notSaved', { error: (e as Error).message });
      }
    };
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) await save(await f.arrayBuffer(), `file: ${f.name}`);
    });
    const download = h('button', {
      class: meta ? '' : 'primary',
      onclick: async () => {
        msg.className = 'small muted';
        try {
          msg.textContent = t('opt.data.downloadingFrom', { host: new URL(url.value).host });
          const res = await fetch(url.value, { cache: 'no-store' });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          const total = Number(res.headers.get('content-length')) || 0;
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            msg.textContent = t('opt.data.progress', { got: (got / 1048576).toFixed(1), total: total ? (total / 1048576).toFixed(1) : '?' });
          }
          const bytes = new Uint8Array(got);
          let o = 0;
          for (const c of chunks) {
            bytes.set(c, o);
            o += c.length;
          }
          await save(bytes.buffer, url.value);
        } catch (e) {
          msg.className = 'error-text';
          msg.textContent = t('opt.data.downloadFailed', { error: (e as Error).message });
        }
      },
    }, t(meta ? 'opt.data.update' : 'opt.data.download'));
    root.append(
      h('div', { class: 'card stack' },
        h('div', { class: 'row' },
          h('h2', {}, info.label),
          meta ? chip(t('opt.data.installed'), 'ok') : usedBy ? chip(t('opt.data.neededChip'), 'warn') : chip(t('opt.data.notInstalled'), 'off'),
          h('span', { class: 'spacer' }),
          meta ? h('span', { class: 'small muted' }, `${meta.summary} · ${(meta.size / 1048576).toFixed(1)} MB · ${new Date(meta.savedAt).toLocaleDateString()}`) : null,
        ),
        h('p', {}, t(`opt.data.desc.${kind}`)),
        h('p', { class: 'hint' }, t('opt.data.formatSource', { format: info.format, source: info.license })),
        meta ? h('p', { class: 'hint' }, t('opt.data.currentFrom', { source: meta.source })) : null,
        h('div', { class: 'row wrap' },
          url,
          download,
          h('button', { onclick: () => file.click() }, t('opt.data.import')),
          file,
          meta
            ? h('button', {
                class: 'danger',
                onclick: async () => {
                  if (!confirm(t('opt.data.deleteConfirm', { name: info.label }))) return;
                  await deleteDataset(kind);
                  await send({ type: 'datasetsChanged' });
                  void renderData();
                },
              }, t('common.delete'))
            : null,
        ),
        msg,
      ),
    );
  }
  const d = status?.global.datasets;
  root.append(
    h('div', { class: 'card stack' },
      h('h2', {}, t('opt.data.ipTitle')),
      h('p', {}, t('opt.data.ipText')),
      h('p', { class: 'hint' }, t('opt.data.ipHint')),
      h('p', { class: 'small muted' }, d ? t(d.watchingIps ? 'opt.data.watching' : 'opt.data.notWatching', { count: d.ipCacheSize }) : ''),
    ),
  );
}

// ----------------------------------------------------------------------- about

function renderAbout(): void {
  const root = $('#about');
  clear(root);
  const li = (n: number) => h('li', {}, h('strong', {}, t(`opt.about.l${n}` as MessageKey)), ' — ', t(`opt.about.l${n}t` as MessageKey));
  root.append(
    h('h1', {}, t('opt.about.title')),
    h('div', { class: 'card stack' }, h('h2', {}, t('opt.about.howTitle')), h('p', {}, t('opt.about.how'))),
    h('div', { class: 'card stack' }, h('h2', {}, t('opt.about.limitsTitle')), h('ul', { class: 'limits' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(li))),
    h('div', { class: 'card stack' },
      h('h2', {}, t('opt.about.privacyTitle')),
      h('ul', { class: 'limits' }, h('li', {}, t('opt.about.p1')), h('li', {}, t('opt.about.p2')), h('li', {}, t('opt.about.p3'))),
    ),
  );
}

// ------------------------------------------------------------------------ boot

function renderAll(): void {
  setLanguage(settings.options.uiLanguage);
  translateDocument();
  renderRules();
  renderTest();
  renderIO();
  renderSettings();
  renderAbout();
  if (currentPage() === 'sessions') void renderSessions();
  if (currentPage() === 'data') void renderData();
  $('#navStatus').textContent = t('opt.navStatus', { count: settings.rules.length, state: t(settings.enabled ? 'common.on' : 'common.off') });
}

async function main(): Promise<void> {
  settings = await loadSettings();
  renderAll();
  showPage();
  window.addEventListener('hashchange', showPage);
  onSettingsChanged((s) => {
    if (JSON.stringify(s) === JSON.stringify(settings)) return;
    settings = s;
    renderAll();
  });
  // Deep link from the popup: #rules=<ruleId> opens that rule's editor.
  const m = /^#rules=(.+)$/.exec(location.hash);
  const target = m ? settings.rules.find((r) => r.id === decodeURIComponent(m[1]!)) : undefined;
  if (target) {
    const edited = await editRule(dialog, target);
    if (edited) await commit({ ...settings, rules: settings.rules.map((x) => (x.id === target.id ? edited : x)) });
  }
}

void main();
