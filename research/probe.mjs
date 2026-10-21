// Research harness: empirically checks chrome.debugger / CDP behaviour.
// Usage: node research/probe.mjs <experiment> [--edge] [--headful]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findBrowser, attach, evaluate, sleep, until } from '../e2e/lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exp = process.argv[2] ?? 'basic';
const kind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const headless = !process.argv.includes('--headful');

const srv = await startServer({ port: 0, quiet: true });
const PORT = srv.port;
const u = (host, p = '/') => `http://${host}:${PORT}${p}`;
const b = await launch({ executable: findBrowser(kind), headless, extraArgs: ['--lang=zh-CN'] });
const { cdp } = b;
const out = (label, v) => console.log(`\n=== ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);

try {
  const ver = await cdp.send('Browser.getVersion');
  out('browser', ver.product);
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: path.join(here, 'probe-ext') });
  const swTarget = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  }, { message: 'extension SW' });
  const swS = await attach(cdp, swTarget.targetId);
  const sw = (expr) => evaluate(cdp, swS, expr);
  await until(() => sw("typeof P !== 'undefined' && typeof chrome !== 'undefined'"), { message: 'SW ready' });

  async function newTab(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const s = await attach(cdp, targetId);
    const tabId = await until(async () => {
      const ts = await sw('P.targets()');
      return ts.find((t) => t.id === targetId)?.tabId;
    }, { message: 'tabId' });
    return { targetId, s, tabId };
  }
  const report = async (s) => {
    await until(() => evaluate(cdp, s, `!!window.__ljReportReady && location.href !== 'about:blank'`), { message: 'report ready' });
    return evaluate(cdp, s, 'window.__ljReportReady.then(r => JSON.parse(JSON.stringify(r)))');
  };
  const brief = (r) => ({
    host: r.host,
    docAL: r.documentAcceptLanguage,
    fetchAL: r.fetchAcceptLanguage,
    start: pick(r.start),
    live: pick(r.live),
    worker: r.worker ? { ...pick(r.worker.snapshot ?? {}), fetchAL: r.worker.fetchAcceptLanguage, err: r.worker.error } : null,
    frames: (r.frames ?? []).map((f) => (f.error ? f : { host: f.host, kind: f.kind, docAL: f.documentAcceptLanguage, start: pick(f.start), live: pick(f.live) })),
  });
  const pick = (x) => x && ({ lang: x.language, langs: (x.languages ?? []).join(','), intl: x.dateLocale, num: x.numberLocale, coll: x.collatorLocale, brands: x.uaBrands?.slice(0, 40) });
  const navigate = async (s, url) => {
    await cdp.send('Page.enable', {}, s);
    const loaded = cdp.waitFor('Page.loadEventFired', (p, sid) => sid === s, 15000);
    await cdp.send('Page.navigate', { url }, s);
    await loaded;
  };
  const send = (tabId, method, params, sessionId) => sw(`P.send(${JSON.stringify(sessionId ? { tabId, sessionId } : { tabId })}, ${JSON.stringify(method)}, ${JSON.stringify(params ?? {})})`);

  if (exp === 'basic') {
    const t = await newTab(u('alpha.localhost', '/'));
    out('native', brief(await report(t.s)));
    out('native server log', srv.log.map((l) => `${l.host}${l.path} AL=${l.acceptLanguage} dest=${l.dest}`).join('\n'));
    out('attach', await sw(`P.attach({tabId: ${t.tabId}})`));
    out('setLocaleOverride', await send(t.tabId, 'Emulation.setLocaleOverride', { locale: 'en-US' }));
    out('after locale only (live in page)', await evaluate(cdp, t.s, `JSON.parse(JSON.stringify(__ljSnapshot()))`).then(pick));
    out('setUserAgentOverride', await send(t.tabId, 'Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'en-US,en' }));
    out('after UA override (live)', await evaluate(cdp, t.s, `JSON.parse(JSON.stringify(__ljSnapshot()))`).then(pick));
    srv.clearLog();
    await navigate(t.s, u('alpha.localhost', '/?reload'));
    out('after reload', brief(await report(t.s)));
    out('server log', srv.log.map((l) => `${l.host}${l.path} AL=${l.acceptLanguage} ua=${l.userAgent?.slice(0, 30)} ch=${l.secChUa}`).join('\n'));
    srv.clearLog();
    await navigate(t.s, u('beta.localhost', '/'));
    out('after cross-site navigation (overrides persist?)', brief(await report(t.s)));
    out('server log', srv.log.map((l) => `${l.host}${l.path} AL=${l.acceptLanguage}`).join('\n'));
    out('clear locale', await send(t.tabId, 'Emulation.setLocaleOverride', {}));
    out('clear UA', await send(t.tabId, 'Emulation.setUserAgentOverride', { userAgent: '' }));
    out('after clear (live)', await evaluate(cdp, t.s, `JSON.parse(JSON.stringify(__ljSnapshot()))`).then(pick));
    out('events', (await sw('P.events')).map((e) => e.method));
  }

  if (exp === 'autoattach') {
    const t = await newTab(u('alpha.localhost', '/plain.html'));
    await report(t.s);
    out('attach', await sw(`P.attach({tabId: ${t.tabId}})`));
    await sw(`(P.autoResume = true, P.onChild = async (s, p) => {
      const r1 = await P.send(s, 'Emulation.setLocaleOverride', { locale: p.targetInfo.type === 'iframe' ? 'ja-JP' : 'fr-FR' });
      const r2 = await P.send(s, 'Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'ja-JP,ja' });
      const r3 = p.targetInfo.type === 'iframe' ? await P.send(s, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }) : null;
      P.events.push({ method: 'childSetup', params: { type: p.targetInfo.type, url: p.targetInfo.url, r1, r2, r3 } });
    }, true)`);
    out('setLocale main', await send(t.tabId, 'Emulation.setLocaleOverride', { locale: 'en-US' }));
    out('setUA main', await send(t.tabId, 'Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'en-US,en' }));
    out('setAutoAttach', await send(t.tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
    await navigate(t.s, u('alpha.localhost', '/'));
    out('report', brief(await report(t.s)));
    const evs = await sw('P.events');
    out('child events', evs.filter((e) => e.method.startsWith('Target.') || e.method === 'childSetup' || e.method === 'onChildError').map((e) => ({ m: e.method, src: e.source, type: e.params?.targetInfo?.type, url: e.params?.targetInfo?.url, waiting: e.params?.waitingForDebugger, p: e.method === 'childSetup' ? e.params : undefined })));
    out('server log', srv.log.map((l) => `${l.host}${l.path} AL=${l.acceptLanguage} dest=${l.dest}`).join('\n'));
  }

  if (exp === 'fetch') {
    const t = await newTab(u('alpha.localhost', '/plain.html'));
    await report(t.s);
    out('attach', await sw(`P.attach({tabId: ${t.tabId}})`));
    await sw(`(P.onPaused = async (src, p) => {
      P.events.push({ method: 'paused', params: { url: p.request.url, frameId: p.frameId, rt: p.resourceType, headers: p.request.headers, redirected: p.redirectedRequestId } });
      const h = Object.entries(p.request.headers).filter(([k]) => k.toLowerCase() !== 'accept-language').map(([name, value]) => ({ name, value }));
      if (P.mode === 'strip') await P.send(src, 'Fetch.continueRequest', { requestId: p.requestId, headers: h });
      else if (P.mode === 'set') await P.send(src, 'Fetch.continueRequest', { requestId: p.requestId, headers: [...h, { name: 'Accept-Language', value: 'fr-FR,fr;q=0.9' }] });
      else await P.send(src, 'Fetch.continueRequest', { requestId: p.requestId });
    }, true)`);
    out('Fetch.enable', await send(t.tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }));
    await sw(`P.mode = 'none'`);
    srv.clearLog();
    await navigate(t.s, u('alpha.localhost', '/plain.html?native'));
    out('paused (no override)', (await sw('P.events')).filter((e) => e.method === 'paused').map((e) => e.params));
    await sw('P.clear()');
    out('set en-US', await send(t.tabId, 'Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'en-US,en' }));
    await navigate(t.s, u('alpha.localhost', '/plain.html?override'));
    out('paused (with override)', (await sw('P.events')).filter((e) => e.method === 'paused').map((e) => e.params.headers));
    await sw(`P.clear(); P.mode = 'strip'`);
    await navigate(t.s, u('alpha.localhost', '/plain.html?strip'));
    await sw(`P.mode = 'set'`);
    await navigate(t.s, u('alpha.localhost', '/plain.html?set'));
    await sw(`P.mode = 'set'`);
    await navigate(t.s, u('alpha.localhost', `/redirect?to=${encodeURIComponent(u('beta.localhost', '/plain.html?afterredirect'))}`));
    out('paused (redirect)', (await sw('P.events')).filter((e) => e.method === 'paused').map((e) => ({ url: e.params.url, al: e.params.headers['Accept-Language'], redirected: e.params.redirected })));
    out('server log', srv.log.map((l) => `${l.host}${l.path}${l.search} AL=${l.acceptLanguage}`).join('\n'));
  }

  if (exp === 'ntp') {
    // Simulate a user opening a new tab and typing a URL.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://newtab/' });
    await sleep(1500);
    const tabs = await sw('P.tabs()');
    out('tabs', tabs);
    const tabId = (await sw('P.targets()')).find((t) => t.id === targetId)?.tabId ?? tabs.at(-1).id;
    out('attach to NTP', await sw(`P.attach({tabId: ${tabId}})`));
    await sw(`P.navHooks.onBeforeNavigate = async (d) => {
      if (d.frameId !== 0) return;
      const r = await P.attach({ tabId: d.tabId });
      P.events.push({ method: 'attachAtBeforeNavigate', params: r });
      if (r.ok) {
        P.events.push({ method: 'setLocale', params: await P.send({ tabId: d.tabId }, 'Emulation.setLocaleOverride', { locale: 'en-US' }) });
        P.events.push({ method: 'setUA', params: await P.send({ tabId: d.tabId }, 'Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'en-US,en' }) });
      }
    }; P.navHooks.onCommitted = async (d) => {
      if (d.frameId !== 0) return;
      P.events.push({ method: 'attachAtCommitted', params: await P.attach({ tabId: d.tabId }) });
    }; true`);
    const s = await attach(cdp, targetId);
    await cdp.send('Page.enable', {}, s);
    const loaded = cdp.waitFor('Page.loadEventFired', (p, sid) => sid === s, 15000);
    await cdp.send('Page.navigate', { url: u('alpha.localhost', '/plain.html?fromntp'), transitionType: 'typed' }, s);
    await loaded;
    out('report', brief(await report(s)));
    out('events', (await sw('P.events')).map((e) => ({ m: e.method, p: e.params })));
    out('nav', (await sw('P.nav')).map((n) => `${n.ev} ${n.frameId} ${n.url} ${n.transitionType ?? ''}`).join('\n'));
    out('server log', srv.log.map((l) => `${l.host}${l.path}${l.search} AL=${l.acceptLanguage}`).join('\n'));
  }

  if (exp === 'shared') {
    // Same-site popup shares the opener's renderer process.
    const t = await newTab(u('alpha.localhost', '/plain.html?opener'));
    await report(t.s);
    out('attach A', await sw(`P.attach({tabId: ${t.tabId}})`));
    out('A setLocale en-US', await send(t.tabId, 'Emulation.setLocaleOverride', { locale: 'en-US' }));
    await cdp.send('Runtime.evaluate', { expression: `void window.open(${JSON.stringify(u('mail.alpha.localhost', '/plain.html?popup'))}, '_blank', 'popup')`, userGesture: true }, t.s);
    const popupInfo = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.url.includes('?popup')), { message: 'popup target' });
    const params = { targetInfo: popupInfo };
    const ps = await attach(cdp, params.targetInfo.targetId);
    await until(() => evaluate(cdp, ps, "typeof __ljSnapshot === 'function' && document.readyState === 'complete'"), { message: 'popup ready' });
    out('popup (no session) live', pick(await evaluate(cdp, ps, 'JSON.parse(JSON.stringify(__ljSnapshot()))')));
    const popupTab = await until(async () => (await sw('P.targets()')).find((x) => x.id === params.targetInfo.targetId)?.tabId, { message: 'popup tab' });
    out('attach B', await sw(`P.attach({tabId: ${popupTab}})`));
    out('B clear locale', await send(popupTab, 'Emulation.setLocaleOverride', {}));
    out('B set ja-JP', await send(popupTab, 'Emulation.setLocaleOverride', { locale: 'ja-JP' }));
    out('B set en-US', await send(popupTab, 'Emulation.setLocaleOverride', { locale: 'en-US' }));
    out('A clear', await send(t.tabId, 'Emulation.setLocaleOverride', {}));
    out('B set ja-JP after A cleared', await send(popupTab, 'Emulation.setLocaleOverride', { locale: 'ja-JP' }));
    out('A live', pick(await evaluate(cdp, t.s, 'JSON.parse(JSON.stringify(__ljSnapshot()))')));
    out('B live', pick(await evaluate(cdp, ps, 'JSON.parse(JSON.stringify(__ljSnapshot()))')));
    out('harness (DevTools-like) client sets locale in A', await cdp.send('Emulation.setLocaleOverride', { locale: 'de-DE' }, t.s).catch((e) => e.message));
  }

  if (exp === 'dnr') {
    out('dnr', await sw(`chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1,2], addRules: [
      { id: 1, priority: 10, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'accept-language', operation: 'set', value: 'en-US,en;q=0.9' }] },
        condition: { requestDomains: ['alpha.localhost'], resourceTypes: ['main_frame'] } },
      { id: 2, priority: 20, action: { type: 'allow' }, condition: { requestDomains: ['sys.alpha.localhost'], resourceTypes: ['main_frame'] } } ] }).then(() => 'ok', e => e.message)`));
    const t = await newTab(u('alpha.localhost', '/plain.html?dnr'));
    out('alpha', brief(await report(t.s)));
    await navigate(t.s, u('sys.alpha.localhost', '/plain.html?dnr'));
    out('sys.alpha', brief(await report(t.s)));
    out('server log', srv.log.map((l) => `${l.host}${l.path}${l.search} AL=${l.acceptLanguage}`).join('\n'));
  }

  if (exp === 'prerender') {
    const t = await newTab(u('alpha.localhost', '/plain.html?pre'));
    await report(t.s);
    out('attach', await sw(`P.attach({tabId: ${t.tabId}})`));
    out('locale', await send(t.tabId, 'Emulation.setLocaleOverride', { locale: 'en-US' }));
    out('ua', await send(t.tabId, 'Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'en-US,en' }));
    out('autoattach', await send(t.tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
    await navigate(t.s, u('alpha.localhost', '/prerender.html'));
    await sleep(2500);
    srv.log.forEach((l) => console.log(`log ${l.host}${l.path}${l.search} AL=${l.acceptLanguage} dest=${l.dest}`));
    const nav = cdp.waitFor('Page.frameNavigated', (p, sid) => sid === t.s && !p.frame.parentId, 10000).catch(() => null);
    await evaluate(cdp, t.s, `document.getElementById('target').click()`);
    await nav;
    await sleep(1000);
    out('targets', (await sw('P.targets()')).map((x) => `${x.type} tab=${x.tabId} attached=${x.attached} ${x.url}`));
    out('after activation', await send(t.tabId, 'Runtime.evaluate', { expression: 'JSON.stringify({href: location.href, start: window.__ljStart && [__ljStart.language, __ljStart.dateLocale], live: [navigator.language, Intl.DateTimeFormat().resolvedOptions().locale], prerendered: document.prerendering, act: performance.getEntriesByType("navigation")[0]?.activationStart})', returnByValue: true }));
    out('nav', (await sw('P.nav')).map((n) => `${n.ev} f=${n.frameId} ${n.url} life=${n.documentLifecycle} type=${n.frameType}`).join('\n'));
    out('events', (await sw('P.events')).map((e) => e.method + ' ' + JSON.stringify(e.source) + ' ' + (e.params?.targetInfo ? e.params.targetInfo.type + ' ' + e.params.targetInfo.url : JSON.stringify(e.params ?? {}).slice(0, 100))));
  }
} catch (e) {
  console.error('FAILED', e);
} finally {
  await b.close();
  await srv.close();
}
