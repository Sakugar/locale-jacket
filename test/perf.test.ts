// Performance guards. Where the code counts its own work (the regex check's units, charged
// to an analysisBudget), the test asserts on that work, which does not depend on the machine.
// The rest are wall-clock ceilings (10x or more above what the code measures on a desktop):
// they always run the code, but are enforced only with LJ_PERF=1 (`npm run test:perf`), so
// a slow or busy machine cannot fail `npm test`; without it the times are only reported.
// Numbers before the fixes (Node 24, 5,000 rules): resolveHost ~1.5 ms per distinct host,
// analyzeRules ~5.7 s, refusing a 20,000-rule file ~1.4 s, 20,000 profile validations
// ~0.8 s, first resolveHost with 5,000 unchecked hostile stored regexes ~3.4 s.

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { performance } from 'node:perf_hooks';
import { makeProfile, normalizeProfile } from '../src/shared/locale.js';
import { analysisBudget, clearRegexVerdicts, regexHazard } from '../src/shared/regex-safety.js';
import { analyzeRules, NAVIGATION_REGEX_BUDGET_MS, resetNavigationRegexBudget, resolveHost, uncompiledRegexes } from '../src/shared/rules.js';
import { MAX_SUBSCRIPTION_RULES, parseSubscription } from '../src/shared/subscriptions.js';
import type { Rule, RuleType, Settings } from '../src/shared/types.js';

const WORDS = ['alpha', 'bravo', 'cdn', 'static', 'media', 'shop', 'news', 'mail', 'api', 'img', 'video', 'cloud', 'data', 'auth', 'login', 'app', 'web', 'edge', 'live', 'store'];
const TLDS = ['com', 'net', 'org', 'io', 'co.uk', 'de', 'jp', 'cn', 'fr', 'com.br'];
const domainFor = (i: number) => `${WORDS[i % WORDS.length]}${i}.${TLDS[(i * 7) % TLDS.length]}`;

function regexFor(i: number): string {
  const d = `${WORDS[i % WORDS.length]}${i}`;
  switch (i % 6) {
    case 0:
      return `^(.+\\.)?${d}\\.com$`;
    case 1:
      return `^([a-z0-9-]+\\.)*${d}\\.(com|net|org)$`;
    case 2:
      return `^api-[a-z]{2}\\d?\\.${d}\\.io$`;
    case 3:
      return `(^|\\.)${d}\\.(cn|com\\.cn)$`;
    case 4:
      return `^cdn\\d+\\.${d}\\.net$`;
    default:
      return `^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*${d}\\.org$`;
  }
}

const PROFILE = makeProfile('en-US');

/** 20% DOMAIN-REGEX, 15% DOMAIN-KEYWORD, 25% DOMAIN, 40% DOMAIN-SUFFIX (the benchmark mix). */
function mixedRules(n: number): Rule[] {
  const out: Rule[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i * 37) % 100;
    const [type, value]: [RuleType, string] =
      x < 20 ? ['DOMAIN-REGEX', regexFor(i)] : x < 35 ? ['DOMAIN-KEYWORD', `kw${i}x`] : x < 60 ? ['DOMAIN', domainFor(i)] : ['DOMAIN-SUFFIX', domainFor(i)];
    out.push({ id: `r${i}`, type, value, action: i % 5 ? 'PROFILE' : 'SYSTEM', profile: i % 5 ? PROFILE : null, enabled: true, priority: 0, note: '' });
  }
  return out;
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/** Wall-clock ceilings are enforced only with LJ_PERF=1 (npm run test:perf). */
const ENFORCE_TIMES = process.env.LJ_PERF === '1';

/** Asserts `ms < ceiling` under LJ_PERF=1; otherwise only reports the time. */
function underCeiling(t: TestContext, ms: number, ceiling: number, what: string): void {
  const msg = `${what}: ${ms < 1 ? ms.toFixed(4) : ms.toFixed(0)} ms (ceiling ${ceiling} ms)`;
  if (ENFORCE_TIMES) assert.ok(ms < ceiling, msg);
  else t.diagnostic(`${msg}, not enforced without LJ_PERF=1`);
}

/** Analysis units one regexHazard call charges to a budget (fresh, not from the verdict memo). */
function analysisUnits(source: string): number {
  clearRegexVerdicts();
  const b = analysisBudget(1000);
  const before = b.remaining;
  regexHazard(source, b);
  return before - b.remaining;
}

describe('performance (work counts, and generous time ceilings with LJ_PERF=1)', () => {
  const settings: Pick<Settings, 'rules' | 'defaultAction'> = { rules: mixedRules(5000), defaultAction: { action: 'SYSTEM' } };
  const hosts = Array.from({ length: 2000 }, (_, k) => (k % 2 ? `www.unrelated-${k}.example.org` : `sub.${domainFor((k * 7919) % 5000)}`));

  it('resolveHost with 5,000 rules: < 0.5 ms per distinct host, warm', (t) => {
    for (const h of hosts.slice(0, 100)) resolveHost(h, settings);
    const ms = time(() => {
      for (const h of hosts) resolveHost(h, settings);
    });
    underCeiling(t, ms / hosts.length, 0.5, 'per host');
  });

  it('resolveHost with 5,000 rules: three calls per navigation < 0.2 ms', (t) => {
    const ms = time(() => {
      for (const h of hosts) for (let k = 0; k < 3; k++) resolveHost(h, settings);
    });
    underCeiling(t, ms / hosts.length, 0.2, 'per navigation');
  });

  it('analyzeRules with 5,000 rules < 500 ms', (t) => {
    const ms = time(() => analyzeRules({ ...settings, rules: [...settings.rules] }));
    underCeiling(t, ms, 500, 'analyzeRules');
  });

  it('a subscription file with 20,000 rules is refused < 500 ms', (t) => {
    const text = JSON.stringify({
      rules: Array.from({ length: 20_000 }, (_, i) => ({ type: 'DOMAIN-SUFFIX', domain: domainFor(i), locale: ['en-US', 'ja-JP', 'de-DE'][i % 3], timezone: i % 2 ? 'America/New_York' : undefined, note: `n${i}` })),
    });
    let error = '';
    const ms = time(() => {
      try {
        parseSubscription(text, { id: 'big', name: 'Big', url: 'https://example.com/big.json', enabled: true, interval: 'daily' });
      } catch (e) {
        error = (e as Error).message;
      }
    });
    assert.match(error, new RegExp(`more than ${MAX_SUBSCRIPTION_RULES} rules`));
    underCeiling(t, ms, 500, 'refusing the file');
  });

  it('5,000 unchecked stored regexes that are hard to check: the first navigation checks only what its budget allows', (t) => {
    // Old subscription data (no regex-check marker), each pattern using up the work one
    // check may do. The navigation path checks only what its budget allows.
    const rep = (x: string, n: number) => x.repeat(n);
    const rules: Rule[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `h${i}`,
      type: 'DOMAIN-REGEX',
      value: `^(?:${rep('(?:', 60)}$${rep('){3}', 60)}\\.)*(?:hostile${i})?$`,
      action: 'PROFILE',
      profile: PROFILE,
      enabled: true,
      priority: 0,
      note: '',
    }));
    const hostile = { rules, defaultAction: { action: 'SYSTEM' as const } };
    // Work, not time: what one check of such a pattern costs, and what a navigation may spend.
    const perPattern = analysisUnits(rules[0]!.value);
    const navigationUnits = analysisBudget(NAVIGATION_REGEX_BUDGET_MS).remaining;
    assert.ok(perPattern > 0 && perPattern * 1000 > navigationUnits, `${perPattern} units per pattern`);
    clearRegexVerdicts();
    resetNavigationRegexBudget(); // earlier tests used it up on their own regexes
    const first = time(() => resolveHost('www.example.com', hostile));
    const checked = rules.length - uncompiledRegexes(rules).length;
    // Only what fits in one navigation budget was checked (the last one may overrun it).
    assert.ok(checked >= 1, 'the budget checks some patterns');
    assert.ok(checked * perPattern <= navigationUnits + perPattern, `${checked} patterns checked, ${checked * perPattern} units > ${navigationUnits}`);
    // The budget is spent: the next navigation checks none.
    const second = time(() => resolveHost('www.example.org', hostile));
    assert.equal(rules.length - uncompiledRegexes(rules).length, checked);
    // Most are left for precompileRegexes.
    assert.ok(uncompiledRegexes(rules).length > 4000);
    underCeiling(t, first, 500, `first navigation (budget ${NAVIGATION_REGEX_BUDGET_MS} ms)`);
    underCeiling(t, second, 100, 'second navigation');
  });

  it('20,000 profile validations (5 locales, 2 time zones) < 200 ms', (t) => {
    const locales = ['en-US', 'ja-JP', 'de-DE', 'fr-FR', 'zh-CN'];
    normalizeProfile({ locale: 'en-US' });
    const ms = time(() => {
      for (let i = 0; i < 20_000; i++) {
        const r = normalizeProfile({ locale: locales[i % 5], timezone: i % 2 ? 'Asia/Tokyo' : 'Europe/Berlin' });
        if (!r.profile) throw new Error(r.errors.join(' '));
      }
    });
    underCeiling(t, ms, 200, '20,000 validations');
  });
});
