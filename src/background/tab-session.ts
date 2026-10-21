// Per-tab debugger session lifecycle.
//
// One TabSession exists for every tab the extension has seen. While attached:
//   * Fetch pauses every document request. For the main frame, the target URL's
//     profile is applied *before* the request continues, and its Accept-Language
//     header is corrected. Overrides persist across navigations, so this gate
//     is what stops one site's profile leaking into the next document.
//   * Target.setAutoAttach (waitForDebuggerOnStart) hands us every cross-site
//     iframe (OOPIF) and dedicated worker before it runs, so they get overrides
//     from their first script.
//   * webNavigation events reconcile state for navigations the gate cannot see
//     (service-worker-served documents, back/forward cache, prerender) and flag
//     documents that started with the wrong state ("late").
// All state-changing work is serialized per tab.

import {
  errorMessage,
  isAlreadyAttachedError,
  isAttachableUrl,
  isDetachedError,
  isRestrictedError,
  type DebuggerPort,
} from './cdp.js';
import {
  applyState,
  CLEAN_STATE,
  desiredFor,
  fixAcceptLanguage,
  stateMatches,
  UNKNOWN_STATE,
  type AppliedState,
  type TargetKind,
} from './overrides.js';
import { PROBE_SOURCE, PROBE_WORLD, VERIFY_EXPRESSION } from './probe.js';
import { hostFromUrl } from '../shared/domain.js';
import { profileKey } from '../shared/locale.js';
import type { FrameVerification, LocaleSnapshot, LogEntry, SessionState, TabStatus, VerifyResult } from '../shared/messages.js';
import { resolveHost, ruleLabel } from '../shared/rules.js';
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
  request: { url: string; method?: string; headers: Record<string, string> };
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

export class TabSession {
  state: 'detached' | 'attaching' | 'attached' = 'detached';
  private mainFrameId: string | null = null;
  private mainState: AppliedState = CLEAN_STATE;
  /** Profile last sent to the main target; frames inherit it. */
  private targetProfile: LocaleProfile | null = null;
  private appliedKey: string | null = null;
  private applyWarnings: string[] = [];
  private readonly children = new Map<string, Child>();
  private url: string | null = null;
  private resolution: Resolution;
  private sessionStatus: SessionState = 'none';
  private late = false;
  private lateReason: string | null = null;
  private autoReloadedAt = 0;
  private error: string | null = null;
  private pendingGateUrl: string | null = null;
  private attachFailures: number[] = [];
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
    return resolveHost(url ? hostFromUrl(url) : null, this.settings());
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
    this.state = 'detached';
    this.mainFrameId = null;
    this.mainState = CLEAN_STATE;
    this.targetProfile = null;
    this.appliedKey = null;
    this.applyWarnings = [];
    this.children.clear();
    this.pendingGateUrl = null;
  }

  private lostSession(where: string): void {
    if (this.state === 'detached') return;
    this.log('warn', `Debugger session lost during ${where}.`);
    this.resetSessionState();
    this.sessionStatus = 'none';
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
    let adopted = false;
    try {
      await this.ctx.port.attach(this.tabId);
    } catch (e) {
      if (isAlreadyAttachedError(e)) {
        // Our own session survived a service-worker restart; reuse it.
        adopted = true;
      } else {
        this.state = 'detached';
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

    try {
      await this.setup(adopted);
    } catch (e) {
      if (isDetachedError(e) || this.closed) {
        this.resetSessionState();
        this.sessionStatus = 'none';
        return false;
      }
      // Setup is best effort: overrides still work without the gate or auto-attach.
      this.log('warn', `Session setup incomplete: ${errorMessage(e)}`);
    }
    if (this.closed) {
      await this.ctx.port.detach(this.tabId).catch(() => undefined);
      this.resetSessionState();
      return false;
    }
    this.state = 'attached';
    this.sessionStatus = 'attached';
    this.error = null;
    this.attachFailures = [];
    this.log('info', adopted ? 'Adopted existing debugger session.' : 'Debugger attached.');
    return true;
  }

  private async setup(adopted: boolean): Promise<void> {
    const t = { tabId: this.tabId };
    const send = this.ctx.port.send.bind(this.ctx.port);
    this.mainState = adopted ? { ...UNKNOWN_STATE } : { ...CLEAN_STATE };
    this.appliedKey = null;
    await send(t, 'Page.enable');
    await send(t, 'Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE, worldName: PROBE_WORLD });
    const tree = await send<{ frameTree: { frame: { id: string } } }>(t, 'Page.getFrameTree');
    this.mainFrameId = tree.frameTree.frame.id;
    await send(t, 'Fetch.enable', FETCH_PATTERNS);
    if (adopted) {
      // Re-announce existing children so we learn their session ids again.
      await send(t, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    }
    await send(t, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
  }

  private async detachInternal(reason: string): Promise<void> {
    if (this.state === 'detached') return;
    await this.ctx.port.detach(this.tabId).catch(() => undefined);
    this.resetSessionState();
    this.sessionStatus = 'none';
    this.late = false;
    this.lateReason = null;
    this.log('info', `Debugger detached (${reason}).`);
  }

  // ---------------------------------------------------------------- applying

  private async applyMain(res: Resolution, withChildren: boolean): Promise<boolean> {
    if (this.state !== 'attached') return false;
    const desired = desiredFor(res.profile, 'page');
    this.targetProfile = res.profile;
    const out = await applyState(this.ctx.port, { tabId: this.tabId }, this.mainState, desired, 'page');
    if (out.detached) {
      this.lostSession('apply');
      return false;
    }
    this.mainState = out.state;
    this.applyWarnings = out.warnings;
    this.appliedKey = stateMatches(this.mainState, desired) ? profileKey(res.profile) : null;
    for (const w of out.warnings) this.log('warn', w);
    if (withChildren) await this.applyChildren();
    return this.appliedKey !== null;
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

  private async applyChild(child: Child): Promise<void> {
    const kind: TargetKind = child.type;
    const profile = kind === 'worker' && !this.settings().options.overrideWorkers ? null : this.childProfile(child);
    const out = await applyState(this.ctx.port, { tabId: this.tabId, sessionId: child.sessionId }, child.state, desiredFor(profile, kind), kind);
    if (out.detached) {
      this.children.delete(child.sessionId);
      return;
    }
    child.state = out.state;
    child.warnings = out.warnings;
  }

  private async applyChildren(): Promise<void> {
    await Promise.all([...this.children.values()].map((c) => this.applyChild(c)));
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
    if (!this.isApplied(this.resolution)) return; // a reload would not help
    if (!RELOADABLE_TRANSITIONS.has(d.transitionType ?? '')) return;
    if ((d.transitionQualifiers ?? []).includes('forward_back')) return;
    if (d.timeStamp && now - d.timeStamp > AUTO_RELOAD_MAX_AGE_MS) return;
    if (now - this.autoReloadedAt < AUTO_RELOAD_COOLDOWN_MS) return;
    this.autoReloadedAt = now;
    this.log('info', 'Reloading once so page scripts start with the locale profile.');
    this.ctx.reloadTab(this.tabId).catch((e) => this.log('warn', `Reload failed: ${errorMessage(e)}`));
  }

  // ---------------------------------------------------------------- events

  /** chrome.tabs.onCreated / startup reconciliation: attach as early as possible. */
  onTabSeen(url: string | null, existingDocument: boolean): Promise<void> {
    return this.queue.run(async () => {
      if (url && url !== this.url && existingDocument) {
        this.url = url;
        this.resolution = this.resolveUrl(url);
      }
      const res = existingDocument ? this.resolution : this.resolveUrl(url);
      if (this.state !== 'attached' && this.needsSession(res) && (await this.ensureAttached(url))) {
        await this.applyMain(res, true);
        if (existingDocument) this.markLate(res.action === 'PROFILE' ? 'This page was already open when the profile was applied; reload it.' : null, null);
      } else if (!this.needsSession(res) && this.state !== 'attached') {
        this.sessionStatus = 'none';
      }
      this.ctx.changed(this.tabId);
    });
  }

  onBeforeNavigate(url: string): Promise<void> {
    return this.queue.run(async () => {
      const res = this.resolveUrl(url);
      if (this.state === 'attached') {
        // Best effort for navigations the Fetch gate never sees (e.g. served by a
        // service worker). Reverted by onNavigationError if the navigation fails.
        await this.applyMain(res, false);
      } else if (this.needsSession(res) && (await this.ensureAttached(url))) {
        await this.applyMain(res, false);
      } else if (this.needsSession(res) && this.sessionStatus === 'restricted') {
        // Leaving a restricted page (e.g. the New Tab Page): attaching becomes possible at commit.
      }
      this.ctx.changed(this.tabId);
    });
  }

  onRequestPaused(p: PausedRequest): Promise<void> {
    return this.queue.run(async () => {
      let headers: { name: string; value: string }[] | null = null;
      try {
        const url = p.request.url;
        if (p.frameId && p.frameId === this.mainFrameId) {
          const res = this.resolveUrl(url);
          this.pendingGateUrl = url;
          await this.applyMain(res, false);
          headers = fixAcceptLanguage(p.request.headers, res.profile);
        } else {
          const profile = this.settings().options.frameMode === 'per-frame' ? this.resolveUrl(url).profile : this.targetProfile;
          headers = fixAcceptLanguage(p.request.headers, profile);
        }
      } catch (e) {
        this.log('warn', `Navigation gate error: ${errorMessage(e)}`);
      } finally {
        const params: Record<string, unknown> = { requestId: p.requestId };
        if (headers) params.headers = headers;
        await this.ctx.port.send({ tabId: this.tabId }, 'Fetch.continueRequest', params).catch((e) => {
          if (!isDetachedError(e)) this.log('warn', `Fetch.continueRequest failed: ${errorMessage(e)}`);
        });
      }
    });
  }

  onCommitted(d: CommitDetails): Promise<void> {
    return this.queue.run(async () => {
      this.url = d.url;
      const res = this.resolveUrl(d.url);
      this.resolution = res;
      this.pendingGateUrl = null;
      if (this.state !== 'attached') {
        if (this.needsSession(res) && (await this.ensureAttached(d.url))) {
          await this.applyMain(res, true);
          this.markLate(res.action === 'PROFILE' ? 'Chrome only allowed debugging after this page had started loading.' : null, d);
        } else if (!this.needsSession(res)) {
          this.sessionStatus = 'none';
          this.markLate(null, null);
        }
      } else {
        if (this.isApplied(res)) {
          this.markLate(null, null);
          await this.applyChildren();
        } else {
          const hadState = this.appliedKey;
          await this.applyMain(res, true);
          // A page that should be SYSTEM but started with a stale profile is a leak too.
          this.markLate(hadState === profileKey(res.profile) ? null : 'The page started before its locale profile was applied.', d);
        }
        if (this.state === 'attached' && !this.keepSession(res)) await this.detachInternal('not needed on this site');
      }
      this.ctx.changed(this.tabId);
    });
  }

  onNavigationError(): Promise<void> {
    return this.queue.run(async () => {
      this.pendingGateUrl = null;
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
        await this.onCommittedInline({ url, transitionType: 'unknown' });
      });
    }, 2000);
  }

  private async onCommittedInline(d: CommitDetails): Promise<void> {
    this.url = d.url;
    const res = this.resolveUrl(d.url);
    this.resolution = res;
    if (this.state !== 'attached') {
      if (this.needsSession(res) && (await this.ensureAttached(d.url))) {
        await this.applyMain(res, true);
        this.markLate(res.action === 'PROFILE' ? 'The profile was applied after this page started.' : null, null);
      }
    } else if (!this.isApplied(res)) {
      await this.applyMain(res, true);
      this.markLate('The profile was applied after this page started.', null);
    }
    this.ctx.changed(this.tabId);
  }

  onSettingsChanged(): Promise<void> {
    return this.queue.run(async () => {
      const res = this.resolveUrl(this.url);
      this.resolution = res;
      if (this.state === 'attached') {
        if (!this.keepSession(res)) {
          await this.detachInternal(this.ctx.spoofingActive() ? 'not needed on this site' : 'spoofing turned off');
        } else {
          const before = this.isApplied(res);
          if (!before) {
            await this.applyMain(res, true);
            this.markLate('Settings changed after this page loaded; reload so page scripts see the new profile.', null);
          } else {
            await this.applyChildren();
          }
        }
      } else if (this.needsSession(res) && this.url && (await this.ensureAttached(this.url))) {
        await this.applyMain(res, true);
        this.markLate(res.action === 'PROFILE' ? 'The profile was applied to an already-loaded page; reload it.' : null, null);
      } else if (!this.needsSession(res)) {
        this.sessionStatus = 'none';
        this.markLate(null, null);
      }
      this.ctx.changed(this.tabId);
    });
  }

  onAttachedToTarget(parentSessionId: string | null, params: { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean }): Promise<void> {
    return this.queue.run(async () => {
      const { sessionId, targetInfo, waitingForDebugger } = params;
      const target = { tabId: this.tabId, sessionId };
      const known = targetInfo.type === 'iframe' || targetInfo.type === 'worker';
      try {
        if (known && this.state === 'attached') {
          const child: Child = {
            sessionId,
            targetId: targetInfo.targetId,
            type: targetInfo.type as Child['type'],
            url: targetInfo.url,
            parentSessionId,
            state: { ...CLEAN_STATE },
            warnings: [],
          };
          this.children.set(sessionId, child);
          await this.applyChild(child);
          if (child.type === 'iframe') await this.ctx.port.send(target, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS);
        }
      } catch (e) {
        if (!isDetachedError(e)) this.log('warn', `Child target setup failed (${targetInfo.type}): ${errorMessage(e)}`);
      } finally {
        // Never leave a frame or worker paused, whatever happened above.
        if (waitingForDebugger) await this.ctx.port.send(target, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
        if (!known) await this.ctx.port.send({ tabId: this.tabId }, 'Target.detachFromTarget', { sessionId }).catch(() => undefined);
      }
      this.ctx.changed(this.tabId);
    });
  }

  onDetachedFromTarget(sessionId: string): void {
    this.children.delete(sessionId);
    for (const [id, c] of this.children) if (c.parentSessionId === sessionId) this.children.delete(id);
  }

  onTargetInfoChanged(info: TargetInfo): void {
    const child = [...this.children.values()].find((c) => c.targetId === info.targetId);
    if (!child || child.url === info.url) return;
    child.url = info.url;
    if (this.settings().options.frameMode === 'per-frame') {
      void this.queue.run(async () => {
        if (this.children.has(child.sessionId)) await this.applyChild(child);
        for (const w of [...this.children.values()].filter((c) => c.parentSessionId === child.sessionId)) await this.applyChild(w);
        this.ctx.changed(this.tabId);
      });
    }
  }

  /** chrome.debugger.onDetach: Chrome ended the session. */
  onDebuggerDetached(reason: string): void {
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
    if (this.state !== 'detached') void this.ctx.port.detach(this.tabId).catch(() => undefined);
    this.resetSessionState();
  }

  // ---------------------------------------------------------------- inspection

  async verify(): Promise<VerifyResult> {
    if (this.state !== 'attached' || !this.mainFrameId) {
      return { ok: false, attached: false, frames: [], error: 'No debugger session on this tab.' };
    }
    const frames: FrameVerification[] = [];
    const evalIn = async (sessionId: string | undefined, frameId: string): Promise<{ url: string; start: LocaleSnapshot | null; live: LocaleSnapshot }> => {
      const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
      const world = await this.ctx.port.send<{ executionContextId: number }>(target, 'Page.createIsolatedWorld', {
        frameId,
        worldName: PROBE_WORLD,
        grantUniveralAccess: false,
      });
      const r = await this.ctx.port.send<{ result: { value: { url: string; start: LocaleSnapshot | null; live: LocaleSnapshot } }; exceptionDetails?: { text: string } }>(
        target,
        'Runtime.evaluate',
        { contextId: world.executionContextId, expression: VERIFY_EXPRESSION, returnByValue: true },
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      const v = await evalIn(undefined, this.mainFrameId);
      frames.push({ kind: 'main', url: v.url, start: v.start, live: v.live, expectedLocale: this.targetProfile?.locale ?? null, error: null });
    } catch (e) {
      frames.push({ kind: 'main', url: this.url ?? '', start: null, live: null, expectedLocale: this.targetProfile?.locale ?? null, error: errorMessage(e) });
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
    const ok = frames.every((f) => !f.error && (!f.expectedLocale || (f.live?.dateLocale === f.expectedLocale)));
    return { ok, attached: true, frames, error: null };
  }

  status(): TabStatus {
    const res = this.resolution;
    const warnings = [...this.applyWarnings];
    for (const c of this.children.values()) for (const w of c.warnings) if (!warnings.includes(w)) warnings.push(w);
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
      },
      session: this.state === 'attached' ? 'attached' : this.sessionStatus,
      applied: this.state === 'attached' ? this.targetProfile : null,
      late: this.late,
      lateReason: this.lateReason,
      autoReloaded: this.ctx.now() - this.autoReloadedAt < 15_000,
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
}
