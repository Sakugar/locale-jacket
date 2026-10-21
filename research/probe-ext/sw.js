// Research-only helper: exposes chrome.debugger to the harness via globalThis.P.
const events = [];
const nav = [];
chrome.debugger.onEvent.addListener((source, method, params) => {
  events.push({ t: Date.now(), source, method, params });
  if (method === 'Target.attachedToTarget' && P.autoResume) {
    const s = { ...source, sessionId: params.sessionId };
    (async () => {
      if (P.onChild) { try { await P.onChild(s, params); } catch (e) { events.push({ t: Date.now(), method: 'onChildError', params: String(e) }); } }
      if (params.waitingForDebugger) chrome.debugger.sendCommand(s, 'Runtime.runIfWaitingForDebugger').catch(() => {});
    })();
  }
  if (method === 'Fetch.requestPaused' && P.onPaused) P.onPaused(source, params);
});
chrome.debugger.onDetach.addListener((source, reason) => events.push({ t: Date.now(), source, method: 'onDetach', params: { reason } }));
for (const ev of ['onBeforeNavigate', 'onCommitted', 'onErrorOccurred', 'onCompleted']) {
  chrome.webNavigation[ev].addListener((d) => {
    nav.push({ ev, t: Date.now(), ...d });
    if (P.navHooks[ev]) P.navHooks[ev](d);
  });
}
const P = {
  events, nav, navHooks: {}, autoResume: false, onChild: null, onPaused: null,
  async attach(target) { try { await chrome.debugger.attach(target, '1.3'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  async detach(target) { try { await chrome.debugger.detach(target); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  async send(target, method, params) {
    try { return { ok: true, result: await chrome.debugger.sendCommand(target, method, params ?? {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  async tabs() { return (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl })); },
  async targets() { return chrome.debugger.getTargets(); },
  clear() { events.length = 0; nav.length = 0; },
};
globalThis.P = P;
