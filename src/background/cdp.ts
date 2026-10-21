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
}

export const PROTOCOL_VERSION = '1.3';

export function chromeDebuggerPort(): DebuggerPort {
  return {
    attach: (tabId) => chrome.debugger.attach({ tabId }, PROTOCOL_VERSION),
    detach: (tabId) => chrome.debugger.detach({ tabId }),
    send: async <T>(target: Target, method: string, params?: object) =>
      (await chrome.debugger.sendCommand(target as chrome.debugger.Debuggee, method, params as Record<string, unknown> | undefined)) as T,
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

/** The session is gone (tab closed, navigated to a restricted page, user cancelled). */
export function isDetachedError(e: unknown): boolean {
  return /not attached|Detached while handling command|No tab with given id|Target closed|No target with given id|Session with given id not found/i.test(
    errorMessage(e),
  );
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
