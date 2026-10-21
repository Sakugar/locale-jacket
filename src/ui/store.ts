// Settings persistence for extension pages. The background worker listens to
// chrome.storage.onChanged, so writing here applies changes everywhere.

import { sanitizeStoredSettings } from '../shared/config-io.js';
import { defaultSettings } from '../shared/presets.js';
import type { Settings } from '../shared/types.js';

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(KEY))[KEY];
  return sanitizeStoredSettings(raw, defaultSettings()).settings;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

/** Load, change and save in one step. */
export async function updateSettings(fn: (s: Settings) => Settings | void): Promise<Settings> {
  const current = await loadSettings();
  const next = fn(structuredClone(current)) ?? current;
  await saveSettings(next);
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(sanitizeStoredSettings(changes[KEY].newValue, defaultSettings()).settings);
  });
}
