// S8: crash a page with Page.crash and reload it like the sad tab's button, in a fresh
// browser each launch. Shows that in Edge a reload sent before the crash is reported
// (Target.targetCrashed) is lost with the dying renderer, with or without the extension.
//
//   node research/crash-reload.mjs [--chrome] [--ext] [--runs 3] [--wait <ms> | --wait-crash] [--poke]
//
// --ext         load dist/ with apple.localhost → ja-JP (otherwise no extension at all)
// --wait <ms>   reload this long after Page.crash (default 1000; the stress test used 1500)
// --wait-crash  reload as soon as Target.targetCrashed arrives
// --poke        5 ms after Page.crash, evaluate in an isolated world from a second session
//               (what the extension's start probe does right after a commit)
//
// Edge 156: the first crash in a browser is reported after 1.2–1.8 s, later ones after
// ~0.7 s; Chrome 156 after ~0.1 s. With --wait 1000 the first reload fails in Edge every
// time (10/10 launches, no extension); with --wait-crash every reload loads (and is
// spoofed with --ext). Now and then (6 of 22 runs in one sitting, 0 of 29 later, with
// and without the extension) Edge reports the crash only after 20–30 s; until then the
// page is frozen and every reload of it is lost. In most of those runs another client's
// command reached the dying renderer (--poke imitates that), but --poke did not bring the
// delay back later, so the trigger is not known.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attach, evaluate, findBrowser, launch, sleep, until } from '../e2e/lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const withExt = process.argv.includes('--ext');
const waitCrash = process.argv.includes('--wait-crash');
const runs = Number(arg('--runs', 3));
const kind = process.argv.includes('--chrome') ? 'chrome' : 'edge';

const srv = await startServer({ port: 0, quiet: true });
const u = (host, p) => `http://${host}:${srv.port}${p}`;
const b = await launch({ executable: findBrowser(kind), extraArgs: ['--lang=zh-CN', '--accept-lang=zh-CN,zh'] });
const { cdp } = b;
const results = [];
try {
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  console.log((await cdp.send('Browser.getVersion')).product, withExt ? 'with the extension' : 'no extension');
  if (withExt) {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: dist });
    const swt = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id)), { timeoutMs: 20000 });
    const sws = await attach(cdp, swt.targetId);
    await until(() => evaluate(cdp, sws, `typeof localeJacket !== 'undefined' && localeJacket.ready()`), { timeoutMs: 20000 });
    const { importConfigText } = await import(pathToFileURL(path.join(dist, 'shared', 'config-io.js')).href);
    const r = importConfigText('rules:\n  - DOMAIN-SUFFIX,apple.localhost,ja-JP\ndefault:\n  mode: SYSTEM\n');
    await evaluate(cdp, sws, `chrome.storage.local.set({ settings: ${JSON.stringify(r.settings)} }).then(() => true)`);
    await sleep(500);
  }
  for (let i = 1; i <= runs; i++) {
    const url = u('apple.localhost', `/plain.html?crash=${i}`);
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const s = await attach(cdp, targetId);
    await cdp.send('Page.enable', {}, s); // as the stress test's sessions do
    const loaded = () => evaluate(cdp, s, '!!(window.__ljReport && window.__ljReport.done) && navigator.language', { timeoutMs: 3000 }).catch(() => false);
    await until(loaded, { timeoutMs: 15000, message: 'first load' });
    const t0 = Date.now();
    let reportedAfter = null;
    const crashed = cdp.waitFor('Target.targetCrashed', (p) => p.targetId === targetId, 60000).then(() => (reportedAfter = Date.now() - t0), () => null);
    const s2 = process.argv.includes('--poke') ? await attach(cdp, targetId) : null;
    cdp.send('Page.crash', {}, s).catch(() => undefined);
    if (s2) {
      await sleep(5);
      cdp
        .send('Page.createIsolatedWorld', { frameId: targetId, worldName: 'poke' }, s2)
        .then((w) => cdp.send('Runtime.evaluate', { contextId: w.executionContextId, expression: '1' }, s2))
        .catch(() => undefined);
    }
    if (waitCrash) await crashed;
    else await sleep(Number(arg('--wait', 1000)));
    const beforeReload = reportedAfter;
    await cdp.send('Page.navigate', { url, transitionType: 'reload' }, s).catch(() => undefined);
    const lang = await until(loaded, { timeoutMs: 8000 }).catch(() => null);
    results.push({ run: i, crashReportedAfterMs: reportedAfter, reportedBeforeReload: beforeReload !== null, reload: lang ?? 'never loaded' });
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
} finally {
  console.table(results);
  await b.close();
  await srv.close();
}
