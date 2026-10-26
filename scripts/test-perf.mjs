#!/usr/bin/env node
// Run the performance tests with their wall-clock ceilings enforced (LJ_PERF=1).
// `npm test` runs the same tests but only reports the times, so a slow machine cannot fail it.
//   npm run test:perf        (builds the tests first)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'build', 'test', 'perf.test.js');
if (!fs.existsSync(file)) {
  console.error(`${path.relative(root, file)} is missing; build the tests first (node scripts/build.mjs --tests).`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, LJ_PERF: '1' },
});
process.exit(r.status ?? 1);
