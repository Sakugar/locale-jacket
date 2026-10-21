// A small, strict YAML subset parser/serializer for configuration import/export.
//
// Supported: block mappings and sequences (including "- key: value" items),
// flow sequences/mappings on one line ([a, b], {k: v}), plain, single- and
// double-quoted scalars, null/~, booleans, numbers, comments and a leading
// "---" document marker. Anchors, aliases, tags, block scalars (| >),
// multi-line flow collections and multiple documents are rejected with a
// line-numbered error instead of being silently misread.

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(line > 0 ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.name = 'YamlError';
  }
}

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
  no: number;
}

export function parseYaml(source: string): YamlValue {
  const lines = tokenize(source);
  if (lines.length === 0) return null;
  const first = lines[0]!;
  const [value, next] = parseBlock(lines, 0, first.indent);
  if (next < lines.length) {
    const l = lines[next]!;
    throw new YamlError(`unexpected content (check indentation): ${l.text}`, l.no);
  }
  return value;
}

function tokenize(source: string): Line[] {
  const out: Line[] = [];
  const raw = source.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let seenContent = false;
  for (let i = 0; i < raw.length; i++) {
    const no = i + 1;
    const lineRaw = raw[i]!;
    const leading = /^[ \t]*/.exec(lineRaw)![0];
    const body = stripComment(lineRaw.slice(leading.length), no).trimEnd();
    if (!body) continue;
    if (leading.includes('\t')) throw new YamlError('tabs are not allowed for indentation', no);
    if (body === '---' || body.startsWith('--- ')) {
      if (seenContent) throw new YamlError('multiple YAML documents are not supported', no);
      const rest = body.slice(3).trim();
      if (rest) out.push({ indent: 0, text: rest, no });
      continue;
    }
    if (body === '...') break;
    if (body.startsWith('%')) throw new YamlError('YAML directives are not supported', no);
    seenContent = true;
    out.push({ indent: leading.length, text: body, no });
  }
  return out;
}

/** Remove a trailing comment while respecting quotes. */
function stripComment(s: string, no: number): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") {
      const prev = i === 0 ? ' ' : s[i - 1];
      if (prev === ' ' || prev === '[' || prev === '{' || prev === ',' || prev === ':' || i === 0) quote = c;
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ')) {
      return s.slice(0, i);
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', no);
  return s;
}

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const line = lines[start]!;
  if (line.indent !== indent) throw new YamlError('bad indentation', line.no);
  if (isSeqItem(line.text)) return parseSequence(lines, start, indent);
  if (findMappingColon(line.text) >= 0) return parseMapping(lines, start, indent);
  // A lone scalar document.
  return [parseScalarOrFlow(line.text, line.no), start + 1];
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('bad indentation inside sequence', line.no);
    if (!isSeqItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trimStart();
    if (!rest) {
      const nxt = lines[i + 1];
      if (nxt && nxt.indent > indent) {
        const [v, n] = parseBlock(lines, i + 1, nxt.indent);
        out.push(v);
        i = n;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }
    // "- key: value" starts an inline mapping whose keys sit at the column of "key".
    const itemIndent = indent + (line.text.length - rest.length);
    if (isSeqItem(rest) || (findMappingColon(rest) >= 0 && !/^[[{]/.test(rest))) {
      const virtual: Line[] = [{ indent: itemIndent, text: rest, no: line.no }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= itemIndent) virtual.push(lines[j++]!);
      const [v, consumed] = parseBlock(virtual, 0, itemIndent);
      if (consumed !== virtual.length) {
        const bad = virtual[consumed]!;
        throw new YamlError(`unexpected content (check indentation): ${bad.text}`, bad.no);
      }
      out.push(v);
      i = j;
      continue;
    }
    out.push(parseScalarOrFlow(rest, line.no));
    i++;
  }
  return [out, i];
}

function parseMapping(lines: Line[], start: number, indent: number): [{ [k: string]: YamlValue }, number] {
  const out: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('bad indentation inside mapping', line.no);
    if (isSeqItem(line.text)) break;
    const colon = findMappingColon(line.text);
    if (colon < 0) throw new YamlError(`expected "key: value", got: ${line.text}`, line.no);
    const key = parseKey(line.text.slice(0, colon).trim(), line.no);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
    const rest = line.text.slice(colon + 1).trim();
    i++;
    if (rest) {
      out[key] = parseScalarOrFlow(rest, line.no);
      continue;
    }
    const nxt = lines[i];
    if (nxt && nxt.indent > indent) {
      const [v, n] = parseBlock(lines, i, nxt.indent);
      out[key] = v;
      i = n;
    } else if (nxt && nxt.indent === indent && isSeqItem(nxt.text)) {
      // YAML allows a sequence value at the same indentation as its key.
      const [v, n] = parseSequence(lines, i, indent);
      out[key] = v;
      i = n;
    } else {
      out[key] = null;
    }
  }
  return [out, i];
}

/** Index of the ':' that separates key and value at the top level of the text, or -1. */
function findMappingColon(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (i === 0) quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function parseKey(raw: string, no: number): string {
  if (!raw) throw new YamlError('empty mapping key', no);
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const v = parseScalarOrFlow(raw, no);
    return String(v);
  }
  if (/^[&*!|>]/.test(raw)) throw new YamlError(`unsupported YAML feature in key: ${raw}`, no);
  return raw;
}

function parseScalarOrFlow(text: string, no: number): YamlValue {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const p = new FlowParser(t, no);
    const v = p.value();
    p.end();
    return v;
  }
  return parseScalar(t, no);
}

function parseScalar(t: string, no: number): YamlValue {
  if (t.startsWith('"')) return parseDoubleQuoted(t, no);
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError('unterminated single-quoted string', no);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!]/.test(t)) throw new YamlError(`anchors, aliases and tags are not supported: ${t}`, no);
  if (t === '|' || t === '>' || /^[|>][+-]?\d*$/.test(t)) throw new YamlError('block scalars (| and >) are not supported', no);
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function parseDoubleQuoted(t: string, no: number): string {
  let out = '';
  for (let i = 1; i < t.length; i++) {
    const c = t[i]!;
    if (c === '"') {
      if (i !== t.length - 1) throw new YamlError(`unexpected text after quoted string: ${t.slice(i + 1)}`, no);
      return out;
    }
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = t[++i];
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ' };
    if (e !== undefined && e in map) out += map[e];
    else if (e === 'u' || e === 'x') {
      const len = e === 'u' ? 4 : 2;
      const hex = t.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new YamlError('invalid escape sequence', no);
      out += String.fromCharCode(parseInt(hex, 16));
      i += len;
    } else throw new YamlError(`invalid escape \\${e ?? ''}`, no);
  }
  throw new YamlError('unterminated double-quoted string', no);
}

class FlowParser {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly no: number,
  ) {}

  private ws(): void {
    while (this.s[this.i] === ' ') this.i++;
  }

  end(): void {
    this.ws();
    if (this.i < this.s.length) throw new YamlError(`unexpected text after flow collection: ${this.s.slice(this.i)}`, this.no);
  }

  value(): YamlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    return this.scalar(false);
  }

  private seq(): YamlValue[] {
    this.i++;
    const out: YamlValue[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') throw new YamlError('expected "," or "]" in flow sequence', this.no);
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
    }
  }

  private map(): { [k: string]: YamlValue } {
    this.i++;
    const out: { [k: string]: YamlValue } = {};
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      const key = String(this.scalar(true));
      this.ws();
      if (this.s[this.i] !== ':') throw new YamlError('expected ":" in flow mapping', this.no);
      this.i++;
      out[key] = this.value();
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') throw new YamlError('expected "," or "}" in flow mapping', this.no);
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
    }
  }

  private scalar(isKey: boolean): YamlValue {
    this.ws();
    const start = this.i;
    const q = this.s[this.i];
    if (q === '"' || q === "'") {
      this.i++;
      while (this.i < this.s.length) {
        const c = this.s[this.i];
        if (q === '"' && c === '\\') this.i += 2;
        else if (c === q) {
          if (q === "'" && this.s[this.i + 1] === "'") this.i += 2;
          else {
            this.i++;
            break;
          }
        } else this.i++;
      }
      return parseScalar(this.s.slice(start, this.i), this.no);
    }
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === ',' || c === ']' || c === '}' || c === '[' || c === '{') break;
      if (c === ':' && (isKey || this.s[this.i + 1] === ' ' || this.s[this.i + 1] === undefined)) break;
      this.i++;
    }
    const text = this.s.slice(start, this.i).trim();
    if (!text && !isKey) throw new YamlError('empty value in flow collection', this.no);
    return parseScalar(text, this.no);
  }
}

// ---------------------------------------------------------------------------
// Serialization

const PLAIN_SAFE = /^[A-Za-z0-9_./+\-@() -￿][A-Za-z0-9_ ./+\-@(),;=* -￿]*$/;

function needsQuotes(s: string): boolean {
  if (s === '' || s !== s.trim()) return true;
  if (!PLAIN_SAFE.test(s)) return true;
  if (/^(~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|no|on|off)$/i.test(s)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true;
  if (s.startsWith('- ') || s.includes(': ') || s.includes(' #') || s.endsWith(':')) return true;
  return false;
}

function scalarToYaml(v: null | boolean | number | string): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return needsQuotes(v) ? JSON.stringify(v) : v;
}

function isScalar(v: unknown): v is null | boolean | number | string {
  return v === null || ['boolean', 'number', 'string'].includes(typeof v);
}

function isFlowFriendlyList(v: YamlValue[]): boolean {
  return v.every(isScalar) && v.length <= 8 && v.map((x) => scalarToYaml(x as string)).join(', ').length < 60;
}

export function stringifyYaml(value: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (isScalar(value)) return pad + scalarToYaml(value) + '\n';
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]\n';
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalarToYaml(item)}\n`;
        if (Array.isArray(item)) return `${pad}-\n${stringifyYaml(item, indent + 2)}`;
        const body = stringifyYaml(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      })
      .join('');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return pad + '{}\n';
  return entries
    .map(([k, v]) => {
      const key = needsQuotes(k) || k.includes(':') ? JSON.stringify(k) : k;
      if (isScalar(v)) return `${pad}${key}: ${scalarToYaml(v)}\n`;
      if (Array.isArray(v)) {
        if (v.length === 0) return `${pad}${key}: []\n`;
        if (isFlowFriendlyList(v)) return `${pad}${key}: [${v.map((x) => scalarToYaml(x as string)).join(', ')}]\n`;
        return `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`;
      }
      if (Object.keys(v).length === 0) return `${pad}${key}: {}\n`;
      return `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`;
    })
    .join('');
}
