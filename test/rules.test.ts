import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostFromUrl, matchesSuffix, normalizeDomainInput, normalizeHost, punycodeDecode, toUnicode } from '../src/shared/domain.js';
import { makeProfile } from '../src/shared/locale.js';
import { examplePresetRules } from '../src/shared/presets.js';
import { analyzeRules, normalizeRuleValue, resolveHost } from '../src/shared/rules.js';
import type { DefaultAction, Rule, RuleType } from '../src/shared/types.js';

let seq = 0;
function rule(type: RuleType, value: string, target: string, extra: Partial<Rule> = {}): Rule {
  const v = normalizeRuleValue(type, value);
  assert.ok(v.value, `invalid test rule value ${value}: ${v.error}`);
  return {
    id: `t${++seq}`,
    type,
    value: v.value,
    action: target === 'SYSTEM' ? 'SYSTEM' : 'PROFILE',
    profile: target === 'SYSTEM' ? null : makeProfile(target),
    enabled: true,
    priority: 0,
    note: '',
    ...extra,
  };
}

function locale(host: string, rules: Rule[], defaultAction: DefaultAction = { action: 'SYSTEM' }): string {
  const r = resolveHost(normalizeHost(host)?.ascii ?? host, { rules, defaultAction });
  return r.action === 'SYSTEM' ? 'SYSTEM' : r.profile!.locale;
}

describe('domain normalization', () => {
  it('lowercases, strips trailing dots and converts IDN to punycode', () => {
    assert.equal(normalizeHost('Mail.Google.COM.')?.ascii, 'mail.google.com');
    assert.equal(normalizeHost('例子.测试')?.ascii, 'xn--fsqu00a.xn--0zwm56d');
    assert.equal(normalizeHost('BÜCHER.example')?.ascii, 'xn--bcher-kva.example');
    assert.equal(normalizeHost('xn--bcher-kva.example')?.unicode, 'bücher.example');
  });

  it('rejects ports, paths, spaces and empty labels', () => {
    for (const bad of ['google.com:443', 'google.com/x', 'goo gle.com', 'a..b', '', '-', 'a@b.com']) {
      assert.equal(normalizeHost(bad), null, bad);
    }
  });

  it('recognises IP literals', () => {
    assert.equal(normalizeHost('127.0.0.1')?.kind, 'ipv4');
    assert.equal(normalizeHost('[::1]')?.kind, 'ipv6');
  });

  it('extracts hostnames from pasted URLs and strips suffix wildcards', () => {
    assert.equal(normalizeDomainInput('https://Mail.Google.com/mail/u/0', { suffix: false }).host?.ascii, 'mail.google.com');
    assert.equal(normalizeDomainInput('*.google.com', { suffix: true }).host?.ascii, 'google.com');
    assert.equal(normalizeDomainInput('+.google.com', { suffix: true }).host?.ascii, 'google.com');
    assert.equal(normalizeDomainInput('.google.com', { suffix: true }).host?.ascii, 'google.com');
    assert.ok(normalizeDomainInput('*.google.com', { suffix: false }).error);
    assert.ok(normalizeDomainInput('goo*gle.com', { suffix: true }).error);
    assert.ok(normalizeDomainInput('10.0.0.1', { suffix: true }).error, 'IPs are not valid suffixes');
    assert.ok(normalizeDomainInput('0.1', { suffix: true }).error, 'numeric last label would match IPs');
  });

  it('hostFromUrl only accepts http(s)', () => {
    assert.equal(hostFromUrl('https://WWW.Example.org./a?b'), 'www.example.org');
    assert.equal(hostFromUrl('chrome://settings'), null);
    assert.equal(hostFromUrl('file:///C:/x.html'), null);
    assert.equal(hostFromUrl('not a url'), null);
  });

  it('punycode decoding matches RFC 3492 samples', () => {
    assert.equal(punycodeDecode('ihqwcrb4cv8a8dqg056pqjye'), '他们为什么不说中文');
    assert.equal(punycodeDecode('bcher-kva'), 'bücher');
    assert.equal(toUnicode('www.xn--bcher-kva.xn--fsqu00a'), 'www.bücher.例子');
    assert.throws(() => punycodeDecode('!!!'));
  });

  it('matchesSuffix respects DNS label boundaries', () => {
    assert.ok(matchesSuffix('google.com', 'google.com'));
    assert.ok(matchesSuffix('mail.google.com', 'google.com'));
    assert.ok(matchesSuffix('a.b.google.com', 'google.com'));
    assert.ok(!matchesSuffix('fakegoogle.com', 'google.com'));
    assert.ok(!matchesSuffix('google.com.evil.org', 'google.com'));
    assert.ok(!matchesSuffix('oogle.com', 'google.com'));
    assert.ok(!matchesSuffix('com', 'google.com'));
  });
});

describe('specification example table', () => {
  const rules = [
    rule('DOMAIN-SUFFIX', 'google.com', 'en-US'),
    rule('DOMAIN-SUFFIX', 'apple.com', 'ja-JP'),
    rule('DOMAIN', 'example.org', 'fr-FR'),
    rule('DOMAIN-KEYWORD', 'microsoft', 'en-GB'),
  ];
  const cases: [string, string][] = [
    ['google.com', 'en-US'],
    ['mail.google.com', 'en-US'],
    ['fakegoogle.com', 'SYSTEM'],
    ['google.com.evil.org', 'SYSTEM'],
    ['apple.com', 'ja-JP'],
    ['developer.apple.com', 'ja-JP'],
    ['example.org', 'fr-FR'],
    ['sub.example.org', 'SYSTEM'],
    ['login.microsoftonline.com', 'en-GB'],
    ['MAIL.GOOGLE.COM.', 'en-US'],
    ['unmatched.net', 'SYSTEM'],
  ];
  for (const [host, expected] of cases) {
    it(`${host} → ${expected}`, () => assert.equal(locale(host, rules), expected));
  }
});

describe('precedence', () => {
  it('DOMAIN beats DOMAIN-SUFFIX regardless of order', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN', 'accounts.google.com', 'SYSTEM')];
    assert.equal(locale('accounts.google.com', rules), 'SYSTEM');
    assert.equal(locale('accounts.google.com', [...rules].reverse()), 'SYSTEM');
    assert.equal(locale('www.accounts.google.com', rules), 'en-US', 'DOMAIN is exact only');
  });

  it('the most specific DOMAIN-SUFFIX wins regardless of order', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN-SUFFIX', 'cloud.google.com', 'de-DE')];
    assert.equal(locale('console.cloud.google.com', rules), 'de-DE');
    assert.equal(locale('console.cloud.google.com', [...rules].reverse()), 'de-DE');
    assert.equal(locale('mail.google.com', rules), 'en-US');
  });

  it('a SYSTEM suffix exception under a broader suffix rule', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN-SUFFIX', 'accounts.google.com', 'SYSTEM')];
    assert.equal(locale('accounts.google.com', rules), 'SYSTEM');
    assert.equal(locale('x.accounts.google.com', rules), 'SYSTEM');
    assert.equal(locale('google.com', rules), 'en-US');
  });

  it('keyword rules lose to domain and suffix rules', () => {
    const rules = [rule('DOMAIN-KEYWORD', 'google', 'ko-KR'), rule('DOMAIN-SUFFIX', 'google.com', 'en-US')];
    assert.equal(locale('mail.google.com', rules), 'en-US');
    assert.equal(locale('google.co.jp', rules), 'ko-KR');
  });

  it('ties are broken by priority, then by list order', () => {
    const a = rule('DOMAIN-KEYWORD', 'goo', 'fr-FR');
    const b = rule('DOMAIN-KEYWORD', 'google', 'de-DE');
    assert.equal(locale('google.de', [a, b]), 'fr-FR', 'earlier rule wins');
    assert.equal(locale('google.de', [b, a]), 'de-DE');
    assert.equal(locale('google.de', [a, { ...b, priority: 5 }]), 'de-DE', 'higher priority wins');
    const d1 = rule('DOMAIN-SUFFIX', 'x.com', 'fr-FR');
    const d2 = rule('DOMAIN-SUFFIX', 'x.com', 'de-DE', { priority: 1 });
    assert.equal(locale('a.x.com', [d1, d2]), 'de-DE');
  });

  it('priority never overrides specificity', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US', { priority: 100 }), rule('DOMAIN', 'accounts.google.com', 'SYSTEM')];
    assert.equal(locale('accounts.google.com', rules), 'SYSTEM');
  });

  it('disabled rules are ignored', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US', { enabled: false })];
    assert.equal(locale('google.com', rules), 'SYSTEM');
  });

  it('the default action applies only when nothing matches', () => {
    const rules = [rule('DOMAIN', 'accounts.google.com', 'SYSTEM')];
    const def: DefaultAction = { action: 'PROFILE', profile: makeProfile('en-US') };
    assert.equal(locale('example.com', rules, def), 'en-US');
    assert.equal(locale('accounts.google.com', rules, def), 'SYSTEM');
  });

  it('reports all matches best-first', () => {
    const rules = [rule('DOMAIN-KEYWORD', 'mail', 'fr-FR'), rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN', 'mail.google.com', 'de-DE')];
    const r = resolveHost('mail.google.com', { rules, defaultAction: { action: 'SYSTEM' } });
    assert.deepEqual(r.matches.map((m) => m.type), ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD']);
    assert.equal(r.source, 'rule');
  });
});

describe('IDN and keyword matching', () => {
  it('suffix rules typed in Unicode match punycode hosts', () => {
    const rules = [rule('DOMAIN-SUFFIX', '例子.测试', 'ja-JP')];
    assert.equal(locale('www.xn--fsqu00a.xn--0zwm56d', rules), 'ja-JP');
    assert.equal(locale('www.例子.测试', rules), 'ja-JP');
  });

  it('Unicode keywords match the Unicode form of the host', () => {
    const rules = [rule('DOMAIN-KEYWORD', 'BÜCHER', 'de-DE')];
    assert.equal(locale('xn--bcher-kva.example', rules), 'de-DE');
    assert.equal(locale('buecher.example', rules), 'SYSTEM');
  });

  it('keywords are case-insensitive and host-only', () => {
    const rules = [rule('DOMAIN-KEYWORD', 'MicroSoft', 'en-GB')];
    assert.equal(locale('LOGIN.MICROSOFTONLINE.COM', rules), 'en-GB');
  });

  it('suffix rules never match IP literals', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN', '127.0.0.1', 'fr-FR')];
    assert.equal(locale('127.0.0.1', rules), 'fr-FR');
  });

  it('rejects keywords with URL delimiters', () => {
    assert.ok(normalizeRuleValue('DOMAIN-KEYWORD', 'a/b').error);
    assert.ok(normalizeRuleValue('DOMAIN-KEYWORD', '   ').error);
  });
});

describe('example preset', () => {
  const rules = examplePresetRules();
  for (const [host, expected] of [
    ['google.com', 'en-US'],
    ['mail.google.com', 'en-US'],
    ['accounts.google.com', 'SYSTEM'],
    ['chat.openai.com', 'en-US'],
    ['apple.com', 'ja-JP'],
    ['news.yahoo.co.jp', 'ja-JP'],
    ['yahoo.com', 'SYSTEM'],
    ['bilibili.com', 'SYSTEM'],
  ] as const) {
    it(`${host} → ${expected}`, () => assert.equal(locale(host, rules), expected));
  }
});

describe('analyzeRules', () => {
  it('flags conflicting duplicates and names the winner', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN-SUFFIX', 'google.com', 'ja-JP')];
    const issues = analyzeRules({ rules, defaultAction: { action: 'SYSTEM' } });
    const conflict = issues.find((i) => i.level === 'error');
    assert.ok(conflict);
    assert.match(conflict.message, /en-US" wins/);
  });

  it('flags identical duplicates as warnings', () => {
    const rules = [rule('DOMAIN', 'a.com', 'en-US'), rule('DOMAIN', 'a.com', 'en-US')];
    assert.ok(analyzeRules({ rules, defaultAction: { action: 'SYSTEM' } }).some((i) => i.level === 'warning' && /Duplicate/.test(i.message)));
  });

  it('flags SYSTEM rules that have no effect and redundant sub-rules', () => {
    const rules = [rule('DOMAIN', 'lonely.com', 'SYSTEM'), rule('DOMAIN-SUFFIX', 'google.com', 'en-US'), rule('DOMAIN', 'mail.google.com', 'en-US')];
    const msgs = analyzeRules({ rules, defaultAction: { action: 'SYSTEM' } }).map((i) => i.message);
    assert.ok(msgs.some((m) => /lonely\.com → SYSTEM has no effect/.test(m)));
    assert.ok(msgs.some((m) => /mail\.google\.com is redundant/.test(m)));
  });

  it('the shipped example preset has no errors or warnings', () => {
    const issues = analyzeRules({ rules: examplePresetRules(), defaultAction: { action: 'SYSTEM' } });
    assert.deepEqual(issues.filter((i) => i.level !== 'info'), []);
  });

  it('warns about TLD-wide suffixes', () => {
    const issues = analyzeRules({ rules: [rule('DOMAIN-SUFFIX', 'com', 'en-US')], defaultAction: { action: 'SYSTEM' } });
    assert.ok(issues.some((i) => /every site under "\.com"/.test(i.message)));
  });
});
