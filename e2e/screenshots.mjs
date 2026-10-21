#!/usr/bin/env node
// Capture screenshots of the popup and options page in a real browser.
// Output: e2e/artifacts/*.png (git-ignored).  Usage: node e2e/screenshots.mjs [--dark]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attach, evaluate, findBrowser, launch, sleep, until } from './lib/cdp.mjs';
import { startServer } from '../verify/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'artifacts');
fs.mkdirSync(out, { recursive: true });
const dark = process.argv.includes('--dark');
const { importConfigText } = await import(pathToFileURL(path.join(root, 'dist', 'shared', 'config-io.js')).href);

const srv = await startServer({ port: 0, quiet: true });
const b = await launch({ executable: findBrowser('chrome'), extraArgs: ['--lang=zh-CN'] });
const { cdp } = b;
try {
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  const swt = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id)));
  const sws = await attach(cdp, swt.targetId);
  await until(() => evaluate(cdp, sws, `typeof localeJacket !== 'undefined' && localeJacket.ready()`));
  const s = importConfigText(`
rules:
  - DOMAIN-SUFFIX,google.localhost,en-US
  - DOMAIN,accounts.google.localhost,SYSTEM
  - type: DOMAIN-SUFFIX
    domain: apple.localhost
    locale: ja-JP
    timezone: Asia/Tokyo
  - DOMAIN-KEYWORD,microsoft,en-GB
  - DOMAIN-SUFFIX,google.localhost,de-DE
  - DOMAIN-SUFFIX,例子.localhost,zh-TW
`).settings;
  await evaluate(cdp, sws, `chrome.storage.local.set({ settings: ${JSON.stringify(s)} }).then(() => true)`);
  await sleep(500);

  const site = await cdp.send('Target.createTarget', { url: `http://mail.google.localhost:${srv.port}/` });
  await sleep(2500);
  const tabId = (await evaluate(cdp, sws, 'chrome.debugger.getTargets()')).find((t) => t.id === site.targetId).tabId;

  async function shot(url, file, { width = 1100, height = 900, before } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const sess = await attach(cdp, targetId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sess);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sess);
    await sleep(900);
    if (before) {
      await evaluate(cdp, sess, before);
      await sleep(900);
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sess);
    const name = `${file}${dark ? '-dark' : ''}.png`;
    fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64'));
    console.log(`saved ${name}`);
    await cdp.send('Target.closeTarget', { targetId });
  }

  const base = `chrome-extension://${id}`;
  await shot(`${base}/popup/popup.html?tabId=${tabId}`, 'popup', { width: 360, height: 760 });
  await shot(`${base}/options/options.html#rules`, 'options-rules');
  await shot(`${base}/options/options.html#test`, 'options-test', {
    before: `(() => { const i = document.querySelector('#test input'); i.value = 'accounts.google.localhost'; i.dispatchEvent(new Event('input')); document.querySelector('#verifyCard button')?.click(); })()`,
  });
  await shot(`${base}/options/options.html#rules`, 'options-editor', {
    before: `[...document.querySelectorAll('#rules button')].find(b => b.textContent === 'Edit').click()`,
    height: 1000,
  });
  await shot(`${base}/options/options.html#io`, 'options-io', { before: `[...document.querySelectorAll('#io button')].find(b => b.textContent === 'Show as YAML').click()` });
  await shot(`${base}/options/options.html#data`, 'options-data', { height: 1000 });
  await shot(`${base}/options/options.html#settings`, 'options-settings');
  await shot(`${base}/options/options.html#sessions`, 'options-sessions');
} finally {
  await b.close();
  await srv.close();
}
