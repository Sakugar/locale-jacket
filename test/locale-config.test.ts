import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportConfig, importConfigText, mergeRules, sanitizeStoredSettings } from '../src/shared/config-io.js';
import { compileDnrRules } from '../src/shared/dnr.js';
import {
  acceptLanguageHeader,
  canonicalizeLocale,
  deriveLanguages,
  makeProfile,
  normalizeProfile,
  parseAcceptLanguage,
} from '../src/shared/locale.js';
import { defaultSettings } from '../src/shared/presets.js';
import { resolveHost } from '../src/shared/rules.js';
import type { Settings } from '../src/shared/types.js';
import { parseYaml, stringifyYaml, YamlError, type YamlValue } from '../src/shared/yaml.js';

describe('locale profiles', () => {
  it('canonicalizes BCP 47 tags and rejects invalid ones', () => {
    assert.equal(canonicalizeLocale('en-us'), 'en-US');
    assert.equal(canonicalizeLocale('zh_hant_tw'), 'zh-Hant-TW');
    assert.equal(canonicalizeLocale('EN'), 'en');
    assert.equal(canonicalizeLocale('not a tag'), null);
    assert.equal(canonicalizeLocale('en-'), null);
    assert.equal(canonicalizeLocale(''), null);
  });

  it('derives languages and the Chrome-format Accept-Language header', () => {
    assert.deepEqual(deriveLanguages('en-US'), ['en-US', 'en']);
    assert.deepEqual(deriveLanguages('ja'), ['ja']);
    assert.equal(acceptLanguageHeader(['en-US', 'en']), 'en-US,en;q=0.9');
    assert.equal(acceptLanguageHeader(['a', 'b', 'c']), 'a,b;q=0.9,c;q=0.8');
    const many = acceptLanguageHeader(Array.from({ length: 12 }, (_, i) => `l${i}`)).split(',');
    assert.equal(many.at(-1), 'l11;q=0.1', 'q never drops below 0.1');
  });

  it('matches the default profile from the specification', () => {
    assert.deepEqual(makeProfile('en-US'), {
      locale: 'en-US',
      languages: ['en-US', 'en'],
      acceptLanguage: 'en-US,en;q=0.9',
      timezone: null,
      geolocation: null,
    });
  });

  it('parses Accept-Language with q-values', () => {
    assert.deepEqual(parseAcceptLanguage('fr;q=0.5, en-US, de;q=0.8, *;q=0.1, x;q=0'), ['en-US', 'de', 'fr']);
  });

  it('completes partial profiles and validates timezone/geolocation', () => {
    const r = normalizeProfile({ acceptLanguage: 'ja-JP,ja;q=0.9' });
    assert.equal(r.profile?.locale, 'ja-JP');
    assert.deepEqual(r.profile?.languages, ['ja-JP', 'ja']);
    assert.deepEqual(r.warnings, []);

    assert.ok(normalizeProfile({ locale: 'en-US', timezone: 'Mars/Base' }).errors.length);
    assert.equal(normalizeProfile({ locale: 'en-US', timezone: 'America/New_York' }).profile?.timezone, 'America/New_York');
    assert.ok(normalizeProfile({ locale: 'en-US', geolocation: { latitude: 200, longitude: 0 } }).errors.length);
    assert.deepEqual(normalizeProfile({ locale: 'en-US', geolocation: { latitude: 40.7, longitude: -74 } }).profile?.geolocation, {
      latitude: 40.7,
      longitude: -74,
      accuracy: 100,
    });
    assert.ok(normalizeProfile({ locale: 'xx-INVALID-!!' }).errors.length);
  });

  it('warns when acceptLanguage disagrees with languages', () => {
    const r = normalizeProfile({ locale: 'en-US', languages: ['en-US', 'en'], acceptLanguage: 'fr-FR' });
    assert.equal(r.profile?.acceptLanguage, 'en-US,en;q=0.9');
    assert.ok(r.warnings.some((w) => /does not match languages/.test(w)));
  });
});

describe('YAML subset', () => {
  it('parses the specification example', () => {
    const v = parseYaml(`
rules:
  - type: DOMAIN-SUFFIX
    domain: google.com
    locale: en-US

  - type: DOMAIN
    domain: accounts.google.com   # exception
    action: SYSTEM

default:
  mode: system
`);
    assert.deepEqual(v, {
      rules: [
        { type: 'DOMAIN-SUFFIX', domain: 'google.com', locale: 'en-US' },
        { type: 'DOMAIN', domain: 'accounts.google.com', action: 'SYSTEM' },
      ],
      default: { mode: 'system' },
    });
  });

  it('handles flow collections, quotes, scalars and same-indent sequences', () => {
    const v = parseYaml(`---
a: [en-US, "en", 'it''s']
b: {x: 1, y: [true, null]}
c:
- 1.5
- -2
- ~
d: "tab\\there # not a comment"
e: plain # comment
f:
`);
    assert.deepEqual(v, {
      a: ['en-US', 'en', "it's"],
      b: { x: 1, y: [true, null] },
      c: [1.5, -2, null],
      d: 'tab\there # not a comment',
      e: 'plain',
      f: null,
    });
  });

  it('parses nested sequences of mappings with nested mappings', () => {
    const v = parseYaml(`
rules:
  - type: DOMAIN-SUFFIX
    domain: apple.com
    profile:
      locale: ja-JP
      geolocation:
        latitude: 35.68
        longitude: 139.69
  -
    type: DOMAIN
    domain: a.com
`);
    assert.deepEqual(v, {
      rules: [
        { type: 'DOMAIN-SUFFIX', domain: 'apple.com', profile: { locale: 'ja-JP', geolocation: { latitude: 35.68, longitude: 139.69 } } },
        { type: 'DOMAIN', domain: 'a.com' },
      ],
    });
  });

  it('rejects unsupported features with line numbers', () => {
    assert.throws(() => parseYaml('a: &x 1\nb: *x'), (e: unknown) => e instanceof YamlError && e.line === 1);
    assert.throws(() => parseYaml('a: |\n  text'), YamlError);
    assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/);
    assert.throws(() => parseYaml('a:\n\t- x'), /tabs/);
    assert.throws(() => parseYaml('a: "open'), /unterminated/);
    assert.throws(() => parseYaml('a: 1\n---\nb: 2'), /multiple YAML documents/);
    assert.throws(() => parseYaml('a:\n  b: 1\n c: 2'), YamlError);
  });

  it('round-trips through stringifyYaml', () => {
    const value: YamlValue = {
      version: 1,
      list: ['a', 'needs: quotes', 'true', '123', '', 'café'],
      nested: [{ x: 1, y: [{ z: null }] }, { empty: [], obj: {} }],
      s: "it's # fine",
    };
    assert.deepEqual(parseYaml(stringifyYaml(value)), value);
  });
});

describe('config import/export', () => {
  it('imports the specification preset and resolves it', () => {
    const r = importConfigText(`
rules:
  - type: DOMAIN-SUFFIX
    domain: google.com
    locale: en-US
  - type: DOMAIN-SUFFIX
    domain: apple.com
    locale: ja-JP
  - type: DOMAIN
    domain: accounts.google.com
    action: SYSTEM
default:
  mode: SYSTEM
`);
    assert.deepEqual(r.errors, []);
    const s = r.settings!;
    assert.equal(resolveHost('accounts.google.com', s).action, 'SYSTEM');
    assert.equal(resolveHost('mail.google.com', s).profile?.locale, 'en-US');
    assert.equal(resolveHost('developer.apple.com', s).profile?.locale, 'ja-JP');
  });

  it('accepts Clash-style compact rules, DIRECT and MATCH', () => {
    const r = importConfigText(`
rules:
  - DOMAIN-SUFFIX,google.com,en-US
  - DOMAIN,accounts.google.com,DIRECT
  - DOMAIN-KEYWORD,microsoft,en-GB
  - MATCH,fr-FR
`);
    assert.deepEqual(r.errors, []);
    const s = r.settings!;
    assert.equal(s.rules.length, 3);
    assert.equal(s.rules[1]!.action, 'SYSTEM');
    assert.equal(s.defaultAction.action, 'PROFILE');
    assert.equal(resolveHost('example.com', s).profile?.locale, 'fr-FR');
  });

  it('accepts JSON with nested profiles and the original single-locale shape', () => {
    const r = importConfigText(
      JSON.stringify({
        rules: [{ type: 'domain-suffix', domain: 'Apple.com', profile: { locale: 'ja-JP', timezone: 'Asia/Tokyo' } }],
        default: { mode: 'PROFILE', locale: 'en-US', languages: ['en-US', 'en'], acceptLanguage: 'en-US,en;q=0.9', timezoneOverride: false, geolocationOverride: false },
      }),
    );
    assert.deepEqual(r.errors, []);
    assert.equal(r.settings!.rules[0]!.profile?.timezone, 'Asia/Tokyo');
    assert.equal(r.settings!.rules[0]!.value, 'apple.com');
    assert.equal(r.settings!.defaultAction.action, 'PROFILE');
  });

  it('reports precise errors', () => {
    const r = importConfigText(`
rules:
  - type: DOMAIN-SUFFIX
    domain: "*.bad*.com"
    locale: en-US
  - type: DOMAIN
    domain: ok.com
  - type: DOMAIN
    domain: ok2.com
    locale: not_a_locale!!
  - type: REGEX
    domain: x
`);
    assert.equal(r.settings, null);
    assert.equal(r.errors.length, 4);
    assert.match(r.errors[0]!, /rules\[0\]/);
    assert.match(r.errors[1]!, /rules\[1\].*locale/);
    assert.match(r.errors[3]!, /unknown rule type/);
  });

  it('round-trips JSON and YAML exports', () => {
    const s = defaultSettings();
    s.rules[0]!.priority = 3;
    s.rules[1]!.enabled = false;
    s.rules[2]!.profile = { ...s.rules[2]!.profile!, timezone: 'Asia/Tokyo', geolocation: { latitude: 35.68, longitude: 139.69, accuracy: 50 } };
    s.defaultAction = { action: 'PROFILE', profile: makeProfile('en-GB') };
    s.options.frameMode = 'per-frame';
    for (const fmt of ['json', 'yaml'] as const) {
      const r = importConfigText(exportConfig(s, fmt));
      assert.deepEqual(r.errors, [], fmt);
      const noIds = (x: Settings) => ({ ...x, rules: x.rules.map(({ id: _id, ...rest }) => rest) });
      assert.deepEqual(noIds(r.settings!), noIds(s), fmt);
    }
  });

  it('merges without duplicating identical rules', () => {
    const base = defaultSettings();
    const incoming = importConfigText('rules:\n  - DOMAIN-SUFFIX,google.com,en-US\n  - DOMAIN-SUFFIX,bing.com,en-US\n').settings!;
    const m = mergeRules(base, incoming);
    assert.equal(m.added, 1);
    assert.equal(m.skipped, 1);
    assert.equal(m.settings.rules.length, base.rules.length + 1);
  });

  it('sanitizes stored settings, keeping valid rules', () => {
    const good = defaultSettings();
    assert.deepEqual(sanitizeStoredSettings(JSON.parse(JSON.stringify(good)), defaultSettings()).settings, good);
    const broken = JSON.parse(JSON.stringify(good)) as Settings;
    (broken.rules[0] as unknown as { value: string }).value = 'bad host!';
    const r = sanitizeStoredSettings(broken, defaultSettings());
    assert.equal(r.settings.rules.length, good.rules.length - 1);
    assert.equal(r.problems.length, 1);
    assert.deepEqual(sanitizeStoredSettings(undefined, good), { settings: good, problems: [] });
    assert.equal(sanitizeStoredSettings('garbage', good).problems.length, 1);
  });
});

describe('DNR compilation', () => {
  function dnrMatch(settings: Settings, url: string): string | null {
    // Minimal DNR evaluator for the condition shapes we emit.
    const { rules } = compileDnrRules(settings);
    const host = new URL(url).hostname;
    const hits = rules.filter((r) => {
      if (r.condition.requestDomains) return r.condition.requestDomains.some((d) => host === d || host.endsWith('.' + d));
      if (r.condition.regexFilter) return new RegExp(r.condition.regexFilter, 'i').test(url);
      return true;
    });
    hits.sort((a, b) => b.priority - a.priority);
    const top = hits[0];
    if (!top || top.action.type === 'allow') return null;
    return top.action.requestHeaders[0]!.value;
  }

  it('reproduces the engine for top-level documents', () => {
    const s = importConfigText(`
rules:
  - DOMAIN-SUFFIX,google.com,en-US
  - DOMAIN,accounts.google.com,SYSTEM
  - DOMAIN-SUFFIX,apple.com,ja-JP
  - DOMAIN-KEYWORD,microsoft,en-GB
  - DOMAIN-SUFFIX,cloud.google.com,de-DE
  - DOMAIN,example.org,fr-FR
`).settings!;
    const cases = [
      'https://google.com/',
      'https://mail.google.com/x',
      'https://accounts.google.com/signin',
      'https://www.accounts.google.com/',
      'https://fakegoogle.com/',
      'https://google.com.evil.org/',
      'https://console.cloud.google.com/',
      'https://developer.apple.com/',
      'https://login.microsoftonline.com/',
      'https://example.org:8443/a',
      'https://sub.example.org/',
      'https://user@example.org/',
      'https://evil.com/?microsoft',
    ];
    for (const url of cases) {
      const res = resolveHost(new URL(url).hostname, s);
      assert.equal(dnrMatch(s, url), res.profile?.acceptLanguage ?? null, url);
    }
  });

  it('adds a lowest-priority catch-all for a PROFILE default', () => {
    const s = defaultSettings();
    s.defaultAction = { action: 'PROFILE', profile: makeProfile('en-US') };
    const { rules } = compileDnrRules(s);
    const last = rules.at(-1)!;
    assert.equal(last.priority, 1);
    assert.equal(last.condition.requestDomains, undefined);
    assert.ok(rules.slice(0, -1).every((r) => r.priority > 1));
    assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  });

  it('skips non-ASCII keywords with a reason', () => {
    const s = importConfigText('rules:\n  - DOMAIN-KEYWORD,例子,ja-JP\n').settings!;
    const r = compileDnrRules(s);
    assert.equal(r.rules.length, 0);
    assert.equal(r.skipped.length, 1);
  });
});
