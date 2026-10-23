// Locale presets shown in the UI and the example configuration shipped on first install.

import { DEFAULT_RELEASE_SOURCE } from './extension-update.js';
import { makeProfile } from './locale.js';
import type { Options, Rule, Settings } from './types.js';

export interface LocalePreset {
  locale: string;
  label: string;
  /** Suggested time zone, used only when the user enables the time zone override. */
  timezone: string;
}

export const LOCALE_PRESETS: readonly LocalePreset[] = [
  { locale: 'en-US', label: 'English (United States)', timezone: 'America/New_York' },
  { locale: 'en-GB', label: 'English (United Kingdom)', timezone: 'Europe/London' },
  { locale: 'en-CA', label: 'English (Canada)', timezone: 'America/Toronto' },
  { locale: 'en-AU', label: 'English (Australia)', timezone: 'Australia/Sydney' },
  { locale: 'en-IN', label: 'English (India)', timezone: 'Asia/Kolkata' },
  { locale: 'ja-JP', label: '日本語 (日本)', timezone: 'Asia/Tokyo' },
  { locale: 'ko-KR', label: '한국어 (대한민국)', timezone: 'Asia/Seoul' },
  { locale: 'zh-CN', label: '中文 (中国大陆)', timezone: 'Asia/Shanghai' },
  { locale: 'zh-TW', label: '中文 (台灣)', timezone: 'Asia/Taipei' },
  { locale: 'zh-HK', label: '中文 (香港)', timezone: 'Asia/Hong_Kong' },
  { locale: 'fr-FR', label: 'Français (France)', timezone: 'Europe/Paris' },
  { locale: 'de-DE', label: 'Deutsch (Deutschland)', timezone: 'Europe/Berlin' },
  { locale: 'es-ES', label: 'Español (España)', timezone: 'Europe/Madrid' },
  { locale: 'es-MX', label: 'Español (México)', timezone: 'America/Mexico_City' },
  { locale: 'pt-BR', label: 'Português (Brasil)', timezone: 'America/Sao_Paulo' },
  { locale: 'it-IT', label: 'Italiano (Italia)', timezone: 'Europe/Rome' },
  { locale: 'nl-NL', label: 'Nederlands (Nederland)', timezone: 'Europe/Amsterdam' },
  { locale: 'ru-RU', label: 'Русский (Россия)', timezone: 'Europe/Moscow' },
  { locale: 'pl-PL', label: 'Polski (Polska)', timezone: 'Europe/Warsaw' },
  { locale: 'tr-TR', label: 'Türkçe (Türkiye)', timezone: 'Europe/Istanbul' },
  { locale: 'ar-SA', label: 'العربية (السعودية)', timezone: 'Asia/Riyadh' },
  { locale: 'hi-IN', label: 'हिन्दी (भारत)', timezone: 'Asia/Kolkata' },
  { locale: 'th-TH', label: 'ไทย (ไทย)', timezone: 'Asia/Bangkok' },
  { locale: 'vi-VN', label: 'Tiếng Việt (Việt Nam)', timezone: 'Asia/Ho_Chi_Minh' },
  { locale: 'id-ID', label: 'Bahasa Indonesia', timezone: 'Asia/Jakarta' },
];

export const DEFAULT_OPTIONS: Options = {
  frameMode: 'inherit',
  keepSessionOnSystem: true,
  reloadOnLate: true,
  dnrHeaders: true,
  overrideWorkers: true,
  uiLanguage: 'auto',
  datasetUpdates: { onStartup: false, interval: 'off', minIntervalHours: 24, onlyNeeded: true },
  extensionUpdates: { onStartup: false, interval: 'off', source: DEFAULT_RELEASE_SOURCE },
};

function rule(id: string, partial: Omit<Rule, 'id' | 'enabled' | 'priority' | 'note' | 'profile'> & { locale?: string; note?: string }): Rule {
  return {
    id,
    type: partial.type,
    value: partial.value,
    action: partial.action,
    profile: partial.locale ? makeProfile(partial.locale) : null,
    enabled: true,
    priority: 0,
    note: partial.note ?? '',
  };
}

/** The example configuration from the specification. Users can edit or delete every rule. */
export function examplePresetRules(): Rule[] {
  return [
    rule('example-google', { type: 'DOMAIN-SUFFIX', value: 'google.com', action: 'PROFILE', locale: 'en-US' }),
    rule('example-openai', { type: 'DOMAIN-SUFFIX', value: 'openai.com', action: 'PROFILE', locale: 'en-US' }),
    rule('example-apple', { type: 'DOMAIN-SUFFIX', value: 'apple.com', action: 'PROFILE', locale: 'ja-JP' }),
    rule('example-yahoo-jp', { type: 'DOMAIN-SUFFIX', value: 'yahoo.co.jp', action: 'PROFILE', locale: 'ja-JP' }),
    rule('example-google-accounts', {
      type: 'DOMAIN',
      value: 'accounts.google.com',
      action: 'SYSTEM',
      note: 'Sign-in pages keep the real browser locale.',
    }),
  ];
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    enabled: true,
    rules: examplePresetRules(),
    defaultAction: { action: 'SYSTEM' },
    options: { ...DEFAULT_OPTIONS },
  };
}

/** The original single-locale behaviour: every site reports en-US unless excluded. */
export function globalEnUsSettings(): Settings {
  return {
    schemaVersion: 1,
    enabled: true,
    rules: [],
    defaultAction: { action: 'PROFILE', profile: makeProfile('en-US') },
    options: { ...DEFAULT_OPTIONS },
  };
}
