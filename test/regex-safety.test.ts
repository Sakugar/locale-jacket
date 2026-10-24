import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeStoredSettings } from '../src/shared/config-io.js';
import { geositeMatches, indexGeosite, loadGeositeCategory } from '../src/shared/geosite.js';
import { makeProfile } from '../src/shared/locale.js';
import { defaultSettings } from '../src/shared/presets.js';
import { MAX_REGEX_LENGTH, regexHazard } from '../src/shared/regex-safety.js';
import { normalizeRuleValue, resolveHost } from '../src/shared/rules.js';
import { parseSubscription } from '../src/shared/subscriptions.js';
import type { Rule } from '../src/shared/types.js';
import { encodeGeosite } from './fixtures.js';

const SAFE = [
  '^(.+\\.)?example\\.(com|org)$',
  '^(.+\\.)?example\\.com$',
  '^([a-z0-9-]+\\.)*example\\.com$',
  '^([a-z0-9-]+\\.)*[a-z0-9-]+\\.example\\.com$',
  '^[a-z0-9]+(-[a-z0-9]+)*\\.example\\.com$',
  '^a{1,3}\\.example$',
  '^x\\d+$',
  '^(www\\.)?(foo|bar)\\.com$',
  '(^|\\.)google\\.[a-z]{2,3}$',
  '^(ab)+$',
  '^ad[0-9]*\\.',
  'tracker',
  '^[^.]+\\.cdn\\.net$',
  '^(?:[a-z]+\\.){2}com$',
  '(?<=\\.)example\\.com$',
  '^((a+)\\.)+$',
  // From the default GeoSite data.
  '(^|\\.)apiproxy-device-prod-nlb-.+\\.amazonaws\\.com$',
  '.+\\.dkr\\.ecr\\.[^\\.]+\\.amazonaws\\.com$',
  '.+\\.awsdns-[0-9][0-9]\\.(co\\.uk|com|net|org)$',
  '^r+[0-9]+(---|\\.)sn-(2x3|ni5|j5o)\\w{5}\\.googlevideo\\.com$',
  '^chatgpt-async-webps-prod-\\S+-\\d+\\.webpubsub\\.azure\\.com$',
  '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$',
  '(\\w+)-static-[0-9]+\\.cdntogo\\.net$',
  '(^|\\.)byyum([3589]|2[235689]|3[34]|4[1-9]|5[1-79]|6[0134679])?\\.com$',
  // Other hostname patterns.
  '^.*\\.example\\.com$',
  '^(.*\\.)?(foo|bar)\\.(.*\\.)?example\\.com$',
  '^[^.]+\\.[^.]+\\.example\\.com$',
  '^[a-z0-9-]{1,63}(\\.[a-z0-9-]{1,63})*$',
  '^(?:[a-z0-9]|-)+\\.example\\.com$',
  '^(?<sub>[a-z0-9-]+)\\.example\\.com$',
  '^(?i:www\\.)?example\\.com$',
  '^(?-i:[a-z]+)\\.example\\.com$',
  '(?<!cdn)\\.example\\.com$',
  '^(?!www\\.)[a-z]+\\.example\\.com$',
  '^\\w+-\\d+\\.example\\.com$',
  '^ad[sv]?\\d{0,3}\\.',
  '^[\\w-]+\\.example$',
  '^[\\]a-]x$',
  '^a[^]b[]?$',
  '^\\x61\\u0062c\\.\\p{L}$',
  // Hostname labels: each repetition ends at the first "." after its start.
  '^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*example\\.com$',
  '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$',
  '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+example\\.com$',
  '^(?:[a-z\\d](?:[a-z\\d-]{0,61}[a-z\\d])?\\.)*[a-z]{2,63}$',
  '(^|\\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*example\\.com$',
  '^(?:[a-z0-9-]*[a-z0-9]\\.)*example$',
  '^(?:(?:a|ab)-)+$',
];

const UNSAFE = [
  '^(a+)+$',
  '(a*)*b',
  '^(.+\\.)*example\\.com$',
  '^(a|aa)+$',
  '^(a|a)*$',
  '^(\\w+\\.?)+$',
  '^([a-z]+\\.[a-z]*)+$',
  '^(-a*a*)*$',
  '^(a?a)+$',
  '^(?:a{1,16}){1,16}$',
  '(.*a){5}',
  '^(a)\\1$',
  '^(?<x>a)\\k<x>$',
  '(?=(a+)+b)',
  '^.*.*.*.*.*x$',
  // Inline modifier groups are groups, not the literals "?", "i" and ":".
  '(?i:a+)+$',
  '(?-i:a+)+$',
  '(?m:[a-z]+)*\\.x$',
  '^(?ims:a|a)+$',
  '^(?s-i:(?i:a)+)+$',
  // Polynomial: overlapping parts outside repeated groups, bounded ones included.
  '^' + '\\w{0,9}'.repeat(8) + '!',
  '^' + '\\w{0,9}'.repeat(10) + '!',
  '.*.*.*.*!',
  '.*.*.*!',
  '^.*.*.*.*!',
  '(?:.*){3}!',
  '\\d+\\d+\\d+!',
  '^(.*)(.*)(.*)(.*)$',
  '^(?:.+\\.){3}.+$',
  '(\\w{0,9}\\d*?\\d{0,3})?!',
  // Ambiguity hidden in a group inside a repeated group.
  '^((a+a+)?-)+$',
  '^(a+-(b?)?)+$',
  // Near misses of the hostname-label form.
  '^([a-z.-]*[a-z]\\.)*x$', // the "." can also be matched inside
  '^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.?)*x$', // optional "."
  '^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.|[a-z0-9]+)*x$', // a branch without it
  '^(?:a*a*\\.)*x$', // each repetition matches in two ways
  '^(?:(?:a|a)\\.)+x$',
  '^(?:[a-z]*X)+$', // X is x under the i flag
  // Escapes and syntax read the way V8 reads them without the u flag.
  '^' + '\\u{0,9}'.repeat(8) + '!',
  '^' + '\\p{0,9}'.repeat(8) + '!',
  '^\\c+c+c+c+!', // a backslash, then four c+ in a row
  '^(?x:a)$',
  '^(?<1a>x)$',
  '^\\01$',
  '^[\\1]$',
  '^\\k$',
  '^(?=a)*a$',
  '(?<=a+)b',
  '^((?=a)a)+$',
];

/** Inputs that make backtracking patterns explode on a hostname-sized string. */
const HOSTILE = ['a'.repeat(40) + '!', 'a.'.repeat(30) + '!', '-a'.repeat(30) + '!', 'x'.repeat(250) + '-'];

/** Hostname-length (253 characters) inputs for the property test. */
const LONG = ['a', 'a.', '-a', 'ab', 'a-b.', 'aab', '0', 'a0', '.'].flatMap((u) => {
  const body = u.repeat(Math.ceil(253 / u.length)).slice(0, 252);
  return [body + '!', body + u[0], '!' + body];
});

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small random patterns from literals, ., classes, groups, alternatives and quantifiers. */
function patterns(count: number, seed: number): string[] {
  const rand = random(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const atoms = ['a', 'a', 'b', '\\.', '-', '.', '[a-z]', '[^.]', '\\w', '\\d', '[ab]', '[a.-]', '0'];
  const quantifiers = ['', '', '', '*', '+', '?', '{0,3}', '{2}', '{1,}', '{0,9}', '*?', '{2,5}', '{3,}', '{1,4}', '{5}'];
  const groups = ['(', '(?:', '(?i:', '(?-i:', '(?m:'];
  const alternatives = (depth: number): string => {
    const n = rand() < 0.75 ? 1 : rand() < 0.8 ? 2 : 3;
    return Array.from({ length: n }, () => sequence(depth)).join('|');
  };
  const sequence = (depth: number): string => {
    let s = '';
    for (let n = 1 + Math.floor(rand() * 4); n > 0; n--) {
      const r = rand();
      if (depth < 3 && r < 0.3) s += pick(groups) + alternatives(depth + 1) + ')' + pick(quantifiers);
      else if (r < 0.33) s += pick(['^', '$', '\\b']);
      else if (depth < 3 && r < 0.35) s += '(?=' + alternatives(depth + 1) + ')';
      else s += pick(atoms) + pick(quantifiers);
    }
    return s;
  };
  return Array.from({ length: count }, () => (rand() < 0.5 ? '^' : '') + alternatives(0) + (rand() < 0.3 ? '!' : ''));
}

describe('regex safety', () => {
  it('accepts ordinary hostname patterns', () => {
    for (const p of SAFE) assert.equal(regexHazard(p), null, p);
  });

  it('refuses patterns that can backtrack for too long', () => {
    for (const p of UNSAFE) assert.ok(regexHazard(p), p);
    assert.ok(regexHazard('a'.repeat(MAX_REGEX_LENGTH + 1)));
  });

  it('accepted patterns stay fast on hostile hostnames', () => {
    for (const p of SAFE) {
      const re = new RegExp(p, 'i');
      const t0 = performance.now();
      for (const h of HOSTILE) re.test(h);
      assert.ok(performance.now() - t0 < 200, `${p} took ${performance.now() - t0} ms`);
    }
  });

  it('every random pattern it accepts stays fast on hostname-length inputs', () => {
    let accepted = 0;
    for (const p of patterns(1500, 7)) {
      if (regexHazard(p)) continue;
      accepted++;
      // A fresh regex: V8 runs the first test() in its slower bytecode interpreter.
      const re = new RegExp(p, 'i');
      const t0 = performance.now();
      for (const h of LONG) re.test(h);
      const ms = performance.now() - t0;
      assert.ok(ms < 100, `${p} took ${ms.toFixed(1)} ms`);
    }
    assert.ok(accepted > 300, `only ${accepted} accepted`);
  });

  it('a DOMAIN-REGEX rule with such a pattern is rejected with a reason', () => {
    const r = normalizeRuleValue('DOMAIN-REGEX', '^(a+)+$');
    assert.equal(r.value, null);
    assert.match(r.error!, /too long to match/);
    assert.equal(normalizeRuleValue('DOMAIN-REGEX', '^(.+\\.)?example\\.com$').value, '^(.+\\.)?example\\.com$');
  });

  it('a subscription skips the rule instead of running it', () => {
    const sub = { id: 's1', name: 'x', url: 'https://example.com/r.yaml', enabled: true, interval: 'daily' as const };
    const d = parseSubscription('rules:\n  - "DOMAIN-REGEX,^(a+)+$,en-US"\n  - DOMAIN-SUFFIX,example.com,en-US\n', sub);
    assert.equal(d.rules.length, 1);
    assert.equal(d.skippedCount, 1);
    assert.match(d.skipped[0]!, /too long to match/);
  });

  it('a stored rule saved before the check is dropped, and never runs if it gets through', () => {
    const bad: Rule = {
      id: 'old',
      type: 'DOMAIN-REGEX',
      value: '^(a+)+$',
      action: 'PROFILE',
      profile: makeProfile('en-US'),
      enabled: true,
      priority: 0,
      note: '',
    };
    const stored = { ...defaultSettings(), rules: [bad] };
    const { settings, problems } = sanitizeStoredSettings(stored, defaultSettings());
    assert.equal(settings.rules.length, 0);
    assert.equal(problems.length, 1);
    // Subscription data in storage is not re-validated; the matcher refuses the pattern itself.
    const t0 = performance.now();
    const res = resolveHost('a'.repeat(40) + '.com', { rules: [bad], defaultAction: { action: 'SYSTEM' } });
    assert.equal(res.action, 'SYSTEM');
    assert.ok(performance.now() - t0 < 200);
  });

  it('a GeoSite data set skips such regex entries', () => {
    const idx = indexGeosite(encodeGeosite({ x: [[1, '^(a+)+$'], [1, '^ads\\d*\\.example$'], [2, 'example.org']] }));
    const list = loadGeositeCategory(idx, 'x')!;
    assert.equal(list.regexes.length, 1);
    assert.equal(list.skipped, 1);
    assert.equal(list.size, 2);
    assert.ok(geositeMatches(list, 'ads3.example') && !geositeMatches(list, 'a'.repeat(40) + '!'));
  });
});
