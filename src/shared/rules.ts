// Domain rule engine: DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD with deterministic precedence.
//
// Precedence (first difference wins):
//   1. Rule type: DOMAIN (exact) > DOMAIN-SUFFIX > DOMAIN-KEYWORD.
//   2. DOMAIN-SUFFIX only: more labels (more specific suffix) wins.
//   3. Higher explicit `priority` wins.
//   4. Earlier position in the rule list wins.
// The default action applies only when no enabled rule matches.

import { hostKind, labelCount, matchesSuffix, normalizeDomainInput, toUnicode } from './domain.js';
import { describeProfile, profileKey } from './locale.js';
import type { Resolution, Rule, RuleType, Settings } from './types.js';

const TYPE_RANK: Record<RuleType, number> = { DOMAIN: 0, 'DOMAIN-SUFFIX': 1, 'DOMAIN-KEYWORD': 2 };

/** Host forms precomputed once per lookup. */
export interface HostView {
  ascii: string;
  unicode: string;
  isIp: boolean;
}

export function hostView(asciiHost: string): HostView {
  const ascii = asciiHost.toLowerCase().replace(/\.+$/, '');
  const isIp = hostKind(ascii) !== 'domain';
  return { ascii, unicode: isIp ? ascii : toUnicode(ascii).normalize('NFC').toLowerCase(), isIp };
}

export function isAsciiKeyword(k: string): boolean {
  return /^[\x21-\x7e]+$/.test(k);
}

export function ruleMatches(rule: Rule, host: HostView): boolean {
  switch (rule.type) {
    case 'DOMAIN':
      return host.ascii === rule.value;
    case 'DOMAIN-SUFFIX':
      return !host.isIp && matchesSuffix(host.ascii, rule.value);
    case 'DOMAIN-KEYWORD':
      return isAsciiKeyword(rule.value) ? host.ascii.includes(rule.value) : host.unicode.includes(rule.value);
  }
}

/** Sort key implementing the precedence above; smaller sorts first (wins). */
export function precedenceKey(rule: Rule, index: number): [number, number, number, number] {
  return [TYPE_RANK[rule.type], rule.type === 'DOMAIN-SUFFIX' ? -labelCount(rule.value) : 0, -rule.priority, index];
}

export function comparePrecedence(a: [number, number, number, number], b: [number, number, number, number]): number {
  for (let i = 0; i < 4; i++) {
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
export function resolveHost(host: string | null, settings: Pick<Settings, 'rules' | 'defaultAction'>): Resolution {
  if (!host) {
    return { action: 'SYSTEM', profile: null, source: 'default', rule: null, matches: [], host: null };
  }
  const view = hostView(host);
  const matches = settings.rules
    .map((rule, index) => ({ rule, key: precedenceKey(rule, index) }))
    .filter((x) => x.rule.enabled && ruleMatches(x.rule, view))
    .sort((a, b) => comparePrecedence(a.key, b.key))
    .map((x) => x.rule);
  const best = matches[0];
  if (best) {
    return {
      action: best.action,
      profile: best.action === 'PROFILE' ? best.profile : null,
      source: 'rule',
      rule: best,
      matches,
      host: view.ascii,
    };
  }
  const d = settings.defaultAction;
  return {
    action: d.action,
    profile: d.action === 'PROFILE' ? d.profile : null,
    source: 'default',
    rule: null,
    matches,
    host: view.ascii,
  };
}

export function ruleLabel(rule: Rule): string {
  const value = rule.type === 'DOMAIN-KEYWORD' ? rule.value : displayDomain(rule.value);
  return `${rule.type},${value}`;
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
  if (type === 'DOMAIN-KEYWORD') {
    const k = input.trim().normalize('NFC').toLowerCase();
    if (!k) return { value: null, notes: [], error: 'Keyword is empty.' };
    if (/[\s/\\?#@:]/.test(k)) return { value: null, notes: [], error: 'Keywords cannot contain spaces or URL delimiters (/ \\ ? # @ :).' };
    const notes = isAsciiKeyword(k) ? [] : ['Non-ASCII keyword: matched against the Unicode form of IDN hostnames.'];
    return { value: k, notes };
  }
  const r = normalizeDomainInput(input, { suffix: type === 'DOMAIN-SUFFIX' });
  if (!r.host) return { value: null, notes: r.notes, error: r.error ?? 'Invalid domain.' };
  return { value: r.host.ascii, notes: r.notes };
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

  // Same type + value.
  const groups = new Map<string, Rule[]>();
  for (const r of enabled) {
    const k = `${r.type}\u0000${r.value}`;
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
        ? `Duplicate rules for ${ruleLabel(group[0]!)}; only one is needed.`
        : `Conflicting rules for ${ruleLabel(group[0]!)}: ${group.map((r) => describeAction(r)).join(' vs ')}. ${winner ? `"${describeAction(winner)}" wins (priority, then list order).` : ''}`,
    });
  }

  // Rules that change nothing: removing them yields the same result for their own domain.
  for (const r of enabled) {
    if (r.type === 'DOMAIN-KEYWORD') continue;
    if ((groups.get(`${r.type}\u0000${r.value}`)?.length ?? 0) > 1) continue;
    const without = { ...settings, rules: settings.rules.filter((x) => x.id !== r.id) };
    const res = resolveHost(r.value, without);
    if (res.action === r.action && profileKey(res.profile) === profileKey(r.profile)) {
      issues.push({
        level: 'info',
        ruleIds: [r.id],
        message:
          r.action === 'SYSTEM' && !res.rule
            ? `${ruleLabel(r)} → SYSTEM has no effect: the default action is already SYSTEM and no broader rule matches.`
            : `${ruleLabel(r)} is redundant: ${res.rule ? ruleLabel(res.rule) : 'the default action'} already gives ${describeAction(r)}.`,
      });
    }
  }

  for (const r of enabled) {
    if (r.type === 'DOMAIN-SUFFIX' && !r.value.includes('.')) {
      issues.push({ level: 'warning', ruleIds: [r.id], message: `${ruleLabel(r)} matches every site under ".${r.value}".` });
    }
    if (r.type === 'DOMAIN-KEYWORD' && r.value.length <= 2) {
      issues.push({ level: 'warning', ruleIds: [r.id], message: `Keyword "${r.value}" is very short and will match many unrelated sites.` });
    }
    if (r.action === 'PROFILE' && !r.profile) {
      issues.push({ level: 'error', ruleIds: [r.id], message: `${ruleLabel(r)} has no locale profile.` });
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
