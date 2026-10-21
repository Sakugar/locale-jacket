#!/usr/bin/env node
// Build the extension into dist/ (load it via chrome://extensions → Load unpacked).
//   node scripts/build.mjs           extension build (dist/)
//   node scripts/build.mjs --tests   also compile unit tests into build/
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const withTests = process.argv.includes('--tests');

function tsc(project) {
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  const r = process.platform === 'win32'
    ? spawnSync(`"${bin}" -p ${project}`, { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync(bin, ['-p', project], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`tsc -p ${project} failed`);
    process.exit(r.status ?? 1);
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
tsc('tsconfig.json');
copyDir(path.join(root, 'static'), dist);

// Keep the manifest version in sync with package.json.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(dist, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built Locale Jacket ${manifest.version} → ${path.relative(root, dist)}${path.sep}`);

if (withTests) {
  fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
  tsc('tsconfig.test.json');
  // Node needs to know the compiled output is ESM.
  fs.writeFileSync(path.join(root, 'build', 'package.json'), '{ "type": "module" }\n');
  console.log('Compiled tests → build/test/');
}
