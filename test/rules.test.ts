import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostFromUrl, labelCount, matchesSuffix, normalizeDomainInput, normalizeHost, punycodeDecode, toUnicode } from '../src/shared/domain.js';
import type { GeositeList } from '../src/shared/geosite.js';
import { t } from '../src/shared/i18n.js';
import { formatIp, parseCidr, parseIp } from '../src/shared/ip.js';
import { makeProfile, profileKey } from '../src/shared/locale.js';
import { examplePresetRules } from '../src/shared/presets.js';
import {
  analyzeRules,
  comparePrecedence,
  describeAction,
  hostView,
  normalizeRuleValue,
  precedenceKey,
  precompileRegexes,
  refusedRegexes,
  requiredLiteral,
  resetNavigationRegexBudget,
  resolveHost,
  ruleLabel,
  ruleMatches,
  uncompiledRegexes,
  type MatchContext,
  type RuleIssue,
} from '../src/shared/rules.js';
import type { DefaultAction, Resolution, Rule, RuleType, Settings } from '../src/shared/types.js';

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

// ---------------------------------------------------------------------------
// The indexed resolver and analyzer must give exactly what the original linear versions
// gave. These are the original implementations, copied unchanged (apart from names).

function oldResolveHost(host: string | null, settings: Pick<Settings, 'rules' | 'defaultAction'>, ctx: MatchContext = {}): Resolution {
  if (!host) {
    return { action: 'SYSTEM', profile: null, source: 'default', rule: null, matches: [], host: null, ip: null };
  }
  const view = hostView(host);
  const matches = settings.rules
    .map((rule, index) => ({ rule, key: precedenceKey(rule, index) }))
    .filter((x) => x.rule.enabled && ruleMatches(x.rule, view, ctx))
    .sort((a, b) => comparePrecedence(a.key, b.key))
    .map((x) => x.rule);
  const best = matches[0];
  const ipUsed = view.literal ?? ctx.ip ?? null;
  const base = { matches, host: view.ascii, ip: ipUsed ? formatIp(ipUsed) : null };
  if (best) return { ...base, action: best.action, profile: best.action === 'PROFILE' ? best.profile : null, source: 'rule', rule: best };
  const d = settings.defaultAction;
  return { ...base, action: d.action, profile: d.action === 'PROFILE' ? d.profile : null, source: 'default', rule: null };
}

function oldAnalyzeRules(settings: Pick<Settings, 'rules' | 'defaultAction'>): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const enabled = settings.rules.filter((r) => r.enabled);
  const effectKey = (r: Rule) => (r.action === 'SYSTEM' ? 'SYSTEM' : profileKey(r.profile));
  const resolveAmong = (group: Rule[], all: Rule[]) =>
    group.map((rule) => ({ rule, key: precedenceKey(rule, all.indexOf(rule)) })).sort((a, b) => comparePrecedence(a.key, b.key))[0]?.rule;
  const groups = new Map<string, Rule[]>();
  for (const r of enabled) {
    const k = `${r.type}\u0000${r.value}\u0000${r.noResolve ? 1 : 0}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = resolveAmong(group, settings.rules);
    const sameEffect = group.every((r) => effectKey(r) === effectKey(group[0]!));
    issues.push({
      level: sameEffect ? 'warning' : 'error',
      ruleIds: group.map((r) => r.id),
      message: sameEffect
        ? t('check.duplicate', { rule: ruleLabel(group[0]!) })
        : t('check.conflict', { rule: ruleLabel(group[0]!), actions: group.map((r) => describeAction(r)).join(' vs '), winner: winner ? describeAction(winner) : '' }),
    });
  }
  for (const r of enabled) {
    if (r.type !== 'DOMAIN' && r.type !== 'DOMAIN-SUFFIX') continue;
    if ((groups.get(`${r.type}\u0000${r.value}\u00000`)?.length ?? 0) > 1) continue;
    const without = { ...settings, rules: settings.rules.filter((x) => x.id !== r.id) };
    const res = oldResolveHost(r.value, without);
    if (res.action === r.action && profileKey(res.profile) === profileKey(r.profile)) {
      issues.push({
        level: 'info',
        ruleIds: [r.id],
        message:
          r.action === 'SYSTEM' && !res.rule
            ? t('check.noEffect', { rule: ruleLabel(r) })
            : t('check.redundant', { rule: ruleLabel(r), by: res.rule ? ruleLabel(res.rule) : t('check.defaultAction'), action: describeAction(r) }),
      });
    }
  }
  for (const r of enabled) {
    if (r.type === 'DOMAIN-SUFFIX' && !r.value.includes('.')) {
      issues.push({ level: 'warning', ruleIds: [r.id], message: t('check.tldSuffix', { rule: ruleLabel(r), value: r.value }) });
    }
    if (r.type === 'DOMAIN-KEYWORD' && r.value.length <= 2) {
      issues.push({ level: 'warning', ruleIds: [r.id], message: t('check.shortKeyword', { value: r.value }) });
    }
    if ((r.type === 'IP-CIDR' || r.type === 'IP-CIDR6') && parseCidr(r.value)?.prefix === 0) {
      issues.push({ level: 'warning', ruleIds: [r.id], message: t('check.allAddresses', { rule: ruleLabel(r) }) });
    }
    if (r.action === 'PROFILE' && !r.profile) {
      issues.push({ level: 'error', ruleIds: [r.id], message: t('check.noProfile', { rule: ruleLabel(r) }) });
    }
  }
  return issues;
}

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

describe('indexed resolver = original resolver', () => {
  const LABELS = ['a', 'b', 'api', 'www', 'cdn', 'xn--bcher-kva'];
  const TLDS = ['com', 'net', 'co.uk', 'io'];
  const PROFILES = [makeProfile('en-US'), makeProfile('ja-JP'), makeProfile('de-DE')];
  const REGEXES = ['^a\\.', 'b\\.com$', '^(.+\\.)?cdn\\.net$', 'api', '^www\\.', '\\.co\\.uk$', 'bücher'];
  const KEYWORDS = ['a', 'api', 'b.c', 'co', 'cdn.n', 'bücher', 'www'];
  const CIDRS = ['10.0.0.0/8', '10.1.0.0/16', '0.0.0.0/0', '192.168.1.0/24'];
  const CIDR6 = ['::/0', '2001:db8::/32', '::1/128'];
  const GEOSITES = ['g1', 'g2', 'none'];
  const LISTS: Record<string, GeositeList> = {
    g1: { full: new Set(['a.com']), suffix: new Set(['cdn.net']), keywords: ['api'], regexes: [], skipped: 0, size: 3 },
    g2: { full: new Set(), suffix: new Set(['co.uk', 'com']), keywords: [], regexes: [/^www\./], skipped: 0, size: 3 },
  };

  function domainFrom(r: () => number): string {
    const n = Math.floor(r() * 3);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(LABELS[Math.floor(r() * LABELS.length)]!);
    parts.push(TLDS[Math.floor(r() * TLDS.length)]!);
    return parts.join('.');
  }

  function randomRules(r: () => number, n: number): Rule[] {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const types: RuleType[] = ['DOMAIN', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-SUFFIX', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'GEOSITE', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'GEOIP'];
    const out: Rule[] = [];
    for (let i = 0; i < n; i++) {
      const type = pick(types);
      const raw =
        type === 'DOMAIN' ? (r() < 0.1 ? pick(['10.1.2.3', '[::1]']) : domainFrom(r))
        : type === 'DOMAIN-SUFFIX' ? (r() < 0.1 ? pick(TLDS) : domainFrom(r))
        : type === 'DOMAIN-KEYWORD' ? pick(KEYWORDS)
        : type === 'DOMAIN-REGEX' ? pick(REGEXES)
        : type === 'GEOSITE' ? pick(GEOSITES)
        : type === 'IP-CIDR' ? pick(CIDRS)
        : type === 'IP-CIDR6' ? pick(CIDR6)
        : type === 'IP-ASN' ? pick(['13335', '15169'])
        : pick(['US', 'LAN', 'JP']);
      const value = normalizeRuleValue(type, raw).value!;
      assert.ok(value, `${type} ${raw}`);
      const system = r() < 0.3;
      const layer = r() < 0.5 ? 0 : 1 + Math.floor(r() * 3);
      out.push({
        // Some ids repeat on purpose: analyzeRules leaves out every rule with the id.
        id: r() < 0.05 && out.length ? out[Math.floor(r() * out.length)]!.id : `r${i}`,
        type,
        value,
        action: system ? 'SYSTEM' : 'PROFILE',
        profile: system ? null : pick(PROFILES),
        enabled: r() < 0.9,
        priority: r() < 0.7 ? 0 : Math.floor(r() * 5) - 2,
        note: '',
        ...(r() < 0.3 && (type.startsWith('IP') || type === 'GEOIP') ? { noResolve: true } : {}),
        ...(layer ? { origin: { subscription: `s${layer}`, name: `S${layer}`, layer } } : {}),
      });
    }
    // Sometimes the same rule object twice (indexOf finds the first one).
    if (out.length > 2 && r() < 0.2) out.push(out[0]!);
    return out;
  }

  function hostsFor(r: () => number, rules: Rule[]): string[] {
    const out = ['10.1.2.3', '192.168.1.7', '[::1]', '[2001:db8::5]', 'unrelated.example'];
    for (let i = 0; i < 25; i++) out.push(domainFrom(r));
    for (const rule of rules.slice(0, 15)) if (rule.type === 'DOMAIN' || rule.type === 'DOMAIN-SUFFIX') out.push(rule.value, `x.${rule.value}`, `${rule.value}.`);
    return out.map((h) => (r() < 0.1 ? h.toUpperCase() : h));
  }

  const contexts = (): MatchContext[] => [
    {},
    { ip: parseIp('10.1.2.3'), geosite: (c) => LISTS[c], geoip: () => 'US', asn: () => 13335 },
    { ip: parseIp('8.8.8.8'), geosite: (c) => LISTS[c] ?? null, geoip: () => 'JP', asn: () => 15169 },
    { ip: parseIp('192.168.1.7'), geosite: () => undefined },
  ];

  const ids = (res: Resolution, rules: Rule[]) => res.matches.map((m) => rules.indexOf(m));

  it('gives identical resolutions for random rule sets, hosts and contexts', () => {
    const r = prng(20261024);
    let compared = 0;
    for (let set = 0; set < 300; set++) {
      const rules = randomRules(r, 1 + Math.floor(r() * 60));
      const defaultAction: DefaultAction = r() < 0.5 ? { action: 'SYSTEM' } : { action: 'PROFILE', profile: PROFILES[2]! };
      const settings = { rules, defaultAction };
      const hosts = hostsFor(r, rules);
      // Twice: the second pass runs on the cached per-host matches.
      for (let pass = 0; pass < 2; pass++) {
        for (const host of hosts) {
          for (const ctx of contexts()) {
            const want = oldResolveHost(host, settings, ctx);
            const got = resolveHost(host, settings, ctx);
            assert.deepEqual(ids(got, rules), ids(want, rules), `${host} in set ${set}`);
            assert.equal(got.rule, want.rule);
            assert.deepEqual({ ...got, matches: [], rule: null }, { ...want, matches: [], rule: null });
            compared++;
          }
        }
      }
    }
    assert.ok(compared > 50_000);
  });

  it('gives identical analyzeRules findings for random rule sets', () => {
    const r = prng(7);
    for (let set = 0; set < 400; set++) {
      const rules = randomRules(r, 1 + Math.floor(r() * 80));
      const defaultAction: DefaultAction = r() < 0.5 ? { action: 'SYSTEM' } : { action: 'PROFILE', profile: PROFILES[Math.floor(r() * 3)]! };
      assert.deepEqual(analyzeRules({ rules, defaultAction }), oldAnalyzeRules({ rules, defaultAction }), `set ${set}`);
    }
  });

  it('a new rules array is resolved with its own rules', () => {
    const a = [rule('DOMAIN-SUFFIX', 'example.com', 'en-US')];
    assert.equal(locale('www.example.com', a), 'en-US');
    const b = [...a, rule('DOMAIN', 'www.example.com', 'ja-JP')];
    assert.equal(locale('www.example.com', b), 'ja-JP');
    const c = b.map((x) => (x.type === 'DOMAIN' ? { ...x, enabled: false } : x));
    assert.equal(locale('www.example.com', c), 'en-US');
    // A rule appended in place (not done by the extension) is still seen.
    a.push(rule('DOMAIN', 'www.example.com', 'de-DE'));
    assert.equal(locale('www.example.com', a), 'de-DE');
  });

  it('IP rules follow the address of each call, not a cached one', () => {
    const rules = [rule('IP-CIDR', '10.0.0.0/8', 'ja-JP'), rule('DOMAIN-KEYWORD', 'zzz', 'de-DE')];
    const s = { rules, defaultAction: { action: 'SYSTEM' } as DefaultAction };
    assert.equal(resolveHost('a.example', s, { ip: parseIp('10.0.0.1') }).profile?.locale, 'ja-JP');
    assert.equal(resolveHost('a.example', s, { ip: parseIp('11.0.0.1') }).action, 'SYSTEM');
    assert.equal(resolveHost('a.example', s).action, 'SYSTEM');
  });

  it('labelCount counts labels like split', () => {
    for (const h of ['', 'a', 'a.b', 'a..b', '.a.', 'x.y.z.co.uk']) assert.equal(labelCount(h), h.split('.').length);
  });
});

describe('regex precompile', () => {
  it('checks and compiles pending sources in slices, then nothing is left', async () => {
    const rules = ['^p1-[a-z]+\\.example$', '^p2\\.example$', '^p3\\.example$'].map((v) => rule('DOMAIN-REGEX', v, 'en-US'));
    const fresh = [{ ...rules[0]!, value: '^p4-never-normalized\\.example$' }, { ...rules[1]!, value: '(a+)+$' }];
    const pending = uncompiledRegexes(fresh);
    assert.deepEqual(pending, ['^p4-never-normalized\\.example$', '(a+)+$']);
    let pauses = 0;
    let clock = 0;
    await precompileRegexes(pending, async () => void pauses++, 1, () => (clock += 1));
    assert.ok(pauses >= 1);
    assert.deepEqual(uncompiledRegexes(fresh), []);
    // The unsafe one was refused by the check, not compiled.
    assert.equal(locale('aaaa', [fresh[1]!]), 'SYSTEM');
    assert.equal(locale('p4-never-normalized.example', [fresh[0]!]), 'en-US');
  });

  it('navigation-time checks share a budget; what it leaves unchecked is no match for now, until precompile checks it', async () => {
    // Stored values that were never checked in this worker (not via normalizeRuleValue).
    const base = rule('DOMAIN-REGEX', '^nav-placeholder\\.example$', 'ja-JP');
    const good = { ...base, id: 'nav-good', value: '^nav-defer-[a-z]+\\.example$' };
    const bad = { ...base, id: 'nav-bad', value: '^(d+)+navdefer$' };
    const rules = [good, bad];
    const evil = `${'d'.repeat(28)}!navdefer`;
    resetNavigationRegexBudget(0);
    try {
      for (let k = 0; k < 3; k++) {
        assert.equal(locale('nav-defer-abc.example', rules), 'SYSTEM', 'unchecked: no match for now');
        assert.equal(locale(evil, rules), 'SYSTEM');
      }
      assert.deepEqual(uncompiledRegexes(rules), [good.value, bad.value], 'nothing was cached');
      assert.deepEqual(refusedRegexes(rules), []);
      await precompileRegexes(uncompiledRegexes(rules), async () => undefined);
      // The same rules array and hosts as before (the per-host cache did not keep the miss).
      assert.equal(locale('nav-defer-abc.example', rules), 'ja-JP');
      assert.equal(locale(evil, rules), 'SYSTEM', 'the unsafe pattern never runs');
      assert.deepEqual(refusedRegexes(rules).map((x) => [x.rule.id, x.index]), [['nav-bad', 1]]);
      assert.match(refusedRegexes(rules)[0]!.reason, /same text/);
      assert.deepEqual(refusedRegexes([{ ...bad, enabled: false }]), []);
    } finally {
      resetNavigationRegexBudget();
    }
    // With budget left, a navigation checks a pattern itself.
    const other = { ...base, id: 'nav-other', value: '^nav-direct-[a-z]+\\.example$' };
    assert.equal(locale('nav-direct-abc.example', [other]), 'ja-JP');
    assert.deepEqual(uncompiledRegexes([other]), []);
  });
});

describe('requiredLiteral', () => {
  it('finds text every match contains, conservatively', () => {
    assert.equal(requiredLiteral('^(.+\\.)?example\\.com$'), 'example.com');
    assert.equal(requiredLiteral('^API-[a-z]{2}\\d?\\.Shop12\\.io$'), '.shop12.io');
    assert.equal(requiredLiteral('a|b'), '');
    assert.equal(requiredLiteral('(a|b)cd'), 'cd');
    assert.equal(requiredLiteral('abc?'), 'ab');
    assert.equal(requiredLiteral('x{2}yz'), 'yz');
    assert.equal(requiredLiteral('\\x41bc'), '', 'the escape and what may belong to it are skipped');
    assert.equal(requiredLiteral('[abc]def\\]'), 'def]');
    assert.equal(requiredLiteral('\\d+'), '');
  });

  it('never claims text a match can lack (fuzzed against V8)', () => {
    const r = prng(99);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const atoms = ['a', 'B', 'c', '-', '_', '1', '.', '\\.', '\\-', '\\d', '\\w', '\\b', '\\x61', '\\u0062', '[ab]', '[^a]', '[\\]a]', '\\1', '^', '$'];
    const quants = ['', '', '', '?', '*', '+', '{2}', '{0,2}', '{1,}', '??', '+?'];
    const gen = (depth: number): string => {
      let out = '';
      const n = 1 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const x = r();
        if (x < 0.15 && depth < 2) out += `(${pick(['', '?:', '?=', '?!', '?<=', '?<n' + depth + i + '>'])}${gen(depth + 1)})`;
        else if (x < 0.2) out += '|';
        else out += pick(atoms);
        if (!out.endsWith('^') && !out.endsWith('$') && !out.endsWith('|') && !out.endsWith('(')) out += pick(quants);
      }
      return out;
    };
    const hosts: string[] = [];
    for (let i = 0; i < 60; i++) hosts.push(Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(['a', 'b', 'c', '-', '_', '1', '.', 'ab', 'bc'])).join(''));
    let checked = 0;
    let withText = 0;
    for (let k = 0; k < 20_000; k++) {
      const src = gen(0);
      let re: RegExp;
      try {
        re = new RegExp(src, 'i');
      } catch {
        continue;
      }
      const lit = requiredLiteral(src);
      if (lit) withText++;
      for (const h of hosts) {
        if (re.test(h)) {
          assert.ok(h.includes(lit), `${JSON.stringify(src)} matches ${JSON.stringify(h)} without ${JSON.stringify(lit)}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 10_000 && withText > 1000, `${checked} matches, ${withText} with text`);
  });
});
