// Messages between extension pages (popup/options) and the background service worker,
// plus the status shapes they exchange. Settings are not sent through messages:
// pages write chrome.storage.local and the worker reacts to storage.onChanged.

import type { DatasetMeta } from './dataset-store.js';
import type { LocaleProfile, ResolutionSource, RuleAction } from './types.js';

export type SessionState =
  /** No debugger session and none needed (SYSTEM site, or spoofing off). */
  | 'none'
  | 'attaching'
  | 'attached'
  /** The page cannot be debugged (chrome://, Web Store, policy-blocked, other extension frames). */
  | 'restricted'
  /** Attaching failed for another reason; see `error`. */
  | 'failed';

export interface ResolutionSummary {
  action: RuleAction;
  source: ResolutionSource;
  ruleId: string | null;
  ruleLabel: string | null;
  profile: LocaleProfile | null;
  /** Server address used for IP rules, if known. */
  ip: string | null;
}

export interface TabStatus {
  tabId: number;
  host: string | null;
  resolution: ResolutionSummary;
  session: SessionState;
  /** Profile currently applied to the tab's main target (null = no overrides). */
  applied: LocaleProfile | null;
  /** The current document started before the right overrides were in place. */
  late: boolean;
  lateReason: string | null;
  autoReloaded: boolean;
  /** Human-readable problems (shared renderer process, unsupported commands, …). */
  warnings: string[];
  frames: number;
  workers: number;
  error: string | null;
  updatedAt: number;
}

export interface GlobalStatus {
  enabled: boolean;
  /** Spoofing paused because the user dismissed Chrome's debugging banner. */
  suspended: boolean;
  attachedTabs: number;
  settingsProblems: string[];
  dnr: { active: boolean; ruleCount: number; skipped: string[]; error: string | null };
  datasets: { installed: DatasetMeta[]; problems: string[]; ipCacheSize: number; watchingIps: boolean };
}

export interface HostTest {
  host: string | null;
  resolution: ResolutionSummary;
  /** Matching rules, best first (labels). */
  matches: { label: string; action: string; ruleId: string }[];
  /** Where the address came from. */
  ipSource: 'literal' | 'observed' | 'given' | 'unknown';
  country: string | null;
  asn: number | null;
  problems: string[];
}

export interface LocaleSnapshot {
  language: string;
  languages: string[];
  dateLocale: string;
  numberLocale: string;
  collatorLocale: string;
  pluralRulesLocale: string;
  relativeTimeLocale: string;
  listFormatLocale: string;
  timeZone: string;
}

export interface FrameVerification {
  kind: 'main' | 'iframe';
  url: string;
  /** Values recorded at document start by the isolated-world probe (null if the document predates the session). */
  start: LocaleSnapshot | null;
  live: LocaleSnapshot | null;
  expectedLocale: string | null;
  error: string | null;
}

export interface VerifyResult {
  ok: boolean;
  attached: boolean;
  frames: FrameVerification[];
  error: string | null;
}

export interface LogEntry {
  t: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  tabId: number | null;
  msg: string;
}

export type Request =
  | { type: 'getStatus'; tabId: number }
  | { type: 'listStatuses' }
  | { type: 'verify'; tabId: number }
  | { type: 'reloadTab'; tabId: number }
  | { type: 'resume' }
  | { type: 'detachAll' }
  | { type: 'getLog' }
  | { type: 'testHost'; host: string; ip?: string }
  | { type: 'datasetsChanged' }
  | { type: 'geositeCategories' };

export interface ResponseMap {
  getStatus: { status: TabStatus | null; global: GlobalStatus };
  listStatuses: { statuses: TabStatus[]; global: GlobalStatus };
  verify: VerifyResult;
  reloadTab: { ok: boolean };
  resume: { ok: boolean };
  detachAll: { detached: number };
  getLog: { entries: LogEntry[] };
  testHost: HostTest;
  datasetsChanged: { ok: boolean; problems: string[] };
  geositeCategories: { names: string[] };
}

export type Response<T extends Request['type']> = ResponseMap[T] | { error: string };

export async function send<T extends Request>(req: T): Promise<ResponseMap[T['type']]> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T['type']> | undefined;
  if (!res) throw new Error('No response from the background service worker.');
  if ('error' in res && typeof res.error === 'string' && Object.keys(res).length === 1) throw new Error(res.error);
  return res as ResponseMap[T['type']];
}
