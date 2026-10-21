// Applying and clearing locale overrides on one CDP session.
//
// Verified behaviour in Chrome 155 (see research/FINDINGS.md):
//  * Emulation.setLocaleOverride      → Intl.* (process-wide in the renderer).
//  * Emulation.setUserAgentOverride   → navigator.language(s) + Accept-Language,
//    with userAgent "" so the UA string and UA client hints stay untouched.
//  * Emulation.setTimezoneOverride    → optional, process-wide.
//  * Emulation.setGeolocationOverride → optional.
// Each field is only sent when it changes, so steady-state navigations cost nothing.

import { isDetachedError, isProcessLockError, isUnsupportedError, protocolMessage, type DebuggerPort, type Target } from './cdp.js';
import type { LocaleProfile } from '../shared/types.js';

export type TargetKind = 'page' | 'iframe' | 'worker';

/** What has been applied on a session. `undefined` fields are unknown (e.g. adopted session). */
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

export interface ApplyOutcome {
  state: AppliedState;
  warnings: string[];
  /** The session disappeared while applying. */
  detached: boolean;
}

type Field = keyof DesiredState;

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

const FIELD_LABEL: Record<Field, string> = {
  locale: 'Intl locale',
  languages: 'navigator.language / Accept-Language',
  timezone: 'time zone',
  geolocation: 'geolocation',
};

export async function applyState(
  port: DebuggerPort,
  target: Target,
  current: AppliedState,
  desired: DesiredState,
  kind: TargetKind,
): Promise<ApplyOutcome> {
  const next: AppliedState = { ...current };
  const warnings: string[] = [];
  let detached = false;
  const fields = (Object.keys(desired) as Field[]).filter((f) => current[f] !== desired[f]);

  await Promise.all(
    fields.map(async (field) => {
      const value = desired[field];
      // Workers never get locale/timezone/geolocation commands; just record the desired value.
      if (kind === 'worker' && field !== 'languages') {
        next[field] = value;
        return;
      }
      const [method, params] = commandFor(field, value);
      try {
        await port.send(target, method, params);
        next[field] = value;
      } catch (e) {
        if (isDetachedError(e)) {
          detached = true;
          return;
        }
        if (isProcessLockError(e)) {
          // Another session in the same renderer process (another tab, DevTools, or a
          // sibling frame) owns this process-wide override.
          if (value === null) {
            next[field] = null; // nothing of ours to clear
          } else if (kind !== 'page') {
            next[field] = value; // sibling frames of one site share the process and the profile
            warnings.push(`${FIELD_LABEL[field]} is shared with another frame in the same renderer process.`);
          } else {
            warnings.push(
              `${FIELD_LABEL[field]} could not be set: another tab or DevTools already overrides it in this renderer process.`,
            );
          }
          return;
        }
        if (isUnsupportedError(e)) {
          next[field] = value;
          if (kind === 'page') warnings.push(`${method} is not supported by this browser (${protocolMessage(e)}).`);
          return;
        }
        warnings.push(`${method} failed: ${protocolMessage(e)}`);
      }
    }),
  );
  return { state: next, warnings, detached };
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
