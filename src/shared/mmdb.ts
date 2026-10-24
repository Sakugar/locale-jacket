// Minimal MaxMind DB (.mmdb) reader: metadata, search tree and data section decoder.
// Spec: https://maxmind.github.io/MaxMind-DB/  — supports record sizes 24/28/32,
// IPv4 and IPv6 trees, and every data type in the format.
//
// Data-set files are untrusted (a subscription can name their URL), so every read is
// bounds-checked and each decoded value tree has a budget: pointers let a few hundred
// bytes expand into millions of values, or point back at themselves.

import type { IpAddr } from './ip.js';

const METADATA_MARKER = [0xab, 0xcd, 0xef, ...Array.from('MaxMind.com', (c) => c.charCodeAt(0))];
const DATA_SECTION_SEPARATOR = 16;

// Budget for one value tree (one record, or the metadata). Real records are far
// smaller: a GeoLite2-City record has a few hundred values, nested about 4 deep;
// Country and ASN records have under a hundred.
const MAX_VALUES = 10_000;
const MAX_DEPTH = 32;
const MAX_PAYLOAD_BYTES = 1 << 20; // strings and bytes, summed

export type MmdbValue = null | boolean | number | bigint | string | Uint8Array | MmdbValue[] | { [k: string]: MmdbValue };

export interface MmdbMetadata {
  node_count: number;
  record_size: number;
  ip_version: number;
  database_type: string;
  build_epoch: number;
  description?: { [lang: string]: string };
  [k: string]: unknown;
}

/** A structural problem in a .mmdb file (truncated, out-of-range offset, over budget, …). */
export class MmdbError extends Error {
  override name = 'MmdbError';
}

/** One decode: the section it may read ([base, end); pointers are relative to base) and what it has used. */
interface DecodeState {
  base: number;
  end: number;
  values: number;
  bytes: number;
}

const decoder = new TextDecoder();

export class MmdbReader {
  readonly metadata: MmdbMetadata;
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly treeSize: number;
  private readonly dataStart: number;
  private readonly dataEnd: number;
  private ipv4Start = -1;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const metaStart = this.findMetadata();
    const meta = this.decodeTree(metaStart, metaStart, this.buf.length);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta instanceof Uint8Array) throw new MmdbError('Corrupt mmdb: metadata is not a map');
    this.metadata = meta as unknown as MmdbMetadata;
    const { node_count, record_size, ip_version } = this.metadata;
    if (![24, 28, 32].includes(record_size)) throw new MmdbError(`Unsupported mmdb record size ${String(record_size)}`);
    if (ip_version !== 4 && ip_version !== 6) throw new MmdbError(`Unsupported mmdb IP version ${String(ip_version)}`);
    if (!Number.isSafeInteger(node_count) || node_count < 0) throw new MmdbError('Corrupt mmdb: invalid node count');
    this.treeSize = (record_size * 2 / 8) * node_count;
    this.dataStart = this.treeSize + DATA_SECTION_SEPARATOR;
    this.dataEnd = metaStart - METADATA_MARKER.length;
    if (this.dataStart > this.dataEnd) throw new MmdbError('Corrupt mmdb: tree overlaps metadata');
  }

  private findMetadata(): number {
    const b = this.buf;
    const lower = Math.max(0, b.length - 128 * 1024);
    outer: for (let i = b.length - METADATA_MARKER.length; i >= lower; i--) {
      for (let j = 0; j < METADATA_MARKER.length; j++) if (b[i + j] !== METADATA_MARKER[j]) continue outer;
      return i + METADATA_MARKER.length;
    }
    throw new MmdbError('Not a MaxMind DB file (metadata marker not found)');
  }

  /** Callers keep `node` below node_count, and the tree lies before the data section, inside the buffer. */
  private readRecord(node: number, bit: 0 | 1): number {
    const size = this.metadata.record_size;
    const base = node * (size * 2) / 8;
    const b = this.buf;
    if (size === 24) {
      const o = base + bit * 3;
      return (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
    }
    if (size === 28) {
      if (bit === 0) return ((b[base + 3]! & 0xf0) << 20) | (b[base]! << 16) | (b[base + 1]! << 8) | b[base + 2]!;
      return ((b[base + 3]! & 0x0f) << 24) | (b[base + 4]! << 16) | (b[base + 5]! << 8) | b[base + 6]!;
    }
    return this.view.getUint32(base + bit * 4);
  }

  /**
   * Look up an address. Returns the record (or null) and the matched prefix length.
   * Never throws: a corrupt part of the file reads as "no record", with `error` set.
   */
  lookup(ip: IpAddr): { record: MmdbValue | null; prefix: number; error?: string } {
    try {
      return this.lookupStrict(ip);
    } catch (e) {
      return { record: null, prefix: 0, error: (e as Error).message };
    }
  }

  /** Like `lookup`, but throws an MmdbError when the file is corrupt (for validation). */
  lookupStrict(ip: IpAddr): { record: MmdbValue | null; prefix: number } {
    const nodeCount = this.metadata.node_count;
    let bits: Uint8Array;
    let node = 0;
    let depth = 0;
    if (this.metadata.ip_version === 4) {
      if (ip.family !== 4) return { record: null, prefix: 0 };
      bits = ip.bytes.slice(12);
    } else if (ip.family === 4) {
      // IPv4 lives under ::a.b.c.d (96 zero bits) in IPv6 databases.
      if (this.ipv4Start < 0) {
        let n = 0;
        for (let i = 0; i < 96 && n < nodeCount; i++) n = this.readRecord(n, 0);
        this.ipv4Start = n;
      }
      node = this.ipv4Start;
      bits = ip.bytes.slice(12);
    } else {
      bits = ip.bytes;
    }
    // At most one step per address bit, so a tree with loops cannot spin.
    const total = bits.length * 8;
    for (; depth < total && node < nodeCount; depth++) {
      const bit = ((bits[depth >> 3]! >> (7 - (depth & 7))) & 1) as 0 | 1;
      node = this.readRecord(node, bit);
    }
    if (node === nodeCount) return { record: null, prefix: depth };
    if (node < nodeCount) throw new MmdbError('Corrupt mmdb: search ran past the address');
    // Data records point past the 16-byte separator; decodeTree refuses anything outside the data section.
    const offset = node - nodeCount + this.treeSize;
    return { record: this.decodeTree(offset, this.dataStart, this.dataEnd), prefix: depth };
  }

  /** Decode the value at `offset` within the section [base, end), with a fresh budget. */
  private decodeTree(offset: number, base: number, end: number): MmdbValue {
    return this.decode(offset, { base, end, values: 0, bytes: 0 }, 0)[0];
  }

  /** Throws unless [offset, offset + n) lies inside the section. */
  private need(offset: number, n: number, s: DecodeState): void {
    if (offset < s.base || offset + n > s.end) throw new MmdbError('Corrupt mmdb: data runs outside its section');
  }

  /** Decode one value at `offset`. Returns [value, nextOffset]. */
  private decode(offset: number, s: DecodeState, depth: number): [MmdbValue, number] {
    if (++s.values > MAX_VALUES) throw new MmdbError(`Corrupt mmdb: a record has more than ${MAX_VALUES} values`);
    if (depth > MAX_DEPTH) throw new MmdbError(`Corrupt mmdb: a record is nested more than ${MAX_DEPTH} levels deep`);
    const b = this.buf;
    this.need(offset, 1, s);
    const ctrl = b[offset++]!;
    let type = ctrl >> 5;
    if (type === 1) {
      // Pointer
      const ss = (ctrl >> 3) & 0x3;
      const vvv = ctrl & 0x7;
      this.need(offset, ss + 1, s);
      let ptr: number;
      if (ss === 0) ptr = (vvv << 8) | b[offset]!;
      else if (ss === 1) ptr = ((vvv << 16) | (b[offset]! << 8) | b[offset + 1]!) + 2048;
      else if (ss === 2) ptr = ((vvv << 24) | (b[offset]! << 16) | (b[offset + 1]! << 8) | b[offset + 2]!) + 526336;
      else ptr = this.view.getUint32(offset);
      const target = s.base + ptr;
      this.need(target, 1, s);
      // The spec forbids pointers to pointers; this also stops a pointer to itself.
      if (b[target]! >> 5 === 1) throw new MmdbError('Corrupt mmdb: pointer to a pointer');
      const [value] = this.decode(target, s, depth);
      return [value, offset + ss + 1];
    }
    if (type === 0) {
      this.need(offset, 1, s);
      type = 7 + b[offset++]!;
      if (type < 8) throw new MmdbError('Corrupt mmdb: invalid extended type');
    }
    let size = ctrl & 0x1f;
    if (size >= 29) {
      const extra = size - 28;
      this.need(offset, extra, s);
      if (size === 29) size = 29 + b[offset]!;
      else if (size === 30) size = 285 + ((b[offset]! << 8) | b[offset + 1]!);
      else size = 65821 + ((b[offset]! << 16) | (b[offset + 1]! << 8) | b[offset + 2]!);
      offset += extra;
    }
    const fixed = (n: number) => {
      if (size !== n) throw new MmdbError(`Corrupt mmdb: invalid size ${size} for data type ${type}`);
    };
    const upTo = (n: number) => {
      if (size > n) throw new MmdbError(`Corrupt mmdb: invalid size ${size} for data type ${type}`);
    };
    switch (type) {
      case 2: // UTF-8 string
      case 4: { // bytes
        this.need(offset, size, s);
        s.bytes += size;
        if (s.bytes > MAX_PAYLOAD_BYTES) throw new MmdbError('Corrupt mmdb: a record holds more than 1 MB of text');
        return [type === 2 ? decoder.decode(b.subarray(offset, offset + size)) : b.slice(offset, offset + size), offset + size];
      }
      case 3: // double
        fixed(8);
        this.need(offset, 8, s);
        return [this.view.getFloat64(offset), offset + 8];
      case 5: // uint16
      case 6: // uint32
      case 8: { // int32
        upTo(type === 5 ? 2 : 4);
        this.need(offset, size, s);
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + b[offset + i]!;
        if (type === 8 && size === 4 && v >= 0x80000000) v -= 0x100000000;
        return [v, offset + size];
      }
      case 7: { // map
        const out: { [k: string]: MmdbValue } = {};
        let o = offset;
        for (let i = 0; i < size; i++) {
          const [k, o1] = this.decode(o, s, depth + 1);
          if (typeof k !== 'string') throw new MmdbError('Corrupt mmdb: map key is not a string');
          const [v, o2] = this.decode(o1, s, depth + 1);
          // A "__proto__" key must stay a plain property, not replace the object's prototype.
          if (k === '__proto__') Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
          else out[k] = v;
          o = o2;
        }
        return [out, o];
      }
      case 9: // uint64
      case 10: { // uint128
        upTo(type === 9 ? 8 : 16);
        this.need(offset, size, s);
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(b[offset + i]!);
        return [v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, offset + size];
      }
      case 11: { // array
        const out: MmdbValue[] = [];
        let o = offset;
        for (let i = 0; i < size; i++) {
          const [v, o1] = this.decode(o, s, depth + 1);
          out.push(v);
          o = o1;
        }
        return [out, o];
      }
      case 14: // boolean (value in size)
        upTo(1);
        return [size !== 0, offset];
      case 15: // float
        fixed(4);
        this.need(offset, 4, s);
        return [this.view.getFloat32(offset), offset + 4];
      default:
        throw new MmdbError(`Unsupported mmdb data type ${type}`);
    }
  }
}

/** ISO country code from a GeoIP/country record (GeoLite2 schema and common variants). */
export function countryOf(record: MmdbValue | null): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record instanceof Uint8Array) return null;
  const r = record as { [k: string]: MmdbValue };
  for (const key of ['country', 'registered_country', 'represented_country']) {
    const c = r[key];
    if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Uint8Array)) {
      const iso = (c as { [k: string]: MmdbValue }).iso_code;
      if (typeof iso === 'string') return iso.toUpperCase();
    }
  }
  if (typeof r.iso_code === 'string') return r.iso_code.toUpperCase();
  if (typeof r.country_code === 'string') return r.country_code.toUpperCase();
  return null;
}

/** Autonomous system number from an ASN record. */
export function asnOf(record: MmdbValue | null): { asn: number; org: string | null } | null {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record instanceof Uint8Array) return null;
  const r = record as { [k: string]: MmdbValue };
  const n = r.autonomous_system_number ?? r.asn;
  if (typeof n !== 'number') return null;
  const org = r.autonomous_system_organization ?? r.as_name ?? null;
  return { asn: n, org: typeof org === 'string' ? org : null };
}
