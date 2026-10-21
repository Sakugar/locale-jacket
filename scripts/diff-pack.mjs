#!/usr/bin/env node
// Build the per-release diff pack: only the files that were added or changed since the
// previous release, so an unpacked install can be upgraded by copying them over it.
//
//   node scripts/diff-pack.mjs [--from <version|zip>] [--to <zip>] [--out <dir>]
//     → <out>/locale-jacket-<from>-to-<version>.diff.zip
//
// The new release is dist/ (run `npm run build` first), or a release zip given with --to. The previous release defaults to
// the newest locale-jacket-<v>.zip under release/ with a lower version. The pack contains
// the changed files at their normal paths, plus:
//   CHANGES.txt   one line per file: A (added) / M (modified) / D (deleted), path, SHA-256
//   DELETED.txt   files to remove from the old folder (only when there are any)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`],
  );
}

let newFiles;
const to = arg('--to');
if (to) {
  newFiles = new Map([...readZip(fs.readFileSync(path.resolve(to)))].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
} else {
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
    console.error('dist/ is missing; run npm run build first.');
    process.exit(1);
  }
  newFiles = new Map(walk(dist).sort().map((n) => [n, fs.readFileSync(path.join(dist, n))]));
}
if (!newFiles.has('manifest.json')) {
  console.error('The new release has no manifest.json.');
  process.exit(1);
}
const { version } = JSON.parse(newFiles.get('manifest.json').toString('utf8'));

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

function releaseZips() {
  const found = new Map();
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && /^v\d/.test(e.name)) visit(path.join(dir, e.name));
      const m = e.isFile() && e.name.match(/^locale-jacket-(\d+(?:\.\d+)*)\.zip$/);
      if (m && !found.has(m[1])) found.set(m[1], path.join(dir, e.name));
    }
  };
  visit(releaseDir);
  return found;
}

let fromVersion;
let fromZip;
const from = arg('--from');
if (from && from.endsWith('.zip')) {
  fromZip = path.resolve(from);
  fromVersion = path.basename(fromZip).match(/locale-jacket-(.+)\.zip$/)?.[1] ?? 'previous';
} else {
  const zips = releaseZips();
  fromVersion = from ?? [...zips.keys()].filter((v) => cmp(v, version) < 0).sort(cmp).at(-1);
  fromZip = fromVersion && zips.get(fromVersion);
}
if (!fromZip || !fs.existsSync(fromZip)) {
  console.error(`No previous release zip found${fromVersion ? ` for ${fromVersion}` : ''}; pass --from <version|zip>.`);
  process.exit(1);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const oldFiles = readZip(fs.readFileSync(fromZip));

const lines = [];
const entries = [];
for (const [name, data] of newFiles) {
  const old = oldFiles.get(name);
  if (old && old.equals(data)) continue;
  lines.push(`${old ? 'M' : 'A'}  ${name}  ${sha(data)}`);
  entries.push({ name, data });
}
const deleted = [...oldFiles.keys()].filter((n) => !newFiles.has(n)).sort();
for (const name of deleted) lines.push(`D  ${name}`);

const header = [
  `Locale Jacket ${fromVersion} → ${version} diff pack`,
  `Unchanged: ${newFiles.size - entries.length} file(s). Added/modified: ${entries.length}. Deleted: ${deleted.length}.`,
  `Upgrade an unpacked ${fromVersion} folder: copy these files over it, delete the files listed in DELETED.txt, then reload the extension.`,
  '',
];
entries.push({ name: 'CHANGES.txt', data: Buffer.from([...header, ...lines, ''].join('\n')) });
if (deleted.length) entries.push({ name: 'DELETED.txt', data: Buffer.from(deleted.join('\n') + '\n') });

const outDir = path.resolve(arg('--out') ?? releaseDir);
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `locale-jacket-${fromVersion}-to-${version}.diff.zip`);
fs.writeFileSync(out, writeZip(entries));
console.log(`Diff pack ${fromVersion} → ${version}: ${lines.length - deleted.length} added/modified, ${deleted.length} deleted → ${path.relative(root, out)}`);
