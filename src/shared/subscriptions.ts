// Rule subscriptions: rules files (JSON or YAML) on the internet that the extension
// fetches and keeps up to date. Their rules are kept apart from your own: they are
// stored separately (storage.local, written only by the service worker), shown
// read-only, and merged in as lower layers, so your own rules always win and an
// earlier subscription wins over a later one. Requests go only to the URLs you added.

import { parseConfigText, parseSubscriptionRules } from './config-io.js';
import { INTERVAL_MS, type UpdateTrigger } from './dataset-schedule.js';
import { DATASET_KINDS, DATASETS, type DatasetKind } from './dataset-store.js';
import { requiredDatasets } from './rules.js';
import { isHttpUrl } from './extension-update.js';
import { fetchLimited, type NetLimits } from './net.js';
import type { Rule, Settings, Subscription } from './types.js';

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
  fetchedAt?: number;
  lastAttempt?: number;
  etag?: string;
  lastModified?: string;
  /** Set when the last attempt failed; the previous rules stay in use. */
  error?: string;
}
export type SubscriptionDataMap = Record<string, SubscriptionData>;

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

/** Parse a subscription file into rules with stable ids and the subscription as origin. */
export function parseSubscription(text: string, sub: Subscription): Pick<SubscriptionData, 'rules' | 'skipped' | 'skippedCount' | 'ignored' | 'datasets'> {
  if (looksLikeHtml(text)) {
    throw new Error('This address returned a web page, not a JSON or YAML file. Use a link to the file itself (on GitHub, the file page or its Raw link).');
  }
  const parsed = parseConfigText(text);
  if (parsed.error) throw new Error(parsed.error);
  const { rules, skipped, ignored, datasets } = parseSubscriptionRules(parsed.value);
  if (rules.length > MAX_SUBSCRIPTION_RULES) throw new Error(`The file has ${rules.length} rules; at most ${MAX_SUBSCRIPTION_RULES} are allowed per subscription.`);
  return {
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
  const same = previous && previous.url === url && previous.fetchedAt !== undefined;
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
 * - startup / alarm: when its interval has passed, at most once per minimum gap.
 */
export function subscriptionDue(sub: Subscription, d: SubscriptionData | undefined, trigger: SubscriptionTrigger, now: number): boolean {
  if (trigger === 'manual') return true;
  if (!sub.enabled) return false;
  const fresh = d === undefined || d.url !== rawUrl(sub.url);
  // A failed attempt for the current URL is not "fresh": it is retried by the schedule or a click.
  if (trigger === 'changed' || fresh) return fresh;
  if (sub.interval === 'off') return false;
  if (d.lastAttempt !== undefined && now - d.lastAttempt < MIN_SUBSCRIPTION_GAP_HOURS * HOUR) return false;
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
