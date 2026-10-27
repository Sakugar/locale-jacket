// v2ray/Xray/mihomo geosite.dat reader (protobuf, no dependencies).
//
//   message GeoSiteList { repeated GeoSite entry = 1; }
//   message GeoSite     { string country_code = 1; repeated Domain domain = 2; }
//   message Domain      { Type type = 1; string value = 2; repeated Attribute attribute = 3; }
//   enum Type { Plain = 0 /* keyword */; Regex = 1; Domain = 2 /* suffix */; Full = 3; }
//   message Attribute   { string key = 1; oneof { bool bool_value = 2; int64 int_value = 3; } }
//
// The file is indexed once (category name → byte range); only categories that
// rules reference are decoded into matchers.

import { analysisBudget, regexHazard } from './regex-safety.js';

/** Analysis time for the regexp: entries of one category (see REGEX_BATCH_BUDGET_MS in rules.ts). */
export const GEOSITE_REGEX_BUDGET_MS = 750;

const decoder = new TextDecoder();

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    public end = buf.length,
  ) {
    this.pos = start;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  varint(): number {
    // One-byte values (almost every tag and length) without the general loop.
    if (this.pos < this.end) {
      const b = this.buf[this.pos]!;
      if (b < 0x80) {
        this.pos++;
        return b;
      }
    }
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error('Truncated varint');
      const b = this.buf[this.pos++]!;
      if (shift < 49) result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 70) throw new Error('Varint too long');
    }
  }
  /** Returns [field, wireType]. */
  tag(): [number, number] {
    const t = this.varint();
    return [Math.floor(t / 8), t & 7];
  }
  bytes(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('Truncated field');
    return [start, this.pos];
  }
  /** Read a length-delimited field and point `into` at its bytes (reuses one reader per nesting level). */
  enter(into: Reader): Reader {
    const len = this.varint();
    into.pos = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('Truncated field');
    into.end = this.pos;
    return into;
  }
  string(): string {
    const [s, e] = this.bytes();
    return decoder.decode(this.buf.subarray(s, e));
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported wire type ${wire}`);
  }
}

export interface GeositeIndex {
  buf: Uint8Array;
  /** lowercase category name → [start, end) of its GeoSite message */
  categories: Map<string, [number, number]>;
}

export function indexGeosite(data: ArrayBuffer | Uint8Array): GeositeIndex {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const categories = new Map<string, [number, number]>();
  const r = new Reader(buf);
  while (!r.done) {
    const [field, wire] = r.tag();
    if (field !== 1 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const [start, end] = r.bytes();
    const entry = new Reader(buf, start, end);
    // country_code is field 1; it normally comes first, but scan to be safe.
    while (!entry.done) {
      const [f, w] = entry.tag();
      if (f === 1 && w === 2) {
        categories.set(entry.string().toLowerCase(), [start, end]);
        break;
      }
      entry.skip(w);
    }
  }
  if (categories.size === 0) throw new Error('Not a geosite.dat file (no categories found)');
  return { buf, categories };
}

/** A set of lowercase domains. `loadGeositeCategory` returns `DomainTable`s; a `Set<string>` works too. */
export interface DomainSet extends Iterable<string> {
  readonly size: number;
  has(domain: string): boolean;
}

export interface GeositeList {
  full: DomainSet;
  suffix: DomainSet;
  keywords: string[];
  regexes: RegExp[];
  /** Entries that could not be used (regex syntax JavaScript does not support, or a pattern that could backtrack for too long). */
  skipped: number;
  size: number;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** ASCII lowercase of one character code. */
const fold = (c: number): number => (c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
/** What DNR `requestDomains` takes (see dnr.ts). */
const PLAIN_DOMAIN = /^[a-z0-9.-]+$/;

/**
 * The domain: or full: entries of one category, kept as byte ranges of the data set rather
 * than one string each. Decoding ~110,000 strings and hashing them into a Set was most of
 * the time the `cn` category took to load; this table hashes the bytes into an
 * open-addressing index instead (about 3× faster, a third of the memory).
 *
 * It behaves like the `Set` of lowercased values it replaces: same members, duplicates
 * dropped, insertion order kept for iteration. ASCII bytes are lowercased on the fly;
 * entries with other bytes are decoded and lowercased like before and kept as strings.
 *
 * Data sets are untrusted. The hash has a random seed per table, and if building the index
 * still takes too many probes (a file crafted to collide), the table falls back to a plain
 * `Set` built the old way, so a crafted file costs at most what it did before.
 */
export class DomainTable implements DomainSet {
  /** Byte offset of entry k in `buf`, or -1 - i for `strings[i]`. */
  private starts = new Int32Array(16);
  /** Length of entry k (bytes, or UTF-16 units for a string entry). */
  private lens = new Int32Array(16);
  private readonly strings: string[] = [];
  private n = 0;
  /** Hash index: entry number or -1. Empty until `seal()`. */
  private slots = new Int32Array(0);
  private readonly seed = (FNV_OFFSET ^ Math.floor(Math.random() * 2 ** 32)) >>> 0;
  /** Set when building the index took too many probes. */
  private fallback: Set<string> | null = null;
  /** Distinct members that are plain domains (a-z, 0-9, '.', '-'). */
  plainCount = 0;

  /** `stripDots`: drop leading dots (domain: entries, where ".example.com" means example.com). */
  constructor(
    private readonly buf: Uint8Array,
    private readonly stripDots = false,
  ) {}

  get size(): number {
    return this.fallback ? this.fallback.size : this.n;
  }

  /** Queue the value at buf[start, end). Call `seal()` once all are queued; nothing can be added after it. */
  push(start: number, end: number): void {
    if (this.n === this.starts.length) {
      const starts = new Int32Array(this.n * 2);
      starts.set(this.starts);
      this.starts = starts;
      const lens = new Int32Array(this.n * 2);
      lens.set(this.lens);
      this.lens = lens;
    }
    this.starts[this.n] = start;
    this.lens[this.n] = end - start;
    this.n++;
  }

  /** Build the hash index, dropping duplicates (the first one stays, like `Set.add`). */
  seal(): this {
    if (this.slots.length || this.fallback) return this; // already sealed
    let cap = 16;
    while (cap < this.n * 2) cap *= 2;
    const slots = new Int32Array(cap).fill(-1);
    const mask = cap - 1;
    // At most half full, so about 1.5 probes per entry; far more means colliding input.
    let probes = 8 * this.n + 64;
    const { buf, starts, lens } = this;
    let w = 0;
    for (let k = 0; k < this.n; k++) {
      const raw = starts[k]!;
      const end = raw + lens[k]!;
      let start = raw;
      if (this.stripDots) while (start < end && buf[start] === 0x2e) start++; // ".example.com" is a suffix too
      let len = end - start;
      let str: string | null = null;
      let h = this.seed;
      let plain = len > 0;
      // fold() and the plain-domain test written out: this loop runs over every byte of the
      // category, mostly before the JIT has optimized it.
      for (let i = start; i < end; i++) {
        let c = buf[i]!;
        if (c >= 0x41 && c <= 0x5a) c |= 0x20;
        else if (c >= 0x80) {
          str = this.rawString(k);
          break;
        } else if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d)) plain = false;
        h = Math.imul(h ^ c, FNV_PRIME);
      }
      if (str !== null) {
        h = this.hash(str);
        plain = PLAIN_DOMAIN.test(str);
        start = -1 - this.strings.length;
        len = str.length;
      }
      for (let slot = h & mask; ; slot = (slot + 1) & mask) {
        if (--probes < 0) return this.fallBack(w, k);
        const o = slots[slot]!;
        if (o < 0) {
          slots[slot] = w;
          if (str !== null) this.strings.push(str);
          starts[w] = start;
          lens[w] = len;
          w++;
          if (plain) this.plainCount++;
          break;
        }
        if (str === null ? this.equalsBytes(o, start, len) : this.equalsString(o, str)) break;
      }
    }
    this.n = w;
    this.slots = slots;
    return this;
  }

  /** Raw (not yet indexed) entry k, decoded and lowercased exactly as before (a leading byte-order mark is dropped). */
  private rawString(k: number): string {
    const start = this.starts[k]!;
    const str = decoder.decode(this.buf.subarray(start, start + this.lens[k]!)).toLowerCase();
    return this.stripDots ? str.replace(/^\.+/, '') : str;
  }

  /** Indexed entry k as a string. */
  private entry(k: number): string {
    const s = this.starts[k]!;
    return s < 0 ? this.strings[-1 - s]! : decoder.decode(this.buf.subarray(s, s + this.lens[k]!)).toLowerCase();
  }

  /** Give up on the index: entries [0, w) are indexed, [k, n) still raw. */
  private fallBack(w: number, k: number): this {
    const set = new Set<string>();
    for (let i = 0; i < w; i++) set.add(this.entry(i));
    for (let i = k; i < this.n; i++) set.add(this.rawString(i));
    this.fallback = set;
    this.plainCount = 0;
    for (const d of set) if (PLAIN_DOMAIN.test(d)) this.plainCount++;
    this.starts = this.lens = new Int32Array(0);
    this.strings.length = 0;
    this.n = 0;
    return this;
  }

  private hash(s: string): number {
    let h = this.seed;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
    return h;
  }

  /** Whether entry `o` is the (ASCII) value at buf[start, start + len), lowercased. */
  private equalsBytes(o: number, start: number, len: number): boolean {
    if (this.lens[o] !== len) return false;
    const os = this.starts[o]!;
    const buf = this.buf;
    if (os < 0) {
      const str = this.strings[-1 - os]!;
      for (let i = 0; i < len; i++) if (str.charCodeAt(i) !== fold(buf[start + i]!)) return false;
      return true;
    }
    for (let i = 0; i < len; i++) if (fold(buf[os + i]!) !== fold(buf[start + i]!)) return false;
    return true;
  }

  /** Whether entry `o` is exactly `s`. */
  private equalsString(o: number, s: string): boolean {
    if (this.lens[o] !== s.length) return false;
    const os = this.starts[o]!;
    if (os < 0) return this.strings[-1 - os] === s;
    const buf = this.buf;
    for (let i = 0; i < s.length; i++) if (fold(buf[os + i]!) !== s.charCodeAt(i)) return false;
    return true;
  }

  has(domain: string): boolean {
    if (this.fallback) return this.fallback.has(domain);
    const slots = this.slots;
    if (!this.n || !slots.length) return false;
    const mask = slots.length - 1;
    for (let slot = this.hash(domain) & mask; ; slot = (slot + 1) & mask) {
      const o = slots[slot]!;
      if (o < 0) return false;
      if (this.equalsString(o, domain)) return true;
    }
  }

  *[Symbol.iterator](): IterableIterator<string> {
    if (this.fallback) {
      yield* this.fallback;
      return;
    }
    for (let k = 0; k < this.n; k++) yield this.entry(k);
  }

  /** Whether `seal()` gave up on the index (for tests). */
  get usesFallback(): boolean {
    return this.fallback !== null;
  }
}

/** Whether attribute key buf[start, end) is `want` (already lowercase), comparing like `toLowerCase()`. */
function keyIs(buf: Uint8Array, start: number, end: number, want: string): boolean {
  for (let i = start; i < end; i++) if (buf[i]! >= 0x80) return decoder.decode(buf.subarray(start, end)).toLowerCase() === want;
  if (end - start !== want.length) return false;
  for (let i = 0; i < want.length; i++) if (fold(buf[start + i]!) !== want.charCodeAt(i)) return false;
  return true;
}

const TAG_DOMAIN = 0x12; // GeoSite.domain: field 2, length-delimited
const TAG_TYPE = 0x08; // Domain.type: field 1, varint
const TAG_VALUE = 0x12; // Domain.value: field 2, length-delimited
const TAG_ATTRIBUTE = 0x1a; // Domain.attribute: field 3, length-delimited
const TAG_KEY = 0x0a; // Attribute.key: field 1, length-delimited

/**
 * Decode one category. `filter` is the part after "@": "cn" keeps entries with
 * attribute cn, "!cn" keeps entries without it. `regexBudgetMs` is the analysis time all
 * its regexp: entries share.
 */
export function loadGeositeCategory(index: GeositeIndex, name: string, filter?: string, regexBudgetMs = GEOSITE_REGEX_BUDGET_MS): GeositeList | null {
  const range = index.categories.get(name.toLowerCase());
  if (!range) return null;
  const negate = filter?.startsWith('!') ?? false;
  const attr = filter ? filter.replace(/^!/, '').toLowerCase() : null;
  const buf = index.buf;
  const full = new DomainTable(buf);
  const suffix = new DomainTable(buf, true);
  const list: GeositeList = { full, suffix, keywords: [], regexes: [], skipped: 0, size: 0 };
  // One budget for all regexp: entries, so a hostile category cannot hold the worker for long.
  const budget = analysisBudget(regexBudgetMs);
  const r = new Reader(buf, range[0], range[1]);
  // One reader per nesting level, reused for every entry.
  const d = new Reader(buf);
  const f = new Reader(buf);
  const a = new Reader(buf);
  while (!r.done) {
    const tag = r.varint();
    if (tag !== TAG_DOMAIN) {
      r.skip(tag & 7);
      continue;
    }
    r.enter(d);
    let type = 0;
    let vs = 0;
    let ve = 0;
    let hasAttr = false;
    while (!d.done) {
      const dt = d.varint();
      if (dt === TAG_TYPE) type = d.varint();
      else if (dt === TAG_VALUE) {
        d.enter(f);
        vs = f.pos;
        ve = f.end;
      } else if (dt === TAG_ATTRIBUTE && attr !== null) {
        d.enter(a);
        while (!a.done) {
          const at = a.varint();
          if (at === TAG_KEY) {
            a.enter(f);
            if (!hasAttr && keyIs(buf, f.pos, f.end, attr)) hasAttr = true;
          } else a.skip(at & 7);
        }
      } else d.skip(dt & 7);
    }
    if (attr !== null && hasAttr === negate) continue;
    // Empty values are left out (a lone UTF-8 byte-order mark decodes to "" too).
    if (vs >= ve || (buf[vs] === 0xef && decoder.decode(buf.subarray(vs, ve)) === '')) continue;
    list.size++;
    switch (type) {
      case 0:
        list.keywords.push(decoder.decode(buf.subarray(vs, ve)).toLowerCase());
        break;
      case 1: {
        const value = decoder.decode(buf.subarray(vs, ve));
        try {
          // Patterns that could backtrack for too long (or that the spent budget leaves
          // unchecked) are skipped like invalid ones.
          if (regexHazard(value, budget)) throw new Error('unsafe');
          list.regexes.push(new RegExp(value, 'i'));
        } catch {
          list.skipped++;
          list.size--;
        }
        break;
      }
      case 2:
        suffix.push(vs, ve);
        break;
      case 3:
        full.push(vs, ve);
        break;
      default:
        list.skipped++;
        list.size--;
    }
  }
  full.seal();
  suffix.seal();
  return list;
}

function plainCount(set: DomainSet): number {
  if (set instanceof DomainTable) return set.plainCount;
  let n = 0;
  for (const d of set) if (PLAIN_DOMAIN.test(d)) n++;
  return n;
}

/**
 * The number of distinct plain domains in `full` ∪ `suffix` (what DNR can mirror), without
 * listing them: the DNR compiler skips a category above its limit, and `cn` is 5× over it.
 */
export function plainDomainCount(list: GeositeList): number {
  const [small, big] = list.full.size <= list.suffix.size ? [list.full, list.suffix] : [list.suffix, list.full];
  let both = 0;
  for (const d of small) if (PLAIN_DOMAIN.test(d) && big.has(d)) both++;
  return plainCount(list.full) + plainCount(list.suffix) - both;
}

export function geositeMatches(list: GeositeList, host: string): boolean {
  if (list.full.has(host)) return true;
  if (list.suffix.size) {
    let h = host;
    for (;;) {
      if (list.suffix.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
  }
  for (const k of list.keywords) if (host.includes(k)) return true;
  for (const re of list.regexes) if (re.test(host)) return true;
  return false;
}

/** Split "google@cn" into name and attribute filter. */
export function parseGeositeValue(value: string): { name: string; filter?: string } {
  const [name = '', filter] = value.split('@');
  return filter ? { name, filter } : { name };
}
