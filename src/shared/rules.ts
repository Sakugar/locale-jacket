// Rule engine with deterministic precedence.
//
// Hostname rules:  DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, DOMAIN-REGEX, GEOSITE
// IP rules:        IP-CIDR, IP-CIDR6, IP-ASN, GEOIP  (need the server address; see MatchContext)
//
// "Special" rules: GEOSITE and the IP rules (they rely on a data set or the server address).
//
// Precedence (first difference wins):
//   0. Tier: your own rules › subscription rules › your own special rules › subscription
//      special rules. Within the subscription tiers, an earlier subscription wins.
//   1. Rule type: DOMAIN > DOMAIN-SUFFIX > DOMAIN-KEYWORD > DOMAIN-REGEX > GEOSITE
//                 > IP-CIDR/IP-CIDR6 > IP-ASN > GEOIP.
//      Hostname rules beat IP rules because the hostname is always known, the address is not.
//   2. Specificity within a type: DOMAIN-SUFFIX with more labels, IP-CIDR with a longer prefix.
//   3. Higher explicit `priority`.
//   4. Earlier position in the rule list.
// The default action applies only when no enabled rule matches.

import { hostKind, labelCount, matchesSuffix, normalizeDomainInput, toUnicode } from './domain.js';
import { geositeMatches, type GeositeList } from './geosite.js';
import { cidrContains, formatCidr, formatIp, isLanIp, parseCidr, parseIp, type Cidr, type IpAddr } from './ip.js';
import { t } from './i18n.js';
import { describeProfile, profileKey } from './locale.js';
import { regexHazard } from './regex-safety.js';
import type { Resolution, Rule, RuleType, Settings } from './types.js';
import { isIpRuleType, isSpecialRuleType } from './types.js';

const TYPE_RANK: Record<RuleType, number> = {
  DOMAIN: 0,
  'DOMAIN-SUFFIX': 1,
  'DOMAIN-KEYWORD': 2,
  'DOMAIN-REGEX': 3,
  GEOSITE: 4,
  'IP-CIDR': 5,
  'IP-CIDR6': 5,
  'IP-ASN': 6,
  GEOIP: 7,
};

/**
 * Optional inputs for GEOSITE and IP rules. Functions return `undefined` when the needed
 * dataset is not available (the rule then simply does not match).
 */
export interface MatchContext {
  /** Server address for the host (from connections Chrome made), if known. */
  ip?: IpAddr | null;
  geosite?: (category: string) => GeositeList | null | undefined;
  geoip?: (ip: IpAddr) => string | null | undefined;
  asn?: (ip: IpAddr) => number | null | undefined;
}

/** Host forms precomputed once per lookup. */
export interface HostView {
  ascii: string;
  unicode: string;
  isIp: boolean;
  /** The host itself when it is an IP literal. */
  literal: IpAddr | null;
}

export function hostView(asciiHost: string): HostView {
  const ascii = asciiHost.toLowerCase().replace(/\.+$/, '');
  const isIp = hostKind(ascii) !== 'domain';
  return {
    ascii,
    unicode: isIp ? ascii : toUnicode(ascii).normalize('NFC').toLowerCase(),
    isIp,
    literal: isIp ? parseIp(ascii) : null,
  };
}

export function isAsciiKeyword(k: string): boolean {
  return /^[\x21-\x7e]+$/.test(k);
}

const regexCache = new Map<string, RegExp | null>();
/** Null when the pattern is invalid or could backtrack for too long (rules saved before the check). */
function compiledRegex(src: string): RegExp | null {
  if (!regexCache.has(src)) {
    try {
      regexCache.set(src, regexHazard(src) ? null : new RegExp(src, 'i'));
    } catch {
      regexCache.set(src, null);
    }
  }
  return regexCache.get(src)!;
}

const cidrCache = new Map<string, Cidr | null>();
function compiledCidr(src: string): Cidr | null {
  if (!cidrCache.has(src)) cidrCache.set(src, parseCidr(src));
  return cidrCache.get(src)!;
}

/** The address an IP rule is evaluated against: the literal host, or (unless no-resolve) the server IP. */
function addressFor(rule: Rule, host: HostView, ctx: MatchContext): IpAddr | null {
  if (host.literal) return host.literal;
  return rule.noResolve ? null : (ctx.ip ?? null);
}

export function ruleMatches(rule: Rule, host: HostView, ctx: MatchContext = {}): boolean {
  switch (rule.type) {
    case 'DOMAIN':
      return host.ascii === rule.value;
    case 'DOMAIN-SUFFIX':
      return !host.isIp && matchesSuffix(host.ascii, rule.value);
    case 'DOMAIN-KEYWORD':
      return isAsciiKeyword(rule.value) ? host.ascii.includes(rule.value) : host.unicode.includes(rule.value);
    case 'DOMAIN-REGEX': {
      const re = compiledRegex(rule.value);
      return !!re && (re.test(host.ascii) || (host.unicode !== host.ascii && re.test(host.unicode)));
    }
    case 'GEOSITE': {
      if (host.isIp) return false;
      const list = ctx.geosite?.(rule.value);
      return !!list && geositeMatches(list, host.ascii);
    }
    case 'IP-CIDR':
    case 'IP-CIDR6': {
      const ip = addressFor(rule, host, ctx);
      const c = compiledCidr(rule.value);
      return !!ip && !!c && cidrContains(c, ip);
    }
    case 'IP-ASN': {
      const ip = addressFor(rule, host, ctx);
      if (!ip) return false;
      const asn = ctx.asn?.(ip);
      return typeof asn === 'number' && String(asn) === rule.value;
    }
    case 'GEOIP': {
      const ip = addressFor(rule, host, ctx);
      if (!ip) return false;
      if (rule.value === 'LAN') return isLanIp(ip);
      const country = ctx.geoip?.(ip);
      return typeof country === 'string' && country.toUpperCase() === rule.value;
    }
  }
}

function specificity(rule: Rule): number {
  if (rule.type === 'DOMAIN-SUFFIX') return labelCount(rule.value);
  if (rule.type === 'IP-CIDR' || rule.type === 'IP-CIDR6') {
    const c = compiledCidr(rule.value);
    // Compare IPv4 and IPv6 prefixes on the same 128-bit scale.
    return c ? (c.family === 4 ? c.prefix + 96 : c.prefix) : 0;
  }
  return 0;
}

type PrecedenceKey = [number, number, number, number, number, number];

/** 0 your rules, 1 subscription rules, 2 your special rules, 3 subscription special rules. */
export function precedenceTier(rule: Rule): number {
  return (isSpecialRuleType(rule.type) ? 2 : 0) + (rule.origin ? 1 : 0);
}

/** Sort key implementing the precedence above; smaller sorts first (wins). */
export function precedenceKey(rule: Rule, index: number): PrecedenceKey {
  return [precedenceTier(rule), rule.origin?.layer ?? 0, TYPE_RANK[rule.type], -specificity(rule), -rule.priority, index];
}

export function comparePrecedence(a: PrecedenceKey, b: PrecedenceKey): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** All enabled rules in global precedence order (used for DNR priorities and display). */
export function rulesInPrecedenceOrder(rules: Rule[]): Rule[] {
  return rules
    .map((rule, index) => ({ rule, key: precedenceKey(rule, index) }))
    .filter((x) => x.rule.enabled)
    .sort((a, b) => comparePrecedence(a.key, b.key))
    .map((x) => x.rule);
}

/** Resolve the effective action for a hostname (ASCII form). `host` null means "not a web page". */
export function resolveHost(host: string | null, settings: Pick<Settings, 'rules' | 'defaultAction'>, ctx: MatchContext = {}): Resolution {
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

/** True if any enabled rule needs the server address. */
export function needsServerIp(rules: Rule[]): boolean {
  return rules.some((r) => r.enabled && isIpRuleType(r.type) && !r.noResolve);
}

/** Datasets referenced by enabled rules. */
export function requiredDatasets(rules: Rule[]): { geosite: string[]; geoip: boolean; asn: boolean } {
  const enabled = rules.filter((r) => r.enabled);
  return {
    geosite: [...new Set(enabled.filter((r) => r.type === 'GEOSITE').map((r) => r.value))],
    geoip: enabled.some((r) => r.type === 'GEOIP' && r.value !== 'LAN'),
    asn: enabled.some((r) => r.type === 'IP-ASN'),
  };
}

export function ruleLabel(rule: Rule): string {
  const value = rule.type === 'DOMAIN' || rule.type === 'DOMAIN-SUFFIX' ? displayDomain(rule.value) : rule.value;
  const label = `${rule.type},${value}${rule.noResolve && isIpRuleType(rule.type) ? ',no-resolve' : ''}`;
  return rule.origin ? `${label} · ${rule.origin.name}` : label;
}

export function displayDomain(ascii: string): string {
  const u = toUnicode(ascii);
  return u === ascii ? ascii : `${u} (${ascii})`;
}

export function describeAction(rule: Pick<Rule, 'action' | 'profile'>): string {
  return rule.action === 'SYSTEM' ? 'SYSTEM' : describeProfile(rule.profile);
}

// ---------------------------------------------------------------------------
// Value normalization for rule editors and importers.

export interface RuleValueResult {
  value: string | null;
  notes: string[];
  error?: string;
}

export function normalizeRuleValue(type: RuleType, input: string): RuleValueResult {
  const raw = input.trim();
  switch (type) {
    case 'DOMAIN-KEYWORD': {
      const k = raw.normalize('NFC').toLowerCase();
      if (!k) return { value: null, notes: [], error: 'Keyword is empty.' };
      // A hostname has at most 253 characters, so a longer keyword can never match (and
      // would make a needlessly large DNR regex).
      if (k.length > 253) return { value: null, notes: [], error: `Keyword is too long (${k.length} characters; a hostname has at most 253).` };
      if (/[\s/\\?#@:]/.test(k)) return { value: null, notes: [], error: 'Keywords cannot contain spaces or URL delimiters (/ \\ ? # @ :).' };
      const notes = isAsciiKeyword(k) ? [] : ['Non-ASCII keyword: matched against the Unicode form of IDN hostnames.'];
      return { value: k, notes };
    }
    case 'DOMAIN-REGEX': {
      if (!raw) return { value: null, notes: [], error: 'Regular expression is empty.' };
      try {
        new RegExp(raw, 'i');
      } catch (e) {
        return { value: null, notes: [], error: `Invalid regular expression: ${(e as Error).message}` };
      }
      const hazard = regexHazard(raw);
      if (hazard) {
        return { value: null, notes: [], error: `This regular expression could take too long to match (${hazard}). Use a simpler pattern, e.g. ^(.+\\.)?example\\.com$, or a DOMAIN-SUFFIX rule.` };
      }
      const notes = ['Matched case-insensitively against the hostname only (e.g. ^(.+\\.)?example\\.com$).'];
      if (!/^\^/.test(raw) || !/\$$/.test(raw)) notes.push('Tip: anchor it with ^ and $ so it cannot match unrelated hosts.');
      return { value: raw, notes };
    }
    case 'GEOSITE': {
      const v = raw.toLowerCase().replace(/^geosite:/, '');
      if (!/^[a-z0-9][a-z0-9_.!-]*(@!?[a-z0-9_-]+)?$/.test(v)) {
        return { value: null, notes: [], error: 'Use a geosite category such as google, cn, apple@cn or geolocation-!cn.' };
      }
      return { value: v, notes: [] };
    }
    case 'IP-CIDR':
    case 'IP-CIDR6': {
      const c = parseCidr(raw);
      if (!c) return { value: null, notes: [], error: `"${raw}" is not a valid ${type === 'IP-CIDR' ? 'IPv4' : 'IPv6'} CIDR (e.g. ${type === 'IP-CIDR' ? '1.2.3.0/24' : '2001:db8::/32'}).` };
      const notes: string[] = [];
      if (type === 'IP-CIDR' && c.family === 6) notes.push('IPv6 range in an IP-CIDR rule; IP-CIDR6 is the conventional type.');
      if (type === 'IP-CIDR6' && c.family === 4) notes.push('IPv4 range in an IP-CIDR6 rule; IP-CIDR is the conventional type.');
      const value = formatCidr(c);
      if (value !== raw) notes.push(`Normalized to ${value}.`);
      return { value, notes };
    }
    case 'IP-ASN': {
      const m = /^(?:AS)?(\d{1,10})$/i.exec(raw);
      const n = m ? Number(m[1]) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 4294967295) return { value: null, notes: [], error: 'Use an AS number such as 13335 or AS13335.' };
      return { value: String(n), notes: [] };
    }
    case 'GEOIP': {
      const v = raw.toUpperCase().replace(/^GEOIP:/, '');
      if (!/^[A-Z0-9_-]{2,32}$/.test(v)) return { value: null, notes: [], error: 'Use a country code (US, CN, JP), LAN, or a special code your database provides (e.g. GOOGLE).' };
      return { value: v, notes: v === 'LAN' ? ['LAN covers private, loopback and link-local addresses and needs no database.'] : [] };
    }
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX': {
      const r = normalizeDomainInput(raw, { suffix: type === 'DOMAIN-SUFFIX' });
      if (!r.host) return { value: null, notes: r.notes, error: r.error ?? 'Invalid domain.' };
      return { value: r.host.ascii, notes: r.notes };
    }
  }
}

// ---------------------------------------------------------------------------
// Static analysis: duplicates, conflicts and redundant rules.

export type IssueLevel = 'error' | 'warning' | 'info';

export interface RuleIssue {
  level: IssueLevel;
  ruleIds: string[];
  message: string;
}

export function analyzeRules(settings: Pick<Settings, 'rules' | 'defaultAction'>): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const enabled = settings.rules.filter((r) => r.enabled);

  // Same type + value (+ no-resolve).
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

  // Rules that change nothing: removing them yields the same result for their own domain.
  for (const r of enabled) {
    if (r.type !== 'DOMAIN' && r.type !== 'DOMAIN-SUFFIX') continue;
    if ((groups.get(`${r.type}\u0000${r.value}\u00000`)?.length ?? 0) > 1) continue;
    const without = { ...settings, rules: settings.rules.filter((x) => x.id !== r.id) };
    const res = resolveHost(r.value, without);
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
    if ((r.type === 'IP-CIDR' || r.type === 'IP-CIDR6') && compiledCidr(r.value)?.prefix === 0) {
      issues.push({ level: 'warning', ruleIds: [r.id], message: t('check.allAddresses', { rule: ruleLabel(r) }) });
    }
    if (r.action === 'PROFILE' && !r.profile) {
      issues.push({ level: 'error', ruleIds: [r.id], message: t('check.noProfile', { rule: ruleLabel(r) }) });
    }
  }
  return issues;
}

function effectKey(r: Rule): string {
  return r.action === 'SYSTEM' ? 'SYSTEM' : profileKey(r.profile);
}

function resolveAmong(group: Rule[], all: Rule[]): Rule | undefined {
  return group
    .map((rule) => ({ rule, key: precedenceKey(rule, all.indexOf(rule)) }))
    .sort((a, b) => comparePrecedence(a.key, b.key))[0]?.rule;
}

export function newRuleId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
