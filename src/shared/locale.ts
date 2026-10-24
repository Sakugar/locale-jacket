// BCP 47 validation and locale-profile construction.

import { t } from './i18n.js';
import type { Geolocation, LocaleProfile } from './types.js';

// The Intl answers below depend only on their input and the browser's ICU data, and
// constructing Intl objects is slow (it dominated validating thousands of rules), so they
// are remembered per tag / time zone. Each map is bounded and starts over when full.
const MEMO_LIMIT = 2000;

function memo<V>(map: Map<string, V>, key: string, compute: () => V): V {
  const known = map.get(key);
  if (known !== undefined || map.has(key)) return known as V;
  const v = compute();
  if (map.size >= MEMO_LIMIT) map.clear();
  map.set(key, v);
  return v;
}

const canonicalMemo = new Map<string, string | null>();
const supportedMemo = new Map<string, boolean>();
const baseLanguageMemo = new Map<string, string | null>();
const timezoneMemo = new Map<string, boolean>();

/** Canonical BCP 47 form (e.g. `en-us` -> `en-US`), or null if the tag is invalid. */
export function canonicalizeLocale(tag: string): string | null {
  const t = tag.trim().replace(/_/g, '-');
  if (!t) return null;
  return memo(canonicalMemo, t, () => {
    try {
      const [c] = Intl.getCanonicalLocales(t);
      return c ?? null;
    } catch {
      return null;
    }
  });
}

/** True if ICU has data for the tag (otherwise Intl silently falls back to a parent or default locale). */
export function isSupportedLocale(tag: string): boolean {
  return memo(supportedMemo, tag, () => {
    try {
      return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
    } catch {
      return false;
    }
  });
}

/** Default navigator.languages for a locale: the tag followed by its base language, e.g. en-US -> [en-US, en]. */
export function deriveLanguages(locale: string): string[] {
  const out = [locale];
  const base = memo(baseLanguageMemo, locale, () => {
    try {
      return new Intl.Locale(locale).language || null;
    } catch {
      return null; /* keep just the tag */
    }
  });
  if (base && base !== locale) out.push(base);
  return out;
}

/**
 * Accept-Language header exactly as Chrome builds it from a language list
 * (net::HttpUtil::GenerateAcceptLanguageHeader): the first entry has an
 * implicit q=1, then q decreases by 0.1 per entry and stops at 0.1.
 */
export function acceptLanguageHeader(languages: string[]): string {
  let q = 10;
  const parts: string[] = [];
  for (const lang of languages) {
    parts.push(q === 10 ? lang : `${lang};q=0.${q}`);
    if (q > 1) q--;
  }
  return parts.join(',');
}

/** Parse an Accept-Language value into an ordered language list (q-values sorted, q=0 dropped). */
export function parseAcceptLanguage(value: string): string[] {
  const items = value
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
        if (m) q = Number(m[1]);
      }
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0);
  items.sort((a, b) => b.q - a.q || a.index - b.index);
  return items.map((x) => x.tag);
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  return memo(timezoneMemo, tz, () => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  });
}

/** Build a complete profile from a locale tag with derived languages and header. Throws on invalid tags. */
export function makeProfile(locale: string, extra: Partial<Pick<LocaleProfile, 'timezone' | 'geolocation'>> = {}): LocaleProfile {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) throw new RangeError(`Invalid BCP 47 locale: ${locale}`);
  const languages = deriveLanguages(canonical);
  return {
    locale: canonical,
    languages,
    acceptLanguage: acceptLanguageHeader(languages),
    timezone: extra.timezone ?? null,
    geolocation: extra.geolocation ?? null,
  };
}

export interface ProfileInput {
  locale?: unknown;
  languages?: unknown;
  acceptLanguage?: unknown;
  timezone?: unknown;
  geolocation?: unknown;
}

export interface ProfileResult {
  profile: LocaleProfile | null;
  errors: string[];
  warnings: string[];
}

/**
 * Validate and complete a (possibly partial) profile. `languages` and
 * `acceptLanguage` are derived when missing. When both are given and disagree,
 * `languages` wins because Chrome derives the header from the same list.
 */
export function normalizeProfile(input: ProfileInput): ProfileResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let languages: string[] | null = null;
  if (input.languages !== undefined && input.languages !== null) {
    const list = Array.isArray(input.languages)
      ? input.languages
      : typeof input.languages === 'string'
        ? input.languages.split(',')
        : null;
    if (!list) {
      errors.push('languages must be a list of BCP 47 tags.');
    } else {
      languages = [];
      for (const raw of list) {
        const c = typeof raw === 'string' ? canonicalizeLocale(raw) : null;
        if (!c) errors.push(`Invalid language tag in languages: ${JSON.stringify(raw)}`);
        else if (!languages.includes(c)) languages.push(c);
      }
      if (languages.length === 0 && errors.length === 0) errors.push('languages must not be empty.');
    }
  }

  let headerLanguages: string[] | null = null;
  if (typeof input.acceptLanguage === 'string' && input.acceptLanguage.trim()) {
    headerLanguages = [];
    for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
      const c = canonicalizeLocale(tag);
      if (!c) errors.push(`Invalid language tag in acceptLanguage: ${JSON.stringify(tag)}`);
      else if (!headerLanguages.includes(c)) headerLanguages.push(c);
    }
  } else if (input.acceptLanguage !== undefined && input.acceptLanguage !== null && input.acceptLanguage !== '') {
    errors.push('acceptLanguage must be a string.');
  }

  let locale: string | null = null;
  if (typeof input.locale === 'string' && input.locale.trim()) {
    locale = canonicalizeLocale(input.locale);
    if (!locale) errors.push(`Invalid BCP 47 locale: ${JSON.stringify(input.locale)}`);
  } else if (languages?.[0]) {
    locale = languages[0];
  } else if (headerLanguages?.[0]) {
    locale = headerLanguages[0];
  } else {
    errors.push('A locale is required.');
  }

  if (locale && !isSupportedLocale(locale)) {
    warnings.push(`"${locale}" is valid BCP 47 but has no ICU data; Intl APIs may report a fallback locale.`);
  }

  if (!languages) languages = headerLanguages ?? (locale ? deriveLanguages(locale) : []);
  const acceptLanguage = acceptLanguageHeader(languages);
  if (headerLanguages && headerLanguages.join(',') !== languages.join(',')) {
    warnings.push(
      `acceptLanguage (${String(input.acceptLanguage)}) does not match languages; Chrome derives the header from languages, so "${acceptLanguage}" will be sent.`,
    );
  } else if (typeof input.acceptLanguage === 'string' && input.acceptLanguage.trim() && input.acceptLanguage.replace(/\s+/g, '') !== acceptLanguage) {
    warnings.push(`Accept-Language will be sent as "${acceptLanguage}" (Chrome's own q-value format).`);
  }
  if (locale && languages[0] && languages[0] !== locale) {
    warnings.push(`navigator.language (${languages[0]}) differs from the Intl locale (${locale}).`);
  }

  let timezone: string | null = null;
  if (typeof input.timezone === 'string' && input.timezone.trim()) {
    timezone = input.timezone.trim();
    if (!isValidTimezone(timezone)) errors.push(`Unknown IANA time zone: ${JSON.stringify(input.timezone)}`);
  } else if (input.timezone !== undefined && input.timezone !== null && input.timezone !== '' && input.timezone !== false) {
    errors.push('timezone must be an IANA time zone name or null.');
  }

  let geolocation: Geolocation | null = null;
  if (input.geolocation !== undefined && input.geolocation !== null && input.geolocation !== false) {
    const g = input.geolocation as Record<string, unknown>;
    const lat = Number(g.latitude);
    const lon = Number(g.longitude);
    const acc = g.accuracy === undefined ? 100 : Number(g.accuracy);
    if (typeof g !== 'object' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push('geolocation needs numeric latitude (-90..90) and longitude (-180..180).');
    } else if (!Number.isFinite(acc) || acc <= 0) {
      errors.push('geolocation accuracy must be a positive number of meters.');
    } else {
      geolocation = { latitude: lat, longitude: lon, accuracy: acc };
    }
  }

  if (errors.length || !locale) return { profile: null, errors, warnings };
  return { profile: { locale, languages, acceptLanguage, timezone, geolocation }, errors, warnings };
}

/** Stable identity of a profile, used to skip redundant CDP commands and to compare rules. */
export function profileKey(p: LocaleProfile | null): string {
  if (!p) return 'SYSTEM';
  return JSON.stringify([p.locale, p.languages, p.timezone, p.geolocation]);
}

export function describeProfile(p: LocaleProfile | null): string {
  if (!p) return t('profile.system');
  const bits = [p.locale];
  if (p.languages.join(',') !== deriveLanguages(p.locale).join(',')) bits.push(`[${p.languages.join(', ')}]`);
  if (p.timezone) bits.push(p.timezone);
  if (p.geolocation) bits.push(`geo ${p.geolocation.latitude.toFixed(2)},${p.geolocation.longitude.toFixed(2)}`);
  return bits.join(' · ');
}
