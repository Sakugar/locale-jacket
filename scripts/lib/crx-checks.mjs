// Checks that keep excluded folders (the editable first-run preset) out of the .crx.
// Kept apart from scripts/pack-crx.mjs so that script can run its main code unconditionally:
// a "was I run directly?" guard compares paths and silently skips packing when the script
// is reached through a junction, subst drive or symlink.
import fs from 'node:fs';
import { readZip, zipFromCrx } from './zip.mjs';

export const EXCLUDE = ['presets'];

/** Paths (forward slashes) whose first segment is excluded from the .crx. */
export const excludedPaths = (names) => names.filter((n) => EXCLUDE.includes(n.split('/')[0]));

/** Throw if the staging folder still contains an excluded folder. */
export function assertStageClean(stage) {
  const found = fs.readdirSync(stage).filter((n) => EXCLUDE.includes(n));
  if (found.length) throw new Error(`The staging folder must not contain ${found.map((n) => `${n}/`).join(', ')}; refusing to pack.`);
}

/** Throw if the ZIP payload of a .crx contains excluded files. */
export function assertCrxClean(crx) {
  const leaked = excludedPaths([...readZip(zipFromCrx(crx)).keys()]);
  if (leaked.length) throw new Error(`The .crx must not contain ${leaked.join(', ')}.`);
}
