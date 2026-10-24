// Screening of regular expressions for slow backtracking.
//
// JavaScript's regex engine backtracks: when a match fails it retries every other way the
// pattern could have matched. ^(a+)+$ then takes exponential time and .*.*.*.*! time n^5 on
// some hostnames. Rule regexes run in the service worker while a page's request waits at the
// navigation gate, and they can come from subscriptions and data sets the user does not
// control, so one bad pattern would stall every tab.
//
// The pattern is parsed the way V8 reads it without the u flag (Annex B). Syntax the parser
// does not fully understand is refused, as are back-references, octal escapes, repeated
// assertions, variable-length lookbehinds and lookarounds inside repeated groups. Then:
//   * A group repeated more than UNROLL times must be deterministic: every part of variable
//     length must be followed by a character it cannot match (cyclically, into the next
//     iteration), alternatives must start with different characters, and nothing inside may
//     match the empty string in two ways. ([a-z0-9-]+\.)* and (-[a-z0-9]+)* pass; (a+)+,
//     (.+\.)*, (a|aa)+ and ((a+a+)?-)+ do not. Such a loop reaches each end position in at
//     most one way, as [x]* does, so it cannot be exponential. A loop whose iterations each
//     end on a character nothing else in them can match, and match no text in two ways, is
//     also accepted: ([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)* (proof at "Loops that end on a
//     terminator"). Groups repeated at most UNROLL times are followed copy by copy.
//   * Then the worst-case number of backtracking steps on a MAX_INPUT-character hostname is
//     bounded, for every sequence (top level, groups, alternatives, lookarounds). A part of
//     variable length, bounded or not, adds a free split point unless the next character is
//     one it cannot match (then only its longest match goes on). d free points over n
//     characters allow C(n+d, d) combinations: the unanchored start is one, ^ removes them, a
//     bounded quantifier may count as a factor (its range) instead, alternatives add up, and
//     a run of literal characters right after a split point leaves only its occurrences.
//     Steps are weighted by what they cost in V8's interpreter (counted loops, captures). A
//     pattern whose bound exceeds MAX_STEPS is refused. So .*.*! and six \w{0,9} in a row
//     are refused, while ^(.+\.)?example\.com$ needs about 2,600 steps.
// The check is conservative: it may refuse a pattern that is actually fast.

export const MAX_REGEX_LENGTH = 512;
/** Hostnames are at most this long; the cost bound is computed for this input length. */
const MAX_INPUT = 253;
/**
 * Backtracking steps one test() may need. V8 runs a regex's first test() in its bytecode
 * interpreter, at up to about 20 ns a step, so this is roughly 40 ms; later calls are native
 * code and several times faster.
 */
const MAX_STEPS = 2e6;
/**
 * V8 unrolls repetitions up to this count; larger counts ({4}, {0,9}) use a loop counter,
 * which costs COUNTED steps per character in the interpreter. Groups repeated up to UNROLL
 * times are analysed as copies, others as loops.
 */
const UNROLL = 3;
const COUNTED = 3;
/** Extra steps for a capture register: saved when a group ends, cleared when a quantified group repeats. */
const CAPTURE = 2;
/** Highest polynomial degree the bound tracks. */
const DEGREE = 6;
/** Analysis steps before a pattern counts as too complex to check. */
const MAX_WORK = 20000;

const BACKREF = 'back-references are not allowed';
const SAME_TEXT = 'a repeated group can match the same text in more than one way; a form like ^([a-z0-9-]+\\.)*example\\.com$ works';
const SAME_START = 'alternatives (|) in a repeated group can start with the same character';
const TOO_MANY = 'parts of it can match the same text in too many ways';

class Unsafe extends Error {}

// ---- Character sets -------------------------------------------------------------------
// Sets of UTF-16 code units, exact for ASCII (four 32-bit words). With the i flag but no u
// flag, V8 never matches an ASCII character against a non-ASCII one, so the rest is only
// tracked as none (0), some (1) or all (2) of it.

type Rest = 0 | 1 | 2;
interface Chars {
  w0: number;
  w1: number;
  w2: number;
  w3: number;
  rest: Rest;
}

const NONE: Chars = { w0: 0, w1: 0, w2: 0, w3: 0, rest: 0 };
const ANY: Chars = { w0: -1, w1: -1, w2: -1, w3: -1, rest: 2 };

/** Bits lo..hi of the 32-bit word starting at code `base`. */
function bits(lo: number, hi: number, base: number): number {
  const a = Math.max(lo, base) - base;
  const b = Math.min(hi, base + 31) - base;
  if (a > b) return 0;
  return b - a === 31 ? -1 : ((1 << (b - a + 1)) - 1) << a;
}

/** Code units lo..hi, closed under case folding (rules are matched with the i flag). */
function span(lo: number, hi: number): Chars {
  const w2 = bits(lo, hi, 64);
  const w3 = bits(lo, hi, 96);
  const letters = (w2 | w3) & 0x07fffffe; // A-Z and a-z sit at the same bits of words 2 and 3
  const rest: Rest = hi < 128 ? 0 : lo <= 128 && hi >= 0xffff ? 2 : 1;
  return { w0: bits(lo, hi, 0), w1: bits(lo, hi, 32), w2: w2 | letters, w3: w3 | letters, rest };
}

function union(...sets: Chars[]): Chars {
  const u = { ...NONE };
  for (const s of sets) {
    u.w0 |= s.w0;
    u.w1 |= s.w1;
    u.w2 |= s.w2;
    u.w3 |= s.w3;
    if (s.rest > u.rest) u.rest = s.rest;
  }
  return u;
}

function overlaps(a: Chars, b: Chars): boolean {
  return ((a.w0 & b.w0) | (a.w1 & b.w1) | (a.w2 & b.w2) | (a.w3 & b.w3)) !== 0 || (a.rest !== 0 && b.rest !== 0);
}

function complement(s: Chars): Chars {
  return { w0: ~s.w0, w1: ~s.w1, w2: ~s.w2, w3: ~s.w3, rest: (2 - s.rest) as Rest };
}

const DIGIT = span(48, 57);
const WORD = union(DIGIT, span(65, 90), span(95, 95));
const SPACE = union(span(9, 13), span(32, 32), { ...NONE, rest: 1 });

// ---- Syntax tree ----------------------------------------------------------------------

interface CharNode {
  kind: 'char';
  set: Chars;
}
interface GroupNode {
  kind: 'group';
  alts: Term[][];
  capture: boolean;
}
interface LookNode {
  kind: 'look';
  alts: Term[][];
  behind: boolean;
}
/** start: ^ at the start of the input. assert: $, \b, \B, or ^ in multiline mode. */
interface AnchorNode {
  kind: 'start' | 'assert';
}
type Node = CharNode | GroupNode | LookNode | AnchorNode;

interface Term {
  node: Node;
  min: number;
  max: number;
  /** Fewest and most characters it consumes. */
  minLen: number;
  maxLen: number;
  /** Characters it can consume first, last, and anywhere. */
  first: Chars;
  last: Chars;
  chars: Chars;
  /** Terms inside it, itself included, as steps per character (see COUNTED and CAPTURE). */
  size: number;
  /** Every quantifier inside it has a fixed count. */
  exact: boolean;
  /** Capturing groups inside it, itself included. */
  captures: number;
}

const seqMin = (terms: Term[]): number => terms.reduce((s, t) => s + t.minLen, 0);
const seqMax = (terms: Term[]): number => terms.reduce((s, t) => s + t.maxLen, 0);

/** Characters `terms` can consume first; `after` when it can match nothing. */
function seqFirst(terms: Term[], after: Chars): Chars {
  let acc = NONE;
  for (const t of terms) {
    if (t.node.kind === 'look') return ANY; // its body runs before anything is consumed
    acc = union(acc, t.first);
    if (t.minLen > 0) return acc;
  }
  return union(acc, after);
}

/** Characters `terms` can consume last; `before` when it can match nothing. */
function seqLast(terms: Term[], before: Chars): Chars {
  let acc = NONE;
  for (let i = terms.length - 1; i >= 0; i--) {
    acc = union(acc, terms[i]!.last);
    if (terms[i]!.minLen > 0) return acc;
  }
  return union(acc, before);
}

function makeTerm(node: Node, min: number, max: number): Term {
  let lo = 0;
  let hi = 0;
  let first = NONE;
  let last = NONE;
  let chars = NONE;
  let size = 1;
  let exact = min === max;
  let captures = node.kind === 'group' && node.capture ? 1 : 0;
  if (node.kind === 'char') {
    lo = hi = 1;
    first = last = chars = node.set;
  } else if (node.kind === 'group' || node.kind === 'look') {
    lo = Infinity;
    for (const alt of node.alts) {
      lo = Math.min(lo, seqMin(alt));
      hi = Math.max(hi, seqMax(alt));
      first = union(first, seqFirst(alt, NONE));
      last = union(last, seqLast(alt, NONE));
      for (const t of alt) {
        chars = union(chars, t.chars);
        size += t.size;
        exact &&= t.exact;
        captures += t.captures;
      }
    }
    if (node.kind === 'look') {
      lo = hi = 0;
      last = NONE;
    }
  }
  const minLen = min === 0 || lo === 0 ? 0 : min * lo;
  const maxLen = max === 0 || hi === 0 ? 0 : max * hi;
  if (min > UNROLL || (max > UNROLL && max !== Infinity)) size *= COUNTED;
  const t = { node, min, max, minLen, maxLen, first, last, chars, size, exact, captures };
  if (node.kind === 'group') t.size += entry(t) + exit(t) - 2;
  return t;
}

/** Steps to enter a group: V8 clears the captures inside a quantified group at each iteration. */
const entry = (t: Term): number => 1 + (t.min !== 1 || t.max !== 1 ? CAPTURE * t.captures : 0);
/** Steps to leave a group: a capturing group records where it ended. */
const exit = (t: Term): number => 1 + (t.node.kind === 'group' && t.node.capture ? CAPTURE : 0);

/**
 * For each term: the characters that can be consumed after it, and how many steps an attempt
 * that fails on the next character takes (`afterSkip` once past the end).
 */
function follows(terms: Term[], after: Chars, afterSkip = 0): { next: Chars[]; skip: number[] } {
  const next: Chars[] = [];
  const skip: number[] = [];
  let acc = after;
  let cost = afterSkip;
  for (let i = terms.length - 1; i >= 0; i--) {
    next[i] = acc;
    skip[i] = cost;
    const t = terms[i]!;
    if (t.node.kind === 'look') acc = ANY;
    else if (t.minLen === 0) acc = union(t.first, acc);
    else {
      acc = t.first;
      cost = 0;
    }
    cost += t.size;
  }
  return { next, skip };
}

// ---- Parser (V8 syntax without the u flag) --------------------------------------------

interface Atom {
  set: Chars;
  /** The code unit when the atom is a single character (for class ranges). */
  code: number | null;
}

const one = (code: number): Atom => ({ set: span(code, code), code });
const BRACES = /^\{(\d+)(,(\d*))?\}/;

class Parser {
  private i = 0;
  /** Inside (?m:…), where ^ also matches after a line break. */
  private multiline = false;
  constructor(private readonly src: string) {}

  parse(): Term[][] {
    const alts = this.alternatives();
    if (this.i < this.src.length) throw new Unsafe('unbalanced parenthesis');
    return alts;
  }

  private alternatives(): Term[][] {
    const alts: Term[][] = [this.sequence()];
    while (this.src[this.i] === '|') {
      this.i++;
      alts.push(this.sequence());
    }
    return alts;
  }

  private sequence(): Term[] {
    const terms: Term[] = [];
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
      const node = this.atom();
      const q = this.quantifier();
      if (q && node.kind !== 'char' && node.kind !== 'group') throw new Unsafe('a repeated assertion or lookaround');
      const [min, max] = q ?? [1, 1];
      if (max > 0) terms.push(makeTerm(node, min, max));
    }
    return terms;
  }

  private atom(): Node {
    const c = this.src[this.i++]!;
    switch (c) {
      case '^':
        return { kind: this.multiline ? 'assert' : 'start' };
      case '$':
        return { kind: 'assert' };
      case '.':
        return { kind: 'char', set: ANY };
      case '[':
        return { kind: 'char', set: this.charClass() };
      case '\\':
        if (this.src[this.i] === 'b' || this.src[this.i] === 'B') {
          this.i++;
          return { kind: 'assert' };
        }
        return { kind: 'char', set: this.escape(false).set };
      case '(':
        return this.group();
      case '*':
      case '+':
      case '?':
        throw new Unsafe('nothing to repeat');
      default:
        if (c === '{' && BRACES.test(this.src.slice(this.i - 1))) throw new Unsafe('nothing to repeat');
        return { kind: 'char', set: one(c.charCodeAt(0)).set }; // includes a literal ], { and }
    }
  }

  private group(): Node {
    const outer = this.multiline;
    let behind: boolean | null = null;
    let capture = this.src[this.i] !== '?';
    if (!capture) {
      const rest = this.src.slice(this.i + 1);
      const flags = /^([ims]*)(?:-([ims]*))?:/.exec(rest);
      const name = /^<[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*>/u.exec(rest);
      if (rest[0] === ':') this.i += 2;
      else if (rest[0] === '=' || rest[0] === '!') {
        this.i += 2;
        behind = false;
      } else if (rest.startsWith('<=') || rest.startsWith('<!')) {
        this.i += 3;
        behind = true;
      } else if (name) {
        this.i += 1 + name[0].length;
        capture = true;
      } else if (flags && validModifiers(flags[1]!, flags[2] ?? '')) {
        // (?ims-ims:…) is a non-capturing group; only m changes what can match (^ at line starts).
        if (flags[1]!.includes('m')) this.multiline = true;
        if (flags[2]?.includes('m')) this.multiline = false;
        this.i += 1 + flags[0].length;
      } else throw new Unsafe(`unsupported group syntax "(?${rest.slice(0, 2)}"`);
    }
    const alts = this.alternatives();
    if (this.src[this.i++] !== ')') throw new Unsafe('unbalanced parenthesis');
    this.multiline = outer;
    return behind === null ? { kind: 'group', alts, capture } : { kind: 'look', alts, behind };
  }

  /** After a backslash. */
  private escape(inClass: boolean): Atom {
    const c = this.src[this.i++];
    if (c === undefined) throw new Unsafe('trailing backslash');
    const next = this.src[this.i] ?? '';
    const hex = (digits: number): Atom => {
      const m = new RegExp(`^[0-9a-f]{${digits}}`, 'i').exec(this.src.slice(this.i));
      if (!m) return one(c.charCodeAt(0)); // \x or \u without enough hex digits is the letter itself
      this.i += digits;
      return one(parseInt(m[0], 16));
    };
    switch (c) {
      case 'd':
        return { set: DIGIT, code: null };
      case 'D':
        return { set: complement(DIGIT), code: null };
      case 'w':
        return { set: WORD, code: null };
      case 'W':
        return { set: complement(WORD), code: null };
      case 's':
        return { set: SPACE, code: null };
      case 'S':
        return { set: complement(SPACE), code: null };
      case 'b':
        return one(8); // in a class: backspace
      case 'f':
        return one(12);
      case 'n':
        return one(10);
      case 'r':
        return one(13);
      case 't':
        return one(9);
      case 'v':
        return one(11);
      case 'x':
        return hex(2);
      case 'u':
        return hex(4); // without the u flag, \u{…} is "u" repeated
      case 'c':
        if (/[a-z]/i.test(next) || (inClass && /[0-9_]/.test(next))) {
          this.i++;
          return one(next.charCodeAt(0) % 32);
        }
        this.i--; // a backslash, then "c" as an ordinary character
        return one(92);
      case '0':
        if (/[0-9]/.test(next)) throw new Unsafe('octal escapes are not allowed');
        return one(0);
      case 'k':
        throw new Unsafe(next === '<' ? BACKREF : 'unsupported escape \\k');
      default:
        if (c >= '1' && c <= '9') throw new Unsafe(inClass ? 'octal escapes are not allowed' : BACKREF);
        return one(c.charCodeAt(0)); // \. \- \p (without the u flag \p{…} is "p{…}") …
    }
  }

  private charClass(): Chars {
    const negate = this.src[this.i] === '^';
    if (negate) this.i++;
    let set = NONE;
    for (;;) {
      if (this.i >= this.src.length) throw new Unsafe('unterminated character class');
      if (this.src[this.i] === ']') {
        this.i++;
        break;
      }
      const a = this.classAtom();
      if (this.src[this.i] === '-' && this.i + 1 < this.src.length && this.src[this.i + 1] !== ']') {
        this.i++;
        const b = this.classAtom();
        // Annex B: a range with a class escape at either end, like [\d-z], is \d, "-" and z.
        if (a.code === null || b.code === null) set = union(set, a.set, b.set, span(45, 45));
        else if (a.code > b.code) throw new Unsafe('range out of order in character class');
        else set = union(set, span(a.code, b.code));
      } else set = union(set, a.set);
    }
    return negate ? complement(set) : set;
  }

  private classAtom(): Atom {
    const c = this.src[this.i++]!;
    return c === '\\' ? this.escape(true) : one(c.charCodeAt(0));
  }

  /** [min, max] of the quantifier at the current position, or null. */
  private quantifier(): [number, number] | null {
    const c = this.src[this.i];
    let q: [number, number];
    if (c === '*') q = [0, Infinity];
    else if (c === '+') q = [1, Infinity];
    else if (c === '?') q = [0, 1];
    else if (c === '{') {
      const m = BRACES.exec(this.src.slice(this.i));
      if (!m) return null; // a literal "{"
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
      if (max < min) throw new Unsafe('numbers out of order in a quantifier');
      this.i += m[0].length - 1;
      q = [min, max];
    } else return null;
    this.i++;
    if (this.src[this.i] === '?') this.i++; // lazy: same cost when the match fails
    return q;
  }
}

function validModifiers(add: string, remove: string): boolean {
  const all = add + remove;
  return all.length > 0 && new Set(all).size === all.length;
}

// ---- Deterministic loops --------------------------------------------------------------

/** Why repeating group `t` could split one stretch of text into iterations in more than one way. */
function loopProblem(t: Term): string | null {
  const alts = (t.node as GroupNode).alts;
  if (alts.some((alt) => seqMin(alt) === 0)) return SAME_TEXT;
  return altsProblem(alts, t.first);
}

/** `after`: the characters that can be consumed after the group (cyclically, inside a loop). */
function altsProblem(alts: Term[][], after: Chars): string | null {
  if (alts.length > 1) {
    const firsts = alts.map((alt) => seqFirst(alt, NONE));
    for (let i = 0; i < alts.length; i++) {
      if (seqMin(alts[i]!) === 0) return SAME_TEXT;
      for (let j = 0; j < i; j++) if (overlaps(firsts[i]!, firsts[j]!)) return SAME_START;
    }
  }
  for (const alt of alts) {
    const p = sequenceProblem(alt, after);
    if (p) return p;
  }
  return null;
}

/** Inside a loop every choice must be settled by the next character. */
function sequenceProblem(terms: Term[], after: Chars): string | null {
  const { next } = follows(terms, after);
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i]!;
    const n = t.node;
    if (n.kind === 'look') return 'a lookaround inside a repeated group';
    if (n.kind === 'char' && t.min !== t.max && overlaps(n.set, next[i]!)) return SAME_TEXT;
    if (n.kind !== 'group') continue;
    let inner = next[i]!;
    const empty = n.alts.some((alt) => seqMin(alt) === 0);
    if (t.max > 1) {
      if (empty || (t.minLen !== t.maxLen && overlaps(t.chars, inner))) return SAME_TEXT;
      inner = union(t.first, inner);
    } else if (t.min === 0 && (empty || overlaps(t.first, inner))) return SAME_TEXT;
    const p = altsProblem(n.alts, inner);
    if (p) return p;
  }
  return null;
}

// ---- Loops that end on a terminator ---------------------------------------------------
// ([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)* is not deterministic ([a-z0-9-]* and [a-z0-9] overlap),
// but it is safe. Suppose every alternative of a loop body ends with one character from a set
// E, nothing else in the body can match a character of E, and the body is unambiguous (no
// text matches it in two ways). Then:
//   1. An iteration that starts at s consumes no E character before its last one, so it ends
//      right after the first E character at or after s, and no attempt inside it consumes
//      past that character. Iteration boundaries are unique and the iterations' spans are
//      disjoint (lookarounds may read further; their cost is part of the body's bound).
//   2. A span is matched in at most one way, so each iteration start is reached once per entry
//      into the loop: backtracking into a finished iteration only finds dead ends. The loop
//      therefore reaches each end position in at most one way (like [x]*), and the step bound
//      treats it as one variable part, with the cost below for every path that enters it.
//   3. One entry costs the sum over its iterations (the last one failing) of exploring the body
//      once from the iteration's start. For a span of L characters the body's bound is
//      sum c[d] * C(L + d, d). C(L + d, d) - 1 is convex in L and 0 at L = 0, so it is
//      superadditive: over at most n + 1 disjoint spans totalling at most n characters the sum
//      is at most sum c[d] * (C(n + d, d) + n + 1) = total(body) + (n + 1) * sum c[d].
// Ambiguity is checked on the body's position (Glushkov) automaton: two paths over the same
// text are a transition or empty match made in two ways, or a pair of different positions
// that the same text reaches together from the start and that can reach the end together.
// Bounded repetitions over 3 count as unbounded there, which only adds paths.

/** Positions of the automaton that a part of the body can start and end on, and its ways to match nothing (2: more than one). */
interface Frag {
  first: number[];
  last: number[];
  empty: number;
}

/** At most this many positions are checked. */
const MAX_POSITIONS = 48;

class Positions {
  sets: Chars[] = [];
  follow: Set<number>[] = [];
  /** Some text matches in two ways (or the body is too big to check). */
  ambiguous = false;

  alternatives(alts: Term[][]): Frag {
    const frags = alts.map((alt) => alt.reduce((f, t) => this.concat(f, this.term(t)), { first: [], last: [], empty: 1 } as Frag));
    const empty = frags.reduce((s, f) => s + f.empty, 0);
    if (empty > 1) this.ambiguous = true;
    return { first: frags.flatMap((f) => f.first), last: frags.flatMap((f) => f.last), empty: Math.min(empty, 2) };
  }

  private term(t: Term): Frag {
    const n = t.node;
    if (this.ambiguous || (n.kind !== 'char' && n.kind !== 'group')) return { first: [], last: [], empty: 1 };
    const copy = (): Frag => (n.kind === 'char' ? this.position(n.set) : this.alternatives(n.alts));
    let f: Frag = { first: [], last: [], empty: 1 };
    for (let k = 0; k < t.min && !this.ambiguous; k++) f = this.concat(f, copy());
    if (t.max - t.min > UNROLL) {
      const body = copy();
      this.link(body.last, body.first);
      if (body.empty) this.ambiguous = true;
      f = this.concat(f, { ...body, empty: 1 });
    } else {
      let opt: Frag | null = null; // x{0,2} is (x(x)?)?
      for (let k = t.min; k < t.max; k++) {
        const body: Frag = opt ? this.concat(copy(), opt) : copy();
        if (body.empty) this.ambiguous = true;
        opt = { ...body, empty: 1 };
      }
      if (opt) f = this.concat(f, opt);
    }
    return f;
  }

  private position(set: Chars): Frag {
    if (this.sets.length >= MAX_POSITIONS) this.ambiguous = true;
    this.sets.push(set);
    this.follow.push(new Set());
    const p = this.sets.length - 1;
    return { first: [p], last: [p], empty: 0 };
  }

  private concat(a: Frag, b: Frag): Frag {
    this.link(a.last, b.first);
    return {
      first: a.empty ? [...a.first, ...b.first] : a.first,
      last: b.empty ? [...a.last, ...b.last] : b.last,
      empty: Math.min(a.empty * b.empty, 2),
    };
  }

  private link(from: number[], to: number[]): void {
    for (const a of from) {
      const f = this.follow[a]!;
      for (const b of to) {
        if (f.has(b)) this.ambiguous = true;
        f.add(b);
      }
    }
  }
}

/** Whether no text matches one of `alts` in two ways. */
function unambiguous(alts: Term[][]): boolean {
  const g = new Positions();
  const body = g.alternatives(alts);
  if (g.ambiguous || body.empty) return false;
  const n = g.sets.length;
  // Pairs of positions that the same text reaches together, with where they were reached from.
  const from = new Map<number, number[]>();
  const queue: number[] = [];
  const visit = (a: number, b: number, prev: number): void => {
    if (!overlaps(g.sets[a]!, g.sets[b]!)) return;
    const k = a * n + b;
    const list = from.get(k);
    if (list) list.push(prev);
    else {
      from.set(k, [prev]);
      queue.push(k);
    }
  };
  for (const a of body.first) for (const b of body.first) visit(a, b, -1);
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!;
    for (const a of g.follow[Math.floor(k / n)]!) for (const b of g.follow[k % n]!) visit(a, b, k);
  }
  // Of those, the pairs that can reach the end together.
  const ends = new Set(body.last);
  const live = queue.filter((k) => ends.has(Math.floor(k / n)) && ends.has(k % n));
  const seen = new Set(live);
  for (let i = 0; i < live.length; i++) {
    for (const p of from.get(live[i]!)!) {
      if (p >= 0 && !seen.has(p)) {
        seen.add(p);
        live.push(p);
      }
    }
  }
  return live.every((k) => Math.floor(k / n) === k % n);
}

/** The body of loop `t` when every alternative ends with a character nothing else in the body can match, or null. */
function terminated(t: Term): Term[][] | null {
  const alts = (t.node as GroupNode).alts;
  let end = NONE;
  for (const alt of alts) {
    const last = alt[alt.length - 1];
    if (!last || last.node.kind !== 'char' || last.min !== 1 || last.max !== 1) return null;
    end = union(end, last.node.set);
  }
  for (const alt of alts) for (const u of alt.slice(0, -1)) if (overlaps(u.chars, end)) return null;
  return unambiguous(alts) ? alts : null;
}

// ---- Cost bound -----------------------------------------------------------------------
// A Poly p stands for the bound sum of p[d] * C(n + d, d) over d, n = MAX_INPUT: p[d] counts
// path shapes (alternatives taken, bounded-quantifier lengths) with d free split points.
// Paths also tracks a "fresh" part: paths whose position still moves one for one with their
// last split point (only fixed-length parts since). Past a run of single characters such a
// path can only be where the run occurs in the text, and if the run cannot overlap itself
// at shifts below q, it occurs at most n / q + 1 times.

type Poly = number[];
interface Paths {
  all: Poly;
  fresh: Poly;
}

/** BIN[d] = C(n + d, d): ways to place d ordered split points among n + 1 positions. */
const BIN: number[] = [1];
for (let d = 1; d <= DEGREE + 1; d++) BIN.push((BIN[d - 1]! * (MAX_INPUT + d)) / d);

const zero = (): Poly => new Array<number>(DEGREE + 1).fill(0);
const unit = (): Poly => [1, ...new Array<number>(DEGREE).fill(0)];
const add = (a: Poly, b: Poly): Poly => a.map((x, d) => x + b[d]!);
const sub = (a: Poly, b: Poly): Poly => a.map((x, d) => x - b[d]!);
const scale = (a: Poly, k: number): Poly => a.map((x) => x * k);
const total = (a: Poly): number => a.reduce((s, x, d) => s + x * BIN[d]!, 0);
const none = (): Paths => ({ all: zero(), fresh: zero() });

/**
 * The paths `p` continued by a part that can end at `spread + 1` positions: each shape gets a
 * new split point (`moved`) or `spread + 1` variants. A split point is preferred unless it is
 * more than twice as big, because only split points share the 1/d! of later ones. When
 * `guarded` (the character before the part is one it cannot match), its runs from different
 * start positions cannot overlap, so together they scan at most 2(n + 1) positions per shape.
 */
function ends(p: Poly, spread: number, guarded = false, points = false): { out: Poly; moved: Poly } {
  const out = zero();
  const moved = zero();
  p.forEach((c, d) => {
    if (!c) return;
    const factor = (spread + 1) * BIN[d]!;
    const point = d < DEGREE ? BIN[d + 1]! : Infinity;
    const shared = guarded && d > 0 ? 2 * (MAX_INPUT + 1) * BIN[d - 1]! : Infinity;
    if (shared < factor && shared < point) out[d - 1]! += c * 2 * (MAX_INPUT + 1);
    else if (point <= 2 * factor || (points && point < Infinity)) {
      out[d + 1]! += c;
      moved[d + 1]! += c;
    } else out[d]! += c * (spread + 1);
  });
  return { out, moved };
}

/**
 * q[k - 1]: the smallest shift at which the first k characters of `run` could overlap
 * themselves (k if none). It never decreases with k.
 */
function periods(run: Chars[]): number[] {
  const out: number[] = [];
  let q = 1;
  for (let k = 1; k <= run.length; k++) {
    for (; q < k; q++) {
      let fits = true;
      for (let i = 0; i + q < k && fits; i++) fits = overlaps(run[i]!, run[i + q]!);
      if (fits) break;
    }
    out.push(q);
  }
  return out;
}

/** Fresh paths `f` past characters that occur at most every q positions: which bound is smaller. */
function located(f: Poly, q: number): { kept: Poly; used: Poly } {
  const kept = zero();
  const used = zero();
  const spots = MAX_INPUT / q + 1;
  f.forEach((c, d) => {
    if (d > 0 && spots * BIN[d - 1]! < BIN[d]!) used[d - 1]! += c * spots;
    else kept[d]! += c;
  });
  return { kept, used };
}

/** Whether a term matches a fixed number (at most 16) of characters from one set. */
const isRun = (t: Term): t is Term & { node: CharNode } => t.node.kind === 'char' && t.min === t.max && t.min <= 16;

class Bound {
  cost = zero();
  private work = 0;
  /** Always use split points (see loopEntrySteps). */
  private points = false;

  charge(p: Poly): void {
    this.cost = add(this.cost, p);
    if (total(this.cost) > MAX_STEPS) throw new Unsafe(TOO_MANY);
    if (++this.work > MAX_WORK) throw new Unsafe('too complex to check');
  }

  /** Paths that come out of `alts`, given the paths `x` going in. */
  alternatives(alts: Term[][], x: Paths, after: Chars, afterSkip: number, prev: Chars): Paths {
    const out = none();
    for (const alt of alts) {
      const y = this.sequence(alt, x, after, afterSkip, prev);
      out.all = add(out.all, y.all);
      out.fresh = add(out.fresh, y.fresh);
    }
    return out;
  }

  /**
   * `after`: what can be consumed next, `afterSkip`: the steps a path takes after the end
   * when it fails on that, `prev`: what the character before can be.
   */
  sequence(terms: Term[], x: Paths, after: Chars, afterSkip: number, prev: Chars): Paths {
    const { next, skip } = follows(terms, after, afterSkip);
    for (let i = 0; i < terms.length; ) {
      const run: Chars[] = [];
      const steps: number[] = [];
      for (let t = terms[i]; t && isRun(t); t = terms[++i]) {
        for (let k = 0; k < t.min; k++) {
          run.push(t.node.set);
          steps.push(t.size);
        }
      }
      if (run.length) {
        x = this.literal(run, steps, x);
        prev = run[run.length - 1]!;
        continue;
      }
      const t = terms[i]!;
      x = this.term(t, x, next[i]!, skip[i]!, prev);
      prev = t.node.kind === 'start' ? NONE : t.minLen === 0 ? union(prev, t.last) : t.last;
      i++;
    }
    return x;
  }

  /** A run of single characters, `steps[k]` steps each. */
  private literal(run: Chars[], steps: number[], { all, fresh }: Paths): Paths {
    const stale = sub(all, fresh);
    const q = periods(run);
    let cost = scale(add(stale, fresh), steps[0]!);
    for (let k = 1; k < run.length; k++) {
      // Fresh paths that get to character k matched the k before it.
      const { kept, used } = located(fresh, q[k - 1]!);
      cost = add(cost, scale(add(stale, add(kept, used)), steps[k]!));
    }
    this.charge(cost);
    const { kept, used } = located(fresh, q[run.length - 1]!);
    return { all: add(stale, add(kept, used)), fresh: kept };
  }

  private term(t: Term, x: Paths, next: Chars, skip: number, prev: Chars): Paths {
    const n = t.node;
    switch (n.kind) {
      case 'start': // only position 0 passes: every split point is 0
        this.charge(x.all);
        return { all: [x.all.reduce((s, c) => s + c, 0), ...zero().slice(1)], fresh: zero() };
      case 'assert':
        this.charge(x.all);
        return x;
      case 'look': {
        // V8 matches a lookbehind backwards; only allow ones without choices of length.
        if (n.behind && !t.exact) throw new Unsafe('a lookbehind of variable length');
        const outer = this.cost;
        this.cost = zero();
        this.alternatives(n.alts, { all: unit(), fresh: zero() }, NONE, 0, ANY);
        const inner = total(this.cost);
        this.cost = outer;
        this.charge(scale(x.all, 1 + inner));
        return x;
      }
      case 'char':
        if (t.min === t.max) {
          // A long fixed run (short ones are literals).
          this.charge(scale(x.all, Math.min(t.min, MAX_INPUT + 1) * t.size));
          return t.min > MAX_INPUT ? none() : x;
        }
        return this.variable(t, x, next, skip, prev);
      case 'group': {
        if (t.max > UNROLL) {
          const problem = loopProblem(t);
          if (!problem) return this.variable(t, x, next, skip, prev);
          const body = terminated(t);
          if (!body) throw new Unsafe(problem);
          return this.variable(t, x, next, skip, prev, this.loopEntrySteps(body));
        }
        // A plain, optional or briefly repeated group: follow each copy.
        const after = t.max > 1 ? union(t.first, next) : next;
        const inPrev = t.max > 1 ? union(prev, t.last) : prev;
        const out = t.min === 0 ? { ...x } : none();
        const steps = skip + exit(t) + (t.max > 1 ? entry(t) : 0);
        let cur = x;
        for (let k = 1; k <= t.max; k++) {
          this.charge(scale(cur.all, entry(t)));
          cur = this.alternatives(n.alts, cur, after, steps, inPrev);
          this.charge(scale(cur.all, exit(t)));
          if (k >= t.min) {
            out.all = add(out.all, cur.all);
            out.fresh = add(out.fresh, cur.fresh);
          }
        }
        return out;
      }
    }
  }

  /** A part that reaches each of its possible ends in at most one way (t.size steps per character). */
  /**
   * A part that reaches each of its possible ends in at most one way: t.size steps per
   * character, or `entrySteps` per entry for a loop that ends on a terminator.
   */
  private variable(t: Term, x: Paths, next: Chars, skip: number, prev: Chars, entrySteps?: number): Paths {
    const work = entrySteps === undefined ? t.size : 0;
    if (t.minLen > MAX_INPUT) {
      this.charge(scale(x.all, entrySteps ?? (MAX_INPUT + 1) * work));
      return none();
    }
    const spread = Math.min(t.maxLen, MAX_INPUT) - t.minLen;
    this.charge(scale(x.all, entrySteps ?? t.minLen * work)); // the characters it must match
    if (overlaps(t.chars, next)) {
      // The next part can start inside this one: every end goes on. Fresh paths stay fresh;
      // the others become fresh where they get a new split point.
      const stale = ends(sub(x.all, x.fresh), spread, false, this.points);
      const fresh = ends(x.fresh, spread, false, this.points).out;
      const all = add(stale.out, fresh);
      this.charge(scale(all, work));
      return { all, fresh: add(stale.moved, fresh) };
    }
    // Only the end followed by a character this part cannot match goes on; the others fail
    // after `skip` more steps.
    this.charge(scale(ends(x.all, spread, !overlaps(prev, t.chars), this.points).out, Math.max(work, 1) + skip));
    return { all: x.all, fresh: zero() };
  }

  /**
   * Steps one entry into a loop with this terminated `body` can take (proof above `Frag`).
   * A bounded part counted as a factor costs that factor in every iteration, but as a split
   * point it costs at most the iteration's length, so the body is also bounded with split
   * points only, and the smaller result is used.
   */
  private loopEntrySteps(body: Term[][]): number {
    const outer = { cost: this.cost, points: this.points };
    let best = Infinity;
    let failure: unknown = null;
    for (const points of [false, true]) {
      this.cost = zero();
      this.points = points;
      try {
        this.alternatives(body, { all: unit(), fresh: zero() }, ANY, 0, ANY);
        best = Math.min(best, total(this.cost) + (MAX_INPUT + 1) * this.cost.reduce((s, c) => s + c, 0));
      } catch (e) {
        failure = e;
      }
    }
    this.cost = outer.cost;
    this.points = outer.points;
    if (best === Infinity) throw failure;
    return best;
  }
}

/**
 * Why this pattern could take too long to match, or null if it looks safe.
 * The pattern must already compile with `new RegExp(source, 'i')`.
 */
export function regexHazard(source: string): string | null {
  if (source.length > MAX_REGEX_LENGTH) return `longer than ${MAX_REGEX_LENGTH} characters`;
  try {
    const bound = new Bound();
    const start = [0, 1, ...zero().slice(2)]; // unanchored: every start position
    for (const alt of new Parser(source).parse()) {
      // Once a path reaches a tail that can always match nothing, the match succeeds, so
      // the tail runs from one position only.
      let end = alt.length;
      while (end > 0 && alt[end - 1]!.min === 0) end--;
      bound.sequence(alt.slice(0, end), { all: start, fresh: start }, NONE, 0, ANY);
      bound.sequence(alt.slice(end), { all: unit(), fresh: zero() }, NONE, 0, ANY);
    }
    return null;
  } catch (e) {
    if (e instanceof Unsafe) return e.message;
    throw e;
  }
}
