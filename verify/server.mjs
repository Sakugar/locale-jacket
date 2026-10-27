#!/usr/bin/env node
// Local verification server for Locale Jacket.
//
// Chrome and Edge resolve every *.localhost hostname to the loopback interface,
// so one server can impersonate many "sites": http://google.localhost:8787,
// http://mail.google.localhost:8787, http://apple.localhost:8787, ...
// Each page reports what JavaScript observes (at document start and live),
// what Accept-Language header the server received, and the same for a
// cross-site iframe, a same-site iframe and a dedicated worker.
//
// Usage: node verify/server.mjs [--port 8787]
// Nothing leaves your machine: the server binds to loopback only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, 'public');

const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Start the server on 127.0.0.1 and ::1. Returns { server, servers, port, log, clearLog, beacons, close }.
 * `log` records every HTML document request with the Accept-Language it carried;
 * `beacons` holds the reports launch.html posts after it has loaded.
 */
export function startServer({ port = 8787, quiet = false } = {}) {
  const log = [];
  const beacons = [];
  const handler = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const al = req.headers['accept-language'] ?? null;
    const noStore = { 'Cache-Control': 'no-store' };

    const html = (file) => {
      log.push({
        time: Date.now(),
        host,
        path: url.pathname,
        search: url.search,
        method: req.method,
        acceptLanguage: al,
        dest: req.headers['sec-fetch-dest'] ?? null,
        referer: req.headers.referer ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        secChUa: req.headers['sec-ch-ua'] ?? null,
      });
      const body = read(file)
        .replaceAll('{{SNAPSHOT_JS}}', read('snapshot.js'))
        .replaceAll('{{ACCEPT_LANGUAGE_JSON}}', JSON.stringify(al).replace(/</g, '\\u003c'))
        .replaceAll('{{ACCEPT_LANGUAGE}}', escapeHtml(al ?? '(none)'))
        .replaceAll('{{HOST}}', escapeHtml(host));
      // ?delay=<ms> holds the response like a slow site would (up to 10 s).
      const delay = Math.min(Math.max(Number(url.searchParams.get('delay')) || 0, 0), 10000);
      // ?prerenderable lets a same-site, cross-origin page prerender this one (Speculation Rules opt-in).
      const optIn = url.searchParams.has('prerenderable') ? { 'Supports-Loading-Mode': 'credentialed-prerender' } : {};
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStore, ...optIn });
        res.end(body);
      }, delay);
    };

    switch (url.pathname) {
      case '/':
      case '/index.html':
        return html('index.html');
      case '/frame.html':
        return html('frame.html');
      case '/plain.html':
        return html('plain.html');
      case '/prerender.html':
        return html('prerender.html');
      case '/launch.html':
        return html('launch.html');
      case '/api/beacon': {
        if (req.method !== 'POST') {
          if (url.searchParams.has('clear')) beacons.length = 0;
          res.writeHead(200, { 'Content-Type': 'application/json', ...noStore });
          return res.end(JSON.stringify(beacons));
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { if (body.length < 1e6) body += d; });
        req.on('end', () => {
          try {
            beacons.push({ receivedAt: Date.now(), ...JSON.parse(body) });
          } catch {
            /* ignore malformed reports */
          }
          res.writeHead(204, noStore);
          res.end();
        });
        return;
      }
      case '/snapshot.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript', ...noStore });
        return res.end(read('snapshot.js'));
      case '/worker.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript', ...noStore });
        return res.end(read('worker.js'));
      case '/sw.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript', ...noStore, 'Service-Worker-Allowed': '/' });
        return res.end(read('sw.js'));
      case '/api/headers':
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...noStore });
        return res.end(JSON.stringify({ host, acceptLanguage: al, headers: req.headers }));
      case '/sample-rules.yaml':
        // A small rule subscription for trying Options ▸ Subscriptions locally.
        res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', ETag: '"sample-1"', ...noStore });
        return res.end([
          '# Sample Locale Jacket subscription (verify/server.mjs)',
          'rules:',
          '  - DOMAIN-SUFFIX,example.localhost,en-GB',
          '  - DOMAIN-SUFFIX,apple.localhost,ja-JP',
          '  - type: DOMAIN',
          '    domain: news.example.localhost',
          '    locale: fr-FR',
          '  - DOMAIN-KEYWORD,shop,de-DE',
          '',
        ].join('\n'));
      case '/api/release': {
        // A GitHub-style "latest release" answer for update-check tests:
        // ?version=9.9.9&from=1.2.1 (diff pack base), ?status=404 for a failure.
        const status = Number(url.searchParams.get('status')) || 200;
        const version = url.searchParams.get('version') ?? '9.9.9';
        const from = url.searchParams.get('from') ?? '1.0.0';
        log.push({ time: Date.now(), host, path: url.pathname, search: url.search, method: req.method, acceptLanguage: al, dest: req.headers['sec-fetch-dest'] ?? null });
        const base = `http://${req.headers.host}/download/v${version}/`;
        const asset = (name) => ({ name, browser_download_url: base + name, size: 1234 });
        const body = status === 200
          ? {
              tag_name: `v${version}`,
              name: `Locale Jacket ${version}`,
              html_url: `http://${req.headers.host}/releases/v${version}`,
              published_at: '2026-10-23T04:05:09Z',
              draft: false,
              prerelease: false,
              body: `### New in ${version}\n- Test release served by verify/server.mjs.`,
              assets: [asset(`locale-jacket-${version}.zip`), asset(`locale-jacket-${version}.crx`), asset(`locale-jacket-${from}-to-${version}.diff.zip`)],
            }
          : { message: 'Not Found' };
        res.writeHead(status, { 'Content-Type': 'application/json', ...noStore });
        return res.end(JSON.stringify(body));
      }
      case '/api/log':
        if (url.searchParams.has('clear')) log.length = 0;
        res.writeHead(200, { 'Content-Type': 'application/json', ...noStore });
        return res.end(JSON.stringify(log));
      case '/redirect': {
        const to = url.searchParams.get('to') ?? '/';
        log.push({ time: Date.now(), host, path: url.pathname, search: url.search, acceptLanguage: al, dest: req.headers['sec-fetch-dest'] ?? null });
        res.writeHead(302, { Location: to, ...noStore });
        return res.end();
      }
      case '/no-content':
        res.writeHead(204, noStore);
        return res.end();
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
    }
  };

  // One server per loopback address (127.0.0.1 and ::1) on the same port, so *.localhost
  // works whichever address the browser picks and nothing else can connect.
  const listen = (host, p) =>
    new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.once('error', reject);
      server.listen({ port: p, host, ipv6Only: host === '::1' }, () => {
        server.off('error', reject);
        resolve(server);
      });
    });
  const closeAll = (servers) =>
    Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  const noIpv6 = (e) => e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT';

  const start = async () => {
    for (let attempt = 0; ; attempt++) {
      const v4 = await listen('127.0.0.1', port);
      const actual = v4.address().port;
      try {
        return [v4, await listen('::1', actual)];
      } catch (e) {
        if (noIpv6(e)) return [v4];
        await closeAll([v4]);
        // With port 0 the IPv4 port may already be taken on ::1; pick another.
        if (port !== 0 || e.code !== 'EADDRINUSE' || attempt >= 9) throw e;
      }
    }
  };

  return start().then((servers) => {
    const actual = servers[0].address().port;
    if (!quiet) {
      console.log(`Locale Jacket verification server: http://localhost:${actual}/`);
      console.log(`Try: http://google.localhost:${actual}/  http://apple.localhost:${actual}/  http://example.localhost:${actual}/`);
    }
    return {
      server: servers[0],
      servers,
      port: actual,
      log,
      clearLog: () => { log.length = 0; },
      beacons,
      close: () => closeAll(servers).then(() => {}),
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT ?? 8787);
  startServer({ port }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
