// Human-readable presentation of a tab's status, shared by popup and options.

import type { GlobalStatus, TabStatus } from '../shared/messages.js';

export type ChipKind = 'ok' | 'warn' | 'bad' | 'off' | 'accent';

export interface StatusView {
  label: string;
  kind: ChipKind;
  detail: string;
}

export function describeStatus(s: TabStatus | null, g: GlobalStatus | null): StatusView {
  if (g && !g.enabled) return { label: 'Off', kind: 'off', detail: 'Locale Jacket is turned off. Websites see your real browser locale.' };
  if (g?.suspended) {
    return {
      label: 'Paused',
      kind: 'warn',
      detail: 'Debugging was canceled from Chrome’s “started debugging this browser” banner. Press Resume to continue.',
    };
  }
  if (!s) return { label: 'Unknown', kind: 'off', detail: 'This tab has not been seen yet. Reload it.' };
  const target = s.resolution.profile;
  if (!target) {
    if (s.session === 'attached') return { label: 'System locale', kind: 'off', detail: 'No spoofing on this site. The debugger stays attached so the next navigation can be switched instantly.' };
    return { label: 'System locale', kind: 'off', detail: 'No spoofing on this site; the browser’s own locale is used.' };
  }
  if (s.session === 'restricted') {
    return { label: 'Not allowed', kind: 'off', detail: 'Chrome does not let extensions debug this page (internal pages, the Web Store, or blocked by policy).' };
  }
  if (s.session === 'failed') return { label: 'Error', kind: 'bad', detail: s.error ?? 'Attaching the debugger failed.' };
  if (s.session !== 'attached') return { label: 'Not active', kind: 'warn', detail: s.error ?? 'Waiting for the next navigation in this tab.' };
  if (s.warnings.length) return { label: 'Partial', kind: 'warn', detail: s.warnings[0]! };
  if (s.late) return { label: 'Reload needed', kind: 'warn', detail: s.lateReason ?? 'The page started before the profile was applied.' };
  return { label: `Active · ${target.locale}`, kind: 'ok', detail: s.autoReloaded ? 'Applied (the page was reloaded once so its scripts start with the profile).' : 'Applied from the start of the page.' };
}
