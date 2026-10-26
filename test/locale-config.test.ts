import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportConfig, importConfigText, mergeRules, sanitizeStoredSettings } from '../src/shared/config-io.js';
import { compileDnrRules } from '../src/shared/dnr.js';
import {
  acceptLanguageHeader,
  canonicalizeLocale,
  deriveLanguages,
  isSupportedLocale,
  isValidTimezone,
  makeProfile,
  normalizeProfile,
  parseAcceptLanguage,
} from '../src/shared/locale.js';
import { defaultSettings } from '../src/shared/presets.js';
import { REGEX_BATCH_BUDGET_MS, refusedRegexes, resolveHost } from '../src/shared/rules.js';
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

  it('keeps stored regex rules the spent settings budget left unchecked, and checks them before use', () => {
    const rule = (id: string, value: string) => ({ id, type: 'DOMAIN-REGEX', value, action: 'PROFILE', profile: makeProfile('ja-JP'), enabled: true, priority: 0, note: '' });
    const stored = { ...JSON.parse(JSON.stringify(defaultSettings())), rules: [rule('ok', '^sanitize-deferred-[a-z]+\\.example$'), rule('bad', '^(b+)+sanitizedeferred$')] };
    // With a budget, the unsafe one is refused as before.
    const checked = sanitizeStoredSettings(stored, defaultSettings());
    assert.deepEqual(checked.settings.rules.map((r) => r.id), ['ok']);
    assert.equal(checked.problems.length, 1);
    // With the budget spent nothing is analysed and nothing is lost...
    const deferred = sanitizeStoredSettings({ ...stored, rules: [rule('ok2', '^sanitize-deferred2-[a-z]+\\.example$'), rule('bad2', '^(c+)+sanitizedeferred$')] }, defaultSettings(), 0);
    assert.deepEqual(deferred.settings.rules.map((r) => r.id), ['ok2', 'bad2']);
    assert.deepEqual(deferred.problems, []);
    // ...and the matcher checks each pattern itself: the unsafe one never runs.
    assert.equal(resolveHost('sanitize-deferred2-abc.example', deferred.settings).profile?.locale, 'ja-JP');
    assert.equal(resolveHost(`${'c'.repeat(30)}sanitizedeferred`, deferred.settings).source, 'default');
    // Once checked, the refused one is reported (the worker lists it with the settings
    // problems) and stays in the settings: a budget never deletes a rule.
    assert.deepEqual(refusedRegexes(deferred.settings.rules).map((x) => x.rule.id), ['bad2']);
  });

  it('names a skipped stored rule by its type and value, cut short when long', () => {
    const rule = (id: string, type: string, value: string) => ({ id, type, value, action: 'PROFILE', profile: makeProfile('ja-JP'), enabled: true, priority: 0, note: '' });
    const long = `^(d+)+${'x'.repeat(200)}storedlong$`;
    const stored = {
      ...JSON.parse(JSON.stringify(defaultSettings())),
      rules: [rule('ok', 'DOMAIN', 'ok.example'), rule('bad', 'DOMAIN-REGEX', '^(b+)+storedname$'), rule('long', 'DOMAIN-REGEX', long), rule('host', 'DOMAIN', 'bad host!'), 'not a rule'],
    };
    const { settings, problems } = sanitizeStoredSettings(stored, defaultSettings());
    assert.deepEqual(settings.rules.map((r) => r.id), ['ok']);
    assert.equal(problems.length, 4);
    assert.match(problems[0]!, /^Stored rule #2 \(DOMAIN-REGEX,\^\(b\+\)\+storedname\$\) was invalid and has been skipped: This regular expression could take too long/);
    // A long value is cut (80 characters with the ellipsis), the reason is still there.
    assert.ok(problems[1]!.startsWith(`Stored rule #3 (DOMAIN-REGEX,${long.slice(0, 79)}…) was invalid`), problems[1]!);
    assert.ok(!problems[1]!.includes('storedlong'));
    assert.match(problems[1]!, /could take too long to match/);
    assert.match(problems[2]!, /^Stored rule #4 \(DOMAIN,bad host!\) was invalid/);
    // Something that is not a rule has nothing to name.
    assert.match(problems[3]!, /^Stored rule #5 was invalid/);
    // The one-rule import's "rules[0]: " prefix is not repeated.
    assert.ok(problems.every((p) => !p.includes('rules[0]')), problems.join('\n'));
  });
});

describe('import regex budget', () => {
  const rep = (x: string, n: number) => x.repeat(n);
  /** Uses up all the work one check may do, and is refused as too complex to check. */
  const heavy = (tag: string) => `^(?:${rep('(?:', 60)}$${rep('){3}', 60)}\\.)*${tag}$`;

  it('a file within the budget is checked as before: no unchecked rules, unsafe ones refused', () => {
    const ok = importConfigText('rules:\n  - DOMAIN-REGEX,^import-budget-[a-z]+\\.example$,ja-JP\n  - DOMAIN-SUFFIX,example.org,de-DE\n');
    assert.equal(ok.unchecked, 0);
    assert.ok(ok.settings);
    assert.ok(!ok.warnings.some((w) => /not checked/.test(w)));
    const bad = importConfigText('rules:\n  - DOMAIN-REGEX,^(e+)+importbudget$,ja-JP\n');
    assert.equal(bad.settings, null);
    assert.equal(bad.unchecked, 0);
    assert.match(bad.errors[0]!, /^rules\[0\]: This regular expression could take too long/);
  });

  it('keeps regexes past a spent budget unchecked, names them, and the matcher checks them before use', () => {
    const r = importConfigText(
      JSON.stringify({
        rules: [
          'DOMAIN-SUFFIX,import-budget.example,fr-FR',
          'DOMAIN-REGEX,^import-deferred-[a-z]+\\.example$,ja-JP',
          { type: 'DOMAIN-REGEX', regex: '^(f+)+importdeferred$', locale: 'ko-KR' },
          { type: 'DOMAIN-REGEX', regex: `^import-deferred-long-${'y'.repeat(120)}$`, action: 'SYSTEM' },
        ],
      }),
      undefined,
      0,
    );
    // Nothing is dropped and the file is not refused...
    assert.ok(r.settings, r.errors.join('\n'));
    assert.equal(r.settings.rules.length, 4);
    assert.equal(r.unchecked, 3);
    // ...and the first warning says so, naming each rule (long values cut short).
    assert.match(r.warnings[0]!, /^3 regular expression\(s\) were not checked/);
    assert.match(r.warnings[0]!, /kept, but never match until the extension has checked them/);
    assert.ok(r.warnings[0]!.includes('rules[1] DOMAIN-REGEX,^import-deferred-[a-z]+\\.example$'), r.warnings[0]!);
    assert.ok(r.warnings[0]!.includes('rules[2] DOMAIN-REGEX,^(f+)+importdeferred$'), r.warnings[0]!);
    assert.ok(r.warnings[0]!.includes('rules[3] DOMAIN-REGEX,^import-deferred-long-y'), r.warnings[0]!);
    assert.ok(!r.warnings[0]!.includes('y'.repeat(100)));
    assert.ok(!r.warnings[0]!.includes('import-budget.example'));
    // The safe one matches once checked; the unsafe one never runs and is then reported.
    const s = r.settings;
    assert.equal(resolveHost('import-deferred-abc.example', s).profile?.locale, 'ja-JP');
    assert.equal(resolveHost(`${'f'.repeat(30)}importdeferred`, s).source, 'default');
    assert.deepEqual(refusedRegexes(s.rules).map((x) => x.rule.value), ['^(f+)+importdeferred$']);
    // The worker loads the saved settings with its own budget: there the unsafe one is
    // found and listed with the stored rule's pattern.
    const loaded = sanitizeStoredSettings(JSON.parse(JSON.stringify(s)), defaultSettings());
    assert.ok(loaded.problems.some((p) => p.includes('(DOMAIN-REGEX,^(f+)+importdeferred$)')), loaded.problems.join('\n'));
  });

  it('lists at most 10 unchecked rules by name', () => {
    const rules = Array.from({ length: 14 }, (_, i) => `DOMAIN-REGEX,^import-many-${i}\\.example$,ja-JP`);
    const r = importConfigText(JSON.stringify({ rules }), undefined, 0);
    assert.equal(r.unchecked, 14);
    assert.ok(r.warnings[0]!.includes('rules[9] '));
    assert.ok(!r.warnings[0]!.includes('rules[10] '));
    assert.match(r.warnings[0]!, /; and 4 more\.$/);
  });

  it('a large hostile import is decided within the budget', () => {
    const N = 8000;
    const text = JSON.stringify({ rules: Array.from({ length: N }, (_, i) => ({ type: 'DOMAIN-REGEX', regex: heavy(`hostileimport${i}`), locale: 'ja-JP' })) });
    const t0 = performance.now();
    const r = importConfigText(text);
    const ms = performance.now() - t0;
    // Without the budget every pattern would use its full limit (several seconds in all).
    assert.ok(ms < REGEX_BATCH_BUDGET_MS * 3, `${ms.toFixed(0)} ms for a ${REGEX_BATCH_BUDGET_MS} ms budget`);
    // The ones checked are refused as too complex, so the file is refused and nothing is
    // saved; the ones past the budget were not analysed at all.
    assert.equal(r.settings, null);
    assert.ok(r.errors.length > 10 && r.errors.length < N / 2, `${r.errors.length} refused`);
    assert.ok(r.errors.every((e) => /too complex to check/.test(e)), r.errors.find((e) => !/too complex to check/.test(e)) ?? '');
    assert.equal(r.unchecked, 0);
  });

  it('a large import of safe regexes past the budget keeps every rule', () => {
    const N = 6000;
    const text = JSON.stringify({ rules: Array.from({ length: N }, (_, i) => `DOMAIN-REGEX,^(?:[a-z0-9-]+\\.)*import-safe-${i}-(?:[a-z]+|[0-9]+)\\.example$,ja-JP`) });
    // A tiny budget, so that it runs out part-way.
    const r = importConfigText(text, undefined, 1);
    assert.ok(r.settings, r.errors.join('\n'));
    assert.equal(r.settings.rules.length, N);
    assert.ok(r.unchecked > 0 && r.unchecked < N, `${r.unchecked} unchecked`);
    assert.match(r.warnings[0]!, new RegExp(`^${r.unchecked} regular expression\\(s\\) were not checked`));
    // Checked or not, each one works once the matcher has checked it.
    assert.equal(resolveHost(`www.import-safe-${N - 1}-abc.example`, r.settings).profile?.locale, 'ja-JP');
  });
});

describe('Intl validation memo', () => {
  it('gives the same answers as without it, on first and repeated calls', () => {
    const tags = ['en-us', 'EN_us', 'zh-hant-tw', 'x-private', 'en-US-u-ca-buddhist', 'xx-YY', '', '  ', 'not a tag', '123', 'de'];
    const first = tags.map((t) => [canonicalizeLocale(t), isSupportedLocale(t), t.trim() ? deriveLanguages(canonicalizeLocale(t) ?? 'en') : null]);
    for (let k = 0; k < 3; k++) assert.deepEqual(tags.map((t) => [canonicalizeLocale(t), isSupportedLocale(t), t.trim() ? deriveLanguages(canonicalizeLocale(t) ?? 'en') : null]), first);
    assert.equal(canonicalizeLocale('en_us'), 'en-US');
    assert.equal(canonicalizeLocale('not a tag'), null);
    assert.deepEqual(deriveLanguages('en-US'), ['en-US', 'en']);
    // A returned list is the caller's own.
    deriveLanguages('fr-FR').push('x');
    assert.deepEqual(deriveLanguages('fr-FR'), ['fr-FR', 'fr']);
    for (let k = 0; k < 2; k++) {
      assert.equal(isValidTimezone('Asia/Tokyo'), true);
      assert.equal(isValidTimezone('Mars/Olympus'), false);
      assert.equal(isValidTimezone(''), false);
    }
  });

  it('stays bounded', () => {
    for (let i = 0; i < 5000; i++) canonicalizeLocale(`en-x-memo${i}`);
    assert.equal(canonicalizeLocale('en-x-memo1'), 'en-x-memo1');
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
