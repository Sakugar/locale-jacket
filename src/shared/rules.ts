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
import { analysisBudget, regexHazard, type AnalysisBudget } from './regex-safety.js';
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

/**
 * Regex sources the current check (regexHazard) has accepted: in this worker (every
 * DOMAIN-REGEX value that normalizeRuleValue accepts is added), or in stored subscription
 * data that records it was checked by the current REGEX_CHECK_VERSION (see
 * subscriptions.ts trustCheckedSubscriptionData). compiledRegex runs the check itself for
 * every other source, so a stored pattern is never compiled unchecked.
 */
const validatedRegexes = new Set<string>();
const MAX_VALIDATED_REGEXES = 50_000;

export function markRegexValidated(src: string): void {
  if (validatedRegexes.size >= MAX_VALIDATED_REGEXES) validatedRegexes.clear();
  validatedRegexes.add(src);
}

/**
 * Analysis time that the checks compiledRegex runs while a navigation waits share, in one
 * worker's life. Once it is spent, unchecked patterns count as no match until
 * precompileRegexes (which runs between other events) has checked them.
 */
export const NAVIGATION_REGEX_BUDGET_MS = 50;
let navigationBudget = analysisBudget(NAVIGATION_REGEX_BUDGET_MS);

/** Gives navigation-time checks a new budget (for tests and benchmarks). */
export function resetNavigationRegexBudget(ms = NAVIGATION_REGEX_BUDGET_MS): void {
  navigationBudget = analysisBudget(ms);
}

/** Why the check refused a stored pattern, by source (see refusedRegexes). */
const regexRefusals = new Map<string, string>();

/** Set when compiledRegex left a pattern unchecked: the result then must not be cached. */
let regexDeferred = false;

/**
 * Null when the pattern is invalid or could backtrack for too long (rules saved before the
 * check); undefined when it still needs the check and `budget` is spent (no match for now).
 * Navigation-time lookups use the shared navigationBudget; precompileRegexes passes null
 * (each pattern then has only its own limit).
 */
function compiledRegex(src: string, budget: AnalysisBudget | null = navigationBudget): RegExp | null | undefined {
  let re = regexCache.get(src);
  if (re === undefined) {
    try {
      if (validatedRegexes.has(src)) re = new RegExp(src, 'i');
      else {
        const hazard = regexHazard(src, budget ?? undefined);
        // `!(x > 0)` also catches NaN. A refusal once the budget is spent may mean "not checked".
        if (hazard && budget && !(budget.remaining > 0)) {
          regexDeferred = true;
          return undefined;
        }
        if (hazard) regexRefusals.set(src, hazard);
        re = hazard ? null : new RegExp(src, 'i');
      }
    } catch {
      re = null;
    }
    regexCache.set(src, re);
  }
  return re;
}

/**
 * Enabled DOMAIN-REGEX rules whose pattern the matcher's own check refused (they never
 * match), with the reason. Stored rules the settings budget left unchecked are only found
 * here, once precompileRegexes or a navigation has checked them.
 */
export function refusedRegexes(rules: readonly Rule[]): { rule: Rule; index: number; reason: string }[] {
  const out: { rule: Rule; index: number; reason: string }[] = [];
  rules.forEach((rule, index) => {
    if (!rule.enabled || rule.type !== 'DOMAIN-REGEX') return;
    const reason = regexRefusals.get(rule.value);
    if (reason !== undefined) out.push({ rule, index, reason });
  });
  return out;
}

/** DOMAIN-REGEX sources of enabled rules that have not been checked and compiled yet. */
export function uncompiledRegexes(rules: readonly Rule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) if (r.enabled && r.type === 'DOMAIN-REGEX' && !regexCache.has(r.value)) out.add(r.value);
  return [...out];
}

/**
 * Check and compile the given regex sources ahead of time, in slices of about `sliceMs`
 * with `pause()` in between, so stored patterns that still need the check (data saved
 * before the current REGEX_CHECK_VERSION) are not checked on the first navigation. It also
 * checks the patterns navigations left unchecked once NAVIGATION_REGEX_BUDGET_MS was spent.
 */
export async function precompileRegexes(sources: readonly string[], pause: () => Promise<void>, sliceMs = 8, now: () => number = () => performance.now()): Promise<void> {
  let i = 0;
  while (i < sources.length) {
    const end = now() + sliceMs;
    do compiledRegex(sources[i++]!, null);
    while (i < sources.length && now() < end);
    if (i < sources.length) await pause();
  }
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

// ---------------------------------------------------------------------------
// Rule index: built once per rules array (rules arrays are replaced, never changed in
// place; a changed length rebuilds it anyway). DOMAIN and DOMAIN-SUFFIX rules are found
// by lookups on the host and its parent domains; DOMAIN-KEYWORD rules, and DOMAIN-REGEX
// rules with a known required piece of text, by the first three characters of that text
// at each position of the host. Only the rest is scanned, every candidate is confirmed
// with ruleMatches, and precedence keys are computed only for rules that match.

interface RuleIndex {
  rules: readonly Rule[];
  length: number;
  /** DOMAIN value → positions of enabled DOMAIN rules. */
  domain: Map<string, number[]>;
  /** DOMAIN-SUFFIX value → positions of enabled DOMAIN-SUFFIX rules. */
  suffix: Map<string, number[]>;
  /** First 3 characters of a keyword (or of a regex's required text) → positions. */
  grams: Map<string, number[]>;
  /** The keyword or required text of each position in `grams`. */
  needles: Map<number, string>;
  /** Enabled DOMAIN-KEYWORD and DOMAIN-REGEX rules without a needle of 3+ characters. */
  hostScan: number[];
  /** Enabled GEOSITE and IP rules (depend on the match context). */
  ctxScan: number[];
  /** Precedence keys, computed on first use. */
  keys: (PrecedenceKey | undefined)[];
  /** Host → its hostname-only matches (DOMAIN, DOMAIN-SUFFIX, KEYWORD, REGEX), best first. */
  hostMatches: Map<string, number[]>;
}

const GRAM = 3;
const MAX_CACHED_HOSTS = 256;
const ruleIndexes = new WeakMap<readonly Rule[], RuleIndex>();

function addTo(map: Map<string, number[]>, key: string, i: number): void {
  const list = map.get(key);
  if (list) list.push(i);
  else map.set(key, [i]);
}

function ruleIndex(rules: readonly Rule[]): RuleIndex {
  const known = ruleIndexes.get(rules);
  if (known && known.length === rules.length) return known;
  const ix: RuleIndex = {
    rules,
    length: rules.length,
    domain: new Map(),
    suffix: new Map(),
    grams: new Map(),
    needles: new Map(),
    hostScan: [],
    ctxScan: [],
    keys: [],
    hostMatches: new Map(),
  };
  rules.forEach((r, i) => {
    if (!r.enabled) return;
    if (r.type === 'DOMAIN') addTo(ix.domain, r.value, i);
    else if (r.type === 'DOMAIN-SUFFIX') addTo(ix.suffix, r.value, i);
    else if (r.type === 'DOMAIN-KEYWORD' || r.type === 'DOMAIN-REGEX') {
      const needle = r.type === 'DOMAIN-KEYWORD' ? r.value : requiredLiteral(r.value);
      if (needle.length >= GRAM) {
        addTo(ix.grams, needle.slice(0, GRAM), i);
        ix.needles.set(i, needle);
      } else ix.hostScan.push(i);
    } else ix.ctxScan.push(i);
  });
  ruleIndexes.set(rules, ix);
  return ix;
}

function keyOf(ix: RuleIndex, i: number): PrecedenceKey {
  return (ix.keys[i] ??= precedenceKey(ix.rules[i]!, i));
}

function byPrecedence(ix: RuleIndex): (a: number, b: number) => number {
  return (a, b) => comparePrecedence(keyOf(ix, a), keyOf(ix, b));
}

/**
 * Positions of hostname rules that may match (a superset; ruleMatches decides): DOMAIN and
 * DOMAIN-SUFFIX lookups, keywords and regex texts found in the host, and the rest of the
 * KEYWORD / REGEX rules.
 */
function hostCandidates(ix: RuleIndex, view: HostView): number[] {
  const out: number[] = [];
  const exact = ix.domain.get(view.ascii);
  if (exact) out.push(...exact);
  if (!view.isIp && ix.suffix.size) {
    // A suffix matches the host itself or the part after any of its dots.
    for (let h = view.ascii; ; ) {
      const list = ix.suffix.get(h);
      if (list) out.push(...list);
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
  }
  if (ix.grams.size) {
    // ruleMatches tests keywords and regexes on the ASCII and the Unicode form.
    const found = new Set<number>();
    const scan = (s: string) => {
      for (let p = 0; p + GRAM <= s.length; p++) {
        const list = ix.grams.get(s.slice(p, p + GRAM));
        if (list) for (const i of list) if (s.startsWith(ix.needles.get(i)!, p)) found.add(i);
      }
    };
    scan(view.ascii);
    if (view.unicode !== view.ascii) scan(view.unicode);
    out.push(...found);
  }
  out.push(...ix.hostScan);
  return out;
}

function hostOnlyMatches(ix: RuleIndex, host: string, view: HostView): number[] {
  const cached = ix.hostMatches.get(host);
  if (cached) return cached;
  regexDeferred = false;
  const out = hostCandidates(ix, view)
    .filter((i) => ruleMatches(ix.rules[i]!, view))
    .sort(byPrecedence(ix));
  // A regex left unchecked counted as no match for now: not remembered for this host.
  if (regexDeferred) return out;
  if (ix.hostMatches.size >= MAX_CACHED_HOSTS) ix.hostMatches.clear();
  ix.hostMatches.set(host, out);
  return out;
}

/** The winning enabled rule for a host, skipping rules for which `skip` is true; -1 when none matches. */
function bestMatch(ix: RuleIndex, view: HostView, ctx: MatchContext, skip: (r: Rule) => boolean): number {
  let best = -1;
  for (const list of [hostCandidates(ix, view), ix.ctxScan]) {
    for (const i of list) {
      const r = ix.rules[i]!;
      if (skip(r) || !ruleMatches(r, view, ctx)) continue;
      if (best < 0 || comparePrecedence(keyOf(ix, i), keyOf(ix, best)) < 0) best = i;
    }
  }
  return best;
}

/**
 * Text that every match of the pattern contains, in lowercase, or '' if none is known.
 * Deliberately conservative: only ASCII letters, digits, `_`, `-` and escaped punctuation
 * in the top-level sequence count, and only when no quantifier follows them; groups,
 * classes, other escapes and anchors end the text, and a top-level `|` gives up. (With the
 * `i` flag and without `u`, ASCII letters only ever match ASCII letters.)
 */
export function requiredLiteral(src: string): string {
  let best = '';
  let run = '';
  const end = () => {
    if (run.length > best.length) best = run;
    run = '';
  };
  const quantified = (j: number) => j < src.length && '?*+{'.includes(src[j]!);
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inClass) {
      if (c === '\\') i++;
      else if (c === ']') inClass = false;
      continue;
    }
    if (c === '\\') {
      const n = src[i + 1];
      i++;
      if (n !== undefined && '.-/\\^$*+?()[]{}|'.includes(n)) {
        if (depth === 0) {
          if (quantified(i + 1)) end();
          else run += n;
        }
      } else {
        // \d, \b, \x41, A, \cX, \1, \k<n>…: skip the escape and whatever may belong to it.
        if (depth === 0) end();
        while (i + 1 < src.length && /[\w{}<>,]/.test(src[i + 1]!)) i++;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      if (depth === 0) end();
      continue;
    }
    if (c === '(') {
      if (depth === 0) end();
      depth++;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;
    if (c === '|') return '';
    if (/[A-Za-z0-9_-]/.test(c)) {
      if (quantified(i + 1)) end();
      else run += c.toLowerCase();
      continue;
    }
    end();
    // A {n,m} quantifier: its digits are not text.
    if (c === '{') while (i + 1 < src.length && /[\d,}]/.test(src[i + 1]!)) i++;
  }
  end();
  return best;
}

/** Resolve the effective action for a hostname (ASCII form). `host` null means "not a web page". */
export function resolveHost(host: string | null, settings: Pick<Settings, 'rules' | 'defaultAction'>, ctx: MatchContext = {}): Resolution {
  if (!host) {
    return { action: 'SYSTEM', profile: null, source: 'default', rule: null, matches: [], host: null, ip: null };
  }
  const view = hostView(host);
  const ix = ruleIndex(settings.rules);
  const hostMatches = hostOnlyMatches(ix, host, view);
  // GEOSITE and IP rules depend on the data sets and the server address: never cached.
  const ctxMatches = ix.ctxScan.length ? ix.ctxScan.filter((i) => ruleMatches(ix.rules[i]!, view, ctx)) : [];
  const order = ctxMatches.length ? [...hostMatches, ...ctxMatches].sort(byPrecedence(ix)) : hostMatches;
  const matches = order.map((i) => ix.rules[i]!);
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

/**
 * Analysis time for one batch of regular expressions (one subscription file, one settings
 * load, one GeoSite category): a hostile list cannot hold the worker for longer. Patterns
 * left over when it is spent are refused like any other unsafe pattern.
 */
export const REGEX_BATCH_BUDGET_MS = 750;

/**
 * How a batch of values checks regular expressions. `budget` is shared by the batch (see
 * REGEX_BATCH_BUDGET_MS); without one, each pattern has only its own limit. With `defer`,
 * a pattern that the spent budget leaves unchecked is accepted without being marked as
 * checked, so compiledRegex checks it before it is first used (stored settings: a big rule
 * list is never thrown away because the batch ran out of time).
 */
export interface RegexCheck {
  budget: AnalysisBudget;
  defer?: boolean;
}

export function normalizeRuleValue(type: RuleType, input: string, check?: RegexCheck): RuleValueResult {
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
      // `!(x > 0)` also catches NaN.
      const spent = () => !!check && !(check.budget.remaining > 0);
      let deferred = !!check?.defer && spent();
      let hazard = deferred ? null : regexHazard(raw, check?.budget);
      // A refusal once the budget is spent may mean "not checked": with defer, compiledRegex decides later.
      if (hazard && check?.defer && spent()) {
        hazard = null;
        deferred = true;
      }
      if (hazard) {
        return { value: null, notes: [], error: `This regular expression could take too long to match (${hazard}). Use a simpler pattern, e.g. ^(.+\\.)?example\\.com$, or a DOMAIN-SUFFIX rule.` };
      }
      if (!deferred) markRegexValidated(raw);
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
    const group = groups.get(k);
    if (group) group.push(r);
    else groups.set(k, [r]);
  }
  let positions: Map<Rule, number> | null = null;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    positions ??= firstPositions(settings.rules);
    const winner = resolveAmong(group, positions);
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
  const ix = ruleIndex(settings.rules);
  for (const r of enabled) {
    if (r.type !== 'DOMAIN' && r.type !== 'DOMAIN-SUFFIX') continue;
    if ((groups.get(`${r.type}\u0000${r.value}\u00000`)?.length ?? 0) > 1) continue;
    // The result for its own domain without it (every rule with its id left out).
    const i = bestMatch(ix, hostView(r.value), {}, (x) => x.id === r.id);
    const winner = i >= 0 ? settings.rules[i]! : null;
    const d = settings.defaultAction;
    const res = winner
      ? { action: winner.action, profile: winner.action === 'PROFILE' ? winner.profile : null, rule: winner }
      : { action: d.action, profile: d.action === 'PROFILE' ? d.profile : null, rule: null };
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

/** Each rule object's first position in the list (what indexOf would return). */
function firstPositions(all: readonly Rule[]): Map<Rule, number> {
  const out = new Map<Rule, number>();
  all.forEach((r, i) => {
    if (!out.has(r)) out.set(r, i);
  });
  return out;
}

function resolveAmong(group: Rule[], positions: Map<Rule, number>): Rule | undefined {
  return group
    .map((rule) => ({ rule, key: precedenceKey(rule, positions.get(rule) ?? -1) }))
    .sort((a, b) => comparePrecedence(a.key, b.key))[0]?.rule;
}

export function newRuleId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
