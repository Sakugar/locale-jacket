// Which gate strategy makes a *changed* profile visible from document start?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findBrowser, attach, evaluate, sleep, until } from '../e2e/lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const srv = await startServer({ port: 0, quiet: true });
const u = (h, q) => `http://${h}:${srv.port}/plain.html?${q}`;
const b = await launch({ executable: findBrowser(process.argv.includes('--edge') ? 'edge' : 'chrome'), extraArgs: ['--lang=zh-CN'] });
const { cdp } = b;
try {
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(here, 'probe-ext') });
  const swt = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id)));
  const sws = await attach(cdp, swt.targetId);
  const sw = (e) => evaluate(cdp, sws, e);
  await until(() => sw("typeof P !== 'undefined'"));
  const { targetId } = await cdp.send('Target.createTarget', { url: u('a.localhost', 'init') });
  const s = await attach(cdp, targetId);
  await sleep(1000);
  const tabId = (await sw('P.targets()')).find((t) => t.id === targetId).tabId;
  await sw(`P.attach({tabId:${tabId}})`);
  await sw(`P.send({tabId:${tabId}}, 'Emulation.setLocaleOverride', {locale:'en-US'})`);
  await sw(`P.send({tabId:${tabId}}, 'Emulation.setUserAgentOverride', {userAgent:'', acceptLanguage:'en-US,en'})`);
  // Gate: strategy chosen per URL query.
  await sw(`(P.onPaused = (src, p) => {
    const url = p.request.url;
    const want = url.includes('want=ja') ? 'ja-JP' : 'en-US';
    const lang = want === 'ja-JP' ? 'ja-JP,ja' : 'en-US,en';
    const strat = (url.split('strat=')[1] || '').split('&')[0]; P.events.push({method:'gate', params:{url, strat}});
    if (strat === 'renav' && !url.includes('renav=done')) {
      const a = P.send(src, 'Emulation.setLocaleOverride', {locale: want});
      const b2 = P.send(src, 'Emulation.setUserAgentOverride', {userAgent:'', acceptLanguage: lang});
      const t0 = Date.now();
      P.send(src, 'Fetch.failRequest', {requestId: p.requestId, errorReason: 'Aborted'})
        .then((fr) => { P.events.push({method:'renav', params:{step:'failed', fr, ms: Date.now()-t0}}); return Promise.all([a, b2]); })
        .then(() => { P.events.push({method:'renav', params:{ms: Date.now()-t0}}); return P.send(src, 'Page.navigate', {url: url + '&renav=done', transitionType: 'link'}); });
      return;
    }
    P.send(src, 'Emulation.setLocaleOverride', {locale: want});
    P.send(src, 'Emulation.setUserAgentOverride', {userAgent:'', acceptLanguage: lang});
    if (strat === 'delay') setTimeout(() => P.send(src, 'Fetch.continueRequest', {requestId: p.requestId}), 300);
    else P.send(src, 'Fetch.continueRequest', {requestId: p.requestId});
  }, true)`);
  await sw(`P.send({tabId:${tabId}}, 'Fetch.enable', {patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}]})`);
  const cases = [
    ['same-site, plain', 'x.a.localhost', 'strat=plain'],
    ['cross-site, plain', 'b.localhost', 'strat=plain'],
    ['cross-site, delay 300ms', 'c.localhost', 'strat=delay'],
    ['cross-site, abort+renavigate', 'd.localhost', 'strat=renav'],
    ['same-site, abort+renavigate', 'y.d.localhost', 'strat=renav'],
  ];
  let want = 'en-US';
  for (const [label, host, q] of cases) {
    want = want === 'en-US' ? 'ja-JP' : 'en-US';
    const url = u(host, `${q}&want=${want === 'ja-JP' ? 'ja' : 'en'}`);
    await cdp.send('Runtime.evaluate', { expression: `location.href=${JSON.stringify(url)}`, userGesture: true }, s);
    await sleep(1800);
    const r = await evaluate(cdp, s, `JSON.stringify({href: location.search, start: [__ljStart.language, __ljStart.dateLocale], live: [navigator.language, Intl.DateTimeFormat().resolvedOptions().locale], hist: history.length})`).catch((e) => e.message);
    console.log(`${label.padEnd(30)} want ${want}: ${r}`);
  }
  console.log(JSON.stringify((await sw('P.events')).filter(e=>e.method==='renav'||e.method==='gate').map(e=>e.params)));
} finally { await b.close(); await srv.close(); }
