import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportConfig, importConfigText } from '../src/shared/config-io.js';
import { en, type MessageKey } from '../src/shared/i18n/en.js';
import { matchLanguage, setLanguage, t, UI_LANGUAGES } from '../src/shared/i18n.js';
import { defaultSettings } from '../src/shared/presets.js';

const KEYS = Object.keys(en) as MessageKey[];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('UI catalogs', () => {
  for (const { value: lang } of UI_LANGUAGES) {
    it(`${lang}: every message is translated and keeps its placeholders`, () => {
      setLanguage(lang);
      for (const key of KEYS) {
        const s = t(key);
        assert.ok(s.trim(), `${lang} ${key} is empty`);
        assert.deepEqual(placeholders(s), placeholders(en[key]), `${lang} ${key} placeholders`);
      }
    });
  }

  it('non-English catalogs translate the main navigation', () => {
    for (const { value: lang } of UI_LANGUAGES.filter((l) => l.value !== 'en')) {
      setLanguage(lang);
      assert.notEqual(t('opt.nav.settings'), en['opt.nav.settings'], lang);
    }
    setLanguage('en');
  });
});

describe('UI language detection', () => {
  it('maps browser UI languages to catalogs', () => {
    const cases: [string, string][] = [
      ['zh-CN', 'zh-CN'], ['zh', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hans-CN', 'zh-CN'],
      ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh_MO', 'zh-TW'], ['zh-Hant', 'zh-TW'],
      ['ja', 'ja'], ['ko-KR', 'ko'], ['de-AT', 'de'], ['fr-CA', 'fr'], ['es-419', 'es'],
      ['ru', 'ru'], ['pt-PT', 'pt-BR'], ['pt-BR', 'pt-BR'], ['en-GB', 'en'], ['it', 'en'], ['', 'en'],
    ];
    for (const [tag, want] of cases) assert.equal(matchLanguage(tag), want, tag);
  });

  it('import accepts every supported uiLanguage and rejects unknown ones', () => {
    for (const lang of ['auto', ...UI_LANGUAGES.map((l) => l.value)]) {
      const r = importConfigText(JSON.stringify({ options: { uiLanguage: lang } }));
      assert.equal(r.settings?.options.uiLanguage, lang, lang);
    }
    const bad = importConfigText(JSON.stringify({ options: { uiLanguage: 'xx' } }));
    assert.ok(bad.errors.some((e) => e.includes('uiLanguage')), bad.errors.join('\n'));
  });

  it('exports round-trip the uiLanguage', () => {
    const s = defaultSettings();
    s.options.uiLanguage = 'ja';
    assert.equal(importConfigText(exportConfig(s, 'yaml')).settings?.options.uiLanguage, 'ja');
  });
});
