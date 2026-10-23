import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportConfig, importConfigText } from '../src/shared/config-io.js';
import {
  availableUpdate,
  checkDue,
  compareVersions,
  DEFAULT_RELEASE_SOURCE,
  fetchLatestRelease,
  MIN_CHECK_GAP_HOURS,
  parseRelease,
  releaseDownloads,
} from '../src/shared/extension-update.js';
import { DEFAULT_OPTIONS, defaultSettings } from '../src/shared/presets.js';
import type { ExtensionUpdateOptions } from '../src/shared/types.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function githubRelease(version: string, extra: Record<string, unknown> = {}) {
  const asset = (name: string) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v${version}/${name}`, size: 100 });
  return {
    tag_name: `v${version}`,
    name: `Locale Jacket ${version}`,
    html_url: `https://github.com/o/r/releases/tag/v${version}`,
    published_at: '2026-10-23T04:05:09Z',
    body: '### New\n<script>alert(1)</script>',
    draft: false,
    prerelease: false,
    assets: [asset(`locale-jacket-${version}.zip`), asset(`locale-jacket-${version}.crx`), asset(`locale-jacket-1.2.1-to-${version}.diff.zip`), asset('SHA256SUMS.txt')],
    ...extra,
  };
}

describe('compareVersions', () => {
  it('compares dotted versions numerically and ignores a leading v', () => {
    assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
    assert.equal(compareVersions('v1.2.1', '1.2.1'), 0);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
    assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  });
});

describe('parseRelease', () => {
  it('reads a GitHub release', () => {
    const r = parseRelease(githubRelease('1.3.0'));
    assert.equal(r.version, '1.3.0');
    assert.equal(r.page, 'https://github.com/o/r/releases/tag/v1.3.0');
    assert.equal(r.assets.length, 4);
    assert.match(r.notes, /<script>/, 'notes are kept as text; the page never renders them as HTML');
  });

  it('takes the newest non-draft, non-prerelease entry of a list', () => {
    const r = parseRelease([githubRelease('2.0.0', { prerelease: true }), githubRelease('1.9.0', { draft: true }), githubRelease('1.3.0')]);
    assert.equal(r.version, '1.3.0');
  });

  it('rejects answers that are not releases, and drops unsafe asset links', () => {
    assert.throws(() => parseRelease({ message: 'Not Found' }), /not a GitHub release/);
    assert.throws(() => parseRelease([]), /not a GitHub release/);
    const r = parseRelease(githubRelease('1.3.0', { assets: [{ name: 'x.zip', browser_download_url: 'javascript:alert(1)' }], html_url: 'javascript:alert(1)' }));
    assert.deepEqual(r.assets, []);
    assert.equal(r.page, '');
  });
});

describe('fetchLatestRelease', () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('returns the release and sends no credentials of its own', async () => {
    let seen: RequestInit | undefined;
    const f = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify(githubRelease('1.3.0')), { status: 200 });
    }) as typeof fetch;
    assert.equal((await fetchLatestRelease(DEFAULT_RELEASE_SOURCE, f)).version, '1.3.0');
    assert.equal(seen?.cache, 'no-store');
    assert.ok(!JSON.stringify(seen).includes('Authorization'));
  });

  it('explains a 404 (private repository) and other failures', async () => {
    await assert.rejects(fetchLatestRelease(DEFAULT_RELEASE_SOURCE, answer(404, { message: 'Not Found' })), /private GitHub repository/);
    await assert.rejects(fetchLatestRelease(DEFAULT_RELEASE_SOURCE, answer(500, {})), /HTTP 500/);
    await assert.rejects(fetchLatestRelease('file:///etc/passwd', answer(200, {})), /https:\/\//);
  });
});

describe('availableUpdate and releaseDownloads', () => {
  it('reports only a newer version', () => {
    const latest = parseRelease(githubRelease('1.3.0'));
    assert.equal(availableUpdate({ latest }, '1.2.1')?.version, '1.3.0');
    assert.equal(availableUpdate({ latest }, '1.3.0'), null);
    assert.equal(availableUpdate({ latest }, '1.4.0'), null);
    assert.equal(availableUpdate(undefined, '1.2.1'), null);
  });

  it('finds the zip, the crx and the diff pack from the installed version', () => {
    const latest = parseRelease(githubRelease('1.3.0'));
    const d = releaseDownloads(latest, '1.2.1');
    assert.match(d.diff!.url, /locale-jacket-1\.2\.1-to-1\.3\.0\.diff\.zip$/);
    assert.match(d.zip!.url, /locale-jacket-1\.3\.0\.zip$/);
    assert.match(d.crx!.url, /locale-jacket-1\.3\.0\.crx$/);
    assert.equal(releaseDownloads(latest, '1.1.0').diff, undefined, 'no diff pack from older versions');
  });
});

describe('checkDue', () => {
  const opts = (o: Partial<ExtensionUpdateOptions>): ExtensionUpdateOptions => ({ ...DEFAULT_OPTIONS.extensionUpdates, ...o });

  it('is off by default; manual checks always run', () => {
    assert.equal(DEFAULT_OPTIONS.extensionUpdates.onStartup, false);
    assert.equal(DEFAULT_OPTIONS.extensionUpdates.interval, 'off');
    assert.equal(checkDue(DEFAULT_OPTIONS.extensionUpdates, undefined, 'startup', NOW), false);
    assert.equal(checkDue(DEFAULT_OPTIONS.extensionUpdates, undefined, 'alarm', NOW), false);
    assert.equal(checkDue(DEFAULT_OPTIONS.extensionUpdates, { lastAttempt: NOW - 1000 }, 'manual', NOW), true);
  });

  it('startup and interval checks, never more often than the minimum gap', () => {
    assert.equal(checkDue(opts({ onStartup: true }), undefined, 'startup', NOW), true);
    assert.equal(checkDue(opts({ onStartup: true }), { lastAttempt: NOW - (MIN_CHECK_GAP_HOURS - 1) * HOUR }, 'startup', NOW), false);
    assert.equal(checkDue(opts({ onStartup: true }), { lastAttempt: NOW - (MIN_CHECK_GAP_HOURS + 1) * HOUR }, 'startup', NOW), true);
    assert.equal(checkDue(opts({ interval: 'daily' }), { lastAttempt: NOW - 25 * HOUR, lastChecked: NOW - 25 * HOUR }, 'alarm', NOW), true);
    assert.equal(checkDue(opts({ interval: 'weekly' }), { lastAttempt: NOW - 25 * HOUR, lastChecked: NOW - 25 * HOUR }, 'alarm', NOW), false);
    assert.equal(checkDue(opts({ interval: 'daily' }), { lastAttempt: NOW - 25 * HOUR, lastChecked: NOW - 25 * HOUR }, 'startup', NOW), true, 'catches up at startup');
    assert.equal(checkDue(opts({ interval: 'daily' }), { lastAttempt: NOW - 2 * HOUR, lastChecked: NOW - 30 * HOUR }, 'alarm', NOW), false, 'a recent failed attempt still counts');
  });
});

describe('extensionUpdates in import / export', () => {
  it('round-trips and validates', () => {
    const s = defaultSettings();
    s.options.extensionUpdates = { onStartup: true, interval: 'weekly', source: 'https://example.com/releases/latest' };
    const back = importConfigText(exportConfig(s, 'yaml'));
    assert.deepEqual(back.settings?.options.extensionUpdates, s.options.extensionUpdates);
    const bad = importConfigText(JSON.stringify({ rules: [], options: { extensionUpdates: { interval: 'hourly', source: 'ftp://x' } } }));
    assert.deepEqual(bad.errors, [
      'options.extensionUpdates.interval must be "off", "daily", "weekly" or "monthly".',
      'options.extensionUpdates.source must be an http(s) URL.',
    ]);
  });

  it('settings without the field (1.2.1 and older) get the defaults', () => {
    const r = importConfigText(JSON.stringify({ rules: [], options: { reloadOnLate: true } }));
    assert.deepEqual(r.settings?.options.extensionUpdates, DEFAULT_OPTIONS.extensionUpdates);
  });
});
