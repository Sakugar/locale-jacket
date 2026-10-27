// Test data writers shared by several test files.

/** Encode a geosite.dat: categories → [type, value, attrs[]] entries. */
export function encodeGeosite(cats: Record<string, [number, string, string[]?][]>): Uint8Array {
  const enc = new TextEncoder();
  const varint = (n: number) => {
    const out: number[] = [];
    while (n > 127) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
  };
  const field = (num: number, bytes: number[]) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
  const str = (num: number, s: string) => field(num, [...enc.encode(s)]);
  const out: number[] = [];
  for (const [name, entries] of Object.entries(cats)) {
    const site: number[] = [...str(1, name.toUpperCase())];
    for (const [type, value, attrs = []] of entries) {
      const dom = [...varint(1 * 8 + 0), ...varint(type), ...str(2, value), ...attrs.flatMap((a) => field(3, [...str(1, a), ...varint(2 * 8), 1]))];
      for (const byte of field(2, dom)) site.push(byte); // no spread: categories can be large
    }
    for (const byte of field(1, site)) out.push(byte);
  }
  return new Uint8Array(out);
}
