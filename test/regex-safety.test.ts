import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeStoredSettings } from '../src/shared/config-io.js';
import { geositeMatches, indexGeosite, loadGeositeCategory } from '../src/shared/geosite.js';
import { makeProfile } from '../src/shared/locale.js';
import { defaultSettings } from '../src/shared/presets.js';
import {
  type AnalysisBudget,
  MAX_REGEX_LENGTH,
  REGEX_CHECK_VERSION,
  analysisBudget,
  clearRegexVerdicts,
  regexHazard,
} from '../src/shared/regex-safety.js';
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
  '^(?:(?:img|images|static|cdn|cdn-static|assets)\\.)*example\\.com$',
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

// ---- Patterns that are hard to check ----------------------------------------------------

/** Patterns that took the checker itself 0.1-0.5 s each before its work was bounded. */
const SLOW_TO_CHECK = [
  '^(?:(?:a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a)*\\.)*$',
  '^(?:a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*\\.)*$',
  '^(?:0(?:(?:b(?:((?:a|b|c|d|e|f|g|h{3}|i|j|k|l|m|n|o|p|q|r|s|t)*0|(?:a|b|c|d|e|f|g|h|j|k|(?:l)|m|n{3}|o|p|q|r[a-z]{3}|s|t)*1)*!){3}"){3}%){3}&){3}-{23}{(?:\\w|\\w|\\w|\\w|\\w|\\w|\\w||\\w|\\w|\\w|\\w)?2,[^.{2,9}]{0,3}9',
  '^-{0,3}(?:(?:([ab]{b]{0,3b]{0,3}?:\\d(?:a?:a(?:(?:a|c|d|e|f|g|h|i[a-z]{3}|j|k[a-zb]|l|m|n|o|p|q|r|s|t)*0|(?:a|b|c|d|e|f|g|h|i|j{3}|k|l|m|n|o|p|(?:q|r)|s|t)*1)*!){3}-{0,3}"){3}%){3}&){3}(?:$){2}',
  '^(?:(?:a|a|aa|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a|a[a0{21{3}}b]+[^.]*|a\\d{0,3}|a|x{2,9}a)*\\.)*[a-z0-9-]$',
  '^(?:((?:(?:(?:(?:a|b|c|d|e|f|g|h|i|j|k|l|m[a-z]{3}|n|o|p|q|r|s[a-z]{3}|t)*0|(?:a|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t)*b{1,3}1)*!){3}"){3}\\.{1,3}%){3}&){3}(?:$){1,3}',
  '^(?:(?:(?:(?:(?:(?:a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t)*0|(?:a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t)*1)*!){3}"){3}%){3}&){3}$',
];

const rep = (s: string, k: number, sep = ''): string => Array.from({ length: k }, () => s).join(sep);
const letters = (m: number): string => Array.from({ length: m }, (_, i) => String.fromCharCode(97 + i)).join('|');
/** build(k) for the largest k that keeps the pattern within MAX_REGEX_LENGTH. */
function fit(build: (k: number) => string): string {
  let k = 1;
  while (build(k + 1).length <= MAX_REGEX_LENGTH) k++;
  return build(k);
}
/** `levels` groups repeated `count` times around `inner`, each ending on its own character. */
function nest(inner: string, levels: number, count: string): string {
  let s = inner;
  for (let l = 0; l < levels; l++) s = `(?:${s}${'!"%&\',-/:;'[l]}){${count}}`;
  return `^${s}$`;
}

/** An alternation of domains as long as allowed: ordinary, and among the costliest to check. */
const LONG_ALTERNATION = fit((k) => `^(.+\\.)?(${Array.from({ length: k }, (_, i) => `site${i}`).join('|')})\\.com$`);

/** Patterns aimed at each part of the check: parser, loop checks, position automaton, step bound. */
const HARD_TO_CHECK = [
  LONG_ALTERNATION,
  fit((k) => `${rep('(', k)}a${rep(')', k)}`),
  fit((k) => `${rep('(?:', k)}a${rep('){3}', k)}`),
  fit((k) => `^(?:${rep('(?:', k)}$${rep('){3}', k)}\\.)*x$`),
  fit((k) => `^(?:${rep('(?:', k)}\\b${rep('){16}', k)}\\.)*x$`),
  fit((k) => `^${rep('(?:(?=[a-z]+)', k)}a${rep('){3}', k)}$`),
  fit((k) => `^${rep('(?:(?<=a)', k)}a${rep('){3}', k)}$`),
  fit((k) => `${rep('(?=', k)}a${rep(')', k)}`),
  fit((k) => `^${rep('(?:a|b|c){0,3}', k)}$`),
  fit((k) => `^${rep('[a-z]{0,3}\\.', k)}$`),
  fit((k) => `^${rep('(?:[a-z0-9](?:', k)}[a-z0-9-]*${rep('[a-z0-9])?\\.)*', k)}$`),
  fit((k) => `^${rep('([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*', k)}com$`),
  fit((k) => `^(?:${Array.from({ length: k }, (_, i) => String.fromCharCode(0x100 + i)).join('|')}|a|a)*$`),
  fit((k) => rep('a{16}', k) + 'b'),
  fit((k) => rep('a', k) + 'b'),
  fit((k) => `^[${rep('a-z0-9_', k)}]+\\.com$`),
  fit((k) => rep('\\x61', k)),
  `^(?:${rep('[a-z]*', 31)}\\.)*$`,
  `^(?:${rep('(?:a|b)', 15)}\\.)*$`,
  `^(?:(?:${letters(15)})*0|(?:${letters(15)})*1)*$`,
  `^(?:${Array.from({ length: 10 }, (_, i) => `[a-z][a-z]?${i}`).join('|')})*$`,
  nest(`(?:(?:${letters(15)})*0|(?:${letters(15)})*1)*`, 9, '2'),
  nest(`(?:(?:${letters(12)})*0|(?:${letters(12)})*1)*`, 7, '1,3'),
  nest(`(?:(?:${letters(9)})*0|(?:${letters(9)})*1|(?:${letters(9)})*2)*`, 9, '3'),
];

/** Random edits of `from`: insertions, deletions, wrapping in a quantified group, duplication. */
function mutants(count: number, seed: number, from: string[]): string[] {
  const rand = random(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const atoms = ['a', '[a-z]', '\\.', '-', '\\d', '.', '(?:a|b)', '(?:a|a)', '(?=a)', '$', 'x{16}'];
  const quantifiers = ['', '*', '+', '?', '{2}', '{3}', '{0,3}', '{2,9}'];
  const out: string[] = [];
  for (let tries = 0; out.length < count && tries < count * 20; tries++) {
    let p = pick(from);
    for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) {
      const i = Math.floor(rand() * (p.length + 1));
      const j = Math.min(p.length, i + Math.floor(rand() * 8));
      const r = rand();
      if (r < 0.3) p = p.slice(0, i) + pick(atoms) + pick(quantifiers) + p.slice(i);
      else if (r < 0.5) p = p.slice(0, i) + p.slice(j);
      else if (r < 0.7) p = p.slice(0, i) + '(?:' + p.slice(i, j) + ')' + pick(quantifiers) + p.slice(j);
      else if (r < 0.85) p = p.slice(0, i) + p.slice(i, j) + p.slice(i, j) + p.slice(j);
      else p = p.slice(0, i) + '|' + p.slice(i);
    }
    if (p.length > MAX_REGEX_LENGTH) continue;
    try {
      new RegExp(p, 'i');
    } catch {
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Analyses `p` afresh (not from the verdict memo): [milliseconds, verdict]. */
function timed(p: string, budget?: AnalysisBudget): [number, string | null] {
  clearRegexVerdicts();
  const t0 = performance.now();
  const verdict = regexHazard(p, budget);
  return [performance.now() - t0, verdict];
}

/** Milliseconds one check may take here: under 1 ms warm, 5-10 ms as the first in a process; the rest is CI noise. */
const CEILING = 25;

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

describe('regex safety: cost of the check itself', () => {
  it('patterns that used to take the checker 0.1-0.5 s are decided quickly', () => {
    for (const p of SLOW_TO_CHECK) {
      const [ms] = timed(p);
      assert.ok(ms < CEILING, `${ms.toFixed(1)} ms: ${p}`);
    }
    assert.match(regexHazard(SLOW_TO_CHECK[0]!)!, /can start with the same character/);
    assert.match(regexHazard(SLOW_TO_CHECK[1]!)!, /same text in more than one way/);
  });

  it('patterns built against each part of the check are decided quickly', () => {
    for (const p of HARD_TO_CHECK) {
      assert.ok(p.length <= MAX_REGEX_LENGTH, p);
      new RegExp(p, 'i');
      const [ms] = timed(p);
      assert.ok(ms < CEILING, `${ms.toFixed(1)} ms: ${p}`);
    }
    // Long but ordinary patterns are still accepted.
    assert.ok(LONG_ALTERNATION.length > 500);
    assert.equal(regexHazard(LONG_ALTERNATION), null);
    const labels = fit((k) => `^(?:[a-z0-9-]+\\.)*(?:${Array.from({ length: k }, (_, i) => `d${i}`).join('|')})\\.(?:com|net|org)$`);
    assert.equal(regexHazard(labels), null);
    // One that needs too much work is refused, the same way each time.
    const deep = HARD_TO_CHECK[3]!;
    assert.equal(timed(deep)[1], 'too complex to check');
    assert.equal(timed(deep)[1], 'too complex to check');
  });

  it('random and mutated patterns are decided quickly', () => {
    const list = [...patterns(1500, 13), ...mutants(600, 29, [...HARD_TO_CHECK, ...SLOW_TO_CHECK, ...SAFE])];
    assert.ok(list.length > 2000);
    for (const p of list) {
      const [ms] = timed(p);
      assert.ok(ms < CEILING, `${ms.toFixed(1)} ms: ${p}`);
    }
  });

  it('a batch budget is shared by the patterns checked with it', () => {
    // Each of these uses up the work allowed for one pattern.
    const heavy = Array.from({ length: 150 }, (_, i) => `^(?:${rep('(?:', 60)}$${rep('){3}', 60)}\\.)*x${i}$`);
    clearRegexVerdicts();
    const budget = analysisBudget(50);
    const t0 = performance.now();
    const verdicts = heavy.map((p) => regexHazard(p, budget));
    const ms = performance.now() - t0;
    const firstSpent = verdicts.findIndex((v) => /too many complex regular expressions/.test(v ?? ''));
    assert.ok(firstSpent > 5, `budget spent after ${firstSpent} patterns`);
    assert.ok(verdicts.slice(0, firstSpent).every((v) => v === 'too complex to check'));
    assert.ok(verdicts.slice(firstSpent).every((v) => /too many complex/.test(v ?? '')));
    assert.ok(budget.remaining <= 0);
    assert.ok(ms < 50 * 6, `${ms.toFixed(0)} ms for a 50 ms budget`);
    // That refusal depends on the batch, so it is not remembered.
    assert.equal(regexHazard(heavy[heavy.length - 1]!), 'too complex to check');
    // Light patterns fit in the same budget.
    const forms = [
      (i: number) => `^(.+\\.)?site${i}\\.com$`,
      (i: number) => `^([a-z0-9-]+\\.)*cdn${i}\\.(com|net|org)$`,
      (i: number) => `^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*ex${i}\\.org$`,
    ];
    const light = Array.from({ length: 300 }, (_, i) => forms[i % 3]!(i));
    const fresh = analysisBudget(50);
    assert.ok(light.every((p) => regexHazard(p, fresh) === null));
    assert.ok(fresh.remaining > 0);
    // A spent budget refuses patterns it has not seen, whatever they are.
    const unseen = '^(.+\\.)?not-checked-yet\\.com$';
    assert.match(regexHazard(unseen, analysisBudget(0))!, /too many complex/);
    assert.match(regexHazard(unseen, { remaining: Number.NaN })!, /too many complex/);
    assert.equal(regexHazard(unseen), null);
  });

  it('what fits in a batch budget is the same with the memo warm, cold or thrashing', () => {
    // Legitimate ~500-character alternations of domains, each needing a large part of the
    // work allowed for one pattern; more of them than the budget or the memo holds.
    const alt = (seed: number) => {
      let s = '';
      for (let i = 0; ; i++) {
        const d = `d${seed}x${i}abc\\.example${i % 7}\\.com`;
        if (`${s}|${d}`.length > 500) break;
        s = s ? `${s}|${d}` : d;
      }
      return `^(?:${s})$`;
    };
    const list = Array.from({ length: 5000 }, (_, i) => alt(i));
    // One subscription file: its rule ids are positions in the accepted list.
    const text = JSON.stringify({ rules: list.map((value) => ({ type: 'DOMAIN-REGEX', value, locale: 'en-US' })) });
    const sub = { id: 'heavy', name: 'Heavy', url: 'https://example.com/heavy.json', enabled: true, interval: 'daily' as const };
    const parse = () => {
      const d = parseSubscription(text, sub);
      return { rules: d.rules.map((r) => `${r.id} ${r.value}`), skippedCount: d.skippedCount };
    };
    clearRegexVerdicts();
    const cold = parse();
    const accepted = cold.rules.length;
    assert.ok(accepted > 500 && accepted < list.length, `${accepted} accepted`);
    assert.equal(cold.skippedCount, list.length - accepted);
    assert.deepEqual(parse(), cold, 'warm (partly remembered, the memo thrashing)');
    assert.deepEqual(parse(), cold, 'again');
    // Warm with only the accepted ones remembered (no thrashing), and with later ones remembered.
    clearRegexVerdicts();
    for (const p of list.slice(0, Math.min(accepted, 4000))) regexHazard(p);
    assert.deepEqual(parse(), cold, 'warm');
    clearRegexVerdicts();
    for (const p of list.slice(-4000)) regexHazard(p);
    assert.deepEqual(parse(), cold, 'the rest remembered');
    // Every pattern on its own is safe; only the shared budget refuses the rest.
    clearRegexVerdicts();
    assert.equal(regexHazard(list.at(-1)!), null);
  });

  it('verdicts are remembered by source', () => {
    const p = HARD_TO_CHECK[2]!;
    clearRegexVerdicts();
    const budget = { remaining: 1e9 };
    const verdict = regexHazard(p, budget);
    const first = 1e9 - budget.remaining;
    assert.ok(first > 10000, `${first} units`);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) assert.equal(regexHazard(p), verdict);
    assert.ok(performance.now() - t0 < 20, 'answered from memory');
    // A batch is charged what the analysis cost, so what fits in it does not depend on the memo.
    for (let i = 0; i < 10; i++) {
      const before = budget.remaining;
      assert.equal(regexHazard(p, budget), verdict);
      assert.equal(before - budget.remaining, first);
    }
    // A batch with too little left refuses it as unchecked, as a fresh analysis would.
    const short = { remaining: first - 1 };
    assert.match(regexHazard(p, short)!, /too many complex/);
    assert.ok(short.remaining <= 0);
    assert.match(regexHazard(p, analysisBudget(0))!, /too many complex/);
    assert.equal(regexHazard(p), verdict, 'the verdict is still remembered');
    assert.equal(regexHazard(SAFE[0]!), null);
    assert.match(regexHazard(SAFE[0]!, analysisBudget(-1))!, /too many complex/);
    assert.ok(Number.isInteger(REGEX_CHECK_VERSION) && REGEX_CHECK_VERSION >= 2);
  });
});
