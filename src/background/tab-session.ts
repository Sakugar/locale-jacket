// Per-tab debugger session lifecycle.
//
// One TabSession exists for every tab the extension has seen. While attached:
//   * Fetch pauses every document request. For the main frame, the target URL's
//     profile is sent to the session *before* the request continues, and its
//     Accept-Language header is corrected. Overrides persist across navigations,
//     so this gate is what stops one site's profile leaking into the next document.
//   * Target.setAutoAttach (waitForDebuggerOnStart) hands us every cross-site
//     iframe (OOPIF) and dedicated worker before it runs, so they get overrides
//     from their first script. It is set on every child session too, so frames
//     inside frames and workers started by workers are handed over the same way.
//   * webNavigation events reconcile state for navigations the gate cannot see
//     (service-worker-served documents, back/forward cache, prerender). A probe
//     recorded at document start (in an isolated world) tells whether page scripts
//     saw the right values; if not, the document is flagged "late".
//
// Deadlock rule: the Fetch gate and child-target setup never wait for anything.
// Chrome holds renderer-bound commands while a cross-process navigation is
// pending, and that navigation cannot proceed until the gate continues it.
// Attach/detach transitions and bookkeeping run in a per-tab serial queue.

import {
  CommandTimeoutError,
  errorMessage,
  withTimeout,
  isAlreadyAttachedError,
  isAttachableUrl,
  isDetachedError,
  isRestrictedError,
  isSessionGone,
  type DebuggerPort,
} from './cdp.js';
import { applyState, CLEAN_STATE, desiredFor, fixAcceptLanguage, UNKNOWN_STATE, type AppliedState, type TargetKind } from './overrides.js';
import { PROBE_WORLD, PROBE_SOURCE, VERIFY_EXPRESSION, type PageLocale } from './probe.js';
import { hostFromUrl, roughSite } from '../shared/domain.js';
import { t } from '../shared/i18n.js';
import { profileKey } from '../shared/locale.js';
import type { FrameVerification, LocaleSnapshot, LogEntry, SessionState, TabStatus, VerifyResult } from '../shared/messages.js';
import { ruleLabel } from '../shared/rules.js';
import type { LocaleProfile, Resolution, Settings } from '../shared/types.js';

export interface TabContext {
  port: DebuggerPort;
  settings(): Settings;
  /** Enabled, not suspended, and at least one rule or the default can spoof. */
  spoofingActive(): boolean;
  reloadTab(tabId: number): Promise<void>;
  /** Current URL of the tab as Chrome reports it (for fallbacks). */
  getTabUrl(tabId: number): Promise<string | null>;
  changed(tabId: number): void;
  log(level: LogEntry['level'], tabId: number | null, msg: string): void;
  now(): number;
  /** The browser's own locale values (what SYSTEM pages should report). */
  native(): { locale: string; languages: string[] };
  /** Resolve a hostname with the current rules, datasets and known server address. */
  resolve(host: string | null): Resolution;
  /**
   * The tab's top-level navigation that has not committed yet, if any, with its HTTP
   * method when that request was observed (undefined = unknown).
   */
  pendingNavigation?(tabId: number): Promise<{ url: string; method?: string } | null>;
  /** The browser or the extension started moments ago (startup pages, restored tabs). */
  justStarted?(): boolean;
  /**
   * Another tab spoofs a page or frame that may be same-site with `host` (see roughSite),
   * so a page of `host` can end up in that renderer process and get its Intl locale.
   */
  spoofedNearby?(host: string, tabId: number): boolean;
  /** What the tab's main document reports, read without the debugger. */
  readPageLocale?(tabId: number): Promise<PageLocale | null>;
}

export interface CommitDetails {
  url: string;
  transitionType?: string;
  transitionQualifiers?: string[];
  timeStamp?: number;
}

interface Child {
  sessionId: string;
  targetId: string;
  type: 'iframe' | 'worker';
  url: string;
  parentSessionId: string | null;
  state: AppliedState;
  warnings: string[];
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export interface PausedRequest {
  requestId: string;
  frameId?: string;
  resourceType?: string;
  request: { url: string; method?: string; headers: Record<string, string>; referrerPolicy?: string };
}

export const AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'iframe' }, { type: 'worker' }],
};

const FETCH_PATTERNS = { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] };

/** Navigations the user started deliberately; only these may be auto-reloaded. */
const RELOADABLE_TRANSITIONS = new Set(['link', 'typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page', 'auto_toplevel']);
const ATTACH_FAILURE_WINDOW_MS = 60_000;
const MAX_ATTACH_FAILURES = 3;
const AUTO_RELOAD_MAX_AGE_MS = 10_000;
const AUTO_RELOAD_COOLDOWN_MS = 30_000;
const AUTO_RELOAD_MAX_PER_WINDOW = 3;
/** A re-issued navigation that still mismatches is let through instead of looping. */
const REISSUE_GUARD_MS = 5_000;
/** How long to wait for the profile commands before re-issuing anyway. */
const REISSUE_APPLY_TIMEOUT_MS = 3_000;

// Fetch reports the Fetch-spec spelling; Page.navigate wants the CDP enum.
const REFERRER_POLICIES: Record<string, string> = {
  'no-referrer': 'noReferrer',
  'no-referrer-when-downgrade': 'noReferrerWhenDowngrade',
  origin: 'origin',
  'origin-when-cross-origin': 'originWhenCrossOrigin',
  'same-origin': 'sameOrigin',
  'strict-origin': 'strictOrigin',
  'strict-origin-when-cross-origin': 'strictOriginWhenCrossOrigin',
  'unsafe-url': 'unsafeUrl',
};

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

export function probeMatches(probe: LocaleSnapshot | null, profile: Pick<LocaleProfile, 'locale' | 'languages'>): boolean {
  return !!probe && probe.dateLocale === profile.locale && probe.language === profile.languages[0];
}

export class TabSession {
  state: 'detached' | 'attaching' | 'attached' = 'detached';
  private mainFrameId: string | null = null;
  /** Intended overrides on the main target (optimistic; failed commands reset fields to unknown). */
  private mainState: AppliedState = CLEAN_STATE;
  /** Profile last sent to the main target; frames inherit it. */
  private targetProfile: LocaleProfile | null = null;
  private appliedKey: string | null = null;
  private applyWarnings: string[] = [];
  private readonly children = new Map<string, Child>();
  /** Subframe document URLs seen by the gate, keyed by frame id (= the OOPIF's target id). */
  private readonly frameUrls = new Map<string, string>();
  private url: string | null = null;
  private resolution: Resolution;
  private sessionStatus: SessionState = 'none';
  private late = false;
  private lateReason: string | null = null;
  /**
   * The document's Intl locale comes from another session in its renderer process (the
   * locale override is process-wide). Reported as a warning; a reload would not help.
   */
  private sharedWarning: string | null = null;
  /** Bumped on every commit, so a check of the previous document is dropped. */
  private documentSeq = 0;
  /** Recent automatic reloads (URL and time), to rule out loops. */
  private autoReloads: { url: string; at: number }[] = [];
  private error: string | null = null;
  private pendingGateUrl: string | null = null;
  /**
   * Navigation aborted and re-issued by the gate. `abortErrors` counts the error events our
   * own abort still owes; only those are ignored, so a re-issued navigation that fails or
   * ends without a document (204, download) still reverts to the committed page's profile.
   */
  private reissue: { url: string; at: number; abortErrors: number } | null = null;
  /** Last main-frame navigation start reported by Page.frameStartedNavigating (tells history traversals apart). */
  private lastStart: { url: string; type: string } | null = null;
  private attachFailures: number[] = [];
  /**
   * Chrome may hold a session for this tab although `state` is 'detached' (an attach
   * that timed out can still complete). Detach paths must not skip such a session.
   */
  private mayHoldSession = false;
  /** Bumped whenever the session ends; answers from an older session are ignored. */
  private generation = 0;
  private closed = false;
  private readonly queue = new SerialQueue();

  constructor(
    readonly tabId: number,
    private readonly ctx: TabContext,
    initialUrl: string | null = null,
  ) {
    this.url = initialUrl;
    this.resolution = this.resolveUrl(initialUrl);
  }

  // ---------------------------------------------------------------- helpers

  private settings(): Settings {
    return this.ctx.settings();
  }

  private resolveUrl(url: string | null): Resolution {
    return this.ctx.resolve(url ? hostFromUrl(url) : null);
  }

  private log(level: LogEntry['level'], msg: string): void {
    this.ctx.log(level, this.tabId, msg);
  }

  private needsSession(res: Resolution): boolean {
    if (!this.ctx.spoofingActive()) return false;
    return res.action === 'PROFILE' || this.settings().options.frameMode === 'per-frame';
  }

  private keepSession(res: Resolution): boolean {
    return this.needsSession(res) || (this.ctx.spoofingActive() && this.settings().options.keepSessionOnSystem);
  }

  private isApplied(res: Resolution): boolean {
    return this.state === 'attached' && this.appliedKey === profileKey(res.profile);
  }

  private resetSessionState(): void {
    this.generation++;
    this.state = 'detached';
    this.mainFrameId = null;
    this.mainState = CLEAN_STATE;
    this.targetProfile = null;
    this.appliedKey = null;
    this.applyWarnings = [];
    this.children.clear();
    this.frameUrls.clear();
    this.pendingGateUrl = null;
  }

  private lostSession(where: string): void {
    if (this.state === 'detached') return;
    this.log('warn', `Debugger session lost during ${where}.`);
    // A command saying "not attached" does not prove Chrome let go of the session (Fetch,
    // auto-attach and overrides would stay in place), so end it on our side as well.
    this.releaseSession();
    this.resetSessionState();
    this.sessionStatus = 'none';
    this.ctx.changed(this.tabId);
  }

  /**
   * Best-effort detach, not awaited. chrome.debugger.detach is called synchronously, so it
   * reaches Chrome before any later attach and cannot end a newer session.
   */
  private releaseSession(): void {
    this.mayHoldSession = false;
    void this.ctx.port.detach(this.tabId).catch(() => undefined);
  }

  // ---------------------------------------------------------------- attach

  private async ensureAttached(url: string | null): Promise<boolean> {
    if (this.state === 'attached') return true;
    if (this.closed || !this.ctx.spoofingActive()) return false;
    if (!isAttachableUrl(url)) {
      this.sessionStatus = 'restricted';
      this.error = null;
      return false;
    }
    const now = this.ctx.now();
    this.attachFailures = this.attachFailures.filter((t) => now - t < ATTACH_FAILURE_WINDOW_MS);
    if (this.attachFailures.length >= MAX_ATTACH_FAILURES) {
      this.sessionStatus = 'failed';
      return false;
    }

    this.state = 'attaching';
    this.sessionStatus = 'attaching';
    this.mayHoldSession = true;
    const gen = this.generation;
    let adopted = false;
    try {
      await this.ctx.port.attach(this.tabId);
    } catch (e) {
      if (isAlreadyAttachedError(e)) {
        // Our own session survived a service-worker restart; reuse it.
        adopted = true;
      } else {
        this.state = 'detached';
        // An attach that timed out may still complete in Chrome.
        this.mayHoldSession = e instanceof CommandTimeoutError;
        this.error = errorMessage(e);
        if (isRestrictedError(e)) {
          this.sessionStatus = 'restricted';
          this.log('debug', `Cannot debug this page: ${this.error}`);
        } else {
          this.attachFailures.push(now);
          this.sessionStatus = 'failed';
          this.log('warn', `Attach failed: ${this.error}`);
        }
        return false;
      }
    }

    const t = { tabId: this.tabId };
    const send = this.ctx.port.send.bind(this.ctx.port);
    // The page target's id is its main frame id. getTargets and the Fetch/Target
    // domains are handled by the browser, so they work even while a navigation is
    // pending; the renderer-side Page commands below may wait for that commit.
    this.mainFrameId = await this.ctx.port.targetIdForTab(this.tabId).catch(() => null);
    if (this.closed) {
      this.mayHoldSession = false;
      await this.ctx.port.detach(this.tabId).catch(() => undefined);
      this.resetSessionState();
      return false;
    }
    // Chrome ended the session meanwhile; onDebuggerDetached recorded why.
    if (gen !== this.generation) return false;
    this.state = 'attached';
    this.sessionStatus = 'attached';
    this.error = null;
    this.mainState = adopted ? { ...UNKNOWN_STATE } : { ...CLEAN_STATE };
    this.appliedKey = null;
    try {
      await send(t, 'Fetch.enable', FETCH_PATTERNS);
      if (adopted) {
        // Re-announce existing children so we learn their session ids again.
        await send(t, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
      }
      await send(t, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
    } catch (e) {
      if (isSessionGone(e)) {
        if (gen !== this.generation) return false;
        this.lostSession('setup');
        // Counts as a failed attach, so a session that cannot be set up (e.g. an "already
        // attached" one that belongs to another client) is not retried forever.
        this.attachFailures.push(now);
        this.sessionStatus = 'failed';
        this.error = errorMessage(e);
        // lostSession reported the status before it became 'failed'; refresh the badge.
        this.ctx.changed(this.tabId);
        return false;
      }
      // Overrides still work without the gate or auto-attach; report it.
      this.log('warn', `Navigation gate / frame auto-attach unavailable: ${errorMessage(e)}`);
    }
    this.attachFailures = [];
    if (!this.mainFrameId) {
      void send<{ frameTree: { frame: { id: string } } }>(t, 'Page.getFrameTree')
        .then((tree) => {
          this.mainFrameId ??= tree.frameTree.frame.id;
        })
        .catch(() => undefined);
    }
    // Document-start probe (diagnostics only); not awaited for the same reason.
    void send(t, 'Page.enable')
      .then(() => send(t, 'Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE, worldName: PROBE_WORLD }))
      .catch((e) => {
        if (!isDetachedError(e)) this.log('debug', `Probe unavailable: ${errorMessage(e)}`);
      });
    this.log('info', adopted ? 'Adopted existing debugger session.' : 'Debugger attached.');
    return this.state === 'attached';
  }

  private async detachInternal(reason: string): Promise<void> {
    if (this.state === 'detached' && !this.mayHoldSession) return;
    this.mayHoldSession = false;
    await this.ctx.port.detach(this.tabId).catch(() => undefined);
    this.resetSessionState();
    this.sessionStatus = 'none';
    this.late = false;
    this.lateReason = null;
    this.log('info', `Debugger detached (${reason}).`);
  }

  // ---------------------------------------------------------------- applying

  /** Send the profile to the main target now; the returned promise settles when Chrome answers. */
  private applyMain(res: Resolution, withChildren: boolean): Promise<void> {
    if (this.state !== 'attached') return Promise.resolve();
    const desired = desiredFor(res.profile, 'page');
    this.targetProfile = res.profile;
    const ticket = applyState(this.ctx.port, { tabId: this.tabId }, this.mainState, desired, 'page');
    this.mainState = ticket.state;
    this.appliedKey = profileKey(res.profile);
    const childrenDone = withChildren ? this.applyChildren() : Promise.resolve();
    if (!ticket.sent) return childrenDone;
    const gen = this.generation;
    const done = ticket.done.then((r) => {
      if (gen !== this.generation) return; // an answer from a session that has since ended
      if (r.detached) return this.lostSession('apply');
      for (const f of r.failed) {
        if (this.mainState[f.field] === f.value) {
          this.mainState[f.field] = undefined; // unknown: resend next time
          this.appliedKey = null;
        }
      }
      this.applyWarnings = r.warnings;
      for (const w of r.warnings) this.log('warn', w);
      this.ctx.changed(this.tabId);
    });
    return Promise.all([done, childrenDone]).then(() => undefined);
  }

  private childProfile(child: Child, depth = 0): LocaleProfile | null {
    if (depth > 16) return this.targetProfile;
    if (child.type === 'worker') {
      const parent = child.parentSessionId ? this.children.get(child.parentSessionId) : undefined;
      return parent ? this.childProfile(parent, depth + 1) : this.targetProfile;
    }
    if (this.settings().options.frameMode === 'per-frame' && child.url && hostFromUrl(child.url)) {
      return this.resolveUrl(child.url).profile;
    }
    return this.targetProfile;
  }

  private applyChild(child: Child): Promise<void> {
    const kind: TargetKind = child.type;
    const profile = kind === 'worker' && !this.settings().options.overrideWorkers ? null : this.childProfile(child);
    const ticket = applyState(this.ctx.port, { tabId: this.tabId, sessionId: child.sessionId }, child.state, desiredFor(profile, kind), kind);
    child.state = ticket.state;
    if (!ticket.sent) return Promise.resolve();
    const gen = this.generation;
    return ticket.done.then((r) => {
      if (gen !== this.generation) return;
      if (r.detached) {
        this.children.delete(child.sessionId);
        return;
      }
      for (const f of r.failed) if (child.state[f.field] === f.value) child.state[f.field] = undefined;
      child.warnings = r.warnings;
      for (const w of r.warnings) this.log('debug', `child ${child.type}: ${w}`);
      for (const f of r.failed) this.log('debug', `child ${child.type}: ${f.field} failed`);
    });
  }

  private applyChildren(): Promise<void> {
    return Promise.all([...this.children.values()].map((c) => this.applyChild(c))).then(() => undefined);
  }

  private markLate(reason: string | null, details: CommitDetails | null): void {
    if (!reason) {
      this.late = false;
      this.lateReason = null;
      return;
    }
    this.late = true;
    this.lateReason = reason;
    this.log('info', `Late override: ${reason}`);
    if (details) this.maybeAutoReload(details);
  }

  private maybeAutoReload(d: CommitDetails): void {
    const now = this.ctx.now();
    if (!this.settings().options.reloadOnLate) return;
    // A reload helps if at least navigator.language / Accept-Language are in place; a
    // process-wide Intl lock held by another tab or DevTools would survive the reload.
    if (this.state !== 'attached' || this.mainState.languages !== desiredFor(this.resolution.profile, 'page').languages) return;
    if (!RELOADABLE_TRANSITIONS.has(d.transitionType ?? '')) return;
    if ((d.transitionQualifiers ?? []).includes('forward_back')) return;
    if (d.timeStamp && now - d.timeStamp > AUTO_RELOAD_MAX_AGE_MS) return;
    // Never reload the same URL twice within the cool-down, and at most a few pages per
    // tab in that window (each new host can need one reload when IP rules are used).
    this.autoReloads = this.autoReloads.filter((r) => now - r.at < AUTO_RELOAD_COOLDOWN_MS);
    if (this.autoReloads.some((r) => r.url === this.url) || this.autoReloads.length >= AUTO_RELOAD_MAX_PER_WINDOW) return;
    this.autoReloads.push({ url: this.url ?? '', at: now });
    this.log('info', 'Reloading once so page scripts start with the locale profile.');
    this.ctx.reloadTab(this.tabId).catch((e) => this.log('warn', `Reload failed: ${errorMessage(e)}`));
  }

  /**
   * The debugger attached while the tab's navigation was already in flight: its request
   * went out before the gate existed, and overrides sent now would reach the renderer
   * only after the new document's scripts start. Stop it, apply the profile while no
   * navigation is pending, and load the page again through the gate, so it renders once,
   * already spoofed, instead of loading and then reloading.
   *
   * Only for loads that can safely be repeated: a GET seen by webRequest, or (method
   * unknown) the browser's own loads right after it or the extension started. Once per
   * URL, like the automatic reload, and under the same option. Returns whether it did.
   */
  private async restartPendingNavigation(): Promise<boolean> {
    if (this.state !== 'attached' || !this.settings().options.reloadOnLate || !this.ctx.pendingNavigation) return false;
    const pending = await this.ctx.pendingNavigation(this.tabId).catch(() => null);
    if (!pending || this.state !== 'attached') return false;
    const url = pending.url;
    // The gate already holds this request and re-issues it itself.
    if (this.pendingGateUrl === stripHash(url)) return false;
    const res = this.resolveUrl(url);
    if (res.action !== 'PROFILE') return false;
    const repeatable = pending.method ? pending.method.toUpperCase() === 'GET' : this.ctx.justStarted?.() === true;
    if (!repeatable) return false;
    const now = this.ctx.now();
    this.autoReloads = this.autoReloads.filter((r) => now - r.at < AUTO_RELOAD_COOLDOWN_MS);
    if (this.autoReloads.some((r) => r.url === url) || this.autoReloads.length >= AUTO_RELOAD_MAX_PER_WINDOW) return false;
    this.autoReloads.push({ url, at: now });
    this.reissue = { url, at: now, abortErrors: 1 }; // the stopped navigation reports an error; ignore it
    this.url = url;
    this.resolution = res;
    const t = { tabId: this.tabId };
    this.log('info', 'Page load began before the debugger attached; restarting it with the locale profile.');
    // If this does not work out, the commit handles the page like any late one (reload
    // once), so it must not count as this URL's one automatic reload.
    const giveBack = () => {
      this.autoReloads = this.autoReloads.filter((r) => r.url !== url);
      this.reissue = null;
    };
    try {
      // Both are handled by the browser, so they work while the navigation is pending.
      await this.ctx.port.send(t, 'Page.stopLoading');
    } catch (e) {
      giveBack();
      if (isSessionGone(e)) {
        this.log('debug', `Page.stopLoading: ${errorMessage(e)}`);
        this.lostSession('restart');
      } else {
        this.log('warn', `Could not restart the page load: ${errorMessage(e)}`);
      }
      return false;
    }
    // The old load may have been committing into another renderer process already; the
    // profile commands then fail or reset the session state. Load the page anyway (it
    // was stopped), and let the commit reload it if it still started unspoofed.
    await withTimeout(this.applyMain(res, true), REISSUE_APPLY_TIMEOUT_MS, () => new Error('profile commands timed out')).catch((e) =>
      this.log('warn', `Restarting without confirmation: ${errorMessage(e)}`),
    );
    if (this.state !== 'attached' || this.appliedKey !== profileKey(res.profile)) giveBack();
    // A load that was already committing when it was stopped still commits (in Chrome its
    // commit can arrive before Page.stopLoading answers). Page.navigate to the URL it
    // committed is not turned into a replacement: it adds a second history entry for the
    // same page. So load that document again with a reload instead, which keeps the entry.
    const committed = await this.currentEntryIs(url);
    if (committed) this.log('debug', 'The stopped load had already committed; reloading it instead.');
    const [method, params] = committed ? ['Page.reload', {}] : ['Page.navigate', { url, transitionType: 'link' }];
    await this.ctx.port.send(t, method, params).catch((e) => {
      giveBack();
      this.log('warn', `Could not restart the page load: ${errorMessage(e)}`);
    });
    return true;
  }

  /** The tab's current history entry is `url` (browser-side, so it answers while a navigation is pending). */
  private async currentEntryIs(url: string): Promise<boolean> {
    try {
      const h = await this.ctx.port.send<{ currentIndex: number; entries: { url: string }[] }>({ tabId: this.tabId }, 'Page.getNavigationHistory');
      const current = h.entries[h.currentIndex]?.url;
      return !!current && stripHash(current) === stripHash(url);
    } catch {
      return false; // unknown: navigate, as before
    }
  }

  /**
   * An already-open page that started loading moments ago (the browser's startup page,
   * the restored active tab) began before this worker could attach, so its scripts saw
   * the real locale. Treat it like a late fresh navigation: reload once. Pages opened
   * earlier keep the "reload it" hint only. Not awaited: Runtime.evaluate waits while a
   * navigation is pending, and that navigation's commit is handled on its own.
   */
  private reloadIfJustOpened(): void {
    if (!this.settings().options.reloadOnLate) return;
    const url = this.url;
    void this.ctx.port
      .send<{ result?: { value?: unknown } }>({ tabId: this.tabId }, 'Runtime.evaluate', { expression: 'performance.timeOrigin', returnByValue: true })
      .then((r) => {
        const started = r.result?.value;
        if (typeof started !== 'number' || this.url !== url || !this.late) return;
        this.maybeAutoReload({ url: url ?? '', transitionType: 'start_page', timeStamp: started });
      })
      .catch(() => undefined);
  }

  /** Values recorded by the isolated-world probe when the current main document started. */
  private async readStartProbe(): Promise<LocaleSnapshot | null> {
    if (!this.mainFrameId) return null;
    const t = { tabId: this.tabId };
    const world = await this.ctx.port.send<{ executionContextId: number }>(t, 'Page.createIsolatedWorld', {
      frameId: this.mainFrameId,
      worldName: PROBE_WORLD,
    });
    const r = await this.ctx.port.send<{ result?: { value?: LocaleSnapshot | null } }>(t, 'Runtime.evaluate', {
      contextId: world.executionContextId,
      expression: 'globalThis.__ljProbe || null',
      returnByValue: true,
    });
    return r.result?.value ?? null;
  }

  // ---------------------------------------------------------------- events

  /** chrome.tabs.onCreated / startup reconciliation: attach as early as possible. */
  onTabSeen(url: string | null, existingDocument: boolean): Promise<void> {
    return this.queue.run(async () => {
      if (url && existingDocument) {
        this.url = url;
        this.resolution = this.resolveUrl(url);
      }
      const res = existingDocument ? this.resolution : this.resolveUrl(url);
      if (this.state !== 'attached' && this.needsSession(res)) {
        // For a tab that is still loading, attaching is enough: the gate applies the
        // profile to its navigation (or, if its request already went out, the load is
        // restarted through the gate). Applying now would race with that navigation.
        const attached = await this.ensureAttached(url);
        const restarted = attached && (await this.restartPendingNavigation());
        if (attached && !restarted && existingDocument) {
          await this.applyMain(res, true);
          if (res.action === 'PROFILE') {
            this.markLate(t('bg.late.alreadyOpen'), null);
            this.reloadIfJustOpened();
          }
        }
      } else if (this.state !== 'attached') {
        this.sessionStatus = 'none';
      }
      this.ctx.changed(this.tabId);
    });
  }

  onBeforeNavigate(url: string): Promise<void> {
    return this.queue.run(async () => {
      // Attach only. Sending overrides now would reach the renderer after the next
      // document starts and would mark the profile as applied, defeating the gate.
      const res = this.resolveUrl(url);
      if (this.state !== 'attached' && this.needsSession(res) && (await this.ensureAttached(url))) await this.restartPendingNavigation();
      this.ctx.changed(this.tabId);
    });
  }

  /**
   * Fetch.requestPaused. Deliberately not queued and never awaits (see the deadlock rule).
   *
   * Same profile as the current document: continue (fixing Accept-Language if needed).
   * Different profile: Chrome only delivers emulation commands to the next document
   * after it has started (verified in research/gate-timing.mjs), so for GET requests
   * the navigation is aborted before anything is sent to the server, the new profile
   * is applied while no navigation is pending, and the navigation is re-issued.
   */
  onRequestPaused(p: PausedRequest): void {
    let headers: { name: string; value: string }[] | null = null;
    try {
      const url = p.request.url;
      if (this.state === 'attached' && p.frameId && p.frameId === this.mainFrameId) {
        const res = this.resolveUrl(url);
        this.pendingGateUrl = stripHash(url);
        const changing = this.appliedKey !== profileKey(res.profile);
        const method = (p.request.method ?? 'GET').toUpperCase();
        const now = this.ctx.now();
        const recentlyReissued = this.reissue !== null && this.reissue.url === url && now - this.reissue.at < REISSUE_GUARD_MS;
        if (changing && method === 'GET' && !recentlyReissued) {
          this.reissueNavigation(p, res);
          return;
        }
        if (changing) void this.applyMain(res, false); // POST, or a re-issue that still mismatches: best effort
        headers = fixAcceptLanguage(p.request.headers, res.profile);
        this.log('debug', `gate: ${res.host ?? url} → ${res.profile?.locale ?? 'SYSTEM'}${changing ? ' (late: could not re-issue)' : ''}`);
      } else if (this.state === 'attached') {
        if (p.frameId) {
          // The OOPIF target for this frame attaches later with an empty URL; remember it.
          this.frameUrls.set(p.frameId, url);
          if (this.frameUrls.size > 200) this.frameUrls.delete(this.frameUrls.keys().next().value!);
        }
        const profile = this.settings().options.frameMode === 'per-frame' ? this.resolveUrl(url).profile : this.targetProfile;
        headers = fixAcceptLanguage(p.request.headers, profile);
      }
    } catch (e) {
      this.log('warn', `Navigation gate error: ${errorMessage(e)}`);
    }
    const params: Record<string, unknown> = { requestId: p.requestId };
    if (headers) params.headers = headers;
    this.ctx.port.send({ tabId: this.tabId }, 'Fetch.continueRequest', params).catch((e) => {
      if (!isDetachedError(e)) this.log('warn', `Fetch.continueRequest failed: ${errorMessage(e)}`);
    });
  }

  private reissueNavigation(p: PausedRequest, res: Resolution): void {
    const url = p.request.url;
    const t = { tabId: this.tabId };
    const reissue = { url, at: this.ctx.now(), abortErrors: 1 };
    this.reissue = reissue;
    this.log('debug', `gate: ${res.host ?? url} → ${res.profile?.locale ?? 'SYSTEM'} (profile change: aborting and re-issuing)`);
    const applied = this.applyMain(res, false);
    const referrer = Object.entries(p.request.headers).find(([k]) => k.toLowerCase() === 'referer')?.[1];
    const policy = p.request.referrerPolicy ? REFERRER_POLICIES[p.request.referrerPolicy] : undefined;
    const kind = this.lastStart && this.lastStart.url === stripHash(url) ? this.lastStart.type : 'differentDocument';
    this.ctx.port
      .send(t, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' })
      .then(async () => {
        // With no navigation pending, the renderer applies the commands right away.
        await withTimeout(applied, REISSUE_APPLY_TIMEOUT_MS, () => new Error('profile commands timed out')).catch((e) =>
          this.log('warn', `Re-issuing without confirmation: ${errorMessage(e)}`),
        );
        // Re-issue in the same way it started, so session history stays intact.
        if (kind === 'reload') {
          await this.ctx.port.send(t, 'Page.reload', {});
          return;
        }
        if (kind === 'historyDifferentDocument') {
          const entryId = await this.historyEntryFor(url);
          if (entryId !== null) {
            await this.ctx.port.send(t, 'Page.navigateToHistoryEntry', { entryId });
            return;
          }
        }
        await this.ctx.port.send(t, 'Page.navigate', {
          url,
          transitionType: 'link',
          ...(referrer ? { referrer } : {}),
          ...(policy ? { referrerPolicy: policy } : {}),
        });
      }, (e) => {
        reissue.abortErrors = 0; // nothing was aborted, so no error event is owed
        throw e;
      })
      .catch((e) => {
        if (!isDetachedError(e)) this.log('warn', `Could not re-issue the navigation: ${errorMessage(e)}`);
      });
  }

  /** The history entry a back/forward traversal was heading to (nearest entry with that URL). */
  private async historyEntryFor(url: string): Promise<number | null> {
    const h = await this.ctx.port.send<{ currentIndex: number; entries: { id: number; url: string }[] }>({ tabId: this.tabId }, 'Page.getNavigationHistory');
    let best: { id: number; distance: number } | null = null;
    h.entries.forEach((e, i) => {
      if (i === h.currentIndex || stripHash(e.url) !== stripHash(url)) return;
      const distance = Math.abs(i - h.currentIndex);
      if (!best || distance < best.distance) best = { id: e.id, distance };
    });
    return best ? (best as { id: number }).id : null;
  }

  /** Page.frameStartedNavigating for any frame of this target. */
  onNavigationStarted(p: { frameId: string; url: string; navigationType: string }): void {
    if (p.frameId === this.mainFrameId) this.lastStart = { url: stripHash(p.url), type: p.navigationType };
  }

  onCommitted(d: CommitDetails): Promise<void> {
    return this.queue.run(() => this.handleCommit(d));
  }

  private wasGated(url: string): boolean {
    return this.pendingGateUrl !== null && this.pendingGateUrl === stripHash(url);
  }

  private async handleCommit(d: CommitDetails): Promise<void> {
    const gated = this.wasGated(d.url);
    this.documentSeq++;
    this.sharedWarning = null;
    this.url = d.url;
    const res = this.resolveUrl(d.url);
    this.resolution = res;
    if (this.state !== 'attached') {
      if (this.needsSession(res) && (await this.ensureAttached(d.url))) {
        await this.applyMain(res, true);
        this.markLate(res.action === 'PROFILE' ? t('bg.late.attachedLate') : null, d);
      } else if (!this.needsSession(res)) {
        this.sessionStatus = 'none';
        this.markLate(null, null);
        if (!res.profile) this.checkSharedProcess(d.url);
      }
      this.ctx.changed(this.tabId);
      return;
    }

    this.pendingGateUrl = null;
    const wasApplied = this.isApplied(res);
    await this.applyMain(res, true);
    // Ask the document-start probe what page scripts actually saw. It is missing when
    // the document predates the probe registration.
    let probe: LocaleSnapshot | null = null;
    try {
      probe = await this.readStartProbe();
    } catch (e) {
      if (!isDetachedError(e)) this.log('debug', `Start probe unavailable: ${errorMessage(e)}`);
    }
    const expected = res.profile ?? this.ctx.native();
    if (probe && !res.profile && probe.language === expected.languages[0] && probe.dateLocale !== expected.locale) {
      // A SYSTEM page whose own values are native, but whose Intl comes from another
      // session in its renderer process: a conflict to report, which a reload would not fix.
      this.noteSharedProcess(probe.dateLocale);
      this.markLate(null, null);
    } else if (probe) {
      this.markLate(probeMatches(probe, expected) ? null : t('bg.late.probe', { language: probe.language, intl: probe.dateLocale, expected: expected.locale }), d);
    } else if (gated || (wasApplied && !res.profile)) {
      this.markLate(null, null); // the gate applied the profile before the request was sent
    } else {
      this.markLate(
        res.profile ? t('bg.late.beforeProfile') : t('bg.late.previousProfile'),
        d,
      );
    }
    if (this.state === 'attached' && !this.keepSession(res)) await this.detachInternal('not needed on this site');
    this.ctx.changed(this.tabId);
  }

  /**
   * A SYSTEM page without a session still shares its renderer process with whatever else
   * runs there, and the locale override is process-wide: a same-site popup opened by a
   * spoofed page gets the opener's Intl locale. Read the page once (a content script, no
   * debugger) when another tab spoofs a page or frame that may be same-site, and report
   * a mismatch. Not awaited: the script runs once the document is ready.
   */
  private checkSharedProcess(url: string): void {
    const host = hostFromUrl(url);
    if (!host || !this.ctx.readPageLocale || !this.ctx.spoofedNearby?.(host, this.tabId)) return;
    const seq = this.documentSeq;
    void this.ctx
      .readPageLocale(this.tabId)
      .then((seen) => {
        // Only for the document it was asked for, and only while no session of ours runs it.
        if (!seen || seq !== this.documentSeq || this.closed || this.state === 'attached' || stripHash(seen.url) !== stripHash(url)) return;
        if (seen.dateLocale !== this.ctx.native().locale) this.noteSharedProcess(seen.dateLocale);
      })
      .catch(() => undefined);
  }

  private noteSharedProcess(intl: string): void {
    this.sharedWarning = t('bg.warn.sharedProcess', { locale: intl });
    this.log('info', `Intl reports ${intl} on this SYSTEM page: it shares its renderer process with a page spoofing that locale.`);
    this.ctx.changed(this.tabId);
  }

  /** Sites (roughSite) of the page and cross-site frames this tab's session gives a locale. */
  spoofedSites(): string[] {
    if (this.state !== 'attached') return [];
    const sites: string[] = [];
    const main = this.url ? hostFromUrl(this.url) : null;
    if (main && this.targetProfile) sites.push(roughSite(main));
    for (const c of this.children.values()) {
      const host = c.type === 'iframe' && c.url ? hostFromUrl(c.url) : null;
      if (host && this.childProfile(c)) sites.push(roughSite(host));
    }
    return sites;
  }

  /** webNavigation.onErrorOccurred for the main frame (`url`: the navigation that failed). */
  onNavigationError(url?: string): Promise<void> {
    return this.queue.run(async () => {
      this.pendingGateUrl = null;
      const r = this.reissue;
      if (r && this.ctx.now() - r.at < REISSUE_GUARD_MS) {
        // Another navigation's error while ours is in flight (e.g. one it superseded).
        if (url === undefined || stripHash(url) !== stripHash(r.url)) return;
        // Our own abort-and-reissue produces one error event for the aborted navigation.
        if (r.abortErrors > 0) {
          r.abortErrors--;
          return;
        }
        // The re-issued navigation itself ended without a document: revert below.
        this.reissue = null;
        this.log('debug', 'The re-issued navigation did not load a page; restoring the current page’s profile.');
      }
      if (this.state !== 'attached' || !this.url) return;
      const res = this.resolveUrl(this.url);
      if (!this.isApplied(res)) await this.applyMain(res, true);
      this.ctx.changed(this.tabId);
    });
  }

  /**
   * chrome.tabs.onUpdated reported a new URL. Normally onCommitted follows; if it
   * does not (e.g. prerender activation), reconcile after a short delay.
   */
  onUrlChanged(url: string): void {
    setTimeout(() => {
      void this.queue.run(async () => {
        if (this.closed || this.url === url) return;
        const current = await this.ctx.getTabUrl(this.tabId);
        if (current !== url || this.url === url) return;
        this.log('debug', 'URL changed without a commit event; reconciling.');
        await this.handleCommit({ url, transitionType: 'unknown' });
      });
    }, 2000);
  }

  onSettingsChanged(): Promise<void> {
    return this.queue.run(async () => {
      const res = this.resolveUrl(this.url);
      this.resolution = res;
      if (this.state === 'attached') {
        if (!this.keepSession(res)) {
          await this.detachInternal(this.ctx.spoofingActive() ? 'not needed on this site' : 'spoofing turned off');
        } else if (!this.isApplied(res)) {
          await this.applyMain(res, true);
          this.markLate(t('bg.late.settingsChanged'), null);
        } else {
          await this.applyChildren();
        }
      } else if (this.needsSession(res) && this.url && (await this.ensureAttached(this.url))) {
        await this.applyMain(res, true);
        this.markLate(res.action === 'PROFILE' ? t('bg.late.alreadyLoaded') : null, null);
      } else if (!this.needsSession(res)) {
        // A session Chrome may still hold (an attach that timed out) must go too.
        if (this.mayHoldSession) await this.detachInternal(this.ctx.spoofingActive() ? 'not needed on this site' : 'spoofing turned off');
        this.sessionStatus = 'none';
        this.markLate(null, null);
        // The other tab may have stopped spoofing (or spoofing was turned off): look again.
        if (this.sharedWarning) {
          this.sharedWarning = null;
          if (this.url && !res.profile) this.checkSharedProcess(this.url);
        }
      }
      this.ctx.changed(this.tabId);
    });
  }

  /** Target.attachedToTarget. Not queued and never awaits before resuming the target. */
  onAttachedToTarget(parentSessionId: string | null, params: { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean }): void {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    const target = { tabId: this.tabId, sessionId };
    const known = targetInfo.type === 'iframe' || targetInfo.type === 'worker';
    const send = (method: string, p?: object) =>
      this.ctx.port.send(target, method, p).catch((e) => {
        if (!isDetachedError(e)) this.log('debug', `${targetInfo.type} ${method} failed: ${errorMessage(e)}`);
      });
    let applied: Promise<void> = Promise.resolve();
    try {
      if (known && this.state === 'attached') {
        const child: Child = {
          sessionId,
          targetId: targetInfo.targetId,
          type: targetInfo.type as Child['type'],
          url: targetInfo.url || this.frameUrls.get(targetInfo.targetId) || '',
          parentSessionId,
          state: { ...CLEAN_STATE },
          warnings: [],
        };
        this.children.set(sessionId, child);
        this.log('debug', `child ${child.type} attached (${targetInfo.url || 'url pending'}) → ${this.childProfile(child)?.locale ?? 'SYSTEM'}`);
        applied = this.applyChild(child); // commands are sent synchronously, in order
        // Frames and workers can start their own workers (nested dedicated workers);
        // without auto-attach on this session those would run with the real values.
        void send('Target.setAutoAttach', AUTO_ATTACH_PARAMS);
      }
    } catch (e) {
      this.log('warn', `Child target setup failed (${targetInfo.type}): ${errorMessage(e)}`);
    }
    // Never leave a frame or worker paused, whatever happened above.
    if (waitingForDebugger) void send('Runtime.runIfWaitingForDebugger');
    if (!known) void this.ctx.port.send({ tabId: this.tabId }, 'Target.detachFromTarget', { sessionId }).catch(() => undefined);
    void applied.then(() => this.ctx.changed(this.tabId));
  }

  /** Children started (directly or through other children) by this session: workers of workers too. */
  private descendants(sessionId: string): Child[] {
    const out: Child[] = [];
    const parents = new Set([sessionId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of this.children.values()) {
        if (c.parentSessionId !== null && parents.has(c.parentSessionId) && !parents.has(c.sessionId)) {
          parents.add(c.sessionId);
          out.push(c);
          grew = true;
        }
      }
    }
    return out;
  }

  onDetachedFromTarget(sessionId: string): void {
    for (const c of this.descendants(sessionId)) this.children.delete(c.sessionId);
    this.children.delete(sessionId);
  }

  onTargetInfoChanged(info: TargetInfo): void {
    const child = [...this.children.values()].find((c) => c.targetId === info.targetId);
    if (!child || child.url === info.url) return;
    child.url = info.url;
    this.log('debug', `child ${child.type} url → ${hostFromUrl(info.url) ?? info.url}`);
    if (this.settings().options.frameMode !== 'per-frame') return;
    const updates = [this.applyChild(child)];
    for (const w of this.descendants(child.sessionId)) if (w.type === 'worker') updates.push(this.applyChild(w));
    void Promise.all(updates).then(() => this.ctx.changed(this.tabId));
  }

  /** chrome.debugger.onDetach: Chrome ended the session. */
  onDebuggerDetached(reason: string): void {
    this.mayHoldSession = false;
    this.resetSessionState();
    this.sessionStatus = 'none';
    this.error = reason === 'canceled_by_user' ? null : `Chrome ended the debugging session (${reason}).`;
    this.log('info', `Chrome detached the debugger: ${reason}`);
    this.ctx.changed(this.tabId);
  }

  detach(reason: string): Promise<void> {
    return this.queue.run(async () => {
      await this.detachInternal(reason);
      this.ctx.changed(this.tabId);
    });
  }

  close(): void {
    this.closed = true;
    if (this.state !== 'detached' || this.mayHoldSession) this.releaseSession();
    this.resetSessionState();
  }

  /** Wait until all queued work for this tab has finished (tests and diagnostics). */
  idle(): Promise<void> {
    return this.queue.run(async () => undefined);
  }

  // ---------------------------------------------------------------- inspection

  async verify(): Promise<VerifyResult> {
    if (this.state !== 'attached' || !this.mainFrameId) {
      return { ok: false, attached: false, source: 'debugger', frames: [], error: 'No debugger session on this tab.' };
    }
    const frames: FrameVerification[] = [];
    const evalIn = async (sessionId: string | undefined, frameId: string): Promise<{ url: string; start: LocaleSnapshot | null; live: LocaleSnapshot }> => {
      const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
      const world = await this.ctx.port.send<{ executionContextId: number }>(target, 'Page.createIsolatedWorld', {
        frameId,
        worldName: PROBE_WORLD,
      });
      const r = await this.ctx.port.send<{ result: { value: { url: string; start: LocaleSnapshot | null; live: LocaleSnapshot } }; exceptionDetails?: { text: string } }>(
        target,
        'Runtime.evaluate',
        { contextId: world.executionContextId, expression: VERIFY_EXPRESSION, returnByValue: true },
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    // Judge the page by the rule for the document that is loaded, not by the profile last
    // sent: if those disagree (a navigation that never committed), the check must show it.
    const expectedMain = this.resolution.profile?.locale ?? null;
    try {
      const v = await evalIn(undefined, this.mainFrameId);
      frames.push({ kind: 'main', url: v.url, start: v.start, live: v.live, expectedLocale: expectedMain, error: null });
    } catch (e) {
      frames.push({ kind: 'main', url: this.url ?? '', start: null, live: null, expectedLocale: expectedMain, error: errorMessage(e) });
    }
    for (const child of this.children.values()) {
      if (child.type !== 'iframe') continue;
      const expected = this.childProfile(child)?.locale ?? null;
      try {
        const v = await evalIn(child.sessionId, child.targetId);
        frames.push({ kind: 'iframe', url: v.url, start: v.start, live: v.live, expectedLocale: expected, error: null });
      } catch (e) {
        frames.push({ kind: 'iframe', url: child.url, start: null, live: null, expectedLocale: expected, error: errorMessage(e) });
      }
    }
    const ok = frames.every((f) => !f.error && (!f.expectedLocale || f.live?.dateLocale === f.expectedLocale));
    return { ok, attached: true, source: 'debugger', frames, error: null };
  }

  status(): TabStatus {
    const res = this.resolution;
    const warnings = [...this.applyWarnings];
    for (const c of this.children.values()) for (const w of c.warnings) if (!warnings.includes(w)) warnings.push(w);
    if (this.sharedWarning && !warnings.includes(this.sharedWarning)) warnings.push(this.sharedWarning);
    let frames = 0;
    let workers = 0;
    for (const c of this.children.values()) c.type === 'iframe' ? frames++ : workers++;
    return {
      tabId: this.tabId,
      host: res.host,
      resolution: {
        action: res.action,
        source: res.source,
        ruleId: res.rule?.id ?? null,
        ruleLabel: res.rule ? ruleLabel(res.rule) : null,
        profile: res.profile,
        ip: res.ip,
      },
      session: this.state === 'attached' ? 'attached' : this.sessionStatus,
      applied: this.state === 'attached' ? this.targetProfile : null,
      late: this.late,
      lateReason: this.lateReason,
      autoReloaded: this.autoReloads.some((r) => r.url === this.url && this.ctx.now() - r.at < 15_000),
      warnings,
      frames,
      workers,
      error: this.error,
      updatedAt: this.ctx.now(),
    };
  }

  get isAttached(): boolean {
    return this.state === 'attached';
  }

  /** Chrome may hold a debugger session for this tab (attached, attaching, or unconfirmed). */
  get holdsSession(): boolean {
    return this.state !== 'detached' || this.mayHoldSession;
  }
}
