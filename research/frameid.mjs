import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findBrowser, attach, evaluate, sleep, until } from '../e2e/lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const srv = await startServer({ port: 0, quiet: true });
const u = (h, p = '/plain.html') => `http://${h}:${srv.port}${p}`;
const b = await launch({ executable: findBrowser('chrome'), extraArgs: ['--lang=zh-CN'] });
const { cdp } = b;
try {
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(here, 'probe-ext') });
  const swt = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id)));
  const sws = await attach(cdp, swt.targetId);
  const sw = (e) => evaluate(cdp, sws, e);
  await until(() => sw("typeof P !== 'undefined'"));
  const { targetId } = await cdp.send('Target.createTarget', { url: u('a.localhost') });
  const s = await attach(cdp, targetId);
  await sleep(800);
  const tabId = (await sw('P.targets()')).find((t) => t.id === targetId).tabId;
  console.log('attach', await sw(`P.attach({tabId:${tabId}})`));
  console.log('tree', JSON.stringify((await sw(`P.send({tabId:${tabId}}, 'Page.getFrameTree')`)).result.frameTree.frame.id), 'targetId', targetId);
  await sw(`(P.onPaused = async (src, p) => { P.events.push({method:'paused', params:{url:p.request.url, frameId:p.frameId}}); const r = await P.send(src,'Fetch.continueRequest',{requestId:p.requestId}); P.events.push({method:'continued', params: r}); }, true)`);
  console.log('fetch', await sw(`P.send({tabId:${tabId}}, 'Fetch.enable', {patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}]})`));
  for (const [h, how] of [['b.a.localhost', 'link'], ['c.localhost', 'link'], ['d.localhost', 'nav']]) {
    if (how === 'link') await cdp.send('Runtime.evaluate', { expression: `location.href=${JSON.stringify(u(h))}`, userGesture: true }, s);
    else await cdp.send('Page.navigate', { url: u(h) }, s);
    await sleep(1500);
    const href = await evaluate(cdp, s, 'location.href').catch((e) => 'ERR ' + e.message);
    const tree = (await sw(`P.send({tabId:${tabId}}, 'Page.getFrameTree')`));
    console.log(h, how, '→ href', href, 'tree main id', tree.result?.frameTree.frame.id ?? tree.error);
  }
  console.log(JSON.stringify((await sw('P.events')).map((e) => [e.method, e.params, e.source?.sessionId]), null, 0));
} finally { await b.close(); await srv.close(); }
