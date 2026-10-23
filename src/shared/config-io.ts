// Import/export of the user-facing configuration format (JSON or YAML).
//
// Accepted rule shapes:
//   - { type: DOMAIN-SUFFIX, domain: google.com, locale: en-US }
//   - { type: DOMAIN, domain: accounts.google.com, action: SYSTEM }     (DIRECT is an alias of SYSTEM)
//   - { type: DOMAIN-KEYWORD, keyword: microsoft, profile: { locale: en-GB, timezone: Europe/London } }
//   - "DOMAIN-SUFFIX,google.com,en-US"   (Clash-style compact strings; "MATCH,<locale|SYSTEM>" sets the default)
// Profile fields may be given inline on the rule or under `profile:`.

import { isUiLanguagePref, UI_LANGUAGES } from './i18n.js';
import { normalizeProfile } from './locale.js';
import { DEFAULT_OPTIONS } from './presets.js';
import { newRuleId, normalizeRuleValue } from './rules.js';
import { MAX_UPDATE_GAP_HOURS, MIN_UPDATE_GAP_HOURS } from './dataset-schedule.js';
import { isHttpUrl } from './extension-update.js';
import type { DatasetUpdateOptions, ExtensionUpdateOptions, DefaultAction, LocaleProfile, Options, Rule, RuleType, Settings } from './types.js';
import { isIpRuleType, RULE_TYPES } from './types.js';
import { parseYaml, stringifyYaml, YamlError, type YamlValue } from './yaml.js';

export interface ImportResult {
  settings: Settings | null;
  errors: string[];
  warnings: string[];
}

const SYSTEM_WORDS = new Set(['SYSTEM', 'DIRECT', 'NONE', 'OFF']);
const PROFILE_WORDS = new Set(['PROFILE', 'SPOOF', 'LOCALE']);
const PROFILE_KEYS = ['locale', 'languages', 'acceptLanguage', 'timezone', 'geolocation'] as const;

/** Parse JSON or YAML text. JSON is tried first; anything else is parsed as YAML. */
export function parseConfigText(text: string): { value: unknown; error?: string } {
  const t = text.trim();
  if (!t) return { value: null, error: 'The configuration is empty.' };
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { value: JSON.parse(t) };
    } catch (e) {
      // Flow-style YAML also starts with "{"; fall through and report the YAML error if both fail.
      try {
        return { value: parseYaml(t) };
      } catch {
        return { value: null, error: `Invalid JSON: ${(e as Error).message}` };
      }
    }
  }
  try {
    return { value: parseYaml(t) };
  } catch (e) {
    return { value: null, error: e instanceof YamlError ? e.message : `Invalid YAML: ${(e as Error).message}` };
  }
}

export function importConfigText(text: string, base?: Settings): ImportResult {
  const parsed = parseConfigText(text);
  if (parsed.error) return { settings: null, errors: [parsed.error], warnings: [] };
  return importConfigObject(parsed.value, base);
}

/**
 * Convert a parsed configuration object into validated Settings.
 * Missing top-level sections fall back to `base` (or defaults).
 */
export function importConfigObject(raw: unknown, base?: Settings): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const obj: Record<string, unknown> = Array.isArray(raw) ? { rules: raw } : isRecord(raw) ? raw : {};
  if (!Array.isArray(raw) && !isRecord(raw)) {
    return { settings: null, errors: ['The configuration must be an object with a "rules" list.'], warnings };
  }

  const rules: Rule[] = [];
  let defaultAction: DefaultAction | null = null;
  const rawRules = obj.rules ?? [];
  if (!Array.isArray(rawRules)) {
    errors.push('"rules" must be a list.');
  } else {
    rawRules.forEach((r, i) => {
      const where = `rules[${i}]`;
      if (typeof r === 'string') {
        const res = parseCompactRule(r, where);
        if (res.error) errors.push(res.error);
        warnings.push(...res.warnings);
        if (res.rule) rules.push(res.rule);
        if (res.defaultAction) {
          if (defaultAction) warnings.push(`${where}: more than one MATCH/FINAL rule; the last one wins.`);
          defaultAction = res.defaultAction;
        }
        return;
      }
      if (!isRecord(r)) {
        errors.push(`${where}: each rule must be an object or a "TYPE,value,locale" string.`);
        return;
      }
      const res = parseRuleObject(r, where);
      errors.push(...res.errors);
      warnings.push(...res.warnings);
      if (res.rule) rules.push(res.rule);
    });
  }

  const rawDefault = obj.default ?? obj.defaultAction;
  if (rawDefault !== undefined) {
    const d = parseDefault(rawDefault);
    errors.push(...d.errors);
    warnings.push(...d.warnings);
    if (d.value) {
      if (defaultAction) warnings.push('Both "default" and a MATCH rule were given; "default" wins.');
      defaultAction = d.value;
    }
  }

  const options = parseOptions(obj.options, base?.options ?? DEFAULT_OPTIONS, errors);
  let enabled = base?.enabled ?? true;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') enabled = obj.enabled;
    else errors.push('"enabled" must be true or false.');
  }

  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) r.id = newRuleId();
    ids.add(r.id);
  }

  if (errors.length) return { settings: null, errors, warnings };
  return {
    settings: {
      schemaVersion: 1,
      enabled,
      rules,
      defaultAction: defaultAction ?? base?.defaultAction ?? { action: 'SYSTEM' },
      options,
    },
    errors,
    warnings,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseType(t: unknown): RuleType | null {
  if (typeof t !== 'string') return null;
  const u = t.trim().toUpperCase().replace(/_/g, '-');
  return (RULE_TYPES as readonly string[]).includes(u) ? (u as RuleType) : null;
}

function profileFrom(src: Record<string, unknown>, where: string, errors: string[], warnings: string[]): LocaleProfile | null {
  const input: Record<string, unknown> = {};
  const nested = isRecord(src.profile) ? src.profile : null;
  for (const k of PROFILE_KEYS) {
    if (nested && nested[k] !== undefined) input[k] = nested[k];
    else if (src[k] !== undefined) input[k] = src[k];
  }
  // Accept the alternative spellings used by the original single-locale config.
  if (input.acceptLanguage === undefined && src['accept-language'] !== undefined) input.acceptLanguage = src['accept-language'];
  if (src.timezoneOverride === false || src.geolocationOverride === false) {
    /* explicit "off" flags from the original config shape; nothing to do */
  }
  const r = normalizeProfile(input);
  errors.push(...r.errors.map((e) => `${where}: ${e}`));
  warnings.push(...r.warnings.map((w) => `${where}: ${w}`));
  return r.profile;
}

function parseAction(raw: unknown, hasProfileFields: boolean): 'PROFILE' | 'SYSTEM' | null {
  if (raw === undefined || raw === null) return hasProfileFields ? 'PROFILE' : null;
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toUpperCase();
  if (SYSTEM_WORDS.has(u)) return 'SYSTEM';
  if (PROFILE_WORDS.has(u)) return 'PROFILE';
  return null;
}

function hasProfile(r: Record<string, unknown>): boolean {
  return isRecord(r.profile) || PROFILE_KEYS.some((k) => r[k] !== undefined && r[k] !== null);
}

function parseRuleObject(r: Record<string, unknown>, where: string): { rule: Rule | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const type = parseType(r.type);
  if (!type) {
    errors.push(`${where}: unknown rule type ${JSON.stringify(r.type)} (expected one of ${RULE_TYPES.join(', ')}).`);
    return { rule: null, errors, warnings };
  }
  const keys = VALUE_KEYS[type];
  const found = keys.map((k) => r[k]).find((x) => x !== undefined && x !== null);
  const rawValue = typeof found === 'number' ? String(found) : found;
  if (typeof rawValue !== 'string') {
    errors.push(`${where}: "${keys[0]}" is required for ${type} rules.`);
    return { rule: null, errors, warnings };
  }
  let noResolve = false;
  const nr = r.noResolve ?? r['no-resolve'];
  if (nr !== undefined) {
    if (typeof nr !== 'boolean') errors.push(`${where}: noResolve must be true or false.`);
    else if (!isIpRuleType(type)) warnings.push(`${where}: noResolve only applies to IP rules; ignored.`);
    else noResolve = nr;
  }
  const v = normalizeRuleValue(type, rawValue);
  if (!v.value) {
    errors.push(`${where}: ${v.error}`);
    return { rule: null, errors, warnings };
  }
  warnings.push(...v.notes.map((n) => `${where}: ${n}`));

  const action = parseAction(r.action, hasProfile(r));
  if (!action) {
    errors.push(
      r.action === undefined
        ? `${where}: give a locale (or profile) to spoof, or action: SYSTEM.`
        : `${where}: unknown action ${JSON.stringify(r.action)} (expected SYSTEM, DIRECT or PROFILE).`,
    );
    return { rule: null, errors, warnings };
  }
  let profile: LocaleProfile | null = null;
  if (action === 'PROFILE') {
    profile = profileFrom(r, where, errors, warnings);
    if (!profile) return { rule: null, errors, warnings };
  } else if (hasProfile(r)) {
    warnings.push(`${where}: profile fields are ignored for SYSTEM rules.`);
  }

  let priority = 0;
  if (r.priority !== undefined) {
    if (typeof r.priority === 'number' && Number.isInteger(r.priority)) priority = r.priority;
    else errors.push(`${where}: priority must be an integer.`);
  }
  let enabled = true;
  if (r.enabled !== undefined) {
    if (typeof r.enabled === 'boolean') enabled = r.enabled;
    else errors.push(`${where}: enabled must be true or false.`);
  }
  if (errors.length) return { rule: null, errors, warnings };
  return {
    rule: {
      id: typeof r.id === 'string' && r.id ? r.id : newRuleId(),
      type,
      value: v.value,
      action,
      profile,
      enabled,
      priority,
      note: typeof r.note === 'string' ? r.note : '',
      ...(noResolve ? { noResolve: true } : {}),
    },
    errors,
    warnings,
  };
}

/** Field names accepted for each rule type's value (the first one is used on export). */
const VALUE_KEYS: Record<RuleType, string[]> = {
  DOMAIN: ['domain', 'value'],
  'DOMAIN-SUFFIX': ['domain', 'value'],
  'DOMAIN-KEYWORD': ['keyword', 'value', 'domain'],
  'DOMAIN-REGEX': ['regex', 'value', 'pattern'],
  GEOSITE: ['geosite', 'value', 'category'],
  'IP-CIDR': ['cidr', 'value', 'ip'],
  'IP-CIDR6': ['cidr', 'value', 'ip'],
  'IP-ASN': ['asn', 'value'],
  GEOIP: ['geoip', 'value', 'country', 'code'],
};

/** Parse "TYPE,value,LOCALE|SYSTEM[,no-resolve]" and "MATCH,LOCALE|SYSTEM". */
function parseCompactRule(s: string, where: string): { rule?: Rule; defaultAction?: DefaultAction; error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const parts = s.split(',').map((p) => p.trim());
  let noResolve = false;
  if (parts.length > 3 && parts.at(-1)!.toLowerCase() === 'no-resolve') {
    parts.pop();
    noResolve = true;
  }
  const head = (parts[0] ?? '').toUpperCase();
  if (head === 'MATCH' || head === 'FINAL') {
    const target = parts[1];
    if (!target) return { error: `${where}: ${head} needs a locale or SYSTEM.`, warnings };
    if (SYSTEM_WORDS.has(target.toUpperCase())) return { defaultAction: { action: 'SYSTEM' }, warnings };
    const p = normalizeProfile({ locale: target });
    if (!p.profile) return { error: `${where}: ${p.errors.join(' ')}`, warnings };
    return { defaultAction: { action: 'PROFILE', profile: p.profile }, warnings: p.warnings.map((w) => `${where}: ${w}`) };
  }
  const type = parseType(parts[0]);
  if (!type) return { error: `${where}: unknown rule type in "${s}".`, warnings };
  if (parts.length < 3) return { error: `${where}: expected "${type},<value>,<locale|SYSTEM>".`, warnings };
  // The target is the last field; everything between type and target is the value
  // (a DOMAIN-REGEX may itself contain commas).
  const target = parts.at(-1)!;
  const rawValue = type === 'DOMAIN-REGEX' ? parts.slice(1, -1).join(',') : parts[1]!;
  if (type !== 'DOMAIN-REGEX' && parts.length > 3) warnings.push(`${where}: extra fields before "${target}" ignored.`);
  const v = normalizeRuleValue(type, rawValue);
  if (!v.value) return { error: `${where}: ${v.error}`, warnings };
  warnings.push(...v.notes.map((n) => `${where}: ${n}`));
  if (noResolve && !isIpRuleType(type)) warnings.push(`${where}: no-resolve only applies to IP rules; ignored.`);
  const extra = noResolve && isIpRuleType(type) ? { noResolve: true } : {};
  if (SYSTEM_WORDS.has(target.toUpperCase())) {
    return { rule: { id: newRuleId(), type, value: v.value, action: 'SYSTEM', profile: null, enabled: true, priority: 0, note: '', ...extra }, warnings };
  }
  const p = normalizeProfile({ locale: target });
  if (!p.profile) return { error: `${where}: ${p.errors.join(' ')}`, warnings };
  warnings.push(...p.warnings.map((w) => `${where}: ${w}`));
  return { rule: { id: newRuleId(), type, value: v.value, action: 'PROFILE', profile: p.profile, enabled: true, priority: 0, note: '', ...extra }, warnings };
}

function parseDefault(raw: unknown): { value: DefaultAction | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw === 'string') {
    if (SYSTEM_WORDS.has(raw.trim().toUpperCase())) return { value: { action: 'SYSTEM' }, errors, warnings };
    const p = normalizeProfile({ locale: raw });
    if (!p.profile) return { value: null, errors: p.errors.map((e) => `default: ${e}`), warnings };
    return { value: { action: 'PROFILE', profile: p.profile }, errors, warnings: p.warnings.map((w) => `default: ${w}`) };
  }
  if (!isRecord(raw)) return { value: null, errors: ['"default" must be an object such as { mode: SYSTEM }.'], warnings };
  const modeRaw = raw.mode ?? raw.action;
  const mode = parseAction(modeRaw, hasProfile(raw));
  if (!mode) return { value: null, errors: [`default: unknown mode ${JSON.stringify(modeRaw)} (expected SYSTEM or PROFILE).`], warnings };
  if (mode === 'SYSTEM') return { value: { action: 'SYSTEM' }, errors, warnings };
  const profile = profileFrom(raw, 'default', errors, warnings);
  return { value: profile ? { action: 'PROFILE', profile } : null, errors, warnings };
}

function parseOptions(raw: unknown, base: Options, errors: string[]): Options {
  const out: Options = { ...base };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    errors.push('"options" must be an object.');
    return out;
  }
  if (raw.frameMode !== undefined) {
    if (raw.frameMode === 'inherit' || raw.frameMode === 'per-frame') out.frameMode = raw.frameMode;
    else errors.push('options.frameMode must be "inherit" or "per-frame".');
  }
  if (raw.uiLanguage !== undefined) {
    if (isUiLanguagePref(raw.uiLanguage)) out.uiLanguage = raw.uiLanguage;
    else errors.push(`options.uiLanguage must be "auto" or one of ${UI_LANGUAGES.map((l) => `"${l.value}"`).join(', ')}.`);
  }
  for (const k of ['keepSessionOnSystem', 'reloadOnLate', 'dnrHeaders', 'overrideWorkers'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
    else errors.push(`options.${k} must be true or false.`);
  }
  if (raw.datasetUpdates !== undefined) out.datasetUpdates = parseDatasetUpdates(raw.datasetUpdates, base.datasetUpdates, errors);
  if (raw.extensionUpdates !== undefined) out.extensionUpdates = parseExtensionUpdates(raw.extensionUpdates, base.extensionUpdates, errors);
  return out;
}

function parseExtensionUpdates(raw: unknown, base: ExtensionUpdateOptions, errors: string[]): ExtensionUpdateOptions {
  const out: ExtensionUpdateOptions = { ...(base ?? DEFAULT_OPTIONS.extensionUpdates) };
  if (!isRecord(raw)) {
    errors.push('options.extensionUpdates must be an object.');
    return out;
  }
  if (raw.onStartup !== undefined) {
    if (typeof raw.onStartup === 'boolean') out.onStartup = raw.onStartup;
    else errors.push('options.extensionUpdates.onStartup must be true or false.');
  }
  if (raw.interval !== undefined) {
    if (raw.interval === 'off' || raw.interval === 'daily' || raw.interval === 'weekly' || raw.interval === 'monthly') out.interval = raw.interval;
    else errors.push('options.extensionUpdates.interval must be "off", "daily", "weekly" or "monthly".');
  }
  if (raw.source !== undefined) {
    if (typeof raw.source === 'string' && isHttpUrl(raw.source.trim())) out.source = raw.source.trim();
    else errors.push('options.extensionUpdates.source must be an http(s) URL.');
  }
  return out;
}

function parseDatasetUpdates(raw: unknown, base: DatasetUpdateOptions, errors: string[]): DatasetUpdateOptions {
  const out: DatasetUpdateOptions = { ...(base ?? DEFAULT_OPTIONS.datasetUpdates) };
  if (!isRecord(raw)) {
    errors.push('options.datasetUpdates must be an object.');
    return out;
  }
  for (const k of ['onStartup', 'onlyNeeded'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
    else errors.push(`options.datasetUpdates.${k} must be true or false.`);
  }
  if (raw.interval !== undefined) {
    if (raw.interval === 'off' || raw.interval === 'daily' || raw.interval === 'weekly' || raw.interval === 'monthly') out.interval = raw.interval;
    else errors.push('options.datasetUpdates.interval must be "off", "daily", "weekly" or "monthly".');
  }
  if (raw.minIntervalHours !== undefined) {
    const n = raw.minIntervalHours;
    if (typeof n === 'number' && Number.isFinite(n) && n >= MIN_UPDATE_GAP_HOURS && n <= MAX_UPDATE_GAP_HOURS) out.minIntervalHours = Math.round(n);
    else errors.push(`options.datasetUpdates.minIntervalHours must be a number from ${MIN_UPDATE_GAP_HOURS} to ${MAX_UPDATE_GAP_HOURS}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export

function profileToObject(p: LocaleProfile, rule: Record<string, YamlValue>): void {
  rule.locale = p.locale;
  rule.languages = p.languages;
  rule.acceptLanguage = p.acceptLanguage;
  if (p.timezone) rule.timezone = p.timezone;
  if (p.geolocation) rule.geolocation = { latitude: p.geolocation.latitude, longitude: p.geolocation.longitude, accuracy: p.geolocation.accuracy };
}

export function settingsToConfigObject(s: Settings): { [k: string]: YamlValue } {
  const rules: YamlValue[] = s.rules.map((r) => {
    const o: { [k: string]: YamlValue } = { type: r.type };
    const key = VALUE_KEYS[r.type][0]!;
    o[key] = r.type === 'IP-ASN' ? Number(r.value) : r.value;
    if (r.noResolve) o.noResolve = true;
    if (r.action === 'SYSTEM') o.action = 'SYSTEM';
    else if (r.profile) profileToObject(r.profile, o);
    if (!r.enabled) o.enabled = false;
    if (r.priority) o.priority = r.priority;
    if (r.note) o.note = r.note;
    return o;
  });
  const def: { [k: string]: YamlValue } = { mode: s.defaultAction.action === 'SYSTEM' ? 'SYSTEM' : 'PROFILE' };
  if (s.defaultAction.action === 'PROFILE') profileToObject(s.defaultAction.profile, def);
  return {
    version: 1,
    enabled: s.enabled,
    rules,
    default: def,
    options: { ...s.options, datasetUpdates: { ...s.options.datasetUpdates }, extensionUpdates: { ...s.options.extensionUpdates } },
  };
}

export function exportConfig(s: Settings, format: 'json' | 'yaml'): string {
  const obj = settingsToConfigObject(s);
  if (format === 'json') return JSON.stringify(obj, null, 2) + '\n';
  return '# Locale Jacket configuration\n' + stringifyYaml(obj);
}

/** Merge imported rules into existing settings, skipping exact duplicates (same type, value, action, profile). */
export function mergeRules(current: Settings, incoming: Settings): { settings: Settings; added: number; skipped: number } {
  const key = (r: Rule) => JSON.stringify([r.type, r.value, Boolean(r.noResolve), r.action, r.profile]);
  const existing = new Set(current.rules.map(key));
  const ids = new Set(current.rules.map((r) => r.id));
  let added = 0;
  let skipped = 0;
  const rules = [...current.rules];
  for (const r of incoming.rules) {
    if (existing.has(key(r))) {
      skipped++;
      continue;
    }
    rules.push(ids.has(r.id) ? { ...r, id: newRuleId() } : r);
    existing.add(key(r));
    added++;
  }
  return { settings: { ...current, rules }, added, skipped };
}

/** Validate settings read from storage; falls back to `fallback` when the stored value is unusable. */
export function sanitizeStoredSettings(raw: unknown, fallback: Settings): { settings: Settings; problems: string[] } {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.rules)) {
    return { settings: fallback, problems: raw === undefined ? [] : ['Stored settings were unreadable; defaults restored.'] };
  }
  const problems: string[] = [];
  const rules: Rule[] = [];
  (raw.rules as unknown[]).forEach((r, i) => {
    const asConfig = isRecord(r)
      ? {
          id: r.id,
          type: r.type,
          value: r.value,
          noResolve: r.noResolve,
          action: r.action,
          ...(isRecord(r.profile) ? { profile: r.profile } : {}),
          enabled: r.enabled,
          priority: r.priority,
          note: r.note,
        }
      : r;
    const one = importConfigObject({ rules: [asConfig] });
    const rule = one.settings?.rules[0];
    if (rule) rules.push(rule);
    else problems.push(`Stored rule #${i + 1} was invalid and has been skipped: ${one.errors.join(' ')}`);
  });
  const res = importConfigObject(
    {
      enabled: raw.enabled,
      rules: [],
      default: isRecord(raw.defaultAction)
        ? raw.defaultAction.action === 'PROFILE'
          ? { mode: 'PROFILE', profile: raw.defaultAction.profile }
          : { mode: 'SYSTEM' }
        : undefined,
      options: raw.options,
    },
    fallback,
  );
  if (!res.settings) return { settings: { ...fallback, rules }, problems: [...problems, ...res.errors] };
  return { settings: { ...res.settings, rules }, problems };
}
