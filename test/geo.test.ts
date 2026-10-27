import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportConfig, importConfigText } from '../src/shared/config-io.js';
import { compileDnrRules, DNR_MAX_GEOSITE_DOMAINS } from '../src/shared/dnr.js';
import { DomainTable, geositeMatches, indexGeosite, loadGeositeCategory, plainDomainCount, type GeositeList } from '../src/shared/geosite.js';
import { cidrContains, formatCidr, formatIp, isLanIp, parseCidr, parseIp, type IpAddr } from '../src/shared/ip.js';
import { makeProfile } from '../src/shared/locale.js';
import { asnOf, countryOf, MmdbReader } from '../src/shared/mmdb.js';
import { needsServerIp, normalizeRuleValue, requiredDatasets, resolveHost, type MatchContext } from '../src/shared/rules.js';
import type { Rule, RuleType, Settings } from '../src/shared/types.js';
import { encodeGeosite } from './fixtures.js';

// ------------------------------------------------------------- test writers

/** Build an IPv6 MaxMind DB (record size 24) mapping prefixes to records. */
function buildMmdb(entries: { cidr: string; record: Record<string, unknown> }[], dbType = 'Test-Country'): Uint8Array {
  const enc = new TextEncoder();
  const data: number[] = [];
  const encode = (v: unknown): number[] => {
    if (typeof v === 'string') {
      const b = [...enc.encode(v)];
      // Sizes of 29+ use an extra length byte (29 + n).
      return b.length < 29 ? [(2 << 5) | b.length, ...b] : [(2 << 5) | 29, b.length - 29, ...b];
    }
    if (typeof v === 'number') {
      const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
      return [(6 << 5) | 4, ...b];
    }
    const m = v as Record<string, unknown>;
    return [(7 << 5) | Object.keys(m).length, ...Object.entries(m).flatMap(([k, x]) => [...encode(k), ...encode(x)])];
  };
  type Node = { l: number | Node | null; r: number | Node | null };
  const root: Node = { l: null, r: null };
  for (const e of entries) {
    const c = parseCidr(e.cidr)!;
    const bits = c.family === 4 ? c.prefix + 96 : c.prefix;
    // Real databases keep IPv4 under ::/96 (zeros), not ::ffff:0:0/96.
    const addr = new Uint8Array(c.bytes);
    if (c.family === 4) addr.fill(0, 0, 12);
    const offset = data.length;
    data.push(...encode(e.record));
    let node = root;
    for (let i = 0; i < bits; i++) {
      const bit = (addr[i >> 3]! >> (7 - (i & 7))) & 1;
      const key = bit ? 'r' : 'l';
      if (i === bits - 1) node[key] = offset;
      else {
        if (typeof node[key] !== 'object' || node[key] === null) node[key] = { l: null, r: null };
        node = node[key] as Node;
      }
    }
  }
  const nodes: Node[] = [];
  const walk = (n: Node) => {
    nodes.push(n);
    for (const k of ['l', 'r'] as const) if (n[k] && typeof n[k] === 'object') walk(n[k] as Node);
  };
  walk(root);
  const count = nodes.length;
  const tree: number[] = [];
  const rec = (v: number | Node | null) => (v === null ? count : typeof v === 'number' ? count + 16 + v : nodes.indexOf(v));
  for (const n of nodes) for (const v of [rec(n.l), rec(n.r)]) tree.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  const meta = encode({ node_count: count, record_size: 24, ip_version: 6, database_type: dbType });
  const marker = [0xab, 0xcd, 0xef, ...enc.encode('MaxMind.com')];
  return new Uint8Array([...tree, ...new Array(16).fill(0), ...data, ...marker, ...meta]);
}

const ip = (s: string): IpAddr => parseIp(s)!;
let seq = 0;
function rule(type: RuleType, value: string, target: string, extra: Partial<Rule> = {}): Rule {
  const v = normalizeRuleValue(type, value);
  assert.ok(v.value, `invalid ${type} ${value}: ${v.error}`);
  return { id: `g${++seq}`, type, value: v.value, action: target === 'SYSTEM' ? 'SYSTEM' : 'PROFILE', profile: target === 'SYSTEM' ? null : makeProfile(target), enabled: true, priority: 0, note: '', ...extra };
}
const settingsOf = (rules: Rule[]): Pick<Settings, 'rules' | 'defaultAction'> => ({ rules, defaultAction: { action: 'SYSTEM' } });
const loc = (host: string, rules: Rule[], ctx: MatchContext = {}) => {
  const r = resolveHost(host, settingsOf(rules), ctx);
  return r.action === 'SYSTEM' ? 'SYSTEM' : r.profile!.locale;
};

// ------------------------------------------------------------------------ ip

describe('IP parsing and CIDR', () => {
  it('parses and formats IPv4 and IPv6', () => {
    assert.equal(formatIp(ip('192.168.001.1'.replace('001', '1'))), '192.168.1.1');
    assert.equal(parseIp('192.168.01.1'), null, 'leading zeros rejected');
    assert.equal(formatIp(ip('2001:0db8:0000:0000:0000:0000:0000:0001')), '2001:db8::1');
    assert.equal(formatIp(ip('[::1]')), '::1');
    assert.equal(ip('::ffff:10.0.0.1').family, 4, 'IPv4-mapped IPv6 counts as IPv4');
    for (const bad of ['1.2.3', '256.1.1.1', '::1::', 'gggg::1', '1:2:3:4:5:6:7:8:9', 'example.com']) assert.equal(parseIp(bad), null, bad);
  });

  it('normalizes CIDRs and tests membership on bit boundaries', () => {
    assert.equal(formatCidr(parseCidr('10.1.2.3/8')!), '10.0.0.0/8');
    assert.equal(formatCidr(parseCidr('2001:db8:abcd::1/33')!), '2001:db8:8000::/33');
    const c = parseCidr('172.16.0.0/12')!;
    assert.ok(cidrContains(c, ip('172.31.255.255')));
    assert.ok(!cidrContains(c, ip('172.32.0.0')));
    assert.ok(!cidrContains(c, ip('::ffff:1:2')), 'other family never matches');
    assert.equal(parseCidr('1.2.3.4/33'), null);
  });

  it('knows LAN ranges', () => {
    for (const a of ['127.0.0.1', '10.2.3.4', '192.168.1.1', '::1', 'fe80::1', 'fd12::1', '100.64.0.1']) assert.ok(isLanIp(ip(a)), a);
    for (const a of ['8.8.8.8', '2001:4860::8888', '172.32.0.1']) assert.ok(!isLanIp(ip(a)), a);
  });
});

// ---------------------------------------------------------------------- mmdb

describe('MaxMind DB reader', () => {
  const db = buildMmdb([
    { cidr: '8.8.8.0/24', record: { country: { iso_code: 'US' }, autonomous_system_number: 15169, autonomous_system_organization: 'Google' } },
    { cidr: '114.114.0.0/16', record: { country: { iso_code: 'CN' } } },
    { cidr: '2001:4860::/32', record: { registered_country: { iso_code: 'us' } } },
  ]);
  const r = new MmdbReader(db);

  it('reads metadata and resolves IPv4 (under ::/96) and IPv6', () => {
    assert.equal(r.metadata.database_type, 'Test-Country');
    assert.equal(countryOf(r.lookup(ip('8.8.8.8')).record), 'US');
    assert.equal(r.lookup(ip('8.8.8.8')).prefix, 24);
    assert.equal(countryOf(r.lookup(ip('114.114.114.114')).record), 'CN');
    assert.equal(countryOf(r.lookup(ip('2001:4860:4860::8888')).record), 'US');
    assert.equal(r.lookup(ip('1.1.1.1')).record, null);
    assert.deepEqual(asnOf(r.lookup(ip('8.8.4.4')).record), null, 'outside the /24');
    assert.deepEqual(asnOf(r.lookup(ip('8.8.8.1')).record), { asn: 15169, org: 'Google' });
  });

  it('rejects files that are not MaxMind databases', () => {
    assert.throws(() => new MmdbReader(new Uint8Array(100)), /metadata marker/);
  });
});

// ------------------------------------------------------------------ geosite

describe('geosite.dat reader', () => {
  const dat = encodeGeosite({
    google: [
      [2, 'google.com'],
      [3, 'www.youtube.com'],
      [0, 'googlevideo'],
      [1, '^gstatic\\d*\\.example$'],
      [2, 'google.cn', ['cn']],
    ],
    empty: [],
  });
  const idx = indexGeosite(dat);

  it('indexes categories case-insensitively and decodes entry types', () => {
    assert.deepEqual([...idx.categories.keys()].sort(), ['empty', 'google']);
    const g = loadGeositeCategory(idx, 'GOOGLE')!;
    assert.equal(g.size, 5);
    const m = (h: string) => geositeMatches(g, h);
    assert.ok(m('google.com') && m('mail.google.com'), 'suffix');
    assert.ok(!m('fakegoogle.com'), 'suffix respects label boundaries');
    assert.ok(m('www.youtube.com') && !m('m.youtube.com'), 'full is exact');
    assert.ok(m('r1---sn.googlevideo.com'), 'keyword');
    assert.ok(m('gstatic3.example') && !m('x.gstatic3.example'), 'regex');
    assert.equal(loadGeositeCategory(idx, 'missing'), null);
  });

  it('filters by attribute', () => {
    const cn = loadGeositeCategory(idx, 'google', 'cn')!;
    assert.equal(cn.size, 1);
    assert.ok(geositeMatches(cn, 'www.google.cn'));
    const notCn = loadGeositeCategory(idx, 'google', '!cn')!;
    assert.equal(notCn.size, 4);
  });

  it('rejects non-geosite data', () => {
    assert.throws(() => indexGeosite(new TextEncoder().encode('hello world')));
  });

  it('regexp entries share one analysis budget per category; when it is spent they are skipped', () => {
    const many = indexGeosite(
      encodeGeosite({
        big: [[2, 'kept.example'], ...Array.from({ length: 5 }, (_, i): [number, string] => [1, `^geo-budget-${i}-[a-z]+\\.example$`])],
      }),
    );
    const none = loadGeositeCategory(many, 'big', undefined, 0)!;
    assert.equal(none.regexes.length, 0);
    assert.equal(none.skipped, 5);
    assert.ok(geositeMatches(none, 'kept.example'), 'other entries are kept');
    const all = loadGeositeCategory(many, 'big')!;
    assert.equal(all.regexes.length, 5);
    assert.ok(geositeMatches(all, 'geo-budget-3-abc.example'));
  });

  // The full: and domain: entries are kept as byte ranges (DomainTable), not one string each.
  // They must behave exactly like the Set of lowercased values they replace.
  it('domain tables behave like a Set of the lowercased values', () => {
    const t = indexGeosite(
      encodeGeosite({
        mixed: [
          [2, 'Example.COM'],
          [2, '..dotted.example'],
          [2, 'example.com'], // duplicate after lowercasing
          [2, 'BÜCHER.de'], // non-ASCII: decoded and lowercased as a string
          [3, 'K.example'], // KELVIN SIGN lowercases to an ASCII "k"…
          [3, 'k.example'], // …so this one is a duplicate
          [3, 'Upper.Example'],
          [2, '﻿'], // decodes to "" (byte-order mark): left out like an empty value
          [2, '﻿.bom.example'], // the mark is dropped, then the leading dot
          [2, '.'], // an empty suffix after the dots go, as before
          [3, 'under_score.example'],
        ],
      }),
    );
    const l = loadGeositeCategory(t, 'mixed')!;
    assert.equal(l.size, 10);
    assert.deepEqual([...l.suffix], ['example.com', 'dotted.example', 'bücher.de', 'bom.example', '']);
    assert.deepEqual([...l.full], ['k.example', 'upper.example', 'under_score.example']);
    assert.equal(l.suffix.size, 5);
    assert.equal(l.full.size, 3);
    for (const d of [...l.suffix, ...l.full]) assert.ok(l.suffix.has(d) || l.full.has(d), d);
    assert.ok(!l.suffix.has('Example.com'), 'lookups are exact, like Set.has');
    assert.ok(!l.suffix.has('example.co') && !l.suffix.has('xample.com') && !l.full.has('K.example'));
    assert.ok(geositeMatches(l, 'www.example.com') && geositeMatches(l, 'a.dotted.example') && geositeMatches(l, 'k.example'));
    assert.ok(!geositeMatches(l, 'www.upper.example'), 'full is exact');
    assert.equal(plainDomainCount(l), 5, 'example.com, dotted.example, bom.example, k.example, upper.example');
  });

  it('attribute keys compare like lowercased strings', () => {
    const t = indexGeosite(encodeGeosite({ g: [[2, 'a.example', ['CN']], [2, 'b.example', ['ads', 'cn']], [2, 'c.example', ['cnx']], [2, 'd.example']] }));
    assert.deepEqual([...loadGeositeCategory(t, 'g', 'cn')!.suffix], ['a.example', 'b.example']);
    assert.deepEqual([...loadGeositeCategory(t, 'g', '!cn')!.suffix], ['c.example', 'd.example']);
    assert.deepEqual([...loadGeositeCategory(t, 'g', 'ADS')!.suffix], ['b.example']);
  });

  it('random categories: same members, order, sizes and lookups as a Set', () => {
    const rnd = random(20261026);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const labels = ['a', 'B', 'cdn', 'Mail', 'xn--fiqs8s', 'bücher', '1', 'e-x', '.', '..', 'k', 'K', 'İ'];
    const tlds = ['com', 'CN', 'org', 'de', ''];
    for (let round = 0; round < 40; round++) {
      const entries: [number, string][] = [];
      const n = 1 + Math.floor(rnd() * 300);
      for (let i = 0; i < n; i++) {
        const parts = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(labels));
        entries.push([rnd() < 0.7 ? 2 : 3, `${rnd() < 0.1 ? '.' : ''}${parts.join('.')}.${pick(tlds)}`]);
      }
      const l = loadGeositeCategory(indexGeosite(encodeGeosite({ r: entries })), 'r')!;
      const want = { suffix: new Set<string>(), full: new Set<string>() };
      for (const [type, value] of entries) {
        const v = value.toLowerCase();
        if (type === 2) want.suffix.add(v.replace(/^\.+/, ''));
        else want.full.add(v);
      }
      assert.equal(l.size, entries.length);
      assert.deepEqual([...l.suffix], [...want.suffix], `round ${round}`);
      assert.deepEqual([...l.full], [...want.full], `round ${round}`);
      assert.equal(l.suffix.size, want.suffix.size);
      const probes = [...want.suffix, ...want.full].flatMap((d) => [d, d.toUpperCase(), `x.${d}`, d.slice(1), `${d}.`]);
      for (const p of probes) {
        assert.equal(l.suffix.has(p), want.suffix.has(p), `suffix ${p}`);
        assert.equal(l.full.has(p), want.full.has(p), `full ${p}`);
        assert.equal(geositeMatches(l, p), geositeMatches({ ...l, ...want }, p), `matches ${p}`);
      }
      const plain = [...new Set([...want.suffix, ...want.full])].filter((d) => /^[a-z0-9.-]+$/.test(d)).length;
      assert.equal(plainDomainCount(l), plain, `round ${round} plain count`);
    }
  });

  it('a data set whose domains all collide falls back to a plain Set, with the same result', () => {
    const rnd = random(7);
    const entries: [number, string][] = Array.from({ length: 3000 }, (_, i) => [2, `${i % 3 ? '' : '.'}H${Math.floor(rnd() * 2000)}.Example${i % 7 ? '' : '.bücher'}`]);
    const want = [...new Set(entries.map(([, v]) => v.toLowerCase().replace(/^\.+/, '')))];
    const idx = indexGeosite(encodeGeosite({ c: entries }));
    const imul = Math.imul;
    Math.imul = () => 0; // every hash is the same
    let l: GeositeList;
    try {
      l = loadGeositeCategory(idx, 'c')!;
    } finally {
      Math.imul = imul;
    }
    assert.ok((l.suffix as DomainTable).usesFallback);
    assert.deepEqual([...l.suffix], want);
    assert.equal(l.suffix.size, want.length);
    assert.ok(want.every((d) => l.suffix.has(d)) && !l.suffix.has('h1.example.x'));
    assert.equal(plainDomainCount(l), want.filter((d) => /^[a-z0-9.-]+$/.test(d)).length);
    const normal = loadGeositeCategory(idx, 'c')!;
    assert.ok(!(normal.suffix as DomainTable).usesFallback);
    assert.deepEqual([...normal.suffix], want);
  });

  it('DNR counts a category over the mirroring limit without listing its domains', () => {
    const big = Array.from({ length: DNR_MAX_GEOSITE_DOMAINS + 5 }, (_, i): [number, string] => [2, `d${i}.example`]);
    const l = loadGeositeCategory(indexGeosite(encodeGeosite({ big: [...big, [3, 'd7.example'], [3, 'only-full.example']] })), 'big')!;
    l.suffix[Symbol.iterator] = () => {
      throw new Error('listed the domains');
    };
    const s = importConfigText('rules:\n  - GEOSITE,big,en-US\n').settings!;
    const out = compileDnrRules(s, { geosite: () => l });
    assert.equal(out.rules.length, 0);
    assert.match(out.skipped.map((x) => x.reason).join('\n'), new RegExp(`${DNR_MAX_GEOSITE_DOMAINS + 6} domains exceed`));
  });
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

// -------------------------------------------------------------------- rules

describe('IP and GEO rules', () => {
  const geoDb = new MmdbReader(buildMmdb([{ cidr: '17.0.0.0/8', record: { country: { iso_code: 'US' } } }, { cidr: '223.5.5.0/24', record: { country: { iso_code: 'CN' } } }]));
  const asnDb = new MmdbReader(buildMmdb([{ cidr: '104.16.0.0/13', record: { autonomous_system_number: 13335 } }]));
  const geo = indexGeosite(encodeGeosite({ google: [[2, 'google.com']], cn: [[2, 'cn'], [2, 'baidu.com']] }));
  const cache = new Map<string, GeositeList | null>();
  const ctx = (addr?: string): MatchContext => ({
    ip: addr ? ip(addr) : null,
    geosite: (v) => {
      if (!cache.has(v)) {
        const [n, f] = v.split('@');
        cache.set(v, loadGeositeCategory(geo, n!, f));
      }
      return cache.get(v);
    },
    geoip: (a) => countryOf(geoDb.lookup(a).record),
    asn: (a) => asnOf(asnDb.lookup(a).record)?.asn ?? null,
  });

  it('IP-CIDR / IP-CIDR6 match the server address; the longest prefix wins', () => {
    const rules = [rule('IP-CIDR', '17.0.0.0/8', 'en-US'), rule('IP-CIDR', '17.253.0.0/16', 'ja-JP'), rule('IP-CIDR6', '2001:db8::/32', 'de-DE')];
    assert.equal(loc('www.apple.com', rules, ctx('17.253.144.10')), 'ja-JP');
    assert.equal(loc('www.apple.com', rules, ctx('17.1.1.1')), 'en-US');
    assert.equal(loc('v6.example', rules, ctx('2001:db8::5')), 'de-DE');
    assert.equal(loc('www.apple.com', rules), 'SYSTEM', 'unknown address: IP rules do not match');
    assert.equal(loc('17.2.3.4', rules), 'en-US', 'IP-literal hosts need no lookup');
  });

  it('no-resolve rules match only IP-literal hosts', () => {
    const rules = [rule('IP-CIDR', '17.0.0.0/8', 'en-US', { noResolve: true })];
    assert.equal(loc('www.apple.com', rules, ctx('17.1.1.1')), 'SYSTEM');
    assert.equal(loc('17.1.1.1', rules), 'en-US');
  });

  it('GEOIP (database and built-in LAN) and IP-ASN', () => {
    const rules = [rule('GEOIP', 'cn', 'zh-CN'), rule('GEOIP', 'LAN', 'fr-FR'), rule('IP-ASN', 'AS13335', 'en-GB')];
    assert.equal(loc('example.cn', rules, ctx('223.5.5.5')), 'zh-CN');
    assert.equal(loc('intranet.example', rules, ctx('192.168.1.10')), 'fr-FR');
    assert.equal(loc('localhost', rules, ctx('::1')), 'fr-FR');
    assert.equal(loc('blog.example', rules, ctx('104.18.1.1')), 'en-GB');
    assert.equal(loc('example.cn', rules, { ip: ip('223.5.5.5') }), 'SYSTEM', 'no database: GEOIP country rules do not match');
  });

  it('GEOSITE and DOMAIN-REGEX match hostnames', () => {
    const rules = [rule('GEOSITE', 'google', 'en-US'), rule('GEOSITE', 'cn', 'zh-CN'), rule('DOMAIN-REGEX', '^(.+\\.)?example\\.(com|org)$', 'fr-FR')];
    assert.equal(loc('mail.google.com', rules, ctx()), 'en-US');
    assert.equal(loc('www.baidu.com', rules, ctx()), 'zh-CN');
    assert.equal(loc('sub.example.org', rules, ctx()), 'fr-FR');
    assert.equal(loc('example.net', rules, ctx()), 'SYSTEM');
    assert.equal(loc('mail.google.com', rules), 'SYSTEM', 'no geosite data: no match');
  });

  it('precedence: hostname rules beat IP rules; within IP rules CIDR > ASN > GEOIP', () => {
    const rules = [rule('GEOIP', 'US', 'en-US'), rule('IP-ASN', '13335', 'en-GB'), rule('IP-CIDR', '104.16.0.0/12', 'de-DE'), rule('GEOSITE', 'google', 'ja-JP'), rule('DOMAIN-SUFFIX', 'google.com', 'ko-KR')];
    assert.equal(loc('google.com', rules, ctx('17.1.1.1')), 'ko-KR', 'suffix beats geosite beats geoip');
    assert.equal(loc('www.google.com.example', rules, ctx('104.18.1.1')), 'de-DE', 'CIDR beats ASN');
    assert.equal(loc('cdn.example', rules, ctx('17.1.1.1')), 'en-US');
    const r = resolveHost('google.com', settingsOf(rules), ctx('104.18.1.1'));
    assert.deepEqual(r.matches.map((m) => m.type), ['DOMAIN-SUFFIX', 'GEOSITE', 'IP-CIDR', 'IP-ASN']);
    assert.equal(r.ip, '104.18.1.1');
  });

  it('validates values', () => {
    assert.equal(normalizeRuleValue('IP-ASN', 'as13335').value, '13335');
    assert.equal(normalizeRuleValue('GEOIP', 'geoip:cn').value, 'CN');
    assert.equal(normalizeRuleValue('GEOSITE', 'geosite:Apple@CN').value, 'apple@cn');
    assert.equal(normalizeRuleValue('IP-CIDR', '10.1.2.3/8').value, '10.0.0.0/8');
    for (const [t, v] of [['IP-CIDR', '1.2.3.4/40'], ['IP-ASN', 'ASX'], ['GEOIP', 'c'], ['GEOSITE', 'bad name'], ['DOMAIN-REGEX', '(']] as const) {
      assert.ok(normalizeRuleValue(t, v).error, `${t} ${v}`);
    }
  });

  it('reports what the rules need', () => {
    const rules = [rule('GEOSITE', 'google', 'en-US'), rule('GEOIP', 'LAN', 'fr-FR'), rule('IP-CIDR', '1.0.0.0/8', 'en-US', { noResolve: true })];
    assert.deepEqual(requiredDatasets(rules), { geosite: ['google'], geoip: false, asn: false });
    assert.equal(needsServerIp(rules), true, 'GEOIP,LAN still needs the address');
    assert.equal(needsServerIp([rules[2]!]), false);
  });
});

describe('import/export and DNR for the new rule types', () => {
  it('imports Clash-style compact rules with no-resolve and regex commas', () => {
    const r = importConfigText(`
rules:
  - IP-CIDR,192.168.0.0/16,fr-FR,no-resolve
  - IP-CIDR6,2001:db8::/32,de-DE
  - IP-ASN,13335,en-GB
  - GEOIP,CN,zh-CN
  - GEOSITE,google,en-US
  - DOMAIN-REGEX,^a{1,3}\\.example$,ja-JP
  - type: GEOIP
    geoip: lan
    action: SYSTEM
`);
    assert.deepEqual(r.errors, []);
    const rules = r.settings!.rules;
    assert.equal(rules[0]!.noResolve, true);
    assert.equal(rules[5]!.value, '^a{1,3}\\.example$');
    assert.equal(rules[6]!.value, 'LAN');
  });

  it('round-trips through JSON and YAML', () => {
    const r = importConfigText('rules:\n  - IP-CIDR,10.0.0.0/8,fr-FR,no-resolve\n  - IP-ASN,AS13335,en-GB\n  - GEOSITE,apple@cn,zh-CN\n  - DOMAIN-REGEX,^x\\d+$,ja-JP\n').settings!;
    for (const fmt of ['json', 'yaml'] as const) {
      const back = importConfigText(exportConfig(r, fmt)).settings!;
      assert.deepEqual(back.rules.map(({ id: _id, ...x }) => x), r.rules.map(({ id: _id, ...x }) => x), fmt);
    }
  });

  it('DNR mirrors geosite domains, skips IP/regex rules and drops the catch-all when IP rules exist', () => {
    const s = importConfigText('rules:\n  - GEOSITE,google,en-US\n  - IP-CIDR,17.0.0.0/8,ja-JP\n  - DOMAIN-REGEX,^x$,fr-FR\ndefault:\n  mode: PROFILE\n  locale: en-GB\n').settings!;
    const list: GeositeList = { full: new Set(['www.youtube.com']), suffix: new Set(['google.com']), keywords: ['googlevideo'], regexes: [], skipped: 0, size: 3 };
    const out = compileDnrRules(s, { geosite: () => list });
    assert.equal(out.rules.length, 1);
    assert.deepEqual(out.rules[0]!.condition.requestDomains?.sort(), ['google.com', 'www.youtube.com']);
    const reasons = out.skipped.map((x) => x.reason).join('\n');
    assert.match(reasons, /partially/);
    assert.match(reasons, /IP rules need the server address/);
    assert.match(reasons, /Regex rules/);
    assert.match(reasons, /default profile is not mirrored/);
    assert.match(compileDnrRules(s).skipped.map((x) => x.reason).join(), /GeoSite data is not loaded/);
  });
});
