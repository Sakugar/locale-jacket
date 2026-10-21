// Automatic updates of downloaded data sets (opt-in, see Options ▸ Data sets).
// Triggered when the browser starts, by an hourly alarm (which only checks whether
// the chosen interval has passed) or manually. Every attempt is recorded before the
// request is sent, so failures and worker restarts still count against the minimum gap.

import type { DatasetKind, DatasetMeta } from '../shared/dataset-store.js';
import { downloadDataset, type DownloadOptions } from '../shared/dataset-download.js';
import { planUpdates, type DatasetUpdateState, type Needed, type UpdateOutcome, type UpdateResult, type UpdateTrigger } from '../shared/dataset-schedule.js';
import type { DatasetUpdateOptions } from '../shared/types.js';

export interface UpdaterDeps {
  now: () => number;
  options: () => DatasetUpdateOptions;
  needed: () => Needed;
  listMetas: () => Promise<DatasetMeta[]>;
  getState: () => Promise<DatasetUpdateState>;
  setState: (s: DatasetUpdateState) => Promise<void>;
  /** Called once after one or more data sets were replaced. */
  onUpdated: () => Promise<void>;
  log: (level: 'info' | 'warn', msg: string) => void;
  download?: typeof downloadDataset;
  downloadOptions?: Pick<DownloadOptions, 'fetch' | 'store'>;
  /** Keeps the service worker alive during long downloads. */
  keepAlive?: () => () => void;
}

const LABEL: Record<DatasetKind, string> = { geosite: 'GeoSite', geoip: 'GeoIP', asn: 'ASN' };

export class DatasetUpdater {
  private running: Promise<UpdateOutcome[]> | null = null;

  constructor(private readonly d: UpdaterDeps) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** Run once; a call while a run is in progress joins that run. */
  run(trigger: UpdateTrigger): Promise<UpdateOutcome[]> {
    if (!this.running) this.running = this.runOnce(trigger).finally(() => (this.running = null));
    return this.running;
  }

  private async runOnce(trigger: UpdateTrigger): Promise<UpdateOutcome[]> {
    const [metas, state] = await Promise.all([this.d.listMetas(), this.d.getState()]);
    const opts = this.d.options();
    const decisions = planUpdates({ now: this.d.now(), trigger, opts, metas, state, needed: this.d.needed() });
    const outcomes: UpdateOutcome[] = [];
    const due = decisions.filter((x) => x.due);
    for (const x of decisions.filter((x) => !x.due)) {
      outcomes.push({ kind: x.kind, result: 'skipped', reason: x.reason });
      if (x.reason === 'too-soon' && trigger !== 'alarm') {
        const hours = Math.max(0, Math.round((x.notBefore - this.d.now()) / 360_000) / 10);
        this.d.log('info', `${LABEL[x.kind]} update skipped (${trigger}): minimum gap of ${opts.minIntervalHours} h, next attempt in ${hours} h.`);
      }
    }
    if (!due.length) return outcomes;
    const release = this.d.keepAlive?.();
    let changed = false;
    try {
      for (const { kind } of due) {
        const meta = metas.find((m) => m.kind === kind)!;
        state[kind] = { ...state[kind], lastAttempt: this.d.now() };
        await this.d.setState(state);
        try {
          const r = await (this.d.download ?? downloadDataset)(kind, meta.source, {
            ...this.d.downloadOptions,
            conditional: { etag: meta.etag, lastModified: meta.lastModified },
          });
          const result: UpdateResult = r.status === 'saved' ? 'updated' : 'unchanged';
          state[kind] = { lastAttempt: state[kind]!.lastAttempt, lastChecked: this.d.now(), lastResult: result };
          if (r.status === 'saved') {
            changed = true;
            outcomes.push({ kind, result, summary: r.meta.summary });
            this.d.log('info', `${LABEL[kind]} updated (${trigger}): ${r.meta.summary}.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`);
          } else {
            outcomes.push({ kind, result });
            this.d.log('info', `${LABEL[kind]} is up to date (${trigger}, HTTP 304).`);
          }
        } catch (e) {
          const error = (e as Error).message || String(e);
          state[kind] = { ...state[kind]!, lastResult: 'failed', lastError: error };
          outcomes.push({ kind, result: 'failed', error });
          this.d.log('warn', `${LABEL[kind]} update failed (${trigger}): ${error}`);
        }
        await this.d.setState(state);
      }
      if (changed) await this.d.onUpdated();
    } finally {
      release?.();
    }
    return outcomes;
  }
}
