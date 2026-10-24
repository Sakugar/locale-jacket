// Dependency-free ZIP writer/reader (deflate via node:zlib), shared by the release scripts.
import zlib from 'node:zlib';

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date for reproducible archives

/** Build a ZIP archive from `[{ name, data }]` (names use forward slashes). */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Read a ZIP archive (stored or deflated entries) into a Map of name → Buffer.
 * Checks each local header against the central directory and the CRC-32 of the extracted data.
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`Encrypted ZIP entry ${name} is not supported.`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`Corrupt ZIP: bad local header for ${name}.`);
    if (buf.readUInt16LE(localOff + 8) !== method) throw new Error(`Corrupt ZIP: compression method mismatch for ${name}.`);
    // With a data descriptor (flag bit 3) the local header may carry zero sizes and CRC.
    if (!(flags & 8)) {
      const lCrc = buf.readUInt32LE(localOff + 14);
      const lComp = buf.readUInt32LE(localOff + 18);
      const lSize = buf.readUInt32LE(localOff + 22);
      if (lCrc !== crc || lComp !== compSize || lSize !== size) throw new Error(`Corrupt ZIP: local and central headers disagree for ${name}.`);
    }
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (dataStart + compSize > buf.length) throw new Error(`Corrupt ZIP: data for ${name} is truncated.`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch (e) {
        throw new Error(`Corrupt ZIP: cannot inflate ${name} (${e.message}).`);
      }
    } else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    if (data.length !== size) throw new Error(`Corrupt ZIP: ${name} is ${data.length} bytes, expected ${size}.`);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`Corrupt ZIP: CRC-32 mismatch for ${name}.`);
    files.set(name, data);
  }
  return files;
}

/** The ZIP inside a CRX3 file (magic "Cr24", version, header length, header, zip). */
export function zipFromCrx(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Not a CRX file.');
  const headerLen = buf.readUInt32LE(8);
  return buf.subarray(12 + headerLen);
}
