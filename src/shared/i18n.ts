// UI localization. Catalogs are typed: every key in the English catalog must exist in
// every other catalog, so a missing translation is a compile error.
//
// The display language follows the browser UI language by default and can be changed in
// Options ▸ Settings. Messages use {name} placeholders.

import { en, type MessageKey } from './i18n/en.js';
import { zhCN } from './i18n/zh-CN.js';
import { zhTW } from './i18n/zh-TW.js';
import { ja } from './i18n/ja.js';
import { ko } from './i18n/ko.js';
import { de } from './i18n/de.js';
import { fr } from './i18n/fr.js';
import { es } from './i18n/es.js';
import { ru } from './i18n/ru.js';
import { ptBR } from './i18n/pt-BR.js';

export type { MessageKey };

const CATALOGS = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, de, fr, es, ru, 'pt-BR': ptBR } satisfies Record<string, Record<MessageKey, string>>;

export type UiLanguage = keyof typeof CATALOGS;
export type UiLanguagePref = 'auto' | UiLanguage;

/** Supported interface languages, each named in its own language. */
export const UI_LANGUAGES: readonly { value: UiLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
];

export function isUiLanguagePref(v: unknown): v is UiLanguagePref {
  return v === 'auto' || (typeof v === 'string' && Object.hasOwn(CATALOGS, v));
}

/** Maps a BCP 47 tag (e.g. the browser UI language) to a supported catalog. */
export function matchLanguage(tag: string): UiLanguage {
  const [lang = '', ...rest] = tag.toLowerCase().replace(/_/g, '-').split('-');
  if (lang === 'zh') return rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-TW' : 'zh-CN';
  if (lang === 'pt') return 'pt-BR';
  return Object.hasOwn(CATALOGS, lang) ? (lang as UiLanguage) : 'en';
}

let current: UiLanguage = 'en';

/** The browser's UI language mapped to a supported catalog. */
export function detectLanguage(): UiLanguage {
  let ui = 'en';
  try {
    ui = typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage ? chrome.i18n.getUILanguage() : (globalThis.navigator?.language ?? 'en');
  } catch {
    /* default */
  }
  return matchLanguage(ui);
}

export function setLanguage(pref: UiLanguagePref | undefined): UiLanguage {
  current = isUiLanguagePref(pref) && pref !== 'auto' ? pref : detectLanguage();
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  return current;
}

export function getLanguage(): UiLanguage {
  return current;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const s = CATALOGS[current][key] ?? en[key];
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Translate static markup: elements with data-i18n="key" get their text replaced. */
export function translateDocument(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as MessageKey);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle as MessageKey);
}
