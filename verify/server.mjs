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
 * Start the server. Returns { server, port, log, clearLog, beacons, close }.
 * `log` records every HTML document request with the Accept-Language it carried;
 * `beacons` holds the reports launch.html posts after it has loaded.
 */
export function startServer({ port = 8787, quiet = false } = {}) {
  const log = [];
  const beacons = [];
  const server = http.createServer((req, res) => {
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStore });
      res.end(body);
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
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Listen on the IPv6 wildcard (dual-stack) so both ::1 and 127.0.0.1 work,
    // but only accept loopback peers.
    server.on('connection', (socket) => {
      const a = socket.remoteAddress ?? '';
      if (!(a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'))) socket.destroy();
    });
    server.listen({ port, host: '::', ipv6Only: false }, () => {
      const actual = server.address().port;
      if (!quiet) {
        console.log(`Locale Jacket verification server: http://localhost:${actual}/`);
        console.log(`Try: http://google.localhost:${actual}/  http://apple.localhost:${actual}/  http://example.localhost:${actual}/`);
      }
      resolve({
        server,
        port: actual,
        log,
        clearLog: () => { log.length = 0; },
        beacons,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
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
