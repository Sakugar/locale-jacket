// Checking for a newer Locale Jacket release. Opt-in like the data-set updates:
// nothing is requested unless the user clicks "Check now" or turns automatic checks
// on, and requests go only to the configured address (a GitHub "latest release"
// API URL by default). Chrome never updates an unpacked folder, so finding a new
// version only tells the user; applying it is up to them (or to Chrome, for
// store and policy installs).

import { INTERVAL_MS } from './dataset-schedule.js';
import type { ExtensionUpdateOptions } from './types.js';

export const DEFAULT_RELEASE_SOURCE = 'https://api.github.com/repos/Sakugar/locale-jacket/releases/latest';
export const EXTENSION_UPDATE_STATE_KEY = 'extensionUpdateState';
/** Automatic checks happen at most this often, whatever triggers them. */
export const MIN_CHECK_GAP_HOURS = 12;
const HOUR = 3_600_000;
const NOTES_LIMIT = 20_000;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  name: string;
  /** The release's web page. */
  page: string;
  publishedAt: string | null;
  notes: string;
  assets: ReleaseAsset[];
}

/** Kept in chrome.storage.local, written only by the service worker. */
export interface ExtensionUpdateState {
  /** When the last check started (written before fetching, so failures count too). */
  lastAttempt?: number;
  /** When the last check succeeded. */
  lastChecked?: number;
  lastError?: string;
  /** The latest release seen by the last successful check. */
  latest?: ReleaseInfo;
}

export type CheckTrigger = 'startup' | 'alarm' | 'manual';

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Compare dotted versions numerically ("1.10.0" > "1.9.3"); a leading "v" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (Number.isFinite(x[i]) ? x[i]! : 0) - (Number.isFinite(y[i]) ? y[i]! : 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A GitHub release object (or a list of them, newest first, as /releases returns).
 * Drafts and pre-releases are skipped. Throws when nothing usable is found.
 */
export function parseRelease(json: unknown): ReleaseInfo {
  const list = Array.isArray(json) ? json : [json];
  const r = list.find((x) => isRecord(x) && x.draft !== true && x.prerelease !== true);
  if (!isRecord(r) || typeof r.tag_name !== 'string' || !/\d/.test(r.tag_name)) throw new Error('The answer is not a GitHub release.');
  const version = r.tag_name.replace(/^v/i, '');
  const assets = Array.isArray(r.assets)
    ? r.assets.filter(isRecord).flatMap((a) =>
        typeof a.name === 'string' && typeof a.browser_download_url === 'string' && isHttpUrl(a.browser_download_url)
          ? [{ name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : 0 }]
          : [],
      )
    : [];
  return {
    version,
    name: typeof r.name === 'string' && r.name ? r.name : `Locale Jacket ${version}`,
    page: typeof r.html_url === 'string' && isHttpUrl(r.html_url) ? r.html_url : '',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    notes: typeof r.body === 'string' ? r.body.slice(0, NOTES_LIMIT) : '',
    assets,
  };
}

/** Ask the release address for the latest release. */
export async function fetchLatestRelease(source: string, fetchFn: typeof fetch = fetch): Promise<ReleaseInfo> {
  if (!isHttpUrl(source)) throw new Error('The release address must start with https:// or http://.');
  const res = await fetchFn(source, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new Error('No release found at this address (404). A private GitHub repository does not answer without signing in.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRelease(await res.json());
}

/** The newer release from the last check, if there is one. */
export function availableUpdate(state: ExtensionUpdateState | undefined, current: string): ReleaseInfo | null {
  const latest = state?.latest;
  return latest && compareVersions(latest.version, current) > 0 ? latest : null;
}

/** Whether a check should run now. Manual checks always run; automatic ones respect the gap. */
export function checkDue(opts: ExtensionUpdateOptions, state: ExtensionUpdateState | undefined, trigger: CheckTrigger, now: number): boolean {
  if (trigger === 'manual') return true;
  if (!opts.onStartup && opts.interval === 'off') return false;
  if (state?.lastAttempt !== undefined && now - state.lastAttempt < MIN_CHECK_GAP_HOURS * HOUR) return false;
  const overdue = opts.interval !== 'off' && now - (state?.lastChecked ?? 0) >= INTERVAL_MS[opts.interval];
  return trigger === 'startup' ? opts.onStartup || overdue : overdue;
}
