#!/usr/bin/env node
// Build a signed .crx with Chrome's own packer (chrome --pack-extension).
//
//   node scripts/pack-crx.mjs        → release/locale-jacket-<version>.crx
//
// The signing key lives in keys/locale-jacket.pem (git-ignored). It is created on
// the first run and reused afterwards: the extension ID is derived from it, so
// keep it safe; losing it means future builds get a different ID.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../e2e/lib/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const keyDir = path.join(root, 'keys');
const key = path.join(keyDir, 'locale-jacket.pem');
const releaseDir = path.join(root, 'release');

const chrome = findBrowser('chrome') ?? findBrowser('edge');
if (!chrome) {
  console.error('Chrome or Edge is required to pack the extension (set BROWSER_PATH).');
  process.exit(1);
}
if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ is missing; run npm run build first.');
  process.exit(1);
}
const { version } = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));

// Chrome writes <dist>.crx (and <dist>.pem for a new key) next to the dist folder.
const outCrx = `${dist}.crx`;
const outPem = `${dist}.pem`;
fs.rmSync(outCrx, { force: true });
fs.rmSync(outPem, { force: true });

// A throwaway profile keeps the request from being handed to a running Chrome window.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-pack-'));
const args = [`--pack-extension=${dist}`, `--user-data-dir=${profile}`, '--no-message-box', '--no-first-run'];
if (fs.existsSync(key)) args.push(`--pack-extension-key=${key}`);
const r = spawnSync(chrome, args, { stdio: 'inherit', timeout: 60_000 });
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (!fs.existsSync(outCrx)) {
  console.error(`Packing failed (exit ${r.status}).`);
  process.exit(1);
}

if (fs.existsSync(outPem)) {
  fs.mkdirSync(keyDir, { recursive: true });
  fs.renameSync(outPem, key);
  console.log(`New signing key saved to ${path.relative(root, key)} (git-ignored). Back it up: it determines the extension ID.`);
}
fs.mkdirSync(releaseDir, { recursive: true });
const target = path.join(releaseDir, `locale-jacket-${version}.crx`);
fs.renameSync(outCrx, target);

// Extension ID = first 16 bytes of SHA-256(public key DER), hex digits mapped to a–p.
const pub = crypto.createPublicKey(fs.readFileSync(key)).export({ type: 'spki', format: 'der' });
const id = [...crypto.createHash('sha256').update(pub).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join('');
const crx = fs.readFileSync(target);
const magic = crx.subarray(0, 4).toString('latin1');
console.log(`Packed ${path.relative(root, target)} (${crx.length} bytes, ${magic} v${crx.readUInt32LE(4)})`);
console.log(`Extension ID: ${id}`);
