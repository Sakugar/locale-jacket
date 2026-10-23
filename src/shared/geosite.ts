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

import { regexHazard } from './regex-safety.js';

const decoder = new TextDecoder();

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  varint(): number {
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

export interface GeositeList {
  full: Set<string>;
  suffix: Set<string>;
  keywords: string[];
  regexes: RegExp[];
  /** Entries that could not be used (regex syntax JavaScript does not support, or a pattern that could backtrack for too long). */
  skipped: number;
  size: number;
}

/**
 * Decode one category. `filter` is the part after "@": "cn" keeps entries with
 * attribute cn, "!cn" keeps entries without it.
 */
export function loadGeositeCategory(index: GeositeIndex, name: string, filter?: string): GeositeList | null {
  const range = index.categories.get(name.toLowerCase());
  if (!range) return null;
  const negate = filter?.startsWith('!') ?? false;
  const attr = filter ? filter.replace(/^!/, '').toLowerCase() : null;
  const list: GeositeList = { full: new Set(), suffix: new Set(), keywords: [], regexes: [], skipped: 0, size: 0 };
  const r = new Reader(index.buf, range[0], range[1]);
  while (!r.done) {
    const [f, w] = r.tag();
    if (f !== 2 || w !== 2) {
      r.skip(w);
      continue;
    }
    const [ds, de] = r.bytes();
    const d = new Reader(index.buf, ds, de);
    let type = 0;
    let value = '';
    const attrs: string[] = [];
    while (!d.done) {
      const [df, dw] = d.tag();
      if (df === 1 && dw === 0) type = d.varint();
      else if (df === 2 && dw === 2) value = d.string();
      else if (df === 3 && dw === 2) {
        const [as, ae] = d.bytes();
        const a = new Reader(index.buf, as, ae);
        while (!a.done) {
          const [af, aw] = a.tag();
          if (af === 1 && aw === 2) attrs.push(a.string().toLowerCase());
          else a.skip(aw);
        }
      } else d.skip(dw);
    }
    if (attr !== null && attrs.includes(attr) === negate) continue;
    const v = value.toLowerCase();
    if (!v) continue;
    list.size++;
    switch (type) {
      case 0:
        list.keywords.push(v);
        break;
      case 1:
        try {
          // Patterns that could backtrack for too long are skipped like invalid ones.
          if (regexHazard(value)) throw new Error('unsafe');
          list.regexes.push(new RegExp(value, 'i'));
        } catch {
          list.skipped++;
          list.size--;
        }
        break;
      case 2:
        list.suffix.add(v.replace(/^\.+/, ''));
        break;
      case 3:
        list.full.add(v);
        break;
      default:
        list.skipped++;
        list.size--;
    }
  }
  return list;
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
