// Locale selector: presets, an optional "System locale" entry, and a validated custom BCP 47 tag.

import { canonicalizeLocale, isSupportedLocale } from '../shared/locale.js';
import { LOCALE_PRESETS } from '../shared/presets.js';
import { t } from '../shared/i18n.js';
import { h } from './dom.js';

const SYSTEM = '__system__';
const CUSTOM = '__custom__';

export interface LocalePicker {
  el: HTMLElement;
  /** Canonical tag, null for "System locale", undefined while the custom input is invalid. */
  value(): string | null | undefined;
  set(value: string | null): void;
}

export function localePicker(initial: string | null, opts: { allowSystem?: boolean; onChange?: () => void; id?: string } = {}): LocalePicker {
  const select = h('select', { id: opts.id ?? null, 'aria-label': t('picker.locale') });
  if (opts.allowSystem) select.append(h('option', { value: SYSTEM }, t('picker.system')));
  for (const p of LOCALE_PRESETS) select.append(h('option', { value: p.locale }, `${p.locale} — ${p.label}`));
  select.append(h('option', { value: CUSTOM }, t('picker.custom')));

  const custom = h('input', { type: 'text', placeholder: t('picker.customPlaceholder'), spellcheck: false, size: 16, 'aria-label': t('picker.customLabel') });
  const msg = h('div', { class: 'hint' });
  const el = h('div', { class: 'stack', style: 'gap:4px' }, select, custom, msg);

  const validate = (): string | null | undefined => {
    msg.textContent = '';
    msg.className = 'hint';
    custom.classList.remove('invalid');
    if (select.value === SYSTEM) return null;
    if (select.value !== CUSTOM) return select.value;
    const raw = custom.value.trim();
    if (!raw) {
      msg.textContent = t('picker.enterTag');
      return undefined;
    }
    const canonical = canonicalizeLocale(raw);
    if (!canonical) {
      custom.classList.add('invalid');
      msg.className = 'error-text';
      msg.textContent = t('picker.invalid', { tag: raw });
      return undefined;
    }
    if (!isSupportedLocale(canonical)) {
      msg.className = 'warn-text';
      msg.textContent = t('picker.noIcu', { tag: canonical });
    } else if (canonical !== raw) {
      msg.textContent = t('picker.savedAs', { tag: canonical });
    }
    return canonical;
  };

  const sync = () => {
    custom.hidden = select.value !== CUSTOM;
    validate();
    opts.onChange?.();
  };
  select.addEventListener('change', sync);
  custom.addEventListener('input', () => {
    validate();
    opts.onChange?.();
  });

  const set = (value: string | null) => {
    if (value === null) select.value = opts.allowSystem ? SYSTEM : LOCALE_PRESETS[0]!.locale;
    else if (LOCALE_PRESETS.some((p) => p.locale === value)) select.value = value;
    else {
      select.value = CUSTOM;
      custom.value = value;
    }
    custom.hidden = select.value !== CUSTOM;
    validate();
  };
  set(initial);
  return { el, value: validate, set };
}
