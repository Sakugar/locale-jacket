// Options page: rule management, hostname tester, verification, import/export,
// settings, sessions/log and documentation of limitations.

import { exportConfig, importConfigText, mergeRules } from '../shared/config-io.js';
import { compileDnrRules } from '../shared/dnr.js';
import { hostFromUrl, normalizeHost, toUnicode } from '../shared/domain.js';
import { describeProfile, makeProfile } from '../shared/locale.js';
import { send, type TabStatus, type VerifyResult } from '../shared/messages.js';
import { defaultSettings, examplePresetRules, globalEnUsSettings } from '../shared/presets.js';
import { analyzeRules, describeAction, displayDomain, resolveHost, ruleLabel, rulesInPrecedenceOrder } from '../shared/rules.js';
import type { Options, Rule, Settings } from '../shared/types.js';
import { $, chip, clear, debounce, h, toggleSwitch } from '../ui/dom.js';
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

const PAGES = ['rules', 'test', 'io', 'settings', 'sessions', 'about'] as const;
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
    h('h1', {}, 'Rules'),
    h('p', { class: 'lead' },
      'Each website gets the locale of the best matching rule: an exact DOMAIN rule first, then the most specific DOMAIN-SUFFIX, then DOMAIN-KEYWORD. Ties are broken by priority, then by list order. If nothing matches, the default applies.'),
  );

  // Global switch + default action
  const d = settings.defaultAction;
  root.append(
    h('div', { class: 'card row wrap' },
      toggleSwitch(settings.enabled, (v) => void commit({ ...settings, enabled: v }), 'Enable spoofing'),
      h('strong', {}, settings.enabled ? 'Spoofing is on' : 'Spoofing is off'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, 'Other websites:'),
      chip(d.action === 'SYSTEM' ? 'System locale' : describeProfile(d.profile), d.action === 'SYSTEM' ? 'off' : 'accent'),
      h('button', {
        onclick: async () => {
          const p = await editProfile(dialog, 'Default profile for unmatched websites', d.action === 'PROFILE' ? d.profile : makeProfile('en-US'));
          if (p) await commit({ ...settings, defaultAction: { action: 'PROFILE', profile: p } });
        },
      }, d.action === 'SYSTEM' ? 'Spoof all other sites…' : 'Edit default…'),
      d.action === 'PROFILE' ? h('button', { onclick: () => void commit({ ...settings, defaultAction: { action: 'SYSTEM' } }) }, 'Use system locale') : null,
    ),
  );

  // Toolbar
  const search = h('input', { type: 'search', placeholder: 'Filter rules…', value: filter, 'aria-label': 'Filter rules' });
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
      }, '+ Add rule'),
      h('button', {
        onclick: async () => {
          const merged = mergeRules(settings, { ...settings, rules: examplePresetRules() });
          await commit(merged.settings);
          flash(`Example preset: ${merged.added} rule(s) added, ${merged.skipped} already present.`);
        },
      }, 'Add example preset'),
      h('button', {
        onclick: async () => {
          if (!confirm('Replace all rules with the global en-US preset (every site reports en-US, no rules)?')) return;
          await commit({ ...globalEnUsSettings(), enabled: settings.enabled, options: settings.options });
        },
      }, 'Use global en-US preset'),
      h('span', { class: 'spacer' }),
      search,
    ),
  );

  if (issues.length) {
    const levels = { error: 'issue-error', warning: 'issue-warning', info: 'issue-info' } as const;
    root.append(
      h('div', { class: 'card issues' },
        h('h2', {}, `Checks (${issues.filter((i) => i.level !== 'info').length} to review, ${issues.filter((i) => i.level === 'info').length} notes)`),
        h('ul', {}, ...issues.map((i) => h('li', { class: levels[i.level] }, `${i.level === 'error' ? 'Conflict: ' : i.level === 'warning' ? 'Warning: ' : ''}${i.message}`))),
      ),
    );
  }

  const tableSlot = h('div', { class: 'card', style: 'padding:0' });
  root.append(tableSlot);
  renderRuleTable(tableSlot, issueIds);

  const skipped = compileDnrRules(settings).skipped;
  if (skipped.length) {
    root.append(h('div', { class: 'notice warn' }, 'Some rules cannot be mirrored for the first request’s Accept-Language (declarativeNetRequest):', h('ul', {}, ...skipped.map((s) => h('li', {}, `${ruleLabel(s.rule)}: ${s.reason}`)))));
  }
}

function renderRuleTable(slot: HTMLElement, issueIds = new Map<string, string>()): void {
  clear(slot);
  if (!settings.rules.length) {
    slot.append(h('p', { class: 'muted', style: 'padding:14px' }, 'No rules yet. Add one, load the example preset, or import a configuration.'));
    return;
  }
  const order = new Map(rulesInPrecedenceOrder(settings.rules).map((r, i) => [r.id, i + 1]));
  const table = h('table', { class: 'rules' },
    h('tr', {}, h('th', {}, 'On'), h('th', {}, 'Type'), h('th', {}, 'Domain / keyword'), h('th', {}, 'Action'), h('th', { title: 'Position in the effective precedence order' }, 'Rank'), h('th', {}, 'Prio'), h('th', {}, '')),
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
        h('td', {}, toggleSwitch(r.enabled, (v) => void commit({ ...settings, rules: settings.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) }), r.enabled ? 'Disable rule' : 'Enable rule')),
        h('td', {}, h('span', { class: 'type' }, r.type)),
        h('td', { class: 'value' }, r.type === 'DOMAIN-KEYWORD' ? r.value : displayDomain(r.value), r.note ? h('div', { class: 'hint' }, r.note) : null),
        h('td', {}, r.action === 'SYSTEM' ? chip('SYSTEM', 'off') : chip(describeProfile(r.profile), 'accent'), issue && issue !== 'info' ? h('span', { title: 'See checks above' }, issue === 'error' ? ' ⚠ conflict' : ' ⚠') : null),
        h('td', { class: 'muted' }, r.enabled ? String(order.get(r.id) ?? '') : '—'),
        h('td', { class: 'muted' }, r.priority ? String(r.priority) : ''),
        h('td', { class: 'actions' },
          h('button', { class: 'icon', title: 'Move up (order breaks ties)', disabled: index === 0, onclick: () => move(-1) }, '↑'),
          h('button', { class: 'icon', title: 'Move down', disabled: index === settings.rules.length - 1, onclick: () => move(1) }, '↓'),
          h('button', {
            onclick: async () => {
              const edited = await editRule(dialog, r);
              if (edited) await commit({ ...settings, rules: settings.rules.map((x) => (x.id === r.id ? edited : x)) });
            },
          }, 'Edit'),
          h('button', {
            class: 'danger',
            onclick: () => {
              if (confirm(`Delete ${ruleLabel(r)}?`)) void commit({ ...settings, rules: settings.rules.filter((x) => x.id !== r.id) });
            },
          }, 'Delete'),
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
  const input = h('input', { type: 'text', placeholder: 'Hostname or URL, e.g. mail.google.com', style: 'flex:1', spellcheck: false, 'aria-label': 'Hostname to test' });
  const out = h('div', { class: 'stack' });
  const run = () => {
    clear(out);
    const raw = input.value.trim();
    if (!raw) return;
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? hostFromUrl(raw) : normalizeHost(raw)?.ascii ?? null;
    if (!host) {
      out.append(h('div', { class: 'notice bad' }, 'Not a valid hostname or http(s) URL.'));
      return;
    }
    const res = resolveHost(host, settings);
    out.append(
      h('div', { class: 'card stack' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Hostname'), h('dd', {}, host === toUnicode(host) ? host : `${toUnicode(host)} (${host})`),
          h('dt', {}, 'Decision'), h('dd', {}, res.rule ? ruleLabel(res.rule) : 'No rule matched → default action'),
          h('dt', {}, 'Result'), h('dd', {}, res.action === 'SYSTEM' ? 'SYSTEM — real browser locale' : describeProfile(res.profile)),
          ...(res.profile ? [h('dt', {}, 'Accept-Language'), h('dd', {}, res.profile.acceptLanguage)] : []),
          ...(settings.enabled ? [] : [h('dt', {}, 'Note'), h('dd', {}, 'Spoofing is currently off.')]),
        ),
        res.matches.length
          ? h('table', { class: 'trace' },
              h('tr', {}, h('th', {}, '#'), h('th', {}, 'Matching rule'), h('th', {}, 'Action'), h('th', {}, 'Why it ranks here')),
              ...res.matches.map((r, i) =>
                h('tr', { class: i === 0 ? 'winner' : '' },
                  h('td', {}, String(i + 1)),
                  h('td', { class: 'mono' }, ruleLabel(r)),
                  h('td', {}, describeAction(r)),
                  h('td', { class: 'small muted' }, why(r)),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'No enabled rule matches this hostname.'),
      ),
    );
  };
  input.addEventListener('input', debounce(run, 150));
  root.append(
    h('h1', {}, 'Test & verify'),
    h('div', { class: 'card stack' }, h('h2', {}, 'Test a hostname against your rules'), h('div', { class: 'row' }, input), out),
  );
  root.append(h('div', { class: 'card stack', id: 'verifyCard' }));
  void renderVerifyCard();
}

function why(r: Rule): string {
  switch (r.type) {
    case 'DOMAIN':
      return 'Exact match (highest precedence)';
    case 'DOMAIN-SUFFIX':
      return `Suffix with ${r.value.split('.').length} labels (more labels win)${r.priority ? `, priority ${r.priority}` : ''}`;
    case 'DOMAIN-KEYWORD':
      return `Keyword (after exact and suffix rules)${r.priority ? `, priority ${r.priority}` : ''}`;
    case 'DOMAIN-REGEX':
      return `Regex (after keyword rules)${r.priority ? `, priority ${r.priority}` : ''}`;
    case 'GEOSITE':
      return `GeoSite category (last of the hostname rules)${r.priority ? `, priority ${r.priority}` : ''}`;
    case 'IP-CIDR':
    case 'IP-CIDR6':
      return `IP range /${r.value.split('/')[1]} (longer prefixes win; after all hostname rules)`;
    case 'IP-ASN':
      return 'Autonomous system (after IP ranges)';
    case 'GEOIP':
      return 'IP country (lowest precedence)';
  }
}

async function renderVerifyCard(): Promise<void> {
  const card = document.getElementById('verifyCard');
  if (!card) return;
  clear(card);
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && t.url && hostFromUrl(t.url));
  const select = h('select', { 'aria-label': 'Tab to verify' }, ...tabs.map((t) => h('option', { value: String(t.id) }, `${hostFromUrl(t.url!)} — ${t.title ?? ''}`.slice(0, 90))));
  const out = h('div', { class: 'stack' });
  card.append(
    h('h2', {}, 'What does a tab actually report?'),
    h('p', { class: 'hint' }, 'Reads navigator.language(s) and Intl in the page and in its cross-site frames, from an isolated world the page cannot see. “At start” is what the page’s first scripts saw.'),
    tabs.length
      ? h('div', { class: 'row' }, select, h('button', {
          onclick: async () => {
            clear(out);
            out.append(h('p', { class: 'muted' }, 'Checking…'));
            const tabId = Number(select.value);
            const [st, v] = await Promise.all([send({ type: 'getStatus', tabId }), send({ type: 'verify', tabId })]);
            clear(out);
            out.append(renderVerification(st.status, v));
          },
        }, 'Verify'))
      : h('p', { class: 'muted' }, 'Open a website in another tab to verify it.'),
    out,
  );
}

function renderVerification(status: TabStatus | null, v: VerifyResult): HTMLElement {
  const view = describeStatus(status, null);
  const box = h('div', { class: 'stack' }, h('div', { class: 'row' }, chip(view.label, view.kind), h('span', { class: 'small muted' }, view.detail)));
  if (!v.attached) {
    box.append(h('div', { class: 'notice info' }, v.error ?? 'Not attached.'));
    return box;
  }
  for (const f of v.frames) {
    if (f.error || !f.live) {
      box.append(h('div', { class: 'notice bad' }, `${f.kind} ${f.url}: ${f.error ?? 'no data'}`));
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
      ['Time zone', (s) => s.timeZone, false],
    ];
    box.append(
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('strong', {}, f.kind === 'main' ? 'Page' : 'Cross-site frame'), h('code', {}, f.url), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `expected: ${exp ?? 'system locale'}`)),
        h('table', {}, h('tr', {}, h('th', {}, 'API'), h('th', {}, 'At start'), h('th', {}, 'Now')),
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
  const area = h('textarea', { class: 'config', spellcheck: false, 'aria-label': 'Configuration text' });
  const msg = h('div', { class: 'stack' });
  const mode = h('select', { 'aria-label': 'Import mode' }, h('option', { value: 'replace' }, 'Replace everything'), h('option', { value: 'merge' }, 'Merge rules into current'));
  const file = h('input', { type: 'file', accept: '.json,.yaml,.yml,.txt', 'aria-label': 'Import file' });
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
    h('h1', {}, 'Import / export'),
    h('p', { class: 'lead' },
      'JSON or YAML. Rules may use the full form ({type, domain|keyword, locale | action: SYSTEM, languages, timezone, geolocation, priority, enabled}) or Clash-style strings such as "DOMAIN-SUFFIX,google.com,en-US", "DOMAIN,accounts.google.com,DIRECT" and "MATCH,SYSTEM".'),
    h('div', { class: 'row wrap' },
      h('button', { onclick: () => { area.value = exportConfig(settings, 'yaml'); show('ok', 'Current configuration shown as YAML.'); } }, 'Show as YAML'),
      h('button', { onclick: () => { area.value = exportConfig(settings, 'json'); show('ok', 'Current configuration shown as JSON.'); } }, 'Show as JSON'),
      h('button', { onclick: () => download('yaml') }, 'Download .yaml'),
      h('button', { onclick: () => download('json') }, 'Download .json'),
      h('button', { onclick: async () => { await navigator.clipboard.writeText(area.value); show('ok', 'Copied.'); } }, 'Copy'),
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
          if (!r.settings) return show('bad', 'Nothing was imported. Fix these problems:', r.errors);
          const next = mode.value === 'merge' ? mergeRules(settings, r.settings).settings : r.settings;
          const issues = analyzeRules(next).filter((i) => i.level !== 'info');
          if (!confirm(`${mode.value === 'merge' ? 'Merge' : 'Replace with'} ${r.settings.rules.length} rule(s)?${issues.length ? `\n\n${issues.length} check(s) need review afterwards.` : ''}`)) return;
          await commit(next);
          show(r.warnings.length || issues.length ? 'warn' : 'ok', `Imported ${r.settings.rules.length} rule(s).`, [...r.warnings, ...issues.map((i) => i.message)]);
        },
      }, 'Validate & import'),
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
    h('h1', {}, 'Settings'),
    h('div', { class: 'card stack' },
      h('h2', {}, 'Frames'),
      radio('inherit', 'Inherit — embedded frames report the same locale as the page (recommended)'),
      radio('per-frame', 'Per frame — cross-site frames use their own rule'),
      h('p', { class: 'hint' },
        'Per-frame works for cross-site frames only: they run in their own renderer process. Same-site frames always share the page’s process and locale. Per-frame mode attaches the debugger to every web tab, because any page may embed a matching frame.'),
    ),
    h('div', { class: 'card stack' },
      opt(toggleSwitch(o.keepSessionOnSystem, (v) => set({ keepSessionOnSystem: v }), 'Keep sessions'), 'Keep the debugger attached after leaving a spoofed site',
        'When on, the next navigation in that tab can be switched to the right profile before it starts. When off, sessions are detached on SYSTEM sites; returning to a spoofed site then relies on attaching in time.'),
      opt(toggleSwitch(o.reloadOnLate, (v) => set({ reloadOnLate: v }), 'Reload once'), 'Reload once if the profile arrived late',
        'For example, when you type a URL into a new tab, Chrome only allows debugging after the page has started. The page is reloaded once (never form submissions, back/forward, or reloads).'),
      opt(toggleSwitch(o.dnrHeaders, (v) => set({ dnrHeaders: v }), 'DNR headers'), 'Set Accept-Language for top-level pages with declarativeNetRequest',
        'Makes the very first document request carry the right header even before the debugger can attach. Mirrors your rules exactly.'),
      opt(toggleSwitch(o.overrideWorkers, (v) => set({ overrideWorkers: v }), 'Workers'), 'Override navigator.language in dedicated workers',
        'Intl in workers follows the page automatically; this also aligns navigator.language(s) and the worker’s own requests.'),
    ),
    h('div', { class: 'card row wrap' },
      h('div', { class: 'spacer' }, h('strong', {}, 'Reset'), h('div', { class: 'hint' }, 'Restore the example rules and default settings.')),
      h('button', {
        class: 'danger',
        onclick: () => {
          if (confirm('Reset all rules and settings to the defaults?')) void commit(defaultSettings());
        },
      }, 'Reset to defaults'),
    ),
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
    root.append(h('h1', {}, 'Sessions & log'), h('div', { class: 'notice bad' }, `Background worker unavailable: ${(e as Error).message}`));
    return;
  }
  if (token !== sessionsRender) return; // a newer render started meanwhile
  clear(root);
  root.append(h('h1', {}, 'Sessions & log'));
  const g = data.global;
  root.append(
    h('div', { class: 'card row wrap' },
      chip(g.enabled ? (g.suspended ? 'Paused' : 'On') : 'Off', g.enabled && !g.suspended ? 'ok' : 'warn'),
      h('span', {}, `${g.attachedTabs} tab(s) under debugging`),
      chip(g.dnr.active ? `DNR: ${g.dnr.ruleCount} header rule(s)` : 'DNR: off', g.dnr.error ? 'bad' : 'off'),
      h('span', { class: 'spacer' }),
      g.suspended ? h('button', { class: 'primary', onclick: async () => { await send({ type: 'resume' }); void renderSessions(); } }, 'Resume') : null,
      h('button', { onclick: async () => { const r = await send({ type: 'detachAll' }); alert(`Detached ${r.detached} session(s). They are re-attached on the next navigation that needs spoofing.`); void renderSessions(); } }, 'Detach all now'),
      h('button', { onclick: () => void renderSessions() }, 'Refresh'),
    ),
  );
  if (g.dnr.error) root.append(h('div', { class: 'notice bad' }, `declarativeNetRequest: ${g.dnr.error}`));
  if (g.settingsProblems.length) root.append(h('div', { class: 'notice warn' }, 'Stored settings had problems:', h('ul', {}, ...g.settingsProblems.map((p) => h('li', {}, p)))));

  const rows = data.statuses.filter((s) => s.host).sort((a, b) => Number(b.session === 'attached') - Number(a.session === 'attached'));
  root.append(
    h('div', { class: 'card', style: 'padding:0' },
      rows.length
        ? h('table', {},
            h('tr', {}, h('th', {}, 'Tab'), h('th', {}, 'Site'), h('th', {}, 'Rule'), h('th', {}, 'Status'), h('th', {}, 'Frames / workers')),
            ...rows.map((s) => {
              const v = describeStatus(s, g);
              return h('tr', {},
                h('td', { class: 'muted' }, String(s.tabId)),
                h('td', { class: 'mono' }, toUnicode(s.host ?? '')),
                h('td', { class: 'mono small' }, s.resolution.ruleLabel ?? (s.resolution.source === 'default' ? 'default' : '')),
                h('td', { title: v.detail }, chip(v.label, v.kind), s.warnings.length ? h('div', { class: 'hint' }, s.warnings.join(' ')) : null),
                h('td', { class: 'muted' }, `${s.frames} / ${s.workers}`),
              );
            }),
          )
        : h('p', { class: 'muted', style: 'padding:14px' }, 'No web tabs seen yet.'),
    ),
  );
  root.append(
    h('h2', {}, 'Recent activity'),
    h('p', { class: 'hint' }, 'Kept in memory only, never stored or sent anywhere. Contains hostnames, not full URLs.'),
    h('div', { class: 'log' }, log.entries.length ? log.entries.slice(-200).map((e) => `${new Date(e.t).toLocaleTimeString()}  ${e.level.padEnd(5)} ${e.tabId !== null ? `tab ${e.tabId}: ` : ''}${e.msg}`).join('\n') : 'Nothing logged yet.'),
  );
}

// ----------------------------------------------------------------------- about

function renderAbout(): void {
  const root = $('#about');
  clear(root);
  const li = (title: string, text: string) => h('li', {}, h('strong', {}, title), ' — ', text);
  root.append(
    h('h1', {}, 'Limitations & privacy'),
    h('div', { class: 'card stack' },
      h('h2', {}, 'How it works'),
      h('p', {},
        'Locale Jacket uses Chrome’s own DevTools emulation through the chrome.debugger API, the same mechanism as DevTools ▸ Sensors ▸ Locale, so no page APIs are monkey-patched. It sets Emulation.setLocaleOverride (Intl) and the Accept-Language/navigator.languages override (Emulation.setUserAgentOverride with an empty user agent, which keeps your real User-Agent and client hints). Chrome’s UI language is never touched.'),
    ),
    h('div', { class: 'card stack' },
      h('h2', {}, 'What cannot be guaranteed'),
      h('ul', { class: 'limits' },
        li('Debugging banner', 'Chrome shows “started debugging this browser” while any tab is spoofed. It cannot and should not be hidden. Closing it with Cancel pauses Locale Jacket until you resume.'),
        li('Restricted pages', 'chrome:// and edge:// pages, the New Tab Page, the Chrome Web Store / Edge Add-ons, and sites blocked by enterprise policy cannot be debugged.'),
        li('First load from the New Tab Page', 'Chrome allows attaching only once the page has started, so the first scripts see the real locale. The HTTP header is still correct (declarativeNetRequest), and the page is reloaded once if that option is on.'),
        li('Profile switches', 'When a navigation changes the profile (e.g. google.com → apple.com), it is briefly aborted and re-issued so the next page starts with the right values. POST form submissions cannot be re-issued; such pages are flagged “Reload needed”.'),
        li('One locale per renderer process', 'Intl’s locale (and the time zone override) applies to a whole renderer process. Two tabs of the same site, or the same cross-site iframe embedded in two tabs, can share a process, and then only one locale can win. Conflicts are shown as “Partial”.'),
        li('DevTools Sensors', 'While a tab is spoofed, DevTools ▸ Sensors ▸ Locale cannot override the locale in that renderer process (and vice versa). This is reported, not hidden.'),
        li('Frames', 'Same-site frames always share the page’s locale. Per-frame mode only works for cross-site frames.'),
        li('Workers', 'Dedicated workers are covered. Service workers and shared workers are not overridden: their Intl follows whichever process hosts them, and their navigator.language and requests use the real locale.'),
        li('Back/forward cache and prerender', 'Pages restored from the cache or activated from a prerender were created earlier. They are re-aligned when shown and flagged if they started with other values.'),
        li('Already-open tabs', 'Tabs open when the extension starts, is enabled or changes rules keep what their scripts already read until reloaded. The popup offers a reload.'),
      ),
    ),
    h('div', { class: 'card stack' },
      h('h2', {}, 'Privacy'),
      h('ul', { class: 'limits' },
        h('li', {}, 'Everything runs locally. There is no server, account, telemetry or analytics, and the extension never makes network requests of its own.'),
        h('li', {}, 'Rules and settings live in chrome.storage.local on this device. The activity log is in memory only and holds hostnames, not URLs.'),
        h('li', {}, 'Permissions: debugger (the emulation itself), webNavigation and tabs access via host permissions (to know which site a tab is on), declarativeNetRequestWithHostAccess (first-request Accept-Language), storage.'),
      ),
    ),
  );
}

// ------------------------------------------------------------------------ boot

function renderAll(): void {
  renderRules();
  renderTest();
  renderIO();
  renderSettings();
  renderAbout();
  if (currentPage() === 'sessions') void renderSessions();
  $('#navStatus').textContent = `${settings.rules.length} rule(s) · ${settings.enabled ? 'on' : 'off'}`;
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
