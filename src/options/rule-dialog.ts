// Rule editor dialog and the reusable locale-profile form.

import { acceptLanguageHeader, deriveLanguages, normalizeProfile } from '../shared/locale.js';
import { LOCALE_PRESETS } from '../shared/presets.js';
import { normalizeRuleValue, newRuleId } from '../shared/rules.js';
import type { LocaleProfile, Rule, RuleType } from '../shared/types.js';
import { isIpRuleType, RULE_TYPES } from '../shared/types.js';
import { send } from '../shared/messages.js';

const LABELS: Record<RuleType, string> = {
  DOMAIN: 'Domain',
  'DOMAIN-SUFFIX': 'Domain',
  'DOMAIN-KEYWORD': 'Keyword',
  'DOMAIN-REGEX': 'Regular expression',
  GEOSITE: 'GeoSite category',
  'IP-CIDR': 'IPv4 range (CIDR)',
  'IP-CIDR6': 'IPv6 range (CIDR)',
  'IP-ASN': 'AS number',
  GEOIP: 'Country code or LAN',
};
const PLACEHOLDERS: Record<RuleType, string> = {
  DOMAIN: 'e.g. accounts.google.com',
  'DOMAIN-SUFFIX': 'e.g. google.com',
  'DOMAIN-KEYWORD': 'e.g. microsoft',
  'DOMAIN-REGEX': 'e.g. ^(.+\.)?example\.(com|org)$',
  GEOSITE: 'e.g. google, cn, apple@cn',
  'IP-CIDR': 'e.g. 17.0.0.0/8',
  'IP-CIDR6': 'e.g. 2001:db8::/32',
  'IP-ASN': 'e.g. 13335',
  GEOIP: 'e.g. US, JP, LAN',
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
  const tz = h('input', { type: 'text', list: 'lj-timezones', value: start.timezone ?? '', placeholder: 'e.g. America/New_York', spellcheck: false, 'aria-label': 'Time zone' });
  const geoOn = h('input', { type: 'checkbox' });
  geoOn.checked = Boolean(start.geolocation);
  const lat = h('input', { type: 'number', step: 'any', min: -90, max: 90, value: start.geolocation?.latitude ?? '', placeholder: 'latitude', 'aria-label': 'Latitude' });
  const lon = h('input', { type: 'number', step: 'any', min: -180, max: 180, value: start.geolocation?.longitude ?? '', placeholder: 'longitude', 'aria-label': 'Longitude' });
  const acc = h('input', { type: 'number', step: 'any', min: 1, value: start.geolocation?.accuracy ?? 100, placeholder: 'accuracy (m)', 'aria-label': 'Accuracy in meters' });
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
  }, 'Reset from locale');
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
    if (locale === undefined || locale === null) return { profile: null, errors: ['Choose a valid locale.'], warnings: [] };
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
    h('legend', {}, 'Locale profile'),
    h('div', { class: 'field' }, h('span', {}, 'Locale (Intl.* and the default for navigator.language)'), picker.el),
    h('div', { class: 'field' },
      h('span', {}, 'navigator.languages'),
      langs,
      h('div', { class: 'row hint' }, h('span', {}, 'Accept-Language sent:'), header, h('span', { class: 'spacer' }), resetLangs),
    ),
    h('label', { class: 'row' }, tzOn, h('span', {}, 'Override time zone'), h('span', { class: 'hint' }, '(off by default; affects Date and Intl time zone)')),
    tzRow,
    h('label', { class: 'row' }, geoOn, h('span', {}, 'Override geolocation'), h('span', { class: 'hint' }, '(off by default; sites still need location permission)')),
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

  const type = h('select', { 'aria-label': 'Match type' }, ...RULE_TYPES.map((t) => h('option', { value: t }, t)));
  type.value = base.type;
  const typeHint = h('div', { class: 'hint' });
  const value = h('input', { type: 'text', value: base.value, spellcheck: false, autofocus: true, 'aria-label': 'Domain or keyword' });
  const valueMsg = h('div', { class: 'hint' });
  const valueLabel = h('span', {});
  const actionProfile = h('input', { type: 'radio', name: 'action', value: 'PROFILE' });
  const actionSystem = h('input', { type: 'radio', name: 'action', value: 'SYSTEM' });
  actionProfile.checked = base.action === 'PROFILE';
  actionSystem.checked = base.action === 'SYSTEM';
  const pf = profileForm(base.profile);
  const noResolve = h('input', { type: 'checkbox' });
  noResolve.checked = Boolean(base.noResolve);
  const noResolveRow = h('label', { class: 'row' }, noResolve, h('span', {}, 'no-resolve'), h('span', { class: 'hint' }, '— match only when the site is opened by IP address, never via the server address'));
  const priority = h('input', { type: 'number', step: 1, value: base.priority, style: 'width:90px', 'aria-label': 'Priority' });
  const note = h('input', { type: 'text', value: base.note, placeholder: 'Optional note', 'aria-label': 'Note' });
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = base.enabled;
  const formErrors = h('div', {});

  const TYPE_HINTS: Record<RuleType, string> = {
    'DOMAIN-SUFFIX': 'Matches the domain and every subdomain on label boundaries: google.com matches mail.google.com but not fakegoogle.com.',
    DOMAIN: 'Matches this exact hostname only. Exact rules beat every suffix and keyword rule.',
    'DOMAIN-KEYWORD': 'Matches any hostname containing the text. After exact and suffix rules.',
    'DOMAIN-REGEX': 'JavaScript regular expression tested against the hostname (case-insensitive), e.g. ^(.+\\.)?example\\.(com|org)$.',
    GEOSITE: 'A category from the GeoSite data set (Options ▸ Data sets), e.g. google, cn, apple@cn, geolocation-!cn. Matches nothing until the data set is downloaded or imported.',
    'IP-CIDR': 'Matches when the site’s server address is in this IPv4 range, e.g. 17.0.0.0/8. Hostname rules always win over IP rules.',
    'IP-CIDR6': 'Matches when the site’s server address is in this IPv6 range, e.g. 2001:db8::/32.',
    'IP-ASN': 'Matches the server’s autonomous system number, e.g. 13335 (Cloudflare). Needs the ASN data set.',
    GEOIP: 'Matches the server’s country (US, CN, JP …) or LAN (private addresses, no data needed). Country codes need the GeoIP data set.',
  };
  const syncType = () => {
    typeHint.textContent = TYPE_HINTS[type.value as RuleType];
    const t = type.value as RuleType;
    value.placeholder = PLACEHOLDERS[t];
    valueLabel.textContent = LABELS[t];
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
      valueMsg.textContent = r.error ?? 'Invalid value.';
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
    const cancel = h('button', { type: 'button', onclick: () => dialog.close('cancel') }, 'Cancel');
    const save = h('button', { type: 'submit', class: 'primary' }, rule ? 'Save rule' : 'Add rule');
    const form = h('form', { method: 'dialog' },
      h('h2', {}, rule ? 'Edit rule' : 'New rule'),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Match type'), type),
        h('label', { class: 'field' }, valueLabel, value),
      ),
      typeHint,
      valueMsg,
      noResolveRow,
      h('div', { class: 'field' },
        h('span', {}, 'Action'),
        h('label', { class: 'row' }, actionProfile, h('span', {}, 'Spoof with a locale profile')),
        h('label', { class: 'row' }, actionSystem, h('span', {}, 'SYSTEM — keep the real browser locale (exception)')),
      ),
      pf.el,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Priority (tie-breaker, higher wins)'), priority),
        h('label', { class: 'field' }, h('span', {}, 'Note'), note),
      ),
      h('label', { class: 'row' }, enabled, h('span', {}, 'Enabled')),
      formErrors,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), cancel, save),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clear(formErrors);
      const errors: string[] = [];
      const v = checkValue();
      if (!v) errors.push(value.value.trim() ? 'Fix the domain/keyword.' : 'Enter a domain or keyword.');
      const action = actionSystem.checked ? 'SYSTEM' : 'PROFILE';
      let profile: LocaleProfile | null = null;
      if (action === 'PROFILE') {
        const r = pf.read();
        if (!r.profile) errors.push(...r.errors);
        profile = r.profile;
      }
      const prio = Number(priority.value || 0);
      if (!Number.isInteger(prio)) errors.push('Priority must be a whole number.');
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
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'submit', class: 'primary' }, 'Save')),
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
