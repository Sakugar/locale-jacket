// Minimal MaxMind DB (.mmdb) reader: metadata, search tree and data section decoder.
// Spec: https://maxmind.github.io/MaxMind-DB/  — supports record sizes 24/28/32,
// IPv4 and IPv6 trees, and every data type in the format.

import type { IpAddr } from './ip.js';

const METADATA_MARKER = [0xab, 0xcd, 0xef, ...Array.from('MaxMind.com', (c) => c.charCodeAt(0))];
const DATA_SECTION_SEPARATOR = 16;

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

const decoder = new TextDecoder();

export class MmdbReader {
  readonly metadata: MmdbMetadata;
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly treeSize: number;
  private readonly dataStart: number;
  private ipv4Start = -1;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const metaStart = this.findMetadata();
    const [meta] = this.decode(metaStart, metaStart);
    this.metadata = meta as unknown as MmdbMetadata;
    const { node_count, record_size } = this.metadata;
    if (![24, 28, 32].includes(record_size)) throw new Error(`Unsupported mmdb record size ${record_size}`);
    this.treeSize = (record_size * 2 / 8) * node_count;
    this.dataStart = this.treeSize + DATA_SECTION_SEPARATOR;
    if (this.dataStart > metaStart) throw new Error('Corrupt mmdb: tree overlaps metadata');
  }

  private findMetadata(): number {
    const b = this.buf;
    const lower = Math.max(0, b.length - 128 * 1024);
    outer: for (let i = b.length - METADATA_MARKER.length; i >= lower; i--) {
      for (let j = 0; j < METADATA_MARKER.length; j++) if (b[i + j] !== METADATA_MARKER[j]) continue outer;
      return i + METADATA_MARKER.length;
    }
    throw new Error('Not a MaxMind DB file (metadata marker not found)');
  }

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

  /** Look up an address. Returns the record (or null) and the matched prefix length. */
  lookup(ip: IpAddr): { record: MmdbValue | null; prefix: number } {
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
    const total = bits.length * 8;
    for (; depth < total && node < nodeCount; depth++) {
      const bit = ((bits[depth >> 3]! >> (7 - (depth & 7))) & 1) as 0 | 1;
      node = this.readRecord(node, bit);
    }
    if (node === nodeCount) return { record: null, prefix: depth };
    if (node < nodeCount) throw new Error('Corrupt mmdb: search ran past the address');
    const offset = node - nodeCount + this.treeSize;
    const [record] = this.decode(offset, this.dataStart);
    return { record, prefix: depth };
  }

  /** Decode one value at `offset`; pointers are relative to `base`. Returns [value, nextOffset]. */
  private decode(offset: number, base: number): [MmdbValue, number] {
    const b = this.buf;
    const ctrl = b[offset++]!;
    let type = ctrl >> 5;
    if (type === 1) {
      // Pointer
      const ss = (ctrl >> 3) & 0x3;
      const vvv = ctrl & 0x7;
      let ptr: number;
      if (ss === 0) ptr = (vvv << 8) | b[offset]!;
      else if (ss === 1) ptr = ((vvv << 16) | (b[offset]! << 8) | b[offset + 1]!) + 2048;
      else if (ss === 2) ptr = ((vvv << 24) | (b[offset]! << 16) | (b[offset + 1]! << 8) | b[offset + 2]!) + 526336;
      else ptr = this.view.getUint32(offset);
      const [value] = this.decode(base + ptr, base);
      return [value, offset + ss + 1];
    }
    if (type === 0) type = 7 + b[offset++]!;
    let size = ctrl & 0x1f;
    if (size === 29) size = 29 + b[offset++]!;
    else if (size === 30) {
      size = 285 + ((b[offset]! << 8) | b[offset + 1]!);
      offset += 2;
    } else if (size === 31) {
      size = 65821 + ((b[offset]! << 16) | (b[offset + 1]! << 8) | b[offset + 2]!);
      offset += 3;
    }
    switch (type) {
      case 2: // UTF-8 string
        return [decoder.decode(b.subarray(offset, offset + size)), offset + size];
      case 3: // double
        return [this.view.getFloat64(offset), offset + 8];
      case 4: // bytes
        return [b.slice(offset, offset + size), offset + size];
      case 5: // uint16
      case 6: // uint32
      case 8: { // int32
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + b[offset + i]!;
        if (type === 8 && size === 4 && v >= 0x80000000) v -= 0x100000000;
        return [v, offset + size];
      }
      case 7: { // map
        const out: { [k: string]: MmdbValue } = {};
        let o = offset;
        for (let i = 0; i < size; i++) {
          const [k, o1] = this.decode(o, base);
          const [v, o2] = this.decode(o1, base);
          out[String(k)] = v;
          o = o2;
        }
        return [out, o];
      }
      case 9: // uint64
      case 10: { // uint128
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(b[offset + i]!);
        return [v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, offset + size];
      }
      case 11: { // array
        const out: MmdbValue[] = [];
        let o = offset;
        for (let i = 0; i < size; i++) {
          const [v, o1] = this.decode(o, base);
          out.push(v);
          o = o1;
        }
        return [out, o];
      }
      case 14: // boolean (value in size)
        return [size !== 0, offset];
      case 15: // float
        return [this.view.getFloat32(offset), offset + 4];
      default:
        throw new Error(`Unsupported mmdb data type ${type}`);
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
