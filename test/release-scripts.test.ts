// Release tooling (CLAUDE.md §11): scripts/lib/zip.mjs, scripts/diff-pack.mjs, scripts/lib/crx-checks.mjs (pack-crx.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ZipEntry {
  name: string;
  data: Buffer;
}
interface ZipLib {
  writeZip(entries: ZipEntry[]): Buffer;
  readZip(buf: Buffer): Map<string, Buffer>;
  zipFromCrx(buf: Buffer): Buffer;
}
interface PackCrx {
  EXCLUDE: string[];
  excludedPaths(names: string[]): string[];
  assertStageClean(stage: string): void;
  assertCrxClean(crx: Buffer): void;
}

// The compiled test may run from build/test/ or any other output folder, so find the repo
// by walking up to its package.json.
function repoRoot(): string {
  if (process.env.LJ_REPO_ROOT) return path.resolve(process.env.LJ_REPO_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg) && fs.existsSync(path.join(dir, 'scripts', 'diff-pack.mjs'))) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'locale-jacket') return dir;
      } catch {
        /* keep looking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('Cannot find the locale-jacket repo root (set LJ_REPO_ROOT).');
    dir = up;
  }
}

const root = repoRoot();
const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(root, rel)).href)) as T;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let zip: ZipLib;
let crx: PackCrx;
let tmp: string;

before(async () => {
  zip = await load<ZipLib>('scripts/lib/zip.mjs');
  crx = await load<PackCrx>('scripts/lib/crx-checks.mjs');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lj-release-test-'));
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const manifest = (version: string) => Buffer.from(JSON.stringify({ manifest_version: 3, name: 'Locale Jacket', version }));
const entries = (files: Record<string, string | Buffer>): ZipEntry[] =>
  Object.entries(files).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));

function writeZipFile(file: string, files: Record<string, string | Buffer>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zip.writeZip(entries(files)));
}

function diffPack(args: string[]) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'diff-pack.mjs'), ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Offsets of the first entry's local header and central directory record. */
function firstHeaders(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return { local: 0, central: buf.readUInt32LE(eocd + 16) };
}

describe('zip.mjs', () => {
  const sample = () =>
    entries({
      'manifest.json': manifest('1.0.0'),
      'empty.txt': '',
      '_locales/zh_CN/messages.json': JSON.stringify({ name: { message: '语言外套' } }),
      'icons/blob.bin': crypto.randomBytes(4096),
    });

  it('round-trips writeZip → readZip', () => {
    const input = sample();
    const out = zip.readZip(zip.writeZip(input));
    assert.deepEqual([...out.keys()], input.map((e) => e.name));
    for (const e of input) assert.ok(out.get(e.name)!.equals(e.data), e.name);
  });

  it('is reproducible', () => {
    const input = sample();
    assert.ok(zip.writeZip(input).equals(zip.writeZip(input)));
  });

  it('rejects a CRC-32 mismatch', () => {
    const buf = zip.writeZip(entries({ 'a.txt': 'hello', 'b.txt': 'world' }));
    const { local, central } = firstHeaders(buf);
    // Change the CRC consistently in both headers so only the data check can catch it.
    const bad = (buf.readUInt32LE(local + 14) ^ 1) >>> 0;
    buf.writeUInt32LE(bad, local + 14);
    buf.writeUInt32LE(bad, central + 16);
    assert.throws(() => zip.readZip(buf), /CRC-32 mismatch for a\.txt/);
  });

  it('rejects a bad local header signature', () => {
    const buf = zip.writeZip(entries({ 'a.txt': 'hello' }));
    buf.writeUInt32LE(0xdeadbeef, 0);
    assert.throws(() => zip.readZip(buf), /bad local header for a\.txt/);
  });

  it('rejects local and central headers that disagree', () => {
    const buf = zip.writeZip(entries({ 'a.txt': 'hello' }));
    buf.writeUInt32LE(buf.readUInt32LE(22) + 1, 22); // local uncompressed size
    assert.throws(() => zip.readZip(buf), /disagree for a\.txt/);
  });

  it('rejects corrupted data', () => {
    const data = crypto.randomBytes(2048);
    const buf = zip.writeZip(entries({ 'a.bin': data }));
    const at = 30 + 'a.bin'.length + 100;
    buf.writeUInt8(buf.readUInt8(at) ^ 0xff, at);
    assert.throws(() => zip.readZip(buf), /Corrupt ZIP/);
  });

  it('rejects non-ZIP input', () => {
    assert.throws(() => zip.readZip(Buffer.from('not a zip at all, just some text padding it out')), /Not a ZIP/);
  });
});

describe('diff-pack.mjs', () => {
  const base = {
    'manifest.json': manifest('1.0.0'),
    'same.js': 'unchanged',
    'changed.js': 'old',
    'gone.js': 'removed in 1.1.0',
  };
  const next = {
    'manifest.json': manifest('1.1.0'),
    'same.js': 'unchanged',
    'changed.js': 'new',
    'added/file.js': 'brand new',
  };
  let releases: string;
  let toZip: string;

  before(() => {
    releases = path.join(tmp, 'release');
    writeZipFile(path.join(releases, 'v1.0.0', 'locale-jacket-1.0.0.zip'), base);
    // Stale dev builds at the top level (package.mjs's default output) must never be the base.
    writeZipFile(path.join(releases, 'locale-jacket-1.0.0.zip'), { ...base, 'changed.js': 'stale', 'stale.js': 'x' });
    writeZipFile(path.join(releases, 'locale-jacket-1.0.1.zip'), { ...next, 'manifest.json': manifest('1.0.1') });
    toZip = path.join(tmp, 'new', 'locale-jacket-1.1.0.zip');
    writeZipFile(toZip, next);
  });

  const run = (out: string, extra: string[] = []) => {
    const r = diffPack(['--releases', releases, '--to', toZip, '--out', out, ...extra]);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };

  it('picks release/v<ver>/ as the base, ignoring stale top-level zips', () => {
    const out = path.join(tmp, 'out-default');
    run(out);
    assert.deepEqual(fs.readdirSync(out), ['locale-jacket-1.0.0-to-1.1.0.diff.zip']);
    const pack = zip.readZip(fs.readFileSync(path.join(out, 'locale-jacket-1.0.0-to-1.1.0.diff.zip')));
    assert.match(pack.get('CHANGES.txt')!.toString('utf8'), /^Locale Jacket 1\.0\.0 → 1\.1\.0 diff pack/);
  });

  it('includes only added and modified files, with A/M/D lines and SHA-256', () => {
    const out = path.join(tmp, 'out-content');
    run(out);
    const pack = zip.readZip(fs.readFileSync(path.join(out, 'locale-jacket-1.0.0-to-1.1.0.diff.zip')));
    assert.deepEqual([...pack.keys()].sort(), ['CHANGES.txt', 'DELETED.txt', 'added/file.js', 'changed.js', 'manifest.json']);
    assert.equal(pack.get('changed.js')!.toString(), 'new');
    const lines = pack.get('CHANGES.txt')!.toString('utf8').split('\n');
    assert.ok(lines.includes(`A  added/file.js  ${sha(Buffer.from('brand new'))}`));
    assert.ok(lines.includes(`M  changed.js  ${sha(Buffer.from('new'))}`));
    assert.ok(lines.includes(`M  manifest.json  ${sha(manifest('1.1.0'))}`));
    assert.ok(lines.includes('D  gone.js'));
    assert.ok(!lines.some((l) => l.includes('same.js')));
    assert.ok(lines.some((l) => l.startsWith('Unchanged: 1 file(s). Added/modified: 3. Deleted: 1.')));
    assert.equal(pack.get('DELETED.txt')!.toString(), 'gone.js\n');
  });

  it('writes no DELETED.txt when nothing was removed', () => {
    const out = path.join(tmp, 'out-nodelete');
    const to = path.join(tmp, 'new', 'nodelete', 'locale-jacket-1.1.0.zip');
    writeZipFile(to, { ...next, 'gone.js': 'removed in 1.1.0' });
    const r = diffPack(['--releases', releases, '--to', to, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const pack = zip.readZip(fs.readFileSync(path.join(out, 'locale-jacket-1.0.0-to-1.1.0.diff.zip')));
    assert.ok(!pack.has('DELETED.txt'));
    assert.ok(!pack.get('CHANGES.txt')!.toString().split('\n').some((l) => l.startsWith('D  ')));
  });

  it('maps --from <version> to release/v<version>/', () => {
    const out = path.join(tmp, 'out-from-version');
    run(out, ['--from', '1.0.0']);
    const pack = zip.readZip(fs.readFileSync(path.join(out, 'locale-jacket-1.0.0-to-1.1.0.diff.zip')));
    assert.ok(!pack.has('stale.js'));
    assert.ok(pack.get('DELETED.txt')!.toString().includes('gone.js'));
  });

  it('accepts an explicit --from <zip>', () => {
    const out = path.join(tmp, 'out-from-zip');
    run(out, ['--from', path.join(releases, 'locale-jacket-1.0.1.zip')]);
    const pack = zip.readZip(fs.readFileSync(path.join(out, 'locale-jacket-1.0.1-to-1.1.0.diff.zip')));
    assert.deepEqual([...pack.keys()].sort(), ['CHANGES.txt', 'manifest.json']);
  });

  it('aborts when the expected base zip is missing', () => {
    const r = diffPack(['--releases', releases, '--to', toZip, '--out', path.join(tmp, 'out-missing'), '--from', '0.9.0']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /v0\.9\.0[\\/]locale-jacket-0\.9\.0\.zip/);
    assert.ok(!fs.existsSync(path.join(tmp, 'out-missing')));
  });

  it('aborts when no published release is older than the new one', () => {
    const empty = path.join(tmp, 'release-empty');
    writeZipFile(path.join(empty, 'locale-jacket-1.0.0.zip'), base); // top level only
    const r = diffPack(['--releases', empty, '--to', toZip, '--out', path.join(tmp, 'out-none')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No previous release found/);
  });

  it('aborts on a corrupt base zip', () => {
    const bad = path.join(tmp, 'release-bad');
    const file = path.join(bad, 'v1.0.0', 'locale-jacket-1.0.0.zip');
    writeZipFile(file, base);
    const buf = fs.readFileSync(file);
    const { local, central } = firstHeaders(buf);
    const crc = (buf.readUInt32LE(local + 14) ^ 0xffff) >>> 0;
    buf.writeUInt32LE(crc, local + 14);
    buf.writeUInt32LE(crc, central + 16);
    fs.writeFileSync(file, buf);
    const r = diffPack(['--releases', bad, '--to', toZip, '--out', path.join(tmp, 'out-bad')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CRC-32 mismatch/);
  });
});

describe('pack-crx.mjs (lib/crx-checks.mjs)', () => {
  const fakeCrx = (files: Record<string, string>) => {
    const head = Buffer.alloc(12);
    head.write('Cr24', 0, 'latin1');
    head.writeUInt32LE(3, 4);
    head.writeUInt32LE(0, 8);
    return Buffer.concat([head, zip.writeZip(entries(files))]);
  };

  it('excludes presets/', () => {
    assert.deepEqual(crx.EXCLUDE, ['presets']);
    assert.deepEqual(crx.excludedPaths(['manifest.json', 'presets/default-rules.yaml', 'shared/presets.js']), ['presets/default-rules.yaml']);
  });

  it('refuses a staging folder that contains presets/', () => {
    const stage = path.join(tmp, 'stage');
    fs.mkdirSync(path.join(stage, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'manifest.json'), manifest('1.0.0'));
    fs.writeFileSync(path.join(stage, 'presets', 'default-rules.yaml'), 'rules: []\n');
    assert.throws(() => crx.assertStageClean(stage), /must not contain presets\//);
    fs.rmSync(path.join(stage, 'presets'), { recursive: true });
    assert.doesNotThrow(() => crx.assertStageClean(stage));
  });

  it('refuses a .crx whose payload contains presets/', () => {
    assert.throws(() => crx.assertCrxClean(fakeCrx({ 'manifest.json': '{}', 'presets/default-rules.yaml': 'rules: []' })), /presets\/default-rules\.yaml/);
    assert.doesNotThrow(() => crx.assertCrxClean(fakeCrx({ 'manifest.json': '{}', 'shared/presets.js': '' })));
  });
});
