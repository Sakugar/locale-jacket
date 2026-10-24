// Hostname normalization and DNS-label-aware matching.
//
// All hostnames are compared in their ASCII (punycode) form, lowercased and
// without a trailing dot. The WHATWG URL parser performs IDNA/UTS #46 mapping,
// so the same code path works in the service worker, extension pages and Node.

const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$|^xn--[a-z0-9-]+$/;

export type HostKind = 'domain' | 'ipv4' | 'ipv6';

export interface NormalizedHost {
  /** ASCII form used for matching, e.g. `xn--fiqs8s.example`. */
  ascii: string;
  /** Unicode form for display and keyword matching, e.g. `中国.example`. */
  unicode: string;
  kind: HostKind;
}

export function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isIPv6(host: string): boolean {
  return host.startsWith('[') && host.endsWith(']');
}

export function hostKind(host: string): HostKind {
  if (isIPv6(host)) return 'ipv6';
  if (isIPv4(host)) return 'ipv4';
  return 'domain';
}

/** Hostname of a URL in canonical ASCII form, or null for URLs without a host. */
export function hostFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const h = stripTrailingDots(parsed.hostname.toLowerCase());
  return h || null;
}

function stripTrailingDots(h: string): string {
  return h.replace(/\.+$/, '');
}

/**
 * Normalize a bare hostname (no scheme, port or path). Returns null if the
 * value is not a syntactically valid hostname.
 */
export function normalizeHost(input: string): NormalizedHost | null {
  const raw = input.trim();
  if (!raw || /[\s/\\?#@]/.test(raw)) return null;
  // Reject ports, except inside an IPv6 literal.
  if (!raw.startsWith('[') && raw.includes(':')) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${raw}/`).hostname;
  } catch {
    return null;
  }
  ascii = stripTrailingDots(ascii.toLowerCase());
  if (!ascii) return null;
  const kind = hostKind(ascii);
  if (kind === 'domain') {
    if (ascii.length > MAX_HOST_LENGTH) return null;
    const labels = ascii.split('.');
    if (labels.some((l) => l.length === 0 || l.length > MAX_LABEL_LENGTH || !LABEL_RE.test(l))) return null;
  }
  return { ascii, unicode: kind === 'domain' ? toUnicode(ascii) : ascii, kind };
}

export interface DomainInputResult {
  host: NormalizedHost | null;
  /** Human-readable notes about how the input was interpreted. */
  notes: string[];
  error?: string;
}

/**
 * Normalize what a user typed into a DOMAIN / DOMAIN-SUFFIX field. Accepts
 * full URLs (the hostname is extracted) and, for suffix rules, wildcard
 * prefixes such as `*.example.com`, `+.example.com` or `.example.com`.
 */
export function normalizeDomainInput(input: string, opts: { suffix: boolean }): DomainInputResult {
  const notes: string[] = [];
  let value = input.trim();
  if (!value) return { host: null, notes, error: 'Domain is empty.' };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const h = hostFromUrl(value);
    if (!h) return { host: null, notes, error: 'Only http(s) URLs can be used.' };
    notes.push(`Using the hostname of the URL: ${h}`);
    value = h;
  }

  const wildcard = /^(\*\.|\+\.|\.)/.exec(value);
  if (wildcard) {
    if (!opts.suffix) {
      return { host: null, notes, error: 'Wildcards are not allowed in DOMAIN rules. Use DOMAIN-SUFFIX instead.' };
    }
    value = value.slice(wildcard[0].length);
    notes.push(`"${wildcard[0]}" prefix removed: DOMAIN-SUFFIX already matches all subdomains.`);
  }
  if (value.includes('*')) return { host: null, notes, error: 'Wildcards are only supported as a leading "*." in DOMAIN-SUFFIX rules.' };

  const host = normalizeHost(value);
  if (!host) return { host: null, notes, error: `"${value}" is not a valid hostname.` };

  if (opts.suffix) {
    if (host.kind !== 'domain') {
      return { host: null, notes, error: 'IP addresses cannot be used with DOMAIN-SUFFIX. Use a DOMAIN rule.' };
    }
    const last = host.ascii.split('.').at(-1) ?? '';
    if (/^\d+$/.test(last)) {
      return { host: null, notes, error: 'The last label of a suffix cannot be numeric (it would match IP addresses).' };
    }
  }
  if (host.ascii !== value.toLowerCase().replace(/\.+$/, '')) {
    notes.push(`Normalized to ${host.ascii}${host.unicode !== host.ascii ? ` (${host.unicode})` : ''}.`);
  }
  return { host, notes };
}

/** True if `host` equals `suffix` or is a subdomain of it (DNS label boundary). */
export function matchesSuffix(host: string, suffix: string): boolean {
  if (host === suffix) return true;
  return host.length > suffix.length && host.endsWith(suffix) && host.charCodeAt(host.length - suffix.length - 1) === 46; /* '.' */
}

export function labelCount(host: string): number {
  // Same as host.split('.').length, without building the array.
  let n = 1;
  for (let i = host.indexOf('.'); i >= 0; i = host.indexOf('.', i + 1)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Punycode (RFC 3492) decoding, used to show and keyword-match IDN hostnames.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let k = 0;
  delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) {
    delta = Math.floor(delta / (BASE - T_MIN));
  }
  return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

function basicToDigit(cp: number): number {
  if (cp >= 0x30 && cp < 0x3a) return cp - 22; // 0-9 -> 26-35
  if (cp >= 0x41 && cp < 0x5b) return cp - 0x41; // A-Z
  if (cp >= 0x61 && cp < 0x7b) return cp - 0x61; // a-z
  return BASE;
}

/** Decode a punycode label body (without the `xn--` prefix). Throws on malformed input. */
export function punycodeDecode(input: string): string {
  const output: number[] = [];
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let basic = input.lastIndexOf('-');
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) throw new RangeError('Invalid punycode');
    output.push(c);
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) throw new RangeError('Invalid punycode');
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= BASE) throw new RangeError('Invalid punycode');
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > Number.MAX_SAFE_INTEGER) throw new RangeError('Punycode overflow');
    }
    const len = output.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** Convert an ASCII hostname to Unicode for display / keyword matching. */
export function toUnicode(asciiHost: string): string {
  return asciiHost
    .split('.')
    .map((label) => {
      if (!label.startsWith('xn--')) return label;
      try {
        return punycodeDecode(label.slice(4));
      } catch {
        return label;
      }
    })
    .join('.');
}
