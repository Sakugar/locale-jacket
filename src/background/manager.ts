// Routes browser events to per-tab sessions and owns global state
// (enabled / suspended, settings, attached-session bookkeeping).

import { errorMessage, type DebuggerPort } from './cdp.js';
import { TabSession, type CommitDetails, type PausedRequest, type TabContext, type TargetInfo } from './tab-session.js';
import type { LogEntry, TabStatus, VerifyResult } from '../shared/messages.js';
import type { Settings } from '../shared/types.js';

export interface ManagerDeps {
  port: DebuggerPort;
  initialSettings: Settings;
  suspended: boolean;
  reloadTab(tabId: number): Promise<void>;
  getTabUrl(tabId: number): Promise<string | null>;
  listTabs(): Promise<{ id: number; url: string | null }[]>;
  onStatus(status: TabStatus): void;
  onTabGone(tabId: number): void;
  log(entry: LogEntry): void;
  now?: () => number;
  /** The browser's own locale (the service worker itself is never overridden). */
  native?: () => { locale: string; languages: string[] };
}

export function spoofingPossible(s: Settings): boolean {
  return s.enabled && (s.defaultAction.action === 'PROFILE' || s.rules.some((r) => r.enabled && r.action === 'PROFILE'));
}

export class SessionManager {
  private readonly tabs = new Map<number, TabSession>();
  private settings: Settings;
  private suspended: boolean;
  private readonly ctx: TabContext;
  private readonly now: () => number;

  constructor(private readonly deps: ManagerDeps) {
    this.settings = deps.initialSettings;
    this.suspended = deps.suspended;
    this.now = deps.now ?? Date.now;
    this.ctx = {
      port: deps.port,
      settings: () => this.settings,
      spoofingActive: () => !this.suspended && spoofingPossible(this.settings),
      reloadTab: deps.reloadTab,
      getTabUrl: deps.getTabUrl,
      changed: (tabId) => {
        const t = this.tabs.get(tabId);
        if (t) deps.onStatus(t.status());
      },
      log: (level, tabId, msg) => deps.log({ t: this.now(), level, tabId, msg }),
      now: this.now,
      native: deps.native ?? (() => ({ locale: Intl.DateTimeFormat().resolvedOptions().locale, languages: [...navigator.languages] })),
    };
  }

  private session(tabId: number, url: string | null = null): TabSession {
    let t = this.tabs.get(tabId);
    if (!t) {
      t = new TabSession(tabId, this.ctx, url);
      this.tabs.set(tabId, t);
    }
    return t;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  get currentSettings(): Settings {
    return this.settings;
  }

  attachedCount(): number {
    let n = 0;
    for (const t of this.tabs.values()) if (t.isAttached) n++;
    return n;
  }

  // --------------------------------------------------------------- lifecycle

  /** Startup, extension install/update, resume: bring every open tab in line. */
  async reconcileAll(): Promise<void> {
    let tabs: { id: number; url: string | null }[] = [];
    try {
      tabs = await this.deps.listTabs();
    } catch (e) {
      this.ctx.log('warn', null, `Could not list tabs: ${errorMessage(e)}`);
    }
    await Promise.all(tabs.map((tab) => this.session(tab.id, tab.url).onTabSeen(tab.url, true)));
  }

  async updateSettings(next: Settings): Promise<void> {
    this.settings = next;
    await Promise.all([...this.tabs.values()].map((t) => t.onSettingsChanged()));
    if (!this.ctx.spoofingActive()) return;
    // Tabs we have never seen (e.g. opened while spoofing was off) may now need a session.
    await this.reconcileAll();
  }

  async suspend(): Promise<void> {
    this.suspended = true;
    await Promise.all([...this.tabs.values()].map((t) => t.detach('suspended')));
  }

  async resume(): Promise<void> {
    this.suspended = false;
    await this.reconcileAll();
  }

  async detachAll(reason: string): Promise<number> {
    const attached = [...this.tabs.values()].filter((t) => t.isAttached);
    await Promise.all(attached.map((t) => t.detach(reason)));
    return attached.length;
  }

  // ------------------------------------------------------------ tab events

  onTabCreated(tabId: number, url: string | null): void {
    void this.session(tabId, null).onTabSeen(url, false);
  }

  onTabRemoved(tabId: number): void {
    const t = this.tabs.get(tabId);
    if (t) t.close();
    this.tabs.delete(tabId);
    this.deps.onTabGone(tabId);
  }

  onTabReplaced(addedTabId: number, removedTabId: number, url: string | null): void {
    this.onTabRemoved(removedTabId);
    void this.session(addedTabId, url).onTabSeen(url, true);
  }

  onTabUrlChanged(tabId: number, url: string): void {
    this.session(tabId).onUrlChanged(url);
  }

  onBeforeNavigate(tabId: number, frameId: number, url: string): void {
    if (frameId !== 0) return;
    void this.session(tabId).onBeforeNavigate(url);
  }

  onCommitted(tabId: number, frameId: number, details: CommitDetails): void {
    if (frameId !== 0) return;
    void this.session(tabId).onCommitted(details);
  }

  onNavigationError(tabId: number, frameId: number): void {
    if (frameId !== 0) return;
    void this.tabs.get(tabId)?.onNavigationError();
  }

  // ------------------------------------------------------- debugger events

  onDebuggerEvent(source: { tabId?: number; sessionId?: string }, method: string, params: unknown): void {
    if (source.tabId === undefined) return;
    const t = this.tabs.get(source.tabId);
    if (!t) {
      // An event for a tab we no longer track: never leave a request or target paused.
      this.releaseOrphan(source as { tabId: number; sessionId?: string }, method, params);
      return;
    }
    switch (method) {
      case 'Fetch.requestPaused':
        t.onRequestPaused(params as PausedRequest);
        break;
      case 'Target.attachedToTarget':
        t.onAttachedToTarget(source.sessionId ?? null, params as { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean });
        break;
      case 'Page.frameStartedNavigating':
        if (!source.sessionId) t.onNavigationStarted(params as { frameId: string; url: string; navigationType: string });
        break;
      case 'Target.detachedFromTarget':
        t.onDetachedFromTarget((params as { sessionId: string }).sessionId);
        break;
      case 'Target.targetInfoChanged':
        t.onTargetInfoChanged((params as { targetInfo: TargetInfo }).targetInfo);
        break;
      default:
        break;
    }
  }

  private releaseOrphan(source: { tabId: number; sessionId?: string }, method: string, params: unknown): void {
    if (method === 'Fetch.requestPaused') {
      const p = params as PausedRequest;
      void this.deps.port.send({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
    } else if (method === 'Target.attachedToTarget') {
      const p = params as { sessionId: string; waitingForDebugger: boolean };
      if (p.waitingForDebugger) {
        void this.deps.port.send({ tabId: source.tabId, sessionId: p.sessionId }, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
      }
    }
  }

  onDebuggerDetach(tabId: number | undefined, reason: string): void {
    if (tabId !== undefined) this.tabs.get(tabId)?.onDebuggerDetached(reason);
  }

  // ------------------------------------------------------------- queries

  status(tabId: number): TabStatus | null {
    return this.tabs.get(tabId)?.status() ?? null;
  }

  statuses(): TabStatus[] {
    return [...this.tabs.values()].map((t) => t.status());
  }

  async verify(tabId: number): Promise<VerifyResult> {
    const t = this.tabs.get(tabId);
    if (!t) return { ok: false, attached: false, frames: [], error: 'This tab is not tracked yet.' };
    return t.verify();
  }
}
