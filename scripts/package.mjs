#!/usr/bin/env node
// Zip dist/ into release/locale-jacket-<version>.zip (load unpacked, Chrome Web Store / Edge Add-ons).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ is missing; run npm run build first.');
  process.exit(1);
}
const { version } = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`],
  );
}

const names = walk(dist).sort();
const zip = writeZip(names.map((name) => ({ name, data: fs.readFileSync(path.join(dist, name)) })));

const outArg = process.argv.indexOf('--out');
const outDir = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `locale-jacket-${version}.zip`);
fs.writeFileSync(out, zip);
console.log(`Packaged ${names.length} files → ${path.relative(root, out)}`);
