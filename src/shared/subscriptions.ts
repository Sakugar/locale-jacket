// Rule subscriptions: rules files (JSON or YAML) on the internet that the extension
// fetches and keeps up to date. Their rules are kept apart from your own: they are
// stored separately (storage.local, written only by the service worker), shown
// read-only, and merged in as lower layers, so your own rules always win and an
// earlier subscription wins over a later one. Requests go only to the URLs you added.

import { parseConfigText, parseSubscriptionRules } from './config-io.js';
import { INTERVAL_MS, type UpdateTrigger } from './dataset-schedule.js';
import { DATASET_KINDS, DATASETS, type DatasetKind } from './dataset-store.js';
import { analysisBudget, REGEX_CHECK_VERSION } from './regex-safety.js';
import { markRegexValidated, REGEX_BATCH_BUDGET_MS, requiredDatasets } from './rules.js';
import { isHttpUrl } from './extension-update.js';
import { fetchLimited, type NetLimits } from './net.js';
import { RULE_TYPES, type LocaleProfile, type Rule, type RuleOrigin, type Settings, type Subscription } from './types.js';

export const SUBSCRIPTION_DATA_KEY = 'subscriptionData';
/** Automatic data-set downloads for subscriptions: { [kind]: SubscriptionDatasetRecord }. */
export const SUBSCRIPTION_DATASET_STATE_KEY = 'subscriptionDatasetState';
/** A failed automatic data-set download is retried at most this often. */
export const DATASET_RETRY_HOURS = 1;
export const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
/** A rules file is small: a minute in all, and 20 s without data, are plenty. */
export const SUBSCRIPTION_LIMITS: NetLimits = { totalMs: 60_000, stallMs: 20_000, maxBytes: MAX_SUBSCRIPTION_BYTES };
export const MAX_SUBSCRIPTION_RULES = 5000;
/** Automatic updates of one subscription happen at most this often. */
export const MIN_SUBSCRIPTION_GAP_HOURS = 1;
const HOUR = 3_600_000;

/** What was last fetched for one subscription. */
export interface SubscriptionData {
  /** The URL that was fetched (after converting GitHub page links). */
  url: string;
  rules: Rule[];
  /** Entries that were not valid rules (first few, with reasons). */
  skipped: string[];
  skippedCount: number;
  /** Keys of the file that subscriptions do not use (default, options…). */
  ignored: string[];
  /** Data-set URLs named by the file (used when its rules need a data set that is missing). */
  datasets?: Partial<Record<DatasetKind, string>>;
  /**
   * REGEX_CHECK_VERSION of the regex check that accepted its DOMAIN-REGEX rules. Data with
   * the current version is not checked again after a worker restart; anything else is.
   */
  regexCheck?: number;
  fetchedAt?: number;
  lastAttempt?: number;
  etag?: string;
  lastModified?: string;
  /** Set when the last attempt failed; the previous rules stay in use. */
  error?: string;
}
export type SubscriptionDataMap = Record<string, SubscriptionData>;

// ------------------------------------------------------------ stored form
//
// storage.local[SUBSCRIPTION_DATA_KEY] holds a compact form of SubscriptionDataMap. This
// is the only place that knows it; the service worker writes it with
// encodeSubscriptionData and both the worker and the options page read it with
// decodeSubscriptionData.
//
// Format 1 (up to 1.3.3, no marker): the map itself, every rule stored verbatim with its
// profile, id and origin (about 330 bytes a rule; 20 × 5,000 rules ≈ 33 MB, past the
// 10 MB quota). Format 2: { format: 2, subscriptions: { [id]: StoredSubscriptionData } },
// where each entry keeps its other fields as they are and `rules` becomes a table: each
// distinct rule type and profile is stored once and rules refer to them by index. Ids
// (`<subId>:<index>`) and `origin` are rebuilt on load, as parseSubscription made them.

/** The stored-format version written by encodeSubscriptionData. */
export const SUBSCRIPTION_DATA_FORMAT = 2;

/** StoredRule flags; a flag that is not set is the common case. */
const SYSTEM_FLAG = 1;
const DISABLED_FLAG = 2;
const NO_RESOLVE_FLAG = 4;

/**
 * One rule: [type (index into `types`), value, profile (index into `profiles`, -1 for none),
 * flags (SYSTEM 1, disabled 2, noResolve 4), priority, note]. Trailing fields equal to
 * their default (0, 0, '') are left out.
 */
export type StoredRule = [type: number, value: string, profile: number, flags?: number, priority?: number, note?: string];

export interface StoredRules {
  /** origin.name of every rule (the subscription's label when it was fetched). */
  name: string;
  types: Rule['type'][];
  profiles: LocaleProfile[];
  list: StoredRule[];
}

export type StoredSubscriptionData = Omit<SubscriptionData, 'rules'> & { rules: StoredRules };

export interface StoredSubscriptionDataMap {
  format: typeof SUBSCRIPTION_DATA_FORMAT;
  subscriptions: Record<string, StoredSubscriptionData>;
}

/**
 * Encoded rule tables by rules array. Entries are replaced, never changed in place (see
 * revertUnsaved), and an entry updated with a new attempt time or error keeps its rules
 * array, so each array is encoded once however often the map is saved.
 */
const encodedRules = new WeakMap<readonly Rule[], StoredRules>();

function encodeRules(rules: readonly Rule[]): StoredRules {
  const cached = encodedRules.get(rules);
  if (cached) return cached;
  const types: Rule['type'][] = [];
  const typeIndex = new Map<string, number>();
  const profiles: LocaleProfile[] = [];
  const profileIndex = new Map<string, number>();
  const list: StoredRule[] = rules.map((r) => {
    let t = typeIndex.get(r.type);
    if (t === undefined) typeIndex.set(r.type, (t = types.push(r.type) - 1));
    let p = -1;
    if (r.profile) {
      const key = profileKey(r.profile);
      const known = profileIndex.get(key);
      if (known !== undefined) p = known;
      else profileIndex.set(key, (p = profiles.push(r.profile) - 1));
    }
    const flags = (r.action === 'SYSTEM' ? SYSTEM_FLAG : 0) | (r.enabled ? 0 : DISABLED_FLAG) | (r.noResolve ? NO_RESOLVE_FLAG : 0);
    // (A rule from format 1 data without a priority or note gets the default.)
    const out: StoredRule = [t, r.value, p, flags, typeof r.priority === 'number' ? r.priority : 0, typeof r.note === 'string' ? r.note : ''];
    // Drop trailing defaults: [t, value, p] for most rules.
    while (out.length > 3 && (out[out.length - 1] === 0 || out[out.length - 1] === '')) out.pop();
    return out;
  });
  const stored: StoredRules = { name: rules[0]?.origin?.name ?? '', types, profiles, list };
  encodedRules.set(rules, stored);
  return stored;
}

/** Two profiles with the same fields are one profile, whatever their key order. */
function profileKey(p: LocaleProfile): string {
  const g = p.geolocation;
  return JSON.stringify([p.locale, p.languages, p.acceptLanguage, p.timezone, g ? [g.latitude, g.longitude, g.accuracy] : null]);
}

/** The stored form of `data` (what the service worker writes to storage.local). */
export function encodeSubscriptionData(data: SubscriptionDataMap): StoredSubscriptionDataMap {
  const subscriptions: Record<string, StoredSubscriptionData> = {};
  for (const [id, d] of Object.entries(data)) subscriptions[id] = { ...d, rules: encodeRules(d.rules) };
  return { format: SUBSCRIPTION_DATA_FORMAT, subscriptions };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodeRules(subId: string, s: unknown): Rule[] | null {
  if (!isRecord(s) || !Array.isArray(s.types) || !Array.isArray(s.profiles) || !Array.isArray(s.list)) return null;
  const types = s.types as unknown[];
  const profiles = s.profiles as unknown[];
  if (!types.every((t) => typeof t === 'string' && (RULE_TYPES as readonly string[]).includes(t))) return null;
  if (!profiles.every(isRecord)) return null;
  const origin: RuleOrigin = { subscription: subId, name: typeof s.name === 'string' ? s.name : subId, layer: 0 };
  const rules: Rule[] = [];
  for (const [i, x] of (s.list as unknown[]).entries()) {
    if (!Array.isArray(x)) return null;
    const [t, value, p, flags = 0, priority = 0, note = ''] = x as unknown[];
    if (typeof t !== 'number' || types[t] === undefined || typeof value !== 'string') return null;
    if (typeof p !== 'number' || (p !== -1 && profiles[p] === undefined)) return null;
    if (typeof flags !== 'number' || typeof priority !== 'number' || typeof note !== 'string') return null;
    rules.push({
      id: `${subId}:${i}`,
      type: types[t] as Rule['type'],
      value,
      action: flags & SYSTEM_FLAG ? 'SYSTEM' : 'PROFILE',
      profile: p === -1 ? null : (profiles[p] as unknown as LocaleProfile),
      enabled: !(flags & DISABLED_FLAG),
      priority,
      note,
      ...(flags & NO_RESOLVE_FLAG ? { noResolve: true } : {}),
      origin,
    });
  }
  // Saving these rules again stores the same table, so it need not be encoded again.
  encodedRules.set(rules, { name: origin.name, types: types as Rule['type'][], profiles: profiles as unknown as LocaleProfile[], list: s.list as StoredRule[] });
  return rules;
}

/** A format-1 entry's rules, if they look like rules (ids and origin are rebuilt like format 2's). */
function migrateRules(subId: string, rules: unknown): Rule[] | null {
  if (!Array.isArray(rules)) return null;
  const ok = rules.every(
    (r) =>
      isRecord(r) &&
      typeof r.type === 'string' &&
      (RULE_TYPES as readonly string[]).includes(r.type) &&
      typeof r.value === 'string' &&
      (r.profile === null || isRecord(r.profile)),
  );
  if (!ok) return null;
  return decodeRules(subId, encodeRules(rules as Rule[]));
}

/**
 * Read what storage.local[SUBSCRIPTION_DATA_KEY] holds, in the current or the older format.
 * Everything but the rules (including the `regexCheck` marker, the ETag and the fetch
 * times) is kept as stored, so migrated data is trusted, checked or refetched exactly as
 * before. An entry that cannot be read is left out, so its subscription is fetched again.
 * `outdated`: the value is not in the current format (and should be written again).
 */
export function decodeSubscriptionData(raw: unknown): { data: SubscriptionDataMap; outdated: boolean } {
  const data: SubscriptionDataMap = {};
  if (!isRecord(raw)) return { data, outdated: false };
  // Format 1 is a map of subscription ids to objects, so a number at `format` marks format 2+.
  const format = typeof raw.format === 'number' ? raw.format : 1;
  // A newer format (after a downgrade) cannot be read: its subscriptions are fetched again,
  // and it is overwritten only then.
  if (format > SUBSCRIPTION_DATA_FORMAT) return { data, outdated: false };
  const entries = format === 1 ? raw : raw.subscriptions;
  if (!isRecord(entries)) return { data, outdated: true };
  for (const [id, e] of Object.entries(entries)) {
    if (!isRecord(e) || typeof e.url !== 'string') continue;
    const rules = format === 1 ? migrateRules(id, e.rules) : decodeRules(id, e.rules);
    if (!rules) continue;
    data[id] = {
      ...(e as unknown as Omit<SubscriptionData, 'rules'>),
      rules,
      skipped: Array.isArray(e.skipped) ? (e.skipped as string[]) : [],
      skippedCount: typeof e.skippedCount === 'number' ? e.skippedCount : 0,
      ignored: Array.isArray(e.ignored) ? (e.ignored as string[]) : [],
    };
  }
  return { data, outdated: format !== SUBSCRIPTION_DATA_FORMAT };
}

export type SubscriptionTrigger = UpdateTrigger | 'changed';

export interface SubscriptionOutcome {
  id: string;
  result: 'updated' | 'unchanged' | 'failed' | 'skipped';
  count?: number;
  error?: string;
}

/**
 * The address to fetch. Links to a file's page on GitHub or to a gist (HTML pages)
 * are turned into their raw file; everything else is used as given.
 */
export function rawUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input.trim();
  }
  if (u.hostname === 'github.com') {
    // https://github.com/<owner>/<repo>/blob/<ref>/<path>  →  raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if (u.hostname === 'gist.github.com') {
    // https://gist.github.com/<user>/<id>  →  gist.githubusercontent.com/<user>/<id>/raw (the gist's file)
    const m = /^\/([^/]+)\/([0-9a-f]+)\/?$/i.exec(u.pathname);
    if (m) return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`;
  }
  return u.href;
}

export function subscriptionLabel(sub: Pick<Subscription, 'name' | 'url'>): string {
  if (sub.name) return sub.name;
  try {
    const u = new URL(sub.url);
    return `${u.hostname}${u.pathname.length > 1 ? u.pathname.replace(/^(.{0,40}).*$/, '$1') : ''}`;
  } catch {
    return sub.url;
  }
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text);
}

/**
 * Parse a subscription file into rules with stable ids and the subscription as origin.
 * Validation stops as soon as the file has more than MAX_SUBSCRIPTION_RULES valid rules,
 * and all its regular expressions share one analysis budget (REGEX_BATCH_BUDGET_MS);
 * patterns left over when it is spent are skipped like other invalid entries.
 */
export function parseSubscription(
  text: string,
  sub: Subscription,
): Pick<SubscriptionData, 'rules' | 'skipped' | 'skippedCount' | 'ignored' | 'datasets' | 'regexCheck'> {
  if (looksLikeHtml(text)) {
    throw new Error('This address returned a web page, not a JSON or YAML file. Use a link to the file itself (on GitHub, the file page or its Raw link).');
  }
  const parsed = parseConfigText(text);
  if (parsed.error) throw new Error(parsed.error);
  const { rules, skipped, ignored, datasets } = parseSubscriptionRules(parsed.value, {
    check: { budget: analysisBudget(REGEX_BATCH_BUDGET_MS) },
    maxRules: MAX_SUBSCRIPTION_RULES,
  });
  return {
    regexCheck: REGEX_CHECK_VERSION,
    // Ids derive from the position, so a tab's matched rule stays recognisable across updates.
    rules: rules.map((r, i) => ({ ...r, id: `${sub.id}:${i}`, origin: { subscription: sub.id, name: subscriptionLabel(sub), layer: 0 } })),
    skipped: skipped.slice(0, 20),
    skippedCount: skipped.length,
    ignored,
    ...(Object.keys(datasets).length ? { datasets } : {}),
  };
}

/**
 * Fetch a subscription. With `previous` from the same URL, the request is conditional
 * and an unchanged file is not downloaded again.
 */
export async function fetchSubscription(
  sub: Subscription,
  previous: SubscriptionData | undefined,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  limits: Partial<NetLimits> = {},
): Promise<{ status: 'unchanged' } | { status: 'updated'; data: SubscriptionData }> {
  const url = rawUrl(sub.url);
  if (!isHttpUrl(url)) throw new Error('The address must start with https:// or http://.');
  const headers: Record<string, string> = { Accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5' };
  // Rules checked by an older regex check are fetched in full (not conditionally) once, so
  // they are parsed and checked again and the stored data gets the current marker.
  const same = previous && previous.url === url && previous.fetchedAt !== undefined && previous.regexCheck === REGEX_CHECK_VERSION;
  if (same && previous.etag) headers['If-None-Match'] = previous.etag;
  if (same && previous.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  // The byte cap is counted while the body streams in, so a file without content-length
  // (or with a wrong one) is never read past it.
  const { res, body } = await fetchLimited(fetchFn, url, { cache: same ? 'no-cache' : 'no-store', headers, credentials: 'omit' }, { ...SUBSCRIPTION_LIMITS, ...limits });
  if (res.status === 304 && same) return { status: 'unchanged' };
  if (res.status === 404) throw new Error('Not found (404). If the file is in a private GitHub repository, GitHub does not serve it without signing in.');
  if (!res.ok || !body) throw new Error(`HTTP ${res.status}`);
  // Like Response.text(): UTF-8, a leading byte-order mark dropped.
  const text = new TextDecoder().decode(body);
  const contentType = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(contentType) && looksLikeHtml(text)) {
    throw new Error('This address returned a web page, not a JSON or YAML file. Use a link to the file itself (on GitHub, the file page or its Raw link).');
  }
  const parsed = parseSubscription(text, sub);
  return {
    status: 'updated',
    data: {
      url,
      ...parsed,
      fetchedAt: now(),
      lastAttempt: now(),
      ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}),
      ...(res.headers.get('last-modified') ? { lastModified: res.headers.get('last-modified')! } : {}),
    },
  };
}

/**
 * After storage refused `current` (chrome.storage.local holds at most 10 MB), put back
 * what storage still has for every entry that changed since `stored`, keeping the
 * attempt time and recording `error`. Memory then matches storage again (plus the
 * error), the previous rules stay in use, and the UI can show why. Entries are replaced,
 * never changed in place, so "changed" is a reference comparison. Returns the ids reverted.
 */
export function revertUnsaved(current: SubscriptionDataMap, stored: SubscriptionDataMap, error: string): string[] {
  const ids: string[] = [];
  for (const [id, d] of Object.entries(current)) {
    const old = stored[id];
    if (d === old) continue;
    const base: SubscriptionData = old && old.url === d.url ? old : { url: d.url, rules: [], skipped: [], skippedCount: 0, ignored: [] };
    current[id] = { ...base, ...(d.lastAttempt !== undefined ? { lastAttempt: d.lastAttempt } : {}), error };
    ids.push(id);
  }
  return ids;
}

/**
 * When even the reverted data could not be saved and memory was reloaded from storage,
 * mark the entries `revertUnsaved` reverted (`reverted`: id → reverted entry) as failed
 * again, so the run reports them as failed instead of updated. A reloaded entry for the
 * same URL keeps its rules; otherwise the reverted entry (no unsaved rules) is used.
 */
export function markUnsaved(current: SubscriptionDataMap, reverted: SubscriptionDataMap, error: string): void {
  for (const [id, r] of Object.entries(reverted)) {
    const d = current[id];
    current[id] = d && d.url === r.url ? { ...d, ...(r.lastAttempt !== undefined ? { lastAttempt: r.lastAttempt } : {}), error } : { ...r, error };
  }
}

/**
 * After loading stored subscription data: the DOMAIN-REGEX sources of entries checked by
 * the current REGEX_CHECK_VERSION are marked as checked, so the first navigation does not
 * analyse them again. Entries without the marker (older data, or an older check) are left
 * alone: compiledRegex checks each of their patterns before it is first used.
 */
export function trustCheckedSubscriptionData(data: SubscriptionDataMap): number {
  let n = 0;
  for (const d of Object.values(data)) {
    if (d?.regexCheck !== REGEX_CHECK_VERSION || !Array.isArray(d.rules)) continue;
    for (const r of d.rules) {
      if (r?.type !== 'DOMAIN-REGEX' || typeof r.value !== 'string') continue;
      markRegexValidated(r.value);
      n++;
    }
  }
  return n;
}

/** Rules last fetched for a subscription, if they belong to its current URL. */
export function currentData(sub: Subscription, data: SubscriptionDataMap): SubscriptionData | undefined {
  const d = data[sub.id];
  return d && d.url === rawUrl(sub.url) ? d : undefined;
}

/**
 * Your settings with the enabled subscriptions' rules appended as lower layers.
 * This is what the rule engine, the DNR rules and the data-set loader work with.
 */
export function withSubscriptions(settings: Settings, data: SubscriptionDataMap): Settings {
  const extra: Rule[] = [];
  settings.subscriptions.forEach((sub, i) => {
    if (!sub.enabled) return;
    const d = currentData(sub, data);
    if (!d) return;
    const origin = { subscription: sub.id, name: subscriptionLabel(sub), layer: i + 1 };
    for (const r of d.rules) extra.push({ ...r, origin });
  });
  return extra.length ? { ...settings, rules: [...settings.rules, ...extra] } : settings;
}

/**
 * Whether a subscription should be fetched now.
 * - manual: always;
 * - changed: when it has no rules for its current URL yet (just added, or the URL changed);
 * - startup / alarm: when its interval has passed, or its data was checked by another
 *   REGEX_CHECK_VERSION, at most once per minimum gap; never when updates are off.
 */
export function subscriptionDue(sub: Subscription, d: SubscriptionData | undefined, trigger: SubscriptionTrigger, now: number): boolean {
  if (trigger === 'manual') return true;
  if (!sub.enabled) return false;
  const fresh = d === undefined || d.url !== rawUrl(sub.url);
  // A failed attempt for the current URL is not "fresh": it is retried by the schedule or a click.
  if (trigger === 'changed' || fresh) return fresh;
  // With updates off nothing is fetched automatically, not even data an older regex check
  // accepted: compiledRegex checks those patterns itself, within a bounded budget.
  if (sub.interval === 'off') return false;
  if (d.lastAttempt !== undefined && now - d.lastAttempt < MIN_SUBSCRIPTION_GAP_HOURS * HOUR) return false;
  // Data checked by another REGEX_CHECK_VERSION is fetched again (in full, see
  // fetchSubscription) at the next attempt the minimum gap allows, so it gets the marker.
  if (d.regexCheck !== REGEX_CHECK_VERSION) return true;
  return now - (d.fetchedAt ?? 0) >= INTERVAL_MS[sub.interval];
}

/** One automatic data-set download for subscriptions. */
export interface SubscriptionDatasetRecord {
  url: string;
  /** The subscription whose rules needed it. */
  for: string;
  at: number;
  ok: boolean;
  error?: string;
}
export type SubscriptionDatasetState = Partial<Record<DatasetKind, SubscriptionDatasetRecord>>;

/**
 * Data sets that enabled subscriptions' rules need but that are not installed, with
 * where to get each: the URL named by the first subscription (in order) that needs it,
 * otherwise the built-in default.
 */
export function datasetsToDownload(settings: Settings, data: SubscriptionDataMap, installed: DatasetKind[]): { kind: DatasetKind; url: string; for: string }[] {
  const out: { kind: DatasetKind; url: string; for: string }[] = [];
  for (const kind of DATASET_KINDS) {
    if (installed.includes(kind)) continue;
    let pick: { url: string; for: string } | null = null;
    let neededBy: string | null = null;
    for (const sub of settings.subscriptions) {
      if (!sub.enabled) continue;
      const d = currentData(sub, data);
      if (!d) continue;
      const need = requiredDatasets(d.rules);
      if (!(kind === 'geosite' ? need.geosite.length > 0 : need[kind])) continue;
      neededBy ??= subscriptionLabel(sub);
      if (d.datasets?.[kind]) {
        pick = { url: d.datasets[kind]!, for: subscriptionLabel(sub) };
        break;
      }
    }
    if (pick) out.push({ kind, ...pick });
    else if (neededBy) out.push({ kind, url: DATASETS[kind].defaultUrl, for: neededBy });
  }
  return out;
}

/**
 * Whether an automatic download of a missing data set may be attempted now:
 * - never tried, or the URL to use changed: yes;
 * - the last attempt failed: after a pause;
 * - it was downloaded from this URL before: no. It is missing because you deleted it
 *   (Options ▸ Data sets), and that deletion sticks. The record is forgotten once no
 *   enabled subscription needs the data set (see `staleDatasetRecords`), so adding a
 *   subscription that needs it again downloads it again.
 */
export function datasetDownloadDue(rec: SubscriptionDatasetRecord | undefined, url: string, now: number): boolean {
  if (!rec || rec.url !== url) return true;
  return !rec.ok && now - rec.at >= DATASET_RETRY_HOURS * HOUR;
}

/** Records of automatic downloads for data sets that no enabled subscription needs any more. */
export function staleDatasetRecords(settings: Settings, data: SubscriptionDataMap, state: SubscriptionDatasetState): DatasetKind[] {
  const needed = new Set(datasetsToDownload(settings, data, []).map((j) => j.kind));
  return DATASET_KINDS.filter((kind) => state[kind] !== undefined && !needed.has(kind));
}
