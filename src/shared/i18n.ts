// UI localization. Catalogs are typed: every key in the English catalog must exist in
// every other catalog, so a missing translation is a compile error.
//
// The display language follows the browser UI language by default and can be changed in
// Options ▸ Settings. Messages use {name} placeholders.

import { en, type MessageKey } from './i18n/en.js';
import { zhCN } from './i18n/zh-CN.js';

export type { MessageKey };
export type UiLanguagePref = 'auto' | 'en' | 'zh-CN';
export type UiLanguage = 'en' | 'zh-CN';

export const UI_LANGUAGES: readonly { value: UiLanguagePref; label: string }[] = [
  { value: 'auto', label: 'Auto / 自动' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
];

const CATALOGS: Record<UiLanguage, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

let current: UiLanguage = 'en';

/** The browser's UI language mapped to a supported catalog. */
export function detectLanguage(): UiLanguage {
  let ui = 'en';
  try {
    ui = typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage ? chrome.i18n.getUILanguage() : (globalThis.navigator?.language ?? 'en');
  } catch {
    /* default */
  }
  return /^zh\b/i.test(ui) ? 'zh-CN' : 'en';
}

export function setLanguage(pref: UiLanguagePref | undefined): UiLanguage {
  current = !pref || pref === 'auto' ? detectLanguage() : pref;
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
