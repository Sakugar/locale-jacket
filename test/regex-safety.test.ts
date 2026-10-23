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
];

/** Inputs that make backtracking patterns explode on a hostname-sized string. */
const HOSTILE = ['a'.repeat(40) + '!', 'a.'.repeat(30) + '!', '-a'.repeat(30) + '!', 'x'.repeat(250) + '-'];

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
