// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe.
// Dependency-free so the e2e suite can drive a real Chrome/Edge build and load
// the unpacked extension through Extensions.loadUnpacked (branded Chrome no
// longer honours --load-extension).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BROWSERS = {
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
};

export function findBrowser(kind) {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  return (BROWSERS[kind] ?? []).find((p) => p && fs.existsSync(p)) ?? null;
}

export class CDP extends EventEmitter {
  #nextId = 1;
  #pending = new Map();
  #buffer = '';
  #write;
  closed = false;

  constructor(readable, writable) {
    super();
    this.setMaxListeners(100);
    this.#write = (s) => writable.write(s + '\0');
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => this.#onData(chunk));
    readable.on('close', () => this.#onClose());
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let idx;
    while ((idx = this.#buffer.indexOf('\0')) !== -1) {
      const raw = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!raw) continue;
      const msg = JSON.parse(raw);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        this.#pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`);
          err.code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
      } else {
        this.emit('event', msg);
        this.emit(msg.method, msg.params, msg.sessionId);
      }
    }
  }

  #onClose() {
    this.closed = true;
    for (const p of this.#pending.values()) p.reject(new Error(`${p.method}: connection closed`));
    this.#pending.clear();
    this.emit('close');
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = this.#nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#write(JSON.stringify(msg));
    });
  }

  /** Resolve with the first event matching `method` (and `predicate`), or reject on timeout. */
  waitFor(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('event', handler);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const handler = (msg) => {
        if (msg.method !== method) return;
        let ok = false;
        try { ok = predicate(msg.params, msg.sessionId); } catch { ok = false; }
        if (!ok) return;
        clearTimeout(timer);
        this.off('event', handler);
        resolve({ params: msg.params, sessionId: msg.sessionId });
      };
      this.on('event', handler);
    });
  }
}

/**
 * Launch a browser with a pipe-based CDP connection.
 * Returns { cdp, proc, userDataDir, close() }.
 */
export async function launch({ executable, userDataDir, headless = true, extraArgs = [], keepProfile = false } = {}) {
  if (!executable) throw new Error('No browser executable found. Set BROWSER_PATH.');
  const profile = userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lj-e2e-'));
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--password-store=basic',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const cdp = new CDP(proc.stdio[4], proc.stdio[3]);
  // Make sure the browser is actually answering before handing it out.
  await withTimeout(cdp.send('Browser.getVersion'), 20000, () => `Browser did not start. stderr:\n${stderr}`);
  const close = async () => {
    try { await withTimeout(cdp.send('Browser.close'), 5000); } catch { /* ignore */ }
    await new Promise((r) => {
      if (proc.exitCode !== null) return r();
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } r(); }, 5000);
      proc.once('exit', () => { clearTimeout(t); r(); });
    });
    if (!keepProfile && !userDataDir) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(500); }
      }
    }
  };
  return { cdp, proc, userDataDir: profile, close, stderr: () => stderr };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout(promise, ms, message = () => 'timeout') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message())), ms); }),
  ]);
}

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function until(fn, { timeoutMs = 10000, intervalMs = 100, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** Attach (flatten) to a target and return its sessionId. */
export async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/** Evaluate an expression in a session and return the by-value result; throws on exceptions. */
export async function evaluate(cdp, sessionId, expression, { awaitPromise = true, timeoutMs = 15000 } = {}) {
  const res = await withTimeout(
    cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId),
    timeoutMs,
    () => `evaluate timed out: ${expression.slice(0, 120)}`,
  );
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`Evaluation failed: ${d.exception?.description ?? d.text}`);
  }
  return res.result.value;
}
