// Does Page.frameStartedNavigating tell the gate what kind of navigation is paused?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findBrowser, attach, evaluate, sleep, until } from '../e2e/lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const srv = await startServer({ port: 0, quiet: true });
const u = (h, q = '') => `http://${h}:${srv.port}/plain.html${q}`;
const b = await launch({ executable: findBrowser(process.argv.includes('--edge') ? 'edge' : 'chrome'), extraArgs: ['--lang=zh-CN', '--disable-features=BackForwardCache'] });
const { cdp } = b;
try {
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(here, 'probe-ext') });
  const swt = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id)));
  const sws = await attach(cdp, swt.targetId);
  const sw = (e) => evaluate(cdp, sws, e);
  await until(() => sw("typeof P !== 'undefined'"));
  const { targetId } = await cdp.send('Target.createTarget', { url: u('a.localhost', '?1') });
  const s = await attach(cdp, targetId);
  await sleep(1000);
  const tabId = (await sw('P.targets()')).find((t) => t.id === targetId).tabId;
  await sw(`P.attach({tabId:${tabId}})`);
  await sw(`P.send({tabId:${tabId}}, 'Page.enable')`);
  await sw(`(P.onPaused = (src, p) => { P.events.push({method:'PAUSED', params:{url: p.request.url}}); P.send(src, 'Fetch.continueRequest', {requestId: p.requestId}); }, true)`);
  await sw(`P.send({tabId:${tabId}}, 'Fetch.enable', {patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}]})`);
  const step = async (label, expr) => {
    await sw('P.clear()');
    await cdp.send('Runtime.evaluate', { expression: expr, userGesture: true }, s);
    await sleep(1200);
    const ev = (await sw('P.events')).filter((e) => ['PAUSED', 'Page.frameStartedNavigating', 'Page.frameRequestedNavigation'].includes(e.method));
    console.log(label.padEnd(12), ev.map((e) => e.method === 'PAUSED' ? `PAUSED ${e.params.url.split('?')[1] ?? ''}` : `${e.method.replace('Page.', '')}(${e.params.navigationType ?? e.params.reason}) ${(e.params.url ?? '').split('?')[1] ?? ''}`).join('  →  '));
  };
  await step('link', `location.href = ${JSON.stringify(u('b.localhost', '?2'))}`);
  await step('link', `location.href = ${JSON.stringify(u('c.localhost', '?3'))}`);
  await step('back', 'history.back()');
  await step('forward', 'history.forward()');
  await step('reload', 'location.reload()');
  await step('replace', `location.replace(${JSON.stringify(u('d.localhost', '?4'))})`);
  console.log('history', JSON.stringify((await sw(`P.send({tabId:${tabId}}, 'Page.getNavigationHistory')`)).result));
} finally { await b.close(); await srv.close(); }
