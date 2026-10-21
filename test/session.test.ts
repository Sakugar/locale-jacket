import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { DebuggerPort, Target } from '../src/background/cdp.js';
import { SessionManager } from '../src/background/manager.js';
import { TabSession, type TabContext } from '../src/background/tab-session.js';
import { makeProfile } from '../src/shared/locale.js';
import type { LogEntry, TabStatus } from '../src/shared/messages.js';
import { defaultSettings } from '../src/shared/presets.js';
import type { Settings } from '../src/shared/types.js';

interface Call {
  target: Target;
  method: string;
  params: Record<string, unknown>;
}

class FakePort implements DebuggerPort {
  calls: Call[] = [];
  attached = new Set<number>();
  attachCalls = 0;
  attachError: string | null = null;
  failures = new Map<string, string>();
  detachCalls: number[] = [];

  async attach(tabId: number): Promise<void> {
    this.attachCalls++;
    if (this.attachError) throw new Error(this.attachError);
    if (this.attached.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
    this.attached.add(tabId);
  }
  async detach(tabId: number): Promise<void> {
    this.detachCalls.push(tabId);
    this.attached.delete(tabId);
  }
  async send<T>(target: Target, method: string, params: object = {}): Promise<T> {
    this.calls.push({ target, method, params: params as Record<string, unknown> });
    const key = `${target.sessionId ?? 'main'}:${method}`;
    const fail = this.failures.get(key) ?? this.failures.get(method);
    if (fail) throw new Error(fail);
    if (!this.attached.has(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' } } } as T;
    return {} as T;
  }
  emulation(sessionId?: string): Call[] {
    return this.calls.filter((c) => c.method.startsWith('Emulation.') && c.target.sessionId === sessionId);
  }
  last(method: string): Call | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }
  clear(): void {
    this.calls = [];
  }
}

const GOOGLE = 'https://mail.google.com/mail/';
const EXAMPLE = 'https://example.com/';
const APPLE = 'https://developer.apple.com/';
const ACCOUNTS = 'https://accounts.google.com/signin';

function makeCtx(port: FakePort, settings: Settings, opts: { active?: boolean } = {}) {
  const reloads: number[] = [];
  const logs: LogEntry[] = [];
  let now = 1_000_000;
  const ctx: TabContext & { reloads: number[]; logs: LogEntry[]; advance(ms: number): void } = {
    port,
    settings: () => settings,
    spoofingActive: () => opts.active ?? true,
    reloadTab: async (id) => {
      reloads.push(id);
    },
    getTabUrl: async () => null,
    changed: () => undefined,
    log: (level, tabId, msg) => logs.push({ t: now, level, tabId, msg }),
    now: () => now,
    reloads,
    logs,
    advance: (ms) => {
      now += ms;
    },
  };
  return ctx;
}

function paused(url: string, frameId = 'MAIN', headers: Record<string, string> = {}) {
  return { requestId: `req-${Math.random()}`, frameId, resourceType: 'Document', request: { url, headers } };
}

describe('TabSession lifecycle', () => {
  let port: FakePort;
  let settings: Settings;
  beforeEach(() => {
    port = new FakePort();
    settings = defaultSettings();
  });

  it('attaches on commit to a spoofed site, sets up the gate and applies the profile', async () => {
    const ctx = makeCtx(port, settings);
    const t = new TabSession(1, ctx);
    await t.onCommitted({ url: GOOGLE, transitionType: 'typed', timeStamp: ctx.now() });
    const methods = port.calls.map((c) => c.method);
    for (const m of ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Fetch.enable', 'Target.setAutoAttach']) assert.ok(methods.includes(m), m);
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'en-US' });
    assert.deepEqual(port.last('Emulation.setUserAgentOverride')?.params, { userAgent: '', acceptLanguage: 'en-US,en' });
    assert.ok(!methods.includes('Emulation.setTimezoneOverride'), 'timezone untouched by default');
    assert.ok(!methods.includes('Emulation.setGeolocationOverride'), 'geolocation untouched by default');
    const s = t.status();
    assert.equal(s.session, 'attached');
    assert.equal(s.applied?.locale, 'en-US');
    assert.equal(s.late, true, 'document predates the session');
    assert.deepEqual(ctx.reloads, [1], 'fresh typed navigation is reloaded once');
  });

  it('does not attach for SYSTEM sites', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: EXAMPLE });
    assert.equal(port.attachCalls, 0);
    assert.equal(t.status().session, 'none');
  });

  it('gates navigations: applies the next profile before the request continues and fixes Accept-Language', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    port.clear();

    // google (en-US) -> apple (ja-JP)
    const req = paused(APPLE, 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' });
    await t.onRequestPaused(req);
    const order = port.calls.map((c) => c.method);
    assert.ok(order.indexOf('Emulation.setLocaleOverride') < order.indexOf('Fetch.continueRequest'), 'override before continue');
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'ja-JP' });
    const cont = port.last('Fetch.continueRequest')!.params;
    assert.equal(cont.requestId, req.requestId);
    assert.deepEqual(cont.headers, [{ name: 'Accept', value: 'text/html' }, { name: 'Accept-Language', value: 'ja-JP,ja;q=0.9' }]);
    await t.onCommitted({ url: APPLE, transitionType: 'link' });
    assert.equal(t.status().late, false);

    // apple (ja-JP) -> accounts.google.com (SYSTEM exception): overrides cleared, header removed
    port.clear();
    await t.onRequestPaused(paused(ACCOUNTS, 'MAIN', { 'Accept-Language': 'ja-JP,ja;q=0.9', Accept: 'text/html' }));
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, {});
    assert.deepEqual(port.last('Emulation.setUserAgentOverride')?.params, { userAgent: '' });
    assert.deepEqual(port.last('Fetch.continueRequest')!.params.headers, [{ name: 'Accept', value: 'text/html' }]);
    await t.onCommitted({ url: ACCOUNTS, transitionType: 'link' });
    assert.equal(t.status().applied, null);
    assert.equal(t.status().late, false);
    assert.equal(t.status().session, 'attached', 'kept for the next navigation (keepSessionOnSystem)');
  });

  it('sends nothing when consecutive navigations share a profile', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    port.clear();
    await t.onRequestPaused(paused('https://www.google.com/search?q=x', 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9' }));
    assert.deepEqual(port.emulation(), []);
    assert.equal(port.last('Fetch.continueRequest')!.params.headers, undefined, 'header untouched when already right');
  });

  it('always continues a paused request, even when applying fails', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    port.failures.set('Emulation.setLocaleOverride', 'boom');
    await t.onRequestPaused(paused(APPLE));
    assert.ok(port.last('Fetch.continueRequest'));
  });

  it('detects late documents (stale profile at commit) and reverts it', async () => {
    const ctx = makeCtx(port, settings);
    const t = new TabSession(1, ctx);
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    ctx.reloads.length = 0;
    port.clear();
    // A navigation the gate never saw (e.g. served by a service worker) lands on a SYSTEM site.
    await t.onCommitted({ url: EXAMPLE, transitionType: 'link', timeStamp: ctx.now() });
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, {});
    assert.equal(t.status().late, true);
    assert.deepEqual(ctx.reloads, [1]);
  });

  it('never auto-reloads form submissions, reloads, back/forward or stale commits, and only once per 30 s', async () => {
    for (const d of [
      { transitionType: 'form_submit' },
      { transitionType: 'reload' },
      { transitionType: 'link', transitionQualifiers: ['forward_back'] },
      { transitionType: 'link', timeStamp: 1 },
    ]) {
      const p = new FakePort();
      const ctx = makeCtx(p, settings);
      await new TabSession(1, ctx).onCommitted({ url: GOOGLE, ...d });
      assert.deepEqual(ctx.reloads, [], JSON.stringify(d));
    }
    const ctx = makeCtx(port, settings);
    const t = new TabSession(1, ctx);
    await t.onCommitted({ url: GOOGLE, transitionType: 'typed' });
    port.attached.clear();
    t.onDebuggerDetached('target_closed');
    await t.onCommitted({ url: APPLE, transitionType: 'typed' });
    assert.deepEqual(ctx.reloads, [1], 'cool-down prevents a second reload');
    settings.options.reloadOnLate = false;
    ctx.advance(60_000);
    port.attached.clear();
    t.onDebuggerDetached('target_closed');
    await t.onCommitted({ url: GOOGLE, transitionType: 'typed' });
    assert.deepEqual(ctx.reloads, [1], 'option disables it');
  });

  it('treats restricted pages as restricted without counting failures', async () => {
    port.attachError = 'Cannot access a chrome:// URL';
    const t = new TabSession(1, makeCtx(port, settings));
    for (let i = 0; i < 5; i++) await t.onBeforeNavigate(GOOGLE);
    assert.equal(port.attachCalls, 5);
    assert.equal(t.status().session, 'restricted');
    port.attachError = null;
    await t.onCommitted({ url: GOOGLE, transitionType: 'typed' });
    assert.equal(t.status().session, 'attached');
  });

  it('does not try to attach to chrome://, Web Store or file URLs at all', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onTabSeen('https://chromewebstore.google.com/detail/x', true);
    assert.equal(t.status().session, 'restricted', 'matches google.com but cannot be debugged');
    await t.onTabSeen('chrome://settings/', true);
    assert.equal(t.status().session, 'none', 'no host, so no rule applies');
    await t.onTabSeen('file:///C:/page.html', true);
    assert.equal(port.attachCalls, 0);
  });

  it('stops retrying after repeated attach failures (no reattach loop)', async () => {
    port.attachError = 'Something unexpected';
    const ctx = makeCtx(port, settings);
    const t = new TabSession(1, ctx);
    for (let i = 0; i < 10; i++) await t.onCommitted({ url: GOOGLE });
    assert.equal(port.attachCalls, 3);
    assert.equal(t.status().session, 'failed');
    ctx.advance(61_000);
    port.attachError = null;
    await t.onCommitted({ url: GOOGLE });
    assert.equal(t.status().session, 'attached', 'retries again after the window');
  });

  it('adopts its own session after a service-worker restart', async () => {
    port.attached.add(1); // session survived, but this TabSession is new
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onTabSeen(GOOGLE, true);
    const aa = port.calls.filter((c) => c.method === 'Target.setAutoAttach').map((c) => c.params.autoAttach);
    assert.deepEqual(aa, [false, true], 're-announces children');
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'en-US' });
    assert.equal(t.status().session, 'attached');
  });

  it('detaches when spoofing is turned off and when settings make the tab SYSTEM without keepSessionOnSystem', async () => {
    let active = true;
    const ctx = { ...makeCtx(port, settings), spoofingActive: () => active };
    const t = new TabSession(1, ctx);
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    active = false;
    await t.onSettingsChanged();
    assert.deepEqual(port.detachCalls, [1]);
    assert.equal(t.status().session, 'none');

    active = true;
    settings.options.keepSessionOnSystem = false;
    await t.onSettingsChanged();
    assert.equal(t.status().session, 'attached');
    await t.onRequestPaused(paused(EXAMPLE));
    await t.onCommitted({ url: EXAMPLE, transitionType: 'link' });
    assert.deepEqual(port.detachCalls, [1, 1], 'detached after landing on a SYSTEM site');
  });

  it('reapplies live when a rule changes and flags the page for reload', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    settings.rules[0]!.profile = makeProfile('en-GB');
    await t.onSettingsChanged();
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'en-GB' });
    assert.match(t.status().lateReason ?? '', /Settings changed/);
  });

  it('applies optional time zone and geolocation, and clears them on SYSTEM', async () => {
    settings.rules[0]!.profile = { ...makeProfile('en-US'), timezone: 'America/New_York', geolocation: { latitude: 40.7, longitude: -74, accuracy: 50 } };
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    assert.deepEqual(port.last('Emulation.setTimezoneOverride')?.params, { timezoneId: 'America/New_York' });
    assert.deepEqual(port.last('Emulation.setGeolocationOverride')?.params, { latitude: 40.7, longitude: -74, accuracy: 50 });
    await t.onRequestPaused(paused(EXAMPLE));
    assert.deepEqual(port.last('Emulation.setTimezoneOverride')?.params, { timezoneId: '' });
    assert.ok(port.last('Emulation.clearGeolocationOverride'));
  });

  it('reports process-wide locale conflicts instead of claiming success', async () => {
    port.failures.set('main:Emulation.setLocaleOverride', JSON.stringify({ code: -32000, message: 'Another locale override is already in effect' }));
    const ctx = makeCtx(port, settings);
    const t = new TabSession(1, ctx);
    await t.onCommitted({ url: GOOGLE, transitionType: 'typed' });
    const s = t.status();
    assert.ok(s.warnings.some((w) => /another tab or DevTools/.test(w)));
    assert.deepEqual(ctx.reloads, [], 'a reload would not fix it');
  });

  it('reverts an early-applied profile when the navigation fails', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    await t.onBeforeNavigate(APPLE);
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'ja-JP' });
    await t.onNavigationError();
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'en-US' });
  });
});

describe('child targets (OOPIFs and workers)', () => {
  let port: FakePort;
  let settings: Settings;
  let t: TabSession;
  beforeEach(async () => {
    port = new FakePort();
    settings = defaultSettings();
    t = new TabSession(1, makeCtx(port, settings));
    await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
    port.clear();
  });

  const iframe = (sessionId: string, url = '') => ({ sessionId, targetInfo: { targetId: `T-${sessionId}`, type: 'iframe', url }, waitingForDebugger: true });

  it('applies the inherited profile, auto-attaches recursively and resumes the frame', async () => {
    await t.onAttachedToTarget(null, iframe('F1'));
    const calls = port.calls.filter((c) => c.target.sessionId === 'F1').map((c) => c.method);
    assert.deepEqual(calls.slice(-2), ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
    assert.deepEqual(port.emulation('F1').map((c) => c.params), [{ locale: 'en-US' }, { userAgent: '', acceptLanguage: 'en-US,en' }]);
    assert.equal(t.status().frames, 1);
  });

  it('gives workers only the navigator.language override', async () => {
    await t.onAttachedToTarget('F1', { sessionId: 'W1', targetInfo: { targetId: 'TW', type: 'worker', url: 'https://mail.google.com/w.js' }, waitingForDebugger: true });
    assert.deepEqual(port.emulation('W1').map((c) => c.method), ['Emulation.setUserAgentOverride']);
    assert.equal(port.last('Runtime.runIfWaitingForDebugger')?.target.sessionId, 'W1');
    settings.options.overrideWorkers = false;
    await t.onAttachedToTarget(null, { sessionId: 'W2', targetInfo: { targetId: 'TW2', type: 'worker', url: '' }, waitingForDebugger: true });
    assert.deepEqual(port.emulation('W2'), []);
  });

  it('resumes the target even if every command fails', async () => {
    port.failures.set('F2:Emulation.setLocaleOverride', 'x');
    port.failures.set('F2:Emulation.setUserAgentOverride', 'x');
    port.failures.set('F2:Target.setAutoAttach', 'x');
    await t.onAttachedToTarget(null, iframe('F2'));
    assert.equal(port.last('Runtime.runIfWaitingForDebugger')?.target.sessionId, 'F2');
  });

  it('treats a shared-process locale on a sibling frame as applied', async () => {
    port.failures.set('F3:Emulation.setLocaleOverride', JSON.stringify({ message: 'Another locale override is already in effect' }));
    await t.onAttachedToTarget(null, iframe('F3'));
    assert.ok(t.status().warnings.some((w) => /shared with another frame/.test(w)));
  });

  it('per-frame mode resolves the frame URL once it is known', async () => {
    settings.options.frameMode = 'per-frame';
    await t.onAttachedToTarget(null, iframe('F4'));
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'en-US' }, 'inherits until the URL is known');
    t.onTargetInfoChanged({ targetId: 'T-F4', type: 'iframe', url: 'https://www.apple.com/embed' });
    await t.onNavigationError(); // flush the queue
    assert.deepEqual(port.emulation('F4').at(-2)?.params, { locale: 'ja-JP' });
  });

  it('detaches non-frame/worker targets after resuming them', async () => {
    await t.onAttachedToTarget(null, { sessionId: 'S1', targetInfo: { targetId: 'X', type: 'service_worker', url: '' }, waitingForDebugger: true });
    assert.ok(port.calls.some((c) => c.method === 'Target.detachFromTarget' && c.params.sessionId === 'S1'));
    assert.ok(port.calls.some((c) => c.method === 'Runtime.runIfWaitingForDebugger' && c.target.sessionId === 'S1'));
  });

  it('drops children when they detach', async () => {
    await t.onAttachedToTarget(null, iframe('F5'));
    await t.onAttachedToTarget('F5', { sessionId: 'W5', targetInfo: { targetId: 'TW5', type: 'worker', url: '' }, waitingForDebugger: false });
    t.onDetachedFromTarget('F5');
    assert.equal(t.status().frames, 0);
    assert.equal(t.status().workers, 0);
  });
});

describe('SessionManager', () => {
  function makeManager(settings: Settings, port = new FakePort()) {
    const statuses: TabStatus[] = [];
    const m = new SessionManager({
      port,
      initialSettings: settings,
      suspended: false,
      reloadTab: async () => undefined,
      getTabUrl: async () => null,
      listTabs: async () => [
        { id: 1, url: GOOGLE },
        { id: 2, url: EXAMPLE },
        { id: 3, url: 'chrome://newtab/' },
      ],
      onStatus: (s) => statuses.push(s),
      onTabGone: () => undefined,
      log: () => undefined,
    });
    return { m, port, statuses };
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));

  it('reconciles existing tabs on startup without reloading them', async () => {
    const { m, port } = makeManager(defaultSettings());
    await m.reconcileAll();
    assert.deepEqual([...port.attached], [1]);
    assert.equal(m.status(1)?.late, true);
    assert.match(m.status(1)?.lateReason ?? '', /already open/);
    assert.equal(m.status(2)?.session, 'none');
  });

  it('disabling the extension detaches every session; re-enabling restores them', async () => {
    const s = defaultSettings();
    const { m, port } = makeManager(s);
    await m.reconcileAll();
    await m.updateSettings({ ...s, enabled: false });
    assert.equal(port.attached.size, 0);
    assert.equal(m.attachedCount(), 0);
    await m.updateSettings({ ...s, enabled: true });
    assert.deepEqual([...port.attached], [1]);
  });

  it('suspends without re-attaching until resumed', async () => {
    const { m, port } = makeManager(defaultSettings());
    await m.reconcileAll();
    m.onDebuggerDetach(1, 'canceled_by_user');
    port.attached.clear();
    await m.suspend();
    m.onCommitted(1, 0, { url: GOOGLE, transitionType: 'typed' });
    await flush();
    assert.equal(port.attached.size, 0);
    await m.resume();
    assert.deepEqual([...port.attached], [1]);
  });

  it('releases paused requests and targets for tabs it does not track', async () => {
    const port = new FakePort();
    port.attached.add(9);
    const { m } = makeManager(defaultSettings(), port);
    m.onDebuggerEvent({ tabId: 9 }, 'Fetch.requestPaused', paused(GOOGLE));
    m.onDebuggerEvent({ tabId: 9 }, 'Target.attachedToTarget', { sessionId: 'Z', waitingForDebugger: true, targetInfo: { type: 'iframe', targetId: 'z', url: '' } });
    await flush();
    assert.ok(port.last('Fetch.continueRequest'));
    assert.equal(port.last('Runtime.runIfWaitingForDebugger')?.target.sessionId, 'Z');
  });

  it('ignores subframe navigation events and cleans up closed tabs', async () => {
    const { m, port } = makeManager(defaultSettings());
    m.onCommitted(5, 3, { url: GOOGLE });
    await flush();
    assert.equal(port.attachCalls, 0);
    m.onCommitted(5, 0, { url: GOOGLE });
    await flush();
    assert.equal(m.attachedCount(), 1);
    m.onTabRemoved(5);
    assert.equal(m.status(5), null);
    assert.deepEqual(port.detachCalls, [5]);
  });

  it('a global default profile spoofs unmatched sites', async () => {
    const s = defaultSettings();
    s.defaultAction = { action: 'PROFILE', profile: makeProfile('en-US') };
    const { m, port } = makeManager(s);
    await m.reconcileAll();
    assert.deepEqual([...port.attached].sort(), [1, 2]);
  });
});
