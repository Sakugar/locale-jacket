// IP address parsing and CIDR matching (IPv4 and IPv6), no dependencies.
// Addresses are represented as 16-byte arrays; IPv4 uses the IPv4-mapped form
// (::ffff:a.b.c.d) so one code path handles both families.

export type IpFamily = 4 | 6;

export interface IpAddr {
  family: IpFamily;
  bytes: Uint8Array; // always 16 bytes
}

export interface Cidr {
  family: IpFamily;
  /** Network address (host bits cleared), 16 bytes. */
  bytes: Uint8Array;
  /** Prefix length within the family (0-32 for IPv4, 0-128 for IPv6). */
  prefix: number;
}

function parseV4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255 || (p.length > 1 && p.startsWith('0'))) return null;
    out.push(n);
  }
  return out;
}

function mapped(v4: number[]): Uint8Array {
  const b = new Uint8Array(16);
  b[10] = 0xff;
  b[11] = 0xff;
  b.set(v4, 12);
  return b;
}

function parseV6(s: string): Uint8Array | null {
  let str = s;
  const zone = str.indexOf('%');
  if (zone >= 0) str = str.slice(0, zone);
  let tail: number[] = [];
  // Embedded IPv4 in the last 32 bits (e.g. ::ffff:1.2.3.4).
  const lastColon = str.lastIndexOf(':');
  if (str.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(str.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    str = str.slice(0, lastColon + 1) + '0:0';
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  const b = new Uint8Array(16);
  groups.forEach((g, i) => {
    b[i * 2] = g >> 8;
    b[i * 2 + 1] = g & 0xff;
  });
  return b;
}

/** Parse an IPv4 or IPv6 literal (brackets allowed). IPv4-mapped IPv6 is reported as IPv4. */
export function parseIp(input: string): IpAddr | null {
  const s = input.trim().replace(/^\[|\]$/g, '');
  if (!s) return null;
  const v4 = parseV4(s);
  if (v4) return { family: 4, bytes: mapped(v4) };
  if (!s.includes(':')) return null;
  const b = parseV6(s);
  if (!b) return null;
  const isMapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  return { family: isMapped ? 4 : 6, bytes: b };
}

function maskTo(bytes: Uint8Array, bits: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < 16; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    out[i] = out[i]! & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff);
  }
  return out;
}

/** Parse "a.b.c.d/n" or "x::y/n" (a bare address means a single host). */
export function parseCidr(input: string): Cidr | null {
  const [addr = '', len] = input.trim().split('/');
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  const prefix = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  const bits = ip.family === 4 ? prefix + 96 : prefix;
  return { family: ip.family, bytes: maskTo(ip.bytes, bits), prefix };
}

export function cidrContains(c: Cidr, ip: IpAddr): boolean {
  if (c.family !== ip.family) return false;
  const bits = c.family === 4 ? c.prefix + 96 : c.prefix;
  const masked = maskTo(ip.bytes, bits);
  return masked.every((b, i) => b === c.bytes[i]);
}

export function formatIp(ip: IpAddr): string {
  if (ip.family === 4) return Array.from(ip.bytes.slice(12)).join('.');
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((ip.bytes[i]! << 8) | ip.bytes[i + 1]!);
  // Compress the longest run of zero groups (RFC 5952).
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

export function formatCidr(c: Cidr): string {
  return `${formatIp({ family: c.family, bytes: c.bytes })}/${c.prefix}`;
}

/** Private, loopback, link-local and unique-local ranges (GEOIP,LAN — no database needed). */
export const LAN_RANGES: readonly Cidr[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
].map((c) => parseCidr(c)!);

export function isLanIp(ip: IpAddr): boolean {
  return LAN_RANGES.some((c) => cidrContains(c, ip));
}
