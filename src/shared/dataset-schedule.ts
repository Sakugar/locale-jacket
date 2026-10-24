// When to update downloaded data sets automatically. Pure logic, no I/O, so the
// rules are easy to test: an update is triggered by the browser starting or by a
// regular interval, and every automatic attempt respects a minimum gap so restarts
// or service-worker wake-ups can never download too often.

import type { DatasetKind, DatasetMeta } from './dataset-store.js';
import type { DatasetUpdateInterval, DatasetUpdateOptions } from './types.js';

export const MIN_UPDATE_GAP_HOURS = 1;
export const MAX_UPDATE_GAP_HOURS = 720;

const HOUR = 3_600_000;
export const INTERVAL_MS: Record<Exclude<DatasetUpdateInterval, 'off'>, number> = {
  daily: 24 * HOUR,
  weekly: 7 * 24 * HOUR,
  monthly: 30 * 24 * HOUR,
};

export type UpdateTrigger = 'startup' | 'alarm' | 'manual';
export type UpdateResult = 'updated' | 'unchanged' | 'failed';

/** Per data set, kept in chrome.storage.local. */
export interface DatasetUpdateRecord {
  /** When the last automatic or manual attempt started (written before fetching). */
  lastAttempt: number;
  /** When the last attempt finished successfully (updated or unchanged). */
  lastChecked?: number;
  lastResult?: UpdateResult;
  lastError?: string;
}
export type DatasetUpdateState = Partial<Record<DatasetKind, DatasetUpdateRecord>>;

export interface Needed {
  geosite: boolean;
  geoip: boolean;
  asn: boolean;
}

export type SkipReason = 'not-url' | 'not-needed' | 'too-soon' | 'not-due' | 'disabled';

export interface Decision {
  kind: DatasetKind;
  due: boolean;
  reason?: SkipReason;
  /** Earliest time an automatic attempt is allowed (minimum gap). */
  notBefore: number;
}

/** Result of one data set in an update run (shown on the Data sets page). */
export interface UpdateOutcome {
  kind: DatasetKind;
  result: UpdateResult | 'skipped';
  reason?: SkipReason;
  error?: string;
  summary?: string;
}

export function isUrlSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function minGapMs(opts: DatasetUpdateOptions): number {
  const h = Math.min(MAX_UPDATE_GAP_HOURS, Math.max(MIN_UPDATE_GAP_HOURS, Math.round(opts.minIntervalHours) || MIN_UPDATE_GAP_HOURS));
  return h * HOUR;
}

/** Whether automatic updates can ever run with these options. */
export function autoUpdatesEnabled(opts: DatasetUpdateOptions): boolean {
  return opts.onStartup || opts.interval !== 'off';
}

/** Decide, per installed data set, whether it should be fetched now. */
export function planUpdates(p: {
  now: number;
  trigger: UpdateTrigger;
  opts: DatasetUpdateOptions;
  metas: readonly DatasetMeta[];
  state: DatasetUpdateState;
  needed: Needed;
}): Decision[] {
  const { now, trigger, opts, metas, state, needed } = p;
  const gap = minGapMs(opts);
  const period = opts.interval === 'off' ? null : INTERVAL_MS[opts.interval];
  return metas.map((meta): Decision => {
    const rec = state[meta.kind];
    const notBefore = rec ? rec.lastAttempt + gap : 0;
    const skip = (reason: SkipReason): Decision => ({ kind: meta.kind, due: false, reason, notBefore });
    if (!isUrlSource(meta.source)) return skip('not-url');
    if (opts.onlyNeeded && trigger !== 'manual' && !needed[meta.kind]) return skip('not-needed');
    if (trigger === 'manual') return { kind: meta.kind, due: true, notBefore };
    if (!autoUpdatesEnabled(opts)) return skip('disabled');
    if (now < notBefore) return skip('too-soon');
    // Measured from the later of the last check and when the file was saved, so a manual
    // download (which saves the file but writes no record) also counts as fresh.
    const overdue = period !== null && now - Math.max(rec?.lastChecked ?? 0, meta.savedAt) >= period;
    if (trigger === 'startup' && (opts.onStartup || overdue)) return { kind: meta.kind, due: true, notBefore };
    if (trigger === 'alarm' && overdue) return { kind: meta.kind, due: true, notBefore };
    return skip('not-due');
  });
}

export function dueDatasets(p: Parameters<typeof planUpdates>[0]): DatasetKind[] {
  return planUpdates(p).filter((d) => d.due).map((d) => d.kind);
}
