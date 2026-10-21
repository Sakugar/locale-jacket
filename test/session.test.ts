import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { DebuggerPort, Target } from '../src/background/cdp.js';
import { SessionManager } from '../src/background/manager.js';
import { TabSession, type TabContext } from '../src/background/tab-session.js';
import { makeProfile } from '../src/shared/locale.js';
import type { LocaleSnapshot, LogEntry, TabStatus } from '../src/shared/messages.js';
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
  /** What the document-start probe reports (null = no probe in this document). */
  probe: LocaleSnapshot | null = null;

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
  async targetIdForTab(): Promise<string> {
    return 'MAIN';
  }
  async send<T>(target: Target, method: string, params: object = {}): Promise<T> {
    this.calls.push({ target, method, params: params as Record<string, unknown> });
    const key = `${target.sessionId ?? 'main'}:${method}`;
    const fail = this.failures.get(key) ?? this.failures.get(method);
    if (fail) throw new Error(fail);
    if (!this.attached.has(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 } as T;
    if (method === 'Runtime.evaluate') return { result: { value: this.probe } } as T;
    return {} as T;
  }
  emulation(sessionId?: string): Call[] {
    return this.calls.filter((c) => c.method.startsWith('Emulation.') && c.target.sessionId === sessionId);
  }
  last(method: string): Call | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  clear(): void {
    this.calls = [];
  }
}

const GOOGLE = 'https://mail.google.com/mail/';
const EXAMPLE = 'https://example.com/';
const APPLE = 'https://developer.apple.com/';
const ACCOUNTS = 'https://accounts.google.com/signin';

const flush = () => new Promise((r) => setTimeout(r, 0));

function snapshot(locale: string, language = locale): LocaleSnapshot {
  return {
    language,
    languages: [language],
    dateLocale: locale,
    numberLocale: locale,
    collatorLocale: locale,
    pluralRulesLocale: locale,
    relativeTimeLocale: locale,
    listFormatLocale: locale,
    timeZone: 'Asia/Shanghai',
  };
}

function makeCtx(port: FakePort, settings: Settings, opts: { active?: () => boolean } = {}) {
  const reloads: number[] = [];
  const logs: LogEntry[] = [];
  let now = 1_000_000;
  const ctx: TabContext & { reloads: number[]; logs: LogEntry[]; advance(ms: number): void } = {
    port,
    settings: () => settings,
    spoofingActive: opts.active ?? (() => true),
    reloadTab: async (id) => {
      reloads.push(id);
    },
    getTabUrl: async () => null,
    changed: () => undefined,
    log: (level, tabId, msg) => logs.push({ t: now, level, tabId, msg }),
    now: () => now,
    native: () => ({ locale: 'zh-CN', languages: ['zh-CN', 'zh'] }),
    reloads,
    logs,
    advance: (ms) => {
      now += ms;
    },
  };
  return ctx;
}

function paused(url: string, frameId = 'MAIN', headers: Record<string, string> = {}, method = 'GET') {
  return { requestId: `req-${Math.random()}`, frameId, resourceType: 'Document', request: { url, method, headers } };
}

/** A tab attached and settled on GOOGLE (en-US), with the call log cleared. */
async function settledOnGoogle(port: FakePort, settings: Settings) {
  const ctx = makeCtx(port, settings);
  const t = new TabSession(1, ctx);
  await t.onCommitted({ url: GOOGLE, transitionType: 'reload' });
  ctx.reloads.length = 0;
  port.clear();
  return { t, ctx };
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
    await flush();
    const methods = port.methods();
    for (const m of ['Fetch.enable', 'Target.setAutoAttach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument']) assert.ok(methods.includes(m), m);
    assert.ok(methods.indexOf('Fetch.enable') < methods.indexOf('Page.enable'), 'browser-side gate first');
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

  it('a profile change aborts the navigation, applies the profile, then re-issues it', async () => {
    const { t } = await settledOnGoogle(port, settings);
    const req = paused(APPLE, 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9', Referer: 'https://mail.google.com/' });
    req.request = { ...req.request, referrerPolicy: 'strict-origin-when-cross-origin' } as typeof req.request;
    t.onRequestPaused(req);
    await flush();
    const m = port.methods();
    assert.ok(!m.includes('Fetch.continueRequest'), 'the stale request never reaches the server');
    assert.deepEqual(port.last('Fetch.failRequest')?.params, { requestId: req.requestId, errorReason: 'Aborted' });
    assert.ok(m.indexOf('Emulation.setLocaleOverride') < m.indexOf('Page.navigate'));
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'ja-JP' });
    assert.deepEqual(port.last('Page.navigate')?.params, {
      url: APPLE,
      transitionType: 'link',
      referrer: 'https://mail.google.com/',
      referrerPolicy: 'strictOriginWhenCrossOrigin',
    });

    // The re-issued request now matches the applied profile: header fixed, request continued.
    port.clear();
    const again = paused(APPLE, 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' });
    t.onRequestPaused(again);
    assert.deepEqual(port.emulation(), []);
    assert.deepEqual(port.last('Fetch.continueRequest')?.params, {
      requestId: again.requestId,
      headers: [{ name: 'Accept', value: 'text/html' }, { name: 'Accept-Language', value: 'ja-JP,ja;q=0.9' }],
    });
    await t.onNavigationError(); // the aborted original navigation reports an error
    assert.deepEqual(port.emulation(), [], 'the abort error does not revert the new profile');
    port.probe = snapshot('ja-JP');
    await t.onCommitted({ url: APPLE, transitionType: 'link' });
    assert.equal(t.status().late, false);
    assert.equal(t.status().applied?.locale, 'ja-JP');
  });

  it('restores SYSTEM before a SYSTEM-exception site loads (no leak)', async () => {
    const { t } = await settledOnGoogle(port, settings);
    t.onRequestPaused(paused(ACCOUNTS, 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9' }));
    await flush();
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, {});
    assert.deepEqual(port.last('Emulation.setUserAgentOverride')?.params, { userAgent: '' });
    assert.ok(port.last('Page.navigate'));
    port.clear();
    const again = paused(ACCOUNTS, 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' });
    t.onRequestPaused(again);
    assert.deepEqual(port.last('Fetch.continueRequest')?.params.headers, [{ name: 'Accept', value: 'text/html' }], 'native header restored');
    port.probe = snapshot('zh-CN');
    await t.onCommitted({ url: ACCOUNTS, transitionType: 'link' });
    assert.equal(t.status().applied, null);
    assert.equal(t.status().late, false);
    assert.equal(t.status().session, 'attached', 'kept for the next navigation (keepSessionOnSystem)');
  });

  it('passes same-profile navigations straight through', async () => {
    const { t } = await settledOnGoogle(port, settings);
    const req = paused('https://www.google.com/search?q=x', 'MAIN', { 'Accept-Language': 'en-US,en;q=0.9' });
    t.onRequestPaused(req);
    assert.deepEqual(port.emulation(), []);
    assert.deepEqual(port.last('Fetch.continueRequest')?.params, { requestId: req.requestId }, 'header untouched when already right');
  });

  it('POST navigations are continued (cannot be re-issued) and flagged late', async () => {
    const { t, ctx } = await settledOnGoogle(port, settings);
    t.onRequestPaused(paused(APPLE, 'MAIN', {}, 'POST'));
    await flush();
    assert.ok(!port.methods().includes('Fetch.failRequest'));
    assert.ok(port.last('Fetch.continueRequest'));
    port.probe = snapshot('en-US');
    await t.onCommitted({ url: APPLE, transitionType: 'form_submit', timeStamp: ctx.now() });
    assert.equal(t.status().late, true);
    assert.deepEqual(ctx.reloads, [], 'form submissions are never reloaded');
  });

  it('never loops: a re-issued request that still mismatches is let through', async () => {
    const { t } = await settledOnGoogle(port, settings);
    port.failures.set('Emulation.setLocaleOverride', 'boom');
    t.onRequestPaused(paused(APPLE));
    await flush();
    assert.equal(port.calls.filter((c) => c.method === 'Page.navigate').length, 1);
    t.onRequestPaused(paused(APPLE));
    await flush();
    assert.equal(port.calls.filter((c) => c.method === 'Page.navigate').length, 1);
    assert.ok(port.last('Fetch.continueRequest'));
  });

  it('subframe documents are continued with the tab profile header', async () => {
    const { t } = await settledOnGoogle(port, settings);
    t.onRequestPaused(paused('https://ads.example.net/frame', 'F9', { Accept: '*/*' }));
    assert.deepEqual(port.last('Fetch.continueRequest')?.params.headers, [
      { name: 'Accept', value: '*/*' },
      { name: 'Accept-Language', value: 'en-US,en;q=0.9' },
    ]);
    assert.deepEqual(port.emulation(), []);
  });

  it('flags ungated documents that started with the wrong profile, using the start probe', async () => {
    const { t, ctx } = await settledOnGoogle(port, settings);
    // e.g. a navigation served by a service worker never passes the gate
    port.probe = snapshot('en-US');
    await t.onCommitted({ url: EXAMPLE, transitionType: 'link', timeStamp: ctx.now() });
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, {});
    assert.equal(t.status().late, true);
    assert.match(t.status().lateReason ?? '', /instead of zh-CN/);
    assert.deepEqual(ctx.reloads, [1]);
  });

  it('a probe that matches clears the late flag (e.g. back/forward cache restore)', async () => {
    const { t, ctx } = await settledOnGoogle(port, settings);
    port.probe = snapshot('ja-JP');
    await t.onCommitted({ url: APPLE, transitionType: 'link', transitionQualifiers: ['forward_back'], timeStamp: ctx.now() });
    assert.equal(t.status().late, false);
    assert.deepEqual(ctx.reloads, []);
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

  it('onBeforeNavigate only attaches; it never sends overrides', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onBeforeNavigate(GOOGLE);
    assert.equal(t.status().session, 'attached');
    assert.deepEqual(port.emulation(), []);
    await t.onBeforeNavigate(APPLE);
    assert.deepEqual(port.emulation(), []);
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
    assert.equal(t.status().late, true, 'an already-open page is flagged, not reloaded');
  });

  it('a tab that is still loading is attached but not overridden (the gate does it)', async () => {
    const t = new TabSession(1, makeCtx(port, settings));
    await t.onTabSeen(GOOGLE, false);
    assert.equal(t.status().session, 'attached');
    assert.deepEqual(port.emulation(), []);
    t.onRequestPaused(paused(GOOGLE));
    await flush();
    assert.deepEqual(port.last('Emulation.setLocaleOverride')?.params, { locale: 'en-US' });
    assert.ok(port.last('Page.navigate'));
  });

  it('detaches when spoofing is turned off and when settings make the tab SYSTEM without keepSessionOnSystem', async () => {
    let active = true;
    const ctx = makeCtx(port, settings, { active: () => active });
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
    t.onRequestPaused(paused(EXAMPLE));
    await flush();
    await t.onCommitted({ url: EXAMPLE, transitionType: 'link' });
    assert.deepEqual(port.detachCalls, [1, 1], 'detached after landing on a SYSTEM site');
  });

  it('reapplies live when a rule changes and flags the page for reload', async () => {
    const { t } = await settledOnGoogle(port, settings);
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
    t.onRequestPaused(paused(EXAMPLE));
    await flush();
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

  it('a failed navigation reverts to the committed page’s profile', async () => {
    const { t } = await settledOnGoogle(port, settings);
    t.onRequestPaused(paused(APPLE, 'MAIN', {}, 'POST')); // applied best-effort, then the POST fails
    await flush();
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
    ({ t } = await settledOnGoogle(port, settings));
  });

  const iframe = (sessionId: string, url = '') => ({ sessionId, targetInfo: { targetId: `T-${sessionId}`, type: 'iframe', url }, waitingForDebugger: true });

  it('sends the inherited profile, auto-attaches recursively, then resumes — in that order', async () => {
    t.onAttachedToTarget(null, iframe('F1'));
    const calls = port.calls.filter((c) => c.target.sessionId === 'F1').map((c) => c.method);
    assert.deepEqual(calls, ['Emulation.setLocaleOverride', 'Emulation.setUserAgentOverride', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
    assert.deepEqual(port.emulation('F1').map((c) => c.params), [{ locale: 'en-US' }, { userAgent: '', acceptLanguage: 'en-US,en' }]);
    await flush();
    assert.equal(t.status().frames, 1);
  });

  it('gives workers only the navigator.language override', async () => {
    t.onAttachedToTarget('F1', { sessionId: 'W1', targetInfo: { targetId: 'TW', type: 'worker', url: 'https://mail.google.com/w.js' }, waitingForDebugger: true });
    assert.deepEqual(port.emulation('W1').map((c) => c.method), ['Emulation.setUserAgentOverride']);
    assert.equal(port.last('Runtime.runIfWaitingForDebugger')?.target.sessionId, 'W1');
    settings.options.overrideWorkers = false;
    t.onAttachedToTarget(null, { sessionId: 'W2', targetInfo: { targetId: 'TW2', type: 'worker', url: '' }, waitingForDebugger: true });
    assert.deepEqual(port.emulation('W2'), []);
  });

  it('resumes the target even if every command fails', async () => {
    port.failures.set('F2:Emulation.setLocaleOverride', 'x');
    port.failures.set('F2:Emulation.setUserAgentOverride', 'x');
    port.failures.set('F2:Target.setAutoAttach', 'x');
    t.onAttachedToTarget(null, iframe('F2'));
    await flush();
    assert.equal(port.last('Runtime.runIfWaitingForDebugger')?.target.sessionId, 'F2');
  });

  it('reports a locale held by another frame in the same process', async () => {
    port.failures.set('F3:Emulation.setLocaleOverride', JSON.stringify({ message: 'Another locale override is already in effect' }));
    t.onAttachedToTarget(null, iframe('F3'));
    await flush();
    assert.ok(t.status().warnings.some((w) => /shares its renderer process/.test(w)));
  });

  it('per-frame mode uses the URL the gate saw for that frame before it attached', async () => {
    settings.options.frameMode = 'per-frame';
    t.onRequestPaused(paused('https://www.apple.com/embed', 'T-F4'));
    t.onAttachedToTarget(null, iframe('F4'));
    assert.deepEqual(port.emulation('F4')[0]?.params, { locale: 'ja-JP' }, 'own rule from the first script');
  });

  it('per-frame mode re-resolves when the frame URL changes', async () => {
    settings.options.frameMode = 'per-frame';
    t.onAttachedToTarget(null, iframe('F5'));
    assert.deepEqual(port.emulation('F5')[0]?.params, { locale: 'en-US' }, 'inherits while the URL is unknown');
    t.onTargetInfoChanged({ targetId: 'T-F5', type: 'iframe', url: 'https://www.apple.com/embed' });
    assert.deepEqual(port.emulation('F5').at(-2)?.params, { locale: 'ja-JP' });
  });

  it('detaches non-frame/worker targets after resuming them', async () => {
    t.onAttachedToTarget(null, { sessionId: 'S1', targetInfo: { targetId: 'X', type: 'service_worker', url: '' }, waitingForDebugger: true });
    assert.ok(port.calls.some((c) => c.method === 'Target.detachFromTarget' && c.params.sessionId === 'S1'));
    assert.ok(port.calls.some((c) => c.method === 'Runtime.runIfWaitingForDebugger' && c.target.sessionId === 'S1'));
  });

  it('drops children (and their workers) when they detach', async () => {
    t.onAttachedToTarget(null, iframe('F6'));
    t.onAttachedToTarget('F6', { sessionId: 'W6', targetInfo: { targetId: 'TW6', type: 'worker', url: '' }, waitingForDebugger: false });
    t.onDetachedFromTarget('F6');
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
      native: () => ({ locale: 'zh-CN', languages: ['zh-CN', 'zh'] }),
    });
    return { m, port, statuses };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

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
    await settle();
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
    await settle();
    assert.ok(port.last('Fetch.continueRequest'));
    assert.equal(port.last('Runtime.runIfWaitingForDebugger')?.target.sessionId, 'Z');
  });

  it('ignores subframe navigation events and cleans up closed tabs', async () => {
    const { m, port } = makeManager(defaultSettings());
    m.onCommitted(5, 3, { url: GOOGLE });
    await settle();
    assert.equal(port.attachCalls, 0);
    m.onCommitted(5, 0, { url: GOOGLE });
    await settle();
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
