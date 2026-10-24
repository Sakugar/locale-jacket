#!/usr/bin/env node
// Build a signed .crx with Chrome's own packer (chrome --pack-extension).
//
//   node scripts/pack-crx.mjs [--out <dir>]   → release/locale-jacket-<version>.crx
//
// The .crx is packed from a copy of dist/ without presets/ (the editable first-run rules
// file of the unpacked build); the extension generates the example preset itself instead.
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
import { EXCLUDE, assertCrxClean, assertStageClean } from './lib/crx-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const dist = path.join(root, 'dist');
  const keyDir = path.join(root, 'keys');
  const key = path.join(keyDir, 'locale-jacket.pem');
  const outArg = process.argv.indexOf('--out');
  const releaseDir = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'release');

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

  // Stage dist/ without the excluded folders. Chrome writes <stage>.crx (and <stage>.pem
  // for a new key) next to the staged folder.
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-crx-'));
  const stage = path.join(stageRoot, 'locale-jacket');
  fs.cpSync(dist, stage, { recursive: true, filter: (src) => !EXCLUDE.includes(path.relative(dist, src).split(path.sep)[0]) });
  try {
    assertStageClean(stage);
  } catch (e) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    console.error(e.message);
    process.exit(1);
  }
  const outCrx = `${stage}.crx`;
  const outPem = `${stage}.pem`;

  // A throwaway profile keeps the request from being handed to a running Chrome window.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-pack-'));
  const args = [`--pack-extension=${stage}`, `--user-data-dir=${profile}`, '--no-message-box', '--no-first-run'];
  if (fs.existsSync(key)) args.push(`--pack-extension-key=${key}`);
  const r = spawnSync(chrome, args, { stdio: 'inherit', timeout: 60_000 });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (!fs.existsSync(outCrx)) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    console.error(`Packing failed (exit ${r.status}).`);
    process.exit(1);
  }

  if (fs.existsSync(outPem)) {
    fs.mkdirSync(keyDir, { recursive: true });
    fs.copyFileSync(outPem, key); // the staging folder may be on another drive
    console.log(`New signing key saved to ${path.relative(root, key)} (git-ignored). Back it up: it determines the extension ID.`);
  }
  fs.mkdirSync(releaseDir, { recursive: true });
  const target = path.join(releaseDir, `locale-jacket-${version}.crx`);
  fs.copyFileSync(outCrx, target);
  fs.rmSync(stageRoot, { recursive: true, force: true });

  // Extension ID = first 16 bytes of SHA-256(public key DER), hex digits mapped to a–p.
  const pub = crypto.createPublicKey(fs.readFileSync(key)).export({ type: 'spki', format: 'der' });
  const id = [...crypto.createHash('sha256').update(pub).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
  const crx = fs.readFileSync(target);
  try {
    assertCrxClean(crx);
  } catch (e) {
    fs.rmSync(target, { force: true });
    console.error(`${e.message} Removed it.`);
    process.exit(1);
  }
  const magic = crx.subarray(0, 4).toString('latin1');
  console.log(`Packed ${path.relative(root, target)} (${crx.length} bytes, ${magic} v${crx.readUInt32LE(4)})`);
  console.log(`Extension ID: ${id}`);
}

// No "run directly?" guard: comparing argv[1] with import.meta.url fails through a junction,
// subst drive or symlink and would exit 0 without a .crx. The checks live in lib/crx-checks.mjs.
main();
