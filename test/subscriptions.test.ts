import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportConfig, importConfigText, MAX_SUBSCRIPTIONS, parseSubscriptionRules, sanitizeStoredSettings, TooManyRules } from '../src/shared/config-io.js';
import { DATASETS } from '../src/shared/dataset-store.js';
import { makeProfile } from '../src/shared/locale.js';
import { defaultSettings } from '../src/shared/presets.js';
import { compileDnrRules, dropUnsupportedRegex } from '../src/shared/dnr.js';
import type { GeositeList } from '../src/shared/geosite.js';
import { parseIp } from '../src/shared/ip.js';
import { analysisBudget, REGEX_CHECK_VERSION } from '../src/shared/regex-safety.js';
import { normalizeRuleValue, precedenceTier, resolveHost, rulesInPrecedenceOrder, ruleLabel } from '../src/shared/rules.js';
import {
  datasetDownloadDue,
  datasetsToDownload,
  fetchSubscription,
  markUnsaved,
  MAX_SUBSCRIPTION_RULES,
  parseSubscription,
  rawUrl,
  revertUnsaved,
  staleDatasetRecords,
  subscriptionDue,
  trustCheckedSubscriptionData,
  withSubscriptions,
  type SubscriptionData,
  type SubscriptionDataMap,
} from '../src/shared/subscriptions.js';
import type { Settings, Subscription } from '../src/shared/types.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function sub(id: string, url: string, extra: Partial<Subscription> = {}): Subscription {
  return { id, name: id.toUpperCase(), url, enabled: true, interval: 'daily', ...extra };
}

function settingsWith(subs: Subscription[], own = defaultSettings()): Settings {
  return { ...own, subscriptions: subs };
}

function data(s: Subscription, text: string, extra: Partial<SubscriptionData> = {}): SubscriptionData {
  return { url: rawUrl(s.url), ...parseSubscription(text, s), fetchedAt: NOW - HOUR, lastAttempt: NOW - HOUR, ...extra };
}

describe('rawUrl', () => {
  it('turns GitHub file pages and gists into the raw file', () => {
    assert.equal(rawUrl('https://github.com/o/r/blob/main/dir/rules.yaml'), 'https://raw.githubusercontent.com/o/r/main/dir/rules.yaml');
    assert.equal(rawUrl('https://gist.github.com/someone/0123abcd'), 'https://gist.githubusercontent.com/someone/0123abcd/raw');
    assert.equal(rawUrl('https://raw.githubusercontent.com/o/r/main/rules.json'), 'https://raw.githubusercontent.com/o/r/main/rules.json');
    assert.equal(rawUrl('https://example.com/r.yaml?x=1'), 'https://example.com/r.yaml?x=1');
  });
});

describe('parseSubscription', () => {
  const s = sub('a', 'https://example.com/a.yaml');

  it('reads YAML and JSON, including Clash-style strings, with stable ids and the origin', () => {
    const y = parseSubscription('rules:\n  - DOMAIN-SUFFIX,example.org,fr-FR\n  - type: DOMAIN\n    domain: www.example.org\n    action: SYSTEM\n', s);
    assert.deepEqual(y.rules.map((r) => [r.id, r.type, r.value, r.action]), [['a:0', 'DOMAIN-SUFFIX', 'example.org', 'PROFILE'], ['a:1', 'DOMAIN', 'www.example.org', 'SYSTEM']]);
    assert.equal(y.rules[0]!.origin?.name, 'A');
    const j = parseSubscription(JSON.stringify({ rules: ['DOMAIN-SUFFIX,example.org,ja-JP'] }), s);
    assert.equal(j.rules[0]!.profile?.locale, 'ja-JP');
    assert.equal(parseSubscription(JSON.stringify(['DOMAIN,x.example,en-US']), s).rules.length, 1, 'a bare list works too');
  });

  it('skips invalid entries instead of rejecting the file, and reports what it does not use', () => {
    const r = parseSubscription('rules:\n  - DOMAIN-SUFFIX,ok.example,en-US\n  - BOGUS,x,en-US\n  - MATCH,en-US\ndefault:\n  mode: SYSTEM\noptions:\n  reloadOnLate: false\n', s);
    assert.equal(r.rules.length, 1);
    assert.equal(r.skippedCount, 1);
    assert.deepEqual(r.ignored, ['default', 'options', 'rules[2] (MATCH)']);
  });

  it('rejects a web page and a file without rules, and reads data-set URLs', () => {
    assert.throws(() => parseSubscription('<!DOCTYPE html><html><body>GitHub</body></html>', s), /web page/);
    assert.throws(() => parseSubscription('{"version":1}', s), /no "rules" list/);
    const r = parseSubscription('datasets:\n  geosite: https://cdn.example/geosite.dat\n  geoip: ftp://nope\nrules:\n  - GEOSITE,google,en-US\n', s);
    assert.deepEqual(r.datasets, { geosite: 'https://cdn.example/geosite.dat' });
    assert.equal(r.skippedCount, 1, 'the bad data-set URL is reported');
  });
});

describe('subscription limits and regex budget', () => {
  const s = sub('lim', 'https://example.com/lim.json');
  const lines = (n: number, f: (i: number) => string) => JSON.stringify({ rules: Array.from({ length: n }, (_, i) => f(i)) });

  it('accepts exactly the limit, and counts only valid rules', () => {
    assert.equal(parseSubscription(lines(MAX_SUBSCRIPTION_RULES, (i) => `DOMAIN,h${i}.example,en-US`), s).rules.length, MAX_SUBSCRIPTION_RULES);
    // More entries than the limit, but the extra ones are invalid or MATCH lines: still accepted.
    const mixed = lines(MAX_SUBSCRIPTION_RULES + 3, (i) => (i < 2 ? `BOGUS,${i},en-US` : i === 2 ? 'MATCH,en-US' : `DOMAIN,h${i}.example,en-US`));
    const r = parseSubscription(mixed, s);
    assert.equal(r.rules.length, MAX_SUBSCRIPTION_RULES);
    assert.equal(r.skippedCount, 2);
  });

  it('refuses a file over the limit as soon as the limit is passed', () => {
    const text = lines(20_000, (i) => `DOMAIN-SUFFIX,h${i}.example,${i % 2 ? 'en-US' : 'ja-JP'}`);
    assert.throws(() => parseSubscription(text, s), (e: Error) => e instanceof TooManyRules && /more than 5000 rules \(20000 entries\)/.test(e.message));
    let validated = 0;
    const raw = { rules: new Proxy(Array.from({ length: 20_000 }, (_, i) => `DOMAIN,h${i}.example,en-US`), {
      get: (t, k) => (typeof k === 'string' && /^\d+$/.test(k) ? (validated++, t[Number(k)]) : Reflect.get(t, k)),
    }) };
    assert.throws(() => parseSubscriptionRules(raw, { maxRules: MAX_SUBSCRIPTION_RULES }), TooManyRules);
    assert.equal(validated, MAX_SUBSCRIPTION_RULES + 1, 'entries after the first one over the limit are not looked at');
  });

  it('regexes share one budget per file; those left when it is spent are skipped and listed', () => {
    const raw = { rules: ['DOMAIN,plain.example,en-US', ...Array.from({ length: 4 }, (_, i) => `DOMAIN-REGEX,^sub-budget-${i}-[a-z]+\\.example$,en-US`)] };
    const spent = parseSubscriptionRules(raw, { check: { budget: analysisBudget(0) } });
    assert.deepEqual(spent.rules.map((r) => r.type), ['DOMAIN']);
    assert.equal(spent.skipped.length, 4);
    assert.match(spent.skipped[0]!, /rules\[1\]: This regular expression could take too long/);
    assert.equal(parseSubscriptionRules(raw, { check: { budget: analysisBudget(1000) } }).rules.length, 5);
  });

  it('records the regex check version with the data', () => {
    assert.equal(parseSubscription('rules:\n  - DOMAIN,a.example,en-US\n', s).regexCheck, REGEX_CHECK_VERSION);
  });
});

describe('stored subscription regexes after a worker restart', () => {
  const s = sub('re', 'https://example.com/re.yaml');
  // Stored data as an older version (without the check, or with an older one) may have saved it.
  const unsafe = (id: string, extra: Partial<SubscriptionData> = {}): SubscriptionDataMap => ({
    [s.id]: {
      url: rawUrl(s.url),
      rules: [{ id: `${s.id}:0`, type: 'DOMAIN-REGEX', value: `^(a+)+${id}$`, action: 'PROFILE', profile: makeProfile('ja-JP'), enabled: true, priority: 0, note: '' }],
      skipped: [],
      skippedCount: 0,
      ignored: [],
      ...extra,
    },
  });

  for (const [what, extra] of [['no marker', {}], ['an older check', { regexCheck: REGEX_CHECK_VERSION - 1 }]] as const) {
    it(`data with ${what} is checked before use: an unsafe pattern never runs`, () => {
      const map = unsafe(what.replace(/\W/g, ''), extra);
      assert.equal(trustCheckedSubscriptionData(map), 0);
      const all = withSubscriptions(settingsWith([s], { ...defaultSettings(), rules: [] }), map);
      const host = `${'a'.repeat(30)}${what.replace(/\W/g, '')}`;
      const res = resolveHost(host, all);
      assert.equal(res.source, 'default', 'refused by the check, so it does not match');
    });
  }

  it('data checked by the current version is trusted: its patterns are not analysed again', () => {
    const map = data(s, 'rules:\n  - DOMAIN-REGEX,^trusted-[a-z]+\\.example$,de-DE\n');
    assert.equal(trustCheckedSubscriptionData({ [s.id]: map }), 1);
    const all = withSubscriptions(settingsWith([s], { ...defaultSettings(), rules: [] }), { [s.id]: map });
    assert.equal(resolveHost('trusted-abc.example', all).profile?.locale, 'de-DE');
  });

  it('data from an older check is fetched in full once, not conditionally', async () => {
    const calls: RequestInit[] = [];
    const fn = (async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('rules:\n  - DOMAIN,a.example,en-US\n', { status: 200, headers: { etag: '"v2"' } });
    }) as typeof fetch;
    const old: SubscriptionData = { ...data(s, 'rules:\n  - DOMAIN,a.example,en-US\n'), etag: '"v1"', regexCheck: undefined };
    const r = await fetchSubscription(s, old, fn);
    assert.equal((calls[0]!.headers as Record<string, string>)['If-None-Match'], undefined);
    assert.ok(r.status === 'updated' && r.data.regexCheck === REGEX_CHECK_VERSION);
    await fetchSubscription(s, r.status === 'updated' ? r.data : undefined, fn);
    assert.equal((calls[1]!.headers as Record<string, string>)['If-None-Match'], '"v2"');
  });
});

describe('withSubscriptions and precedence', () => {
  const a = sub('a', 'https://example.com/a.yaml');
  const b = sub('b', 'https://example.com/b.yaml');
  const own = { ...defaultSettings(), rules: [] as Settings['rules'] };
  own.rules = importConfigText('rules:\n  - DOMAIN-SUFFIX,example.org,de-DE\n').settings!.rules;
  const map: SubscriptionDataMap = {
    a: data(a, 'rules:\n  - DOMAIN,www.example.org,fr-FR\n  - DOMAIN-SUFFIX,other.example,fr-FR\n  - DOMAIN-SUFFIX,both.example,fr-FR\n'),
    b: data(b, 'rules:\n  - DOMAIN-SUFFIX,both.example,ja-JP\n  - DOMAIN,only-b.example,ja-JP\n'),
  };

  it('your own rules win over subscription rules, even less specific ones', () => {
    const s = withSubscriptions(settingsWith([a, b], own), map);
    assert.equal(s.rules.length, 1 + 3 + 2);
    assert.equal(resolveHost('www.example.org', s).profile?.locale, 'de-DE', 'own DOMAIN-SUFFIX beats the subscription DOMAIN');
    assert.equal(resolveHost('x.other.example', s).profile?.locale, 'fr-FR');
    assert.equal(resolveHost('only-b.example', s).profile?.locale, 'ja-JP');
  });

  it('an earlier subscription wins over a later one; order and switches are respected', () => {
    assert.equal(resolveHost('both.example', withSubscriptions(settingsWith([a, b], own), map)).profile?.locale, 'fr-FR');
    assert.equal(resolveHost('both.example', withSubscriptions(settingsWith([b, a], own), map)).profile?.locale, 'ja-JP');
    assert.equal(resolveHost('both.example', withSubscriptions(settingsWith([{ ...a, enabled: false }, b], own), map)).profile?.locale, 'ja-JP');
    const order = rulesInPrecedenceOrder(withSubscriptions(settingsWith([a, b], own), map).rules);
    assert.equal(order[0]!.origin, undefined, 'own rules come first in DNR priority order');
  });

  it('labels subscription rules with their subscription, and ignores data from an old URL', () => {
    const s = withSubscriptions(settingsWith([a], own), map);
    assert.equal(ruleLabel(resolveHost('x.other.example', s).rule!), 'DOMAIN-SUFFIX,other.example · A');
    const moved = withSubscriptions(settingsWith([{ ...a, url: 'https://example.com/moved.yaml' }], own), map);
    assert.equal(moved.rules.length, 1);
  });
});

describe('four precedence tiers: your rules › subscriptions › your special rules › subscription special rules', () => {
  const a = sub('a', 'https://example.com/a.yaml');
  const geo: GeositeList = { full: new Set(), suffix: new Set(['tier.example']), keywords: [], regexes: [], skipped: 0, size: 1 };
  const ctx = { geosite: () => geo, ip: parseIp('17.1.2.3') };
  const merged = (ownYaml: string, subYaml: string) => {
    const own = importConfigText(ownYaml).settings!;
    return withSubscriptions(settingsWith([a], own), { a: data(a, subYaml) });
  };
  const locale = (s: Settings, host = 'www.tier.example') => resolveHost(host, s, ctx).profile?.locale;

  it('a subscription hostname rule beats your own GEOSITE and IP rules', () => {
    assert.equal(locale(merged('rules:\n  - GEOSITE,tiered,de-DE\n', 'rules:\n  - DOMAIN-SUFFIX,tier.example,fr-FR\n')), 'fr-FR');
    assert.equal(locale(merged('rules:\n  - IP-CIDR,17.0.0.0/8,de-DE\n', 'rules:\n  - DOMAIN-KEYWORD,tier,fr-FR\n')), 'fr-FR');
  });

  it('your own special rules beat subscription special rules, whatever the type', () => {
    assert.equal(locale(merged('rules:\n  - IP-CIDR,17.0.0.0/8,de-DE\n', 'rules:\n  - GEOSITE,tiered,fr-FR\n')), 'de-DE', 'your IP rule beats their GEOSITE');
    assert.equal(locale(merged('rules:\n  - GEOIP,LAN,SYSTEM\n  - GEOSITE,tiered,de-DE\n', 'rules:\n  - IP-CIDR,17.0.0.0/8,fr-FR\n')), 'de-DE');
  });

  it('your own hostname rules still beat everything, and the tiers are ordered for DNR', () => {
    const s = merged('rules:\n  - DOMAIN,www.tier.example,ja-JP\n  - IP-CIDR,17.0.0.0/8,de-DE\n', 'rules:\n  - DOMAIN-SUFFIX,tier.example,fr-FR\n  - GEOSITE,tiered,ko-KR\n');
    assert.equal(locale(s), 'ja-JP');
    assert.deepEqual(rulesInPrecedenceOrder(s.rules).map((r) => precedenceTier(r)), [0, 1, 2, 3]);
  });

  it('DNR does not mirror rules that rank below an IP rule (the address may decide instead)', () => {
    const withIp = merged('rules:\n  - IP-CIDR,17.0.0.0/8,de-DE\n', 'rules:\n  - DOMAIN-SUFFIX,sub.example,fr-FR\n  - GEOSITE,tiered,ko-KR\n');
    const out = compileDnrRules(withIp, { geosite: () => geo });
    assert.deepEqual(out.rules.map((r) => r.condition.requestDomains), [['sub.example']], 'the subscription hostname rule ranks above the IP rule');
    assert.match(out.skipped.map((x) => `${x.rule.type}: ${x.reason}`).join('\n'), /GEOSITE: Ranks below an IP rule/);
    const noIp = merged('rules: []\n', 'rules:\n  - GEOSITE,tiered,ko-KR\n');
    assert.equal(compileDnrRules(noIp, { geosite: () => geo }).rules.length, 1, 'mirrored when no IP rule ranks above it');
  });
});

describe('fetchSubscription', () => {
  const s = sub('a', 'https://github.com/o/r/blob/main/a.yaml');
  const respond = (status: number, body: string, headers: Record<string, string> = {}) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 304 ? null : body, { status, headers });
    }) as typeof fetch;
    return { fn, calls };
  };

  it('fetches the raw file, keeps the ETag, and sends a conditional request next time', async () => {
    const first = respond(200, 'rules:\n  - DOMAIN-SUFFIX,a.example,en-US\n', { etag: '"v1"', 'content-type': 'text/plain' });
    const r = await fetchSubscription(s, undefined, first.fn, () => NOW);
    assert.equal(first.calls[0]!.url, 'https://raw.githubusercontent.com/o/r/main/a.yaml');
    assert.equal(first.calls[0]!.init?.credentials, 'omit');
    assert.ok(r.status === 'updated' && r.data.etag === '"v1"' && r.data.rules.length === 1);
    const again = respond(304, '');
    const r2 = await fetchSubscription(s, r.status === 'updated' ? r.data : undefined, again.fn);
    assert.equal(r2.status, 'unchanged');
    assert.equal((again.calls[0]!.init?.headers as Record<string, string>)['If-None-Match'], '"v1"');
  });

  it('explains a 404 and a web page instead of a file', async () => {
    await assert.rejects(fetchSubscription(s, undefined, respond(404, 'Not Found').fn), /private GitHub repository/);
    await assert.rejects(fetchSubscription(s, undefined, respond(200, '<!doctype html><title>x</title>', { 'content-type': 'text/html' }).fn), /web page/);
  });

  it('caps the size in bytes, also without content-length', async () => {
    const stream = (text: string) => (async () => new Response(new Blob([text]).stream())) as typeof fetch;
    const rules = 'rules:\n  - DOMAIN-SUFFIX,a.example,en-US\n';
    // 60 characters but 120 bytes: a character count would let it through.
    const wide = `# ${'é'.repeat(60)}\n${rules}`;
    await assert.rejects(fetchSubscription(s, undefined, stream(wide), () => NOW, { maxBytes: 100 }), /larger than 100 bytes/);
    await assert.rejects(fetchSubscription(s, undefined, respond(200, rules, { 'content-length': '5000000' }).fn), /larger than 2 MB/);
    const ok = await fetchSubscription(s, undefined, stream(`\uFEFF${rules}`), () => NOW, { maxBytes: 100 });
    assert.ok(ok.status === 'updated' && ok.data.rules.length === 1, 'a byte-order mark is dropped, as Response.text() does');
  });

  it('times out on a server that never answers or stops sending', async () => {
    const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    await assert.rejects(fetchSubscription(s, undefined, never, () => NOW, { stallMs: 20 }), /did not answer within 0\.02 s/);
    const stalled = (async () => new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('rules:\n')) }))) as typeof fetch;
    await assert.rejects(fetchSubscription(s, undefined, stalled, () => NOW, { stallMs: 20 }), /stopped sending data/);
  });
});

describe('saving subscription data that does not fit', () => {
  const a = sub('a', 'https://example.com/a.yaml');
  const b = sub('b', 'https://example.com/b.yaml');

  it('puts back what storage has for changed entries and records the error', () => {
    const oldA = data(a, 'rules:\n  - DOMAIN-SUFFIX,a.example,en-US\n');
    const oldB = data(b, 'rules:\n  - DOMAIN-SUFFIX,b.example,en-US\n');
    const stored: SubscriptionDataMap = { a: oldA, b: oldB };
    const newA = data(a, 'rules:\n  - DOMAIN-SUFFIX,a.example,en-US\n  - DOMAIN-SUFFIX,a2.example,en-US\n', { lastAttempt: NOW });
    const c = sub('c', 'https://example.com/c.yaml');
    const current: SubscriptionDataMap = { a: newA, b: oldB, c: data(c, 'rules:\n  - DOMAIN,c.example,en-US\n', { lastAttempt: NOW }) };
    const ids = revertUnsaved(current, stored, 'Could not save');
    assert.deepEqual(ids.sort(), ['a', 'c']);
    assert.deepEqual(current.a, { ...oldA, lastAttempt: NOW, error: 'Could not save' }, 'previous rules, new attempt time');
    assert.equal(current.b, oldB, 'unchanged entries are left alone');
    assert.deepEqual(current.c!.rules, [], 'a new subscription keeps no unsaved rules');
    assert.equal(current.c!.error, 'Could not save');
    assert.equal(subscriptionDue(c, current.c, 'changed', NOW), false, 'not refetched on every settings change');
  });

  it('keeps reverted entries failed when even the revert could not be saved', () => {
    const oldA = data(a, 'rules:\n  - DOMAIN-SUFFIX,a.example,en-US\n');
    const oldB = data(b, 'rules:\n  - DOMAIN-SUFFIX,b.example,en-US\n');
    const c = sub('c', 'https://example.com/c.yaml');
    const current: SubscriptionDataMap = {
      a: data(a, 'rules:\n  - DOMAIN,a2.example,en-US\n', { lastAttempt: NOW }),
      b: oldB,
      c: data(c, 'rules:\n  - DOMAIN,c.example,en-US\n', { lastAttempt: NOW }),
    };
    const ids = revertUnsaved(current, { a: oldA, b: oldB }, 'Could not save');
    const reverted: SubscriptionDataMap = Object.fromEntries(ids.map((id) => [id, current[id]!]));
    // Memory reloaded from storage, which never got c.
    const reloaded: SubscriptionDataMap = { a: oldA, b: oldB };
    markUnsaved(reloaded, reverted, 'Could not save');
    assert.deepEqual(reloaded.a, { ...oldA, lastAttempt: NOW, error: 'Could not save' }, 'stored rules, marked failed');
    assert.equal(reloaded.b, oldB, 'entries that were not reverted are left alone');
    assert.equal(reloaded.c!.url, rawUrl(c.url));
    assert.deepEqual(reloaded.c!.rules, []);
    assert.equal(reloaded.c!.error, 'Could not save');
    assert.equal(subscriptionDue(c, reloaded.c, 'changed', NOW), false);
  });
});

describe('subscriptionDue', () => {
  const s = sub('a', 'https://example.com/a.yaml');
  const d = (extra: Partial<SubscriptionData>): SubscriptionData => ({ url: s.url, rules: [], skipped: [], skippedCount: 0, ignored: [], regexCheck: REGEX_CHECK_VERSION, ...extra });

  it('fetches new or moved subscriptions right away, and only once on "changed"', () => {
    assert.equal(subscriptionDue(s, undefined, 'changed', NOW), true);
    assert.equal(subscriptionDue(s, d({ url: 'https://example.com/old.yaml', fetchedAt: NOW }), 'changed', NOW), true);
    assert.equal(subscriptionDue(s, d({ fetchedAt: NOW - 1000 }), 'changed', NOW), false);
    assert.equal(subscriptionDue(s, d({ lastAttempt: NOW - 1000, error: 'x' }), 'changed', NOW), false, 'a failure is not retried on every settings change');
  });

  it('follows the interval with a minimum gap; manual always; disabled never', () => {
    assert.equal(subscriptionDue(s, d({ fetchedAt: NOW - 25 * HOUR, lastAttempt: NOW - 25 * HOUR }), 'alarm', NOW), true);
    assert.equal(subscriptionDue(s, d({ fetchedAt: NOW - 2 * HOUR, lastAttempt: NOW - 2 * HOUR }), 'alarm', NOW), false);
    assert.equal(subscriptionDue({ ...s, interval: 'weekly' }, d({ fetchedAt: NOW - 25 * HOUR, lastAttempt: NOW - 25 * HOUR }), 'startup', NOW), false);
    assert.equal(subscriptionDue(s, d({ fetchedAt: NOW - 30 * HOUR, lastAttempt: NOW - 10 * 60_000 }), 'alarm', NOW), false, 'minimum gap after a failed attempt');
    assert.equal(subscriptionDue({ ...s, interval: 'off' }, d({ fetchedAt: NOW - 90 * 24 * HOUR }), 'alarm', NOW), false);
    assert.equal(subscriptionDue({ ...s, enabled: false }, undefined, 'changed', NOW), false);
    assert.equal(subscriptionDue({ ...s, enabled: false, interval: 'off' }, d({ fetchedAt: NOW }), 'manual', NOW), true);
  });

  it('refetches data checked by an older regex check at the next allowed attempt, but not with updates off', () => {
    const old = (extra: Partial<SubscriptionData>) => d({ regexCheck: undefined, ...extra });
    for (const trigger of ['startup', 'alarm'] as const) {
      assert.equal(subscriptionDue(s, old({ fetchedAt: NOW - 2 * HOUR, lastAttempt: NOW - 2 * HOUR }), trigger, NOW), true, 'before the interval');
      assert.equal(subscriptionDue({ ...s, interval: 'weekly' }, d({ fetchedAt: NOW - 2 * HOUR, regexCheck: REGEX_CHECK_VERSION - 1 }), trigger, NOW), true);
      // A failing URL is not hammered: the minimum gap still applies.
      assert.equal(subscriptionDue(s, old({ fetchedAt: NOW - 30 * HOUR, lastAttempt: NOW - 10 * 60_000, error: 'x' }), trigger, NOW), false);
      // Updates off: nothing goes over the network automatically.
      assert.equal(subscriptionDue({ ...s, interval: 'off' }, old({ fetchedAt: NOW - 2 * HOUR }), trigger, NOW), false);
      assert.equal(subscriptionDue({ ...s, enabled: false }, old({ fetchedAt: NOW - 2 * HOUR }), trigger, NOW), false);
    }
    assert.equal(subscriptionDue(s, old({ fetchedAt: NOW - 2 * HOUR }), 'changed', NOW), false, 'not on every settings change');
    assert.equal(subscriptionDue(s, d({ fetchedAt: NOW - 2 * HOUR, lastAttempt: NOW - 2 * HOUR }), 'alarm', NOW), false, 'current data waits for its interval');
  });
});

describe('data sets for subscriptions', () => {
  const a = sub('a', 'https://example.com/a.yaml');
  const b = sub('b', 'https://example.com/b.yaml');
  const map: SubscriptionDataMap = {
    a: data(a, 'rules:\n  - GEOSITE,google,en-US\n  - GEOIP,US,en-US\n'),
    b: data(b, 'datasets:\n  geosite: https://mirror.example/geosite.dat\nrules:\n  - GEOSITE,apple,ja-JP\n  - IP-ASN,13335,en-US\n'),
  };

  it('lists missing data sets with the first URL a subscription names, else the default', () => {
    const todo = datasetsToDownload(settingsWith([a, b]), map, []);
    assert.deepEqual(todo, [
      { kind: 'geosite', url: 'https://mirror.example/geosite.dat', for: 'B' },
      { kind: 'geoip', url: DATASETS.geoip.defaultUrl, for: 'A' },
      { kind: 'asn', url: DATASETS.asn.defaultUrl, for: 'B' },
    ]);
    assert.deepEqual(datasetsToDownload(settingsWith([a, b]), map, ['geosite', 'geoip', 'asn']), []);
    assert.deepEqual(datasetsToDownload(settingsWith([{ ...a, enabled: false }, { ...b, enabled: false }]), map, []), []);
  });

  it('retries a failed download only after an hour, or for a different URL', () => {
    const failed = { url: 'u', for: 'A', at: NOW - 10 * 60_000, ok: false, error: 'x' };
    assert.equal(datasetDownloadDue(failed, 'u', NOW), false);
    assert.equal(datasetDownloadDue(failed, 'v', NOW), true);
    assert.equal(datasetDownloadDue({ ...failed, at: NOW - 2 * HOUR }, 'u', NOW), true);
    assert.equal(datasetDownloadDue(undefined, 'u', NOW), true);
  });

  it('does not download again a data set you deleted, unless its URL changes', () => {
    const done = { url: 'u', for: 'A', at: NOW - 30 * 24 * HOUR, ok: true };
    assert.equal(datasetDownloadDue(done, 'u', NOW), false);
    assert.equal(datasetDownloadDue(done, 'v', NOW), true);
  });

  it('forgets the record once no enabled subscription needs the data set', () => {
    const state = {
      geosite: { url: 'https://mirror.example/geosite.dat', for: 'B', at: NOW, ok: true },
      asn: { url: DATASETS.asn.defaultUrl, for: 'B', at: NOW, ok: true },
    };
    assert.deepEqual(staleDatasetRecords(settingsWith([a, b]), map, state), []);
    // Without B, nothing needs the ASN data set: adding a subscription that does downloads it again.
    assert.deepEqual(staleDatasetRecords(settingsWith([a]), map, state), ['asn']);
    assert.deepEqual(staleDatasetRecords(settingsWith([a, { ...b, enabled: false }]), map, state), ['asn']);
    assert.deepEqual(staleDatasetRecords(settingsWith([]), map, state), ['geosite', 'asn']);
  });
});

describe('DNR safety', () => {
  it('caps DOMAIN-KEYWORD at the length of a hostname', () => {
    assert.equal(normalizeRuleValue('DOMAIN-KEYWORD', 'a'.repeat(253)).value, 'a'.repeat(253));
    const long = normalizeRuleValue('DOMAIN-KEYWORD', 'a'.repeat(254));
    assert.equal(long.value, null);
    assert.match(long.error!, /too long \(254 characters/);
    const r = parseSubscription(`rules:\n  - DOMAIN-KEYWORD,${'k'.repeat(5000)},en-US\n  - DOMAIN-KEYWORD,ok,en-US\n`, sub('x', 'https://example.com/x.yaml'));
    assert.equal(r.rules.length, 1);
    assert.equal(r.skippedCount, 1);
  });

  it('drops regex rules Chrome does not support and records them as skipped', async () => {
    const s = importConfigText('rules:\n  - DOMAIN-KEYWORD,good,en-US\n  - DOMAIN-KEYWORD,bad,ja-JP\n  - DOMAIN-SUFFIX,plain.example,fr-FR\ndefault:\n  mode: PROFILE\n  locale: en-GB\n').settings!;
    const compiled = compileDnrRules(s);
    assert.equal(compiled.rules.length, 4);
    assert.equal(compiled.sources.length, 4);
    const checked: string[] = [];
    const out = await dropUnsupportedRegex(compiled, async (re) => {
      checked.push(re);
      return re.includes('bad') ? { isSupported: false, reason: 'memoryLimitExceeded' } : { isSupported: true };
    });
    assert.equal(checked.length, 2, 'only regex rules are checked');
    assert.equal(out.rules.length, 3);
    assert.ok(out.rules.every((r) => !r.condition.regexFilter?.includes('bad')));
    assert.equal(new Set(out.rules.map((r) => r.id)).size, 3);
    assert.match(out.skipped.map((x) => `${x.rule.value}: ${x.reason}`).join('\n'), /bad: Chrome cannot use this pattern .*memoryLimitExceeded/);
    // A check that fails leaves the decision to Chrome.
    assert.equal((await dropUnsupportedRegex(compiled, async () => Promise.reject(new Error('x')))).rules.length, 4);
  });
});

describe('subscriptions in the configuration', () => {
  it('are imported, validated, exported and kept in stored settings', () => {
    const r = importConfigText('subscriptions:\n  - https://example.com/a.yaml\n  - name: Team\n    url: https://example.com/b.json\n    interval: weekly\n    enabled: false\nrules: []\n');
    assert.deepEqual(r.errors, []);
    const subs = r.settings!.subscriptions;
    assert.deepEqual(subs.map((x) => [x.name, x.url, x.enabled, x.interval]), [['', 'https://example.com/a.yaml', true, 'daily'], ['Team', 'https://example.com/b.json', false, 'weekly']]);
    const back = importConfigText(exportConfig(r.settings!, 'yaml'));
    assert.deepEqual(back.settings!.subscriptions.map((x) => [x.name, x.url, x.enabled, x.interval]), subs.map((x) => [x.name, x.url, x.enabled, x.interval]));
    const stored = sanitizeStoredSettings(JSON.parse(JSON.stringify(r.settings)), defaultSettings()).settings;
    assert.deepEqual(stored.subscriptions, subs, 'ids survive storage');
    assert.ok(!exportConfig(defaultSettings(), 'yaml').includes('subscriptions'), 'not exported when empty');
  });

  it('rejects bad entries and too many', () => {
    const bad = importConfigText(JSON.stringify({ rules: [], subscriptions: ['ftp://x', { url: 'https://e.com/a', interval: 'hourly' }] }));
    assert.deepEqual(bad.errors, ['subscriptions[0].url must be an http(s) URL.', 'subscriptions[1].interval must be "off", "daily", "weekly" or "monthly".']);
    const many = Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, (_, i) => `https://e.com/${i}`);
    assert.match(importConfigText(JSON.stringify({ rules: [], subscriptions: many })).errors[0]!, /At most 20/);
  });

  it('a subscription rule does not change your settings when exported', () => {
    const a = sub('a', 'https://example.com/a.yaml');
    const s = settingsWith([a]);
    s.rules = [];
    const merged = withSubscriptions(s, { a: data(a, 'rules:\n  - DOMAIN,x.example,en-US\n') });
    assert.equal(merged.rules.length, 1);
    assert.equal(s.rules.length, 0, 'the input is not modified');
    assert.equal(resolveHost('x.example', merged).profile?.locale, makeProfile('en-US').locale);
  });
});
