// Applying and clearing locale overrides on one CDP session.
//
// Verified behaviour in Chrome 155 (see research/FINDINGS.md):
//  * Emulation.setLocaleOverride      → Intl.* (process-wide in the renderer).
//  * Emulation.setUserAgentOverride   → navigator.language(s) + Accept-Language,
//    with userAgent "" so the UA string and UA client hints stay untouched.
//  * Emulation.setTimezoneOverride    → optional, process-wide.
//  * Emulation.setGeolocationOverride → optional.
//
// Commands are *sent* synchronously and *not awaited* by callers on the critical
// path: while a cross-process navigation is pending, Chrome holds renderer-bound
// commands until the navigation commits, so awaiting them from inside the Fetch
// gate would deadlock (the navigation waits for the gate, the gate waits for the
// commit). chrome.debugger delivers commands to a session in order, so sending
// them before Fetch.continueRequest is what guarantees they apply first.

import { isDetachedError, isProcessLockError, isUnsupportedError, protocolMessage, type DebuggerPort, type Target } from './cdp.js';
import { t, type MessageKey } from '../shared/i18n.js';
import type { LocaleProfile } from '../shared/types.js';

export type TargetKind = 'page' | 'iframe' | 'worker';

/** Intended overrides on a session. `undefined` = unknown (adopted session or a failed command). */
export interface AppliedState {
  locale: string | null | undefined;
  languages: string | null | undefined;
  timezone: string | null | undefined;
  geolocation: string | null | undefined;
}

export const UNKNOWN_STATE: AppliedState = { locale: undefined, languages: undefined, timezone: undefined, geolocation: undefined };
export const CLEAN_STATE: AppliedState = { locale: null, languages: null, timezone: null, geolocation: null };

export interface DesiredState {
  locale: string | null;
  languages: string | null;
  timezone: string | null;
  geolocation: string | null;
}

export type Field = keyof DesiredState;

export function desiredFor(profile: LocaleProfile | null, kind: TargetKind): DesiredState {
  if (!profile) return { locale: null, languages: null, timezone: null, geolocation: null };
  if (kind === 'worker') {
    // Dedicated workers share their parent's renderer process, so Intl and the time
    // zone already follow the parent; only navigator.language(s) needs a worker override.
    return { locale: null, languages: profile.languages.join(','), timezone: null, geolocation: null };
  }
  return {
    locale: profile.locale,
    languages: profile.languages.join(','),
    timezone: profile.timezone,
    geolocation: profile.geolocation ? JSON.stringify(profile.geolocation) : null,
  };
}

export interface ApplyResult {
  /** Fields whose command failed; the caller should treat them as unknown. */
  failed: { field: Field; value: string | null }[];
  warnings: string[];
  /** The session disappeared while applying. */
  detached: boolean;
}

export interface ApplyTicket {
  /** State to record immediately (optimistic: every sent command succeeds). */
  state: AppliedState;
  /** True if at least one command was sent. */
  sent: boolean;
  done: Promise<ApplyResult>;
}

function commandFor(field: Field, value: string | null): [string, object] {
  switch (field) {
    case 'locale':
      return ['Emulation.setLocaleOverride', value ? { locale: value } : {}];
    case 'languages':
      return ['Emulation.setUserAgentOverride', value ? { userAgent: '', acceptLanguage: value } : { userAgent: '' }];
    case 'timezone':
      return ['Emulation.setTimezoneOverride', { timezoneId: value ?? '' }];
    case 'geolocation': {
      if (!value) return ['Emulation.clearGeolocationOverride', {}];
      const g = JSON.parse(value) as { latitude: number; longitude: number; accuracy: number };
      return ['Emulation.setGeolocationOverride', { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy }];
    }
  }
}

const FIELD_LABEL: Record<Field, MessageKey> = {
  locale: 'bg.field.locale',
  languages: 'bg.field.languages',
  timezone: 'bg.field.timezone',
  geolocation: 'bg.field.geolocation',
};

/** Send the commands needed to move `current` to `desired`. Never awaits. */
export function applyState(port: DebuggerPort, target: Target, current: AppliedState, desired: DesiredState, kind: TargetKind): ApplyTicket {
  const state: AppliedState = { ...current };
  const fields = (Object.keys(desired) as Field[]).filter((f) => current[f] !== desired[f]);
  const pending: Promise<{ field: Field; value: string | null; error?: unknown }>[] = [];

  for (const field of fields) {
    const value = desired[field];
    state[field] = value;
    // Workers never get locale/timezone/geolocation commands; recording the value is enough.
    if (kind === 'worker' && field !== 'languages') continue;
    const [method, params] = commandFor(field, value);
    pending.push(
      port.send(target, method, params).then(
        () => ({ field, value }),
        (error: unknown) => ({ field, value, error }),
      ),
    );
  }

  const done = Promise.all(pending).then((outcomes) => {
    const result: ApplyResult = { failed: [], warnings: [], detached: false };
    for (const { field, value, error } of outcomes) {
      if (error === undefined) continue;
      const [method] = commandFor(field, value);
      if (isDetachedError(error)) {
        result.detached = true;
      } else if (isProcessLockError(error)) {
        // Another session in the same renderer process (another tab, DevTools, or a
        // sibling frame) owns this process-wide override.
        if (value === null) continue; // nothing of ours to clear
        if (kind !== 'page') {
          // Frames of one site share a renderer process; usually that is the same tab and
          // profile, but another tab embedding the same site can hold a different locale.
          result.warnings.push(t('bg.warn.sharedFrame', { field: t(FIELD_LABEL[field]) }));
          continue;
        }
        result.failed.push({ field, value });
        result.warnings.push(t('bg.warn.locked', { field: t(FIELD_LABEL[field]) }));
      } else if (isUnsupportedError(error)) {
        if (kind === 'page') result.warnings.push(t('bg.warn.unsupported', { method, error: protocolMessage(error) }));
      } else {
        result.failed.push({ field, value });
        result.warnings.push(t('bg.warn.failed', { method, error: protocolMessage(error) }));
      }
    }
    return result;
  });
  return { state, sent: pending.length > 0, done };
}

export function stateMatches(state: AppliedState, desired: DesiredState): boolean {
  return (Object.keys(desired) as Field[]).every((f) => state[f] === desired[f]);
}

/**
 * Accept-Language for a paused document request. Returns the replacement header list,
 * or null when the request already carries the right value.
 * `profile` null means "native": the header is removed so the network stack adds the
 * browser's own value (verified: paused requests carry no Accept-Language natively).
 */
export function fixAcceptLanguage(
  headers: Record<string, string>,
  profile: LocaleProfile | null,
): { name: string; value: string }[] | null {
  const entries = Object.entries(headers);
  const current = entries.find(([k]) => k.toLowerCase() === 'accept-language')?.[1] ?? null;
  const want = profile ? profile.acceptLanguage : null;
  if (current === want) return null;
  const out = entries.filter(([k]) => k.toLowerCase() !== 'accept-language').map(([name, value]) => ({ name, value }));
  if (want) out.push({ name: 'Accept-Language', value: want });
  return out;
}
