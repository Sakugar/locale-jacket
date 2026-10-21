// Rule editor dialog and the reusable locale-profile form.

import { acceptLanguageHeader, deriveLanguages, normalizeProfile } from '../shared/locale.js';
import { LOCALE_PRESETS } from '../shared/presets.js';
import { normalizeRuleValue, newRuleId } from '../shared/rules.js';
import type { LocaleProfile, Rule, RuleType } from '../shared/types.js';
import { isIpRuleType, RULE_TYPES } from '../shared/types.js';
import { send } from '../shared/messages.js';
import { t as tr, type MessageKey } from '../shared/i18n.js';

const LABELS: Record<RuleType, MessageKey> = {
  DOMAIN: 'rule.label.domain',
  'DOMAIN-SUFFIX': 'rule.label.domain',
  'DOMAIN-KEYWORD': 'rule.label.keyword',
  'DOMAIN-REGEX': 'rule.label.regex',
  GEOSITE: 'rule.label.geosite',
  'IP-CIDR': 'rule.label.cidr4',
  'IP-CIDR6': 'rule.label.cidr6',
  'IP-ASN': 'rule.label.asn',
  GEOIP: 'rule.label.geoip',
};
const PLACEHOLDERS: Record<RuleType, string> = {
  DOMAIN: 'accounts.google.com',
  'DOMAIN-SUFFIX': 'google.com',
  'DOMAIN-KEYWORD': 'microsoft',
  'DOMAIN-REGEX': '^(.+\.)?example\.(com|org)$',
  GEOSITE: 'google, cn, apple@cn',
  'IP-CIDR': '17.0.0.0/8',
  'IP-CIDR6': '2001:db8::/32',
  'IP-ASN': '13335',
  GEOIP: 'US, JP, LAN',
};

let geositeList: HTMLDataListElement | null = null;
/** Offer the installed GeoSite categories as suggestions (loaded once per page). */
async function loadGeositeNames(input: HTMLInputElement): Promise<void> {
  if (!geositeList) {
    geositeList = h('datalist', { id: 'lj-geosite' });
    document.body.append(geositeList);
    try {
      const { names } = await send({ type: 'geositeCategories' });
      for (const n of names) geositeList.append(h('option', { value: n }));
    } catch {
      /* no suggestions */
    }
  }
  input.setAttribute('list', 'lj-geosite');
}

import { h, clear } from '../ui/dom.js';
import { localePicker } from '../ui/locale-picker.js';

export interface ProfileForm {
  el: HTMLElement;
  read(): { profile: LocaleProfile | null; errors: string[]; warnings: string[] };
}

let tzOptions: HTMLDataListElement | null = null;
function timezoneList(): HTMLDataListElement {
  if (tzOptions) return tzOptions;
  tzOptions = h('datalist', { id: 'lj-timezones' });
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    zones = [...new Set(LOCALE_PRESETS.map((p) => p.timezone))];
  }
  for (const z of zones) tzOptions.append(h('option', { value: z }));
  document.body.append(tzOptions);
  return tzOptions;
}

export function profileForm(initial: LocaleProfile | null): ProfileForm {
  timezoneList();
  const start = initial ?? normalizeProfile({ locale: 'en-US' }).profile!;
  let languagesTouched = initial !== null && initial.languages.join(',') !== deriveLanguages(initial.locale).join(',');

  const header = h('code', {});
  const langs = h('input', { type: 'text', value: start.languages.join(', '), spellcheck: false, 'aria-label': 'navigator.languages' });
  const tzOn = h('input', { type: 'checkbox' });
  tzOn.checked = Boolean(start.timezone);
  const presetTz = () => LOCALE_PRESETS.find((p) => p.locale === picker.value())?.timezone ?? '';
  const tz = h('input', { type: 'text', list: 'lj-timezones', value: start.timezone ?? '', placeholder: tr('common.eg', { x: 'America/New_York' }), spellcheck: false, 'aria-label': tr('common.timeZone') });
  const geoOn = h('input', { type: 'checkbox' });
  geoOn.checked = Boolean(start.geolocation);
  const lat = h('input', { type: 'number', step: 'any', min: -90, max: 90, value: start.geolocation?.latitude ?? '', placeholder: tr('profile.latitude'), 'aria-label': tr('profile.latitude') });
  const lon = h('input', { type: 'number', step: 'any', min: -180, max: 180, value: start.geolocation?.longitude ?? '', placeholder: tr('profile.longitude'), 'aria-label': tr('profile.longitude') });
  const acc = h('input', { type: 'number', step: 'any', min: 1, value: start.geolocation?.accuracy ?? 100, placeholder: tr('profile.accuracy'), 'aria-label': tr('profile.accuracy') });
  const msg = h('div', { class: 'stack', style: 'gap:2px' });

  const picker = localePicker(start.locale, {
    onChange: () => {
      const v = picker.value();
      if (v && !languagesTouched) langs.value = deriveLanguages(v).join(', ');
      if (v && tzOn.checked && !tz.value) tz.value = presetTz();
      update();
    },
  });
  langs.addEventListener('input', () => {
    languagesTouched = true;
    update();
  });
  const resetLangs = h('button', {
    type: 'button',
    class: 'link small',
    onclick: () => {
      const v = picker.value();
      if (v) langs.value = deriveLanguages(v).join(', ');
      languagesTouched = false;
      update();
    },
  }, tr('profile.resetLanguages'));
  const tzRow = h('div', { class: 'row' }, tz);
  const geoRow = h('div', { class: 'grid3' }, lat, lon, acc);
  tzOn.addEventListener('change', () => {
    if (tzOn.checked && !tz.value) tz.value = presetTz();
    update();
  });
  geoOn.addEventListener('change', update);
  for (const el of [tz, lat, lon, acc]) el.addEventListener('input', update);

  function read() {
    const locale = picker.value();
    if (locale === undefined || locale === null) return { profile: null, errors: [tr('profile.chooseLocale')], warnings: [] };
    return normalizeProfile({
      locale,
      languages: langs.value.split(',').map((s) => s.trim()).filter(Boolean),
      timezone: tzOn.checked ? tz.value.trim() : null,
      geolocation: geoOn.checked ? { latitude: lat.value === '' ? NaN : Number(lat.value), longitude: lon.value === '' ? NaN : Number(lon.value), accuracy: Number(acc.value || 100) } : null,
    });
  }

  function update() {
    tzRow.hidden = !tzOn.checked;
    geoRow.hidden = !geoOn.checked;
    const r = read();
    const list = langs.value.split(',').map((s) => s.trim()).filter(Boolean);
    header.textContent = r.profile ? r.profile.acceptLanguage : acceptLanguageHeader(list);
    clear(msg);
    for (const e of r.errors) msg.append(h('div', { class: 'error-text' }, e));
    for (const w of r.warnings) msg.append(h('div', { class: 'warn-text' }, w));
  }

  const el = h('fieldset', {},
    h('legend', {}, tr('profile.legend')),
    h('div', { class: 'field' }, h('span', {}, tr('profile.localeField')), picker.el),
    h('div', { class: 'field' },
      h('span', {}, 'navigator.languages'),
      langs,
      h('div', { class: 'row hint' }, h('span', {}, tr('profile.headerSent')), header, h('span', { class: 'spacer' }), resetLangs),
    ),
    h('label', { class: 'row' }, tzOn, h('span', {}, tr('profile.tzOverride')), h('span', { class: 'hint' }, tr('profile.tzHint'))),
    tzRow,
    h('label', { class: 'row' }, geoOn, h('span', {}, tr('profile.geoOverride')), h('span', { class: 'hint' }, tr('profile.geoHint'))),
    geoRow,
    msg,
  );
  update();
  return { el, read };
}

// ---------------------------------------------------------------------------

export interface RuleDialogResult {
  rule: Rule;
}

/** Open the editor for an existing rule (or a new one when `rule` is null). Resolves null on cancel. */
export function editRule(dialog: HTMLDialogElement, rule: Rule | null, prefill: Partial<Rule> = {}): Promise<Rule | null> {
  clear(dialog);
  const base: Rule = rule ?? {
    id: newRuleId(),
    type: 'DOMAIN-SUFFIX',
    value: '',
    action: 'PROFILE',
    profile: null,
    enabled: true,
    priority: 0,
    note: '',
    ...prefill,
  };

  const type = h('select', { 'aria-label': tr('rule.matchType') }, ...RULE_TYPES.map((t) => h('option', { value: t }, t)));
  type.value = base.type;
  const typeHint = h('div', { class: 'hint' });
  const value = h('input', { type: 'text', value: base.value, spellcheck: false, autofocus: true, 'aria-label': tr('rule.value') });
  const valueMsg = h('div', { class: 'hint' });
  const valueLabel = h('span', {});
  const actionProfile = h('input', { type: 'radio', name: 'action', value: 'PROFILE' });
  const actionSystem = h('input', { type: 'radio', name: 'action', value: 'SYSTEM' });
  actionProfile.checked = base.action === 'PROFILE';
  actionSystem.checked = base.action === 'SYSTEM';
  const pf = profileForm(base.profile);
  const noResolve = h('input', { type: 'checkbox' });
  noResolve.checked = Boolean(base.noResolve);
  const noResolveRow = h('label', { class: 'row' }, noResolve, h('span', {}, 'no-resolve'), h('span', { class: 'hint' }, tr('rule.noResolveHint')));
  const priority = h('input', { type: 'number', step: 1, value: base.priority, style: 'width:90px', 'aria-label': tr('rule.priorityShort') });
  const note = h('input', { type: 'text', value: base.note, placeholder: tr('rule.notePlaceholder'), 'aria-label': tr('rule.note') });
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = base.enabled;
  const formErrors = h('div', {});

  const TYPE_HINTS: Record<RuleType, MessageKey> = {
    'DOMAIN-SUFFIX': 'rule.hint.suffix',
    DOMAIN: 'rule.hint.domain',
    'DOMAIN-KEYWORD': 'rule.hint.keyword',
    'DOMAIN-REGEX': 'rule.hint.regex',
    GEOSITE: 'rule.hint.geosite',
    'IP-CIDR': 'rule.hint.cidr4',
    'IP-CIDR6': 'rule.hint.cidr6',
    'IP-ASN': 'rule.hint.asn',
    GEOIP: 'rule.hint.geoip',
  };
  const syncType = () => {
    typeHint.textContent = tr(TYPE_HINTS[type.value as RuleType]);
    const t = type.value as RuleType;
    value.placeholder = tr('common.eg', { x: PLACEHOLDERS[t] });
    valueLabel.textContent = tr(LABELS[t]);
    noResolveRow.hidden = !isIpRuleType(t);
    if (t === 'GEOSITE') void loadGeositeNames(value);
    checkValue();
  };
  const checkValue = () => {
    valueMsg.className = 'hint';
    value.classList.remove('invalid');
    if (!value.value.trim()) {
      valueMsg.textContent = '';
      return null;
    }
    const r = normalizeRuleValue(type.value as RuleType, value.value);
    if (!r.value) {
      valueMsg.className = 'error-text';
      valueMsg.textContent = r.error ?? tr('rule.invalidValue');
      value.classList.add('invalid');
      return null;
    }
    valueMsg.textContent = r.notes.join(' ');
    return r.value;
  };
  const syncAction = () => {
    pf.el.hidden = !actionProfile.checked;
  };
  type.addEventListener('change', syncType);
  value.addEventListener('input', checkValue);
  actionProfile.addEventListener('change', syncAction);
  actionSystem.addEventListener('change', syncAction);

  return new Promise((resolve) => {
    const cancel = h('button', { type: 'button', onclick: () => dialog.close('cancel') }, tr('common.cancel'));
    const save = h('button', { type: 'submit', class: 'primary' }, tr(rule ? 'rule.save' : 'rule.add'));
    const form = h('form', { method: 'dialog' },
      h('h2', {}, tr(rule ? 'rule.editTitle' : 'rule.newTitle')),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, tr('rule.matchType')), type),
        h('label', { class: 'field' }, valueLabel, value),
      ),
      typeHint,
      valueMsg,
      noResolveRow,
      h('div', { class: 'field' },
        h('span', {}, tr('rule.action')),
        h('label', { class: 'row' }, actionProfile, h('span', {}, tr('rule.actionProfile'))),
        h('label', { class: 'row' }, actionSystem, h('span', {}, tr('rule.actionSystem'))),
      ),
      pf.el,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, tr('rule.priority')), priority),
        h('label', { class: 'field' }, h('span', {}, tr('rule.note')), note),
      ),
      h('label', { class: 'row' }, enabled, h('span', {}, tr('rule.enabled'))),
      formErrors,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), cancel, save),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clear(formErrors);
      const errors: string[] = [];
      const v = checkValue();
      if (!v) errors.push(tr(value.value.trim() ? 'rule.fixValue' : 'rule.enterValue'));
      const action = actionSystem.checked ? 'SYSTEM' : 'PROFILE';
      let profile: LocaleProfile | null = null;
      if (action === 'PROFILE') {
        const r = pf.read();
        if (!r.profile) errors.push(...r.errors);
        profile = r.profile;
      }
      const prio = Number(priority.value || 0);
      if (!Number.isInteger(prio)) errors.push(tr('rule.priorityInteger'));
      if (errors.length) {
        for (const err of errors) formErrors.append(h('div', { class: 'error-text' }, err));
        return;
      }
      dialog.close('save');
      const t = type.value as RuleType;
      const { noResolve: _old, ...rest } = base;
      resolve({ ...rest, type: t, value: v!, action, profile, priority: prio, note: note.value.trim(), enabled: enabled.checked, ...(isIpRuleType(t) && noResolve.checked ? { noResolve: true } : {}) });
    });
    dialog.addEventListener('close', () => resolve(null), { once: true });
    dialog.append(form);
    syncType();
    syncAction();
    dialog.showModal();
  });
}

/** Edit only a profile (used for the default action). */
export function editProfile(dialog: HTMLDialogElement, title: string, profile: LocaleProfile | null): Promise<LocaleProfile | null> {
  clear(dialog);
  const pf = profileForm(profile);
  const errors = h('div', {});
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog' },
      h('h2', {}, title),
      pf.el,
      errors,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { type: 'button', onclick: () => dialog.close() }, tr('common.cancel')), h('button', { type: 'submit', class: 'primary' }, tr('common.save'))),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = pf.read();
      clear(errors);
      if (!r.profile) {
        for (const err of r.errors) errors.append(h('div', { class: 'error-text' }, err));
        return;
      }
      dialog.close('save');
      resolve(r.profile);
    });
    dialog.addEventListener('close', () => resolve(null), { once: true });
    dialog.append(form);
    dialog.showModal();
  });
}
