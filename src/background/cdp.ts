// Thin, mockable wrapper around chrome.debugger plus error classification.

export interface Target {
  tabId: number;
  /** Child session (OOPIF / worker) obtained through Target.setAutoAttach with flatten: true. */
  sessionId?: string;
}

export interface DebuggerPort {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<T = unknown>(target: Target, method: string, params?: object): Promise<T>;
  /** CDP target id of the tab's page target (equals its main frame id). Browser-side, never blocked by navigations. */
  targetIdForTab(tabId: number): Promise<string | null>;
}

export const PROTOCOL_VERSION = '1.3';

/** No CDP call may block a tab's queue forever (e.g. a command sent into a renderer that is going away). */
export const COMMAND_TIMEOUT_MS = 10_000;

export class CommandTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`CDP command timed out: ${method}`);
    this.name = 'CommandTimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}

export function chromeDebuggerPort(onSlow?: (method: string, ms: number) => void): DebuggerPort {
  return {
    attach: (tabId) => withTimeout(chrome.debugger.attach({ tabId }, PROTOCOL_VERSION), COMMAND_TIMEOUT_MS, () => new CommandTimeoutError('attach')),
    detach: (tabId) => withTimeout(chrome.debugger.detach({ tabId }), COMMAND_TIMEOUT_MS, () => new CommandTimeoutError('detach')),
    targetIdForTab: async (tabId) => (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId && t.type === 'page')?.id ?? null,
    send: async <T>(target: Target, method: string, params?: object) => {
      const t0 = Date.now();
      try {
        return (await withTimeout(
          chrome.debugger.sendCommand(target as chrome.debugger.Debuggee, method, params as Record<string, unknown> | undefined),
          COMMAND_TIMEOUT_MS,
          () => new CommandTimeoutError(method),
        )) as T;
      } finally {
        const ms = Date.now() - t0;
        if (ms > 1000) onSlow?.(method, ms);
      }
    },
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** The CDP error text from chrome.debugger (it wraps protocol errors as JSON strings). */
export function protocolMessage(e: unknown): string {
  const m = errorMessage(e);
  try {
    const parsed = JSON.parse(m) as { message?: string };
    if (parsed && typeof parsed.message === 'string') return parsed.message;
  } catch {
    /* not JSON */
  }
  return m;
}

/**
 * The command failed because the session is gone (tab closed, navigated to a restricted
 * page, user cancelled) or was cut off (see isCommandCutOff). Good for quieting logs; use
 * isSessionGone to decide whether the session was lost.
 */
export function isDetachedError(e: unknown): boolean {
  return /not attached|Detached while handling command|No tab with given id|Target closed|No target with given id|Session with given id not found/i.test(
    errorMessage(e),
  );
}

/**
 * A command cut off by a renderer swap; the session itself is still attached. Chrome uses
 * the same text when the session really ends, but then it also fires
 * chrome.debugger.onDetach, so that event (not this error) decides.
 */
export function isCommandCutOff(e: unknown): boolean {
  return /Detached while handling command/i.test(errorMessage(e));
}

/** The session itself is gone, not just one command cut off. */
export function isSessionGone(e: unknown): boolean {
  return isDetachedError(e) && !isCommandCutOff(e);
}

export function isAlreadyAttachedError(e: unknown): boolean {
  return /Another debugger is already attached/i.test(errorMessage(e));
}

/** Chrome refuses to debug this page (chrome://, other extensions, Web Store, enterprise policy). */
export function isRestrictedError(e: unknown): boolean {
  return /Cannot access|Cannot attach to this target|restricted|blocked by policy|not allowed/i.test(errorMessage(e));
}

export function isProcessLockError(e: unknown): boolean {
  return /override is already in effect/i.test(protocolMessage(e));
}

export function isUnsupportedError(e: unknown): boolean {
  return /wasn't found|not found|not supported|Not allowed|not implemented/i.test(protocolMessage(e)) && !isDetachedError(e);
}

// Hosts where Chrome/Edge forbid extensions from running (chrome.debugger refuses them too).
const BLOCKED_HOSTS: { host: string; path?: string }[] = [
  { host: 'chromewebstore.google.com' },
  { host: 'chrome.google.com', path: '/webstore' },
  { host: 'microsoftedge.microsoft.com', path: '/addons' },
];

/** Quick local check before trying chrome.debugger.attach. Chrome still has the final say. */
export function isAttachableUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return !BLOCKED_HOSTS.some((b) => host === b.host && (!b.path || u.pathname.startsWith(b.path)));
}
