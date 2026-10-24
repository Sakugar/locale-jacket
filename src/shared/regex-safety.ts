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
//
// The check's own work is bounded as well, since a crafted pattern could make the analysis
// slow instead of the match. Every phase (parsing, the loop checks, the position automaton
// and its pair walk, the step bound) counts units of work against one limit per pattern
// (MAX_ANALYSIS, under a millisecond); a pattern that needs more is refused as too complex to
// check. Checks of many patterns in one go can share an AnalysisBudget, and verdicts are
// remembered by source with what they cost, so the same pattern is analysed once (a batch
// is still charged that cost: what fits in it depends only on its patterns).

export const MAX_REGEX_LENGTH = 512;
/**
 * Increased whenever the rules for what is accepted change, so stored data that was checked
 * by the same version need not be checked again.
 */
export const REGEX_CHECK_VERSION = 2;
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

const BACKREF = 'back-references are not allowed';
const SAME_TEXT = 'a repeated group can match the same text in more than one way; a form like ^([a-z0-9-]+\\.)*example\\.com$ works';
const SAME_START = 'alternatives (|) in a repeated group can start with the same character';
const TOO_MANY = 'parts of it can match the same text in too many ways';
const COMPLEX = 'too complex to check';
const SPENT = 'too many complex regular expressions in this list';

/**
 * Thrown with the reason a pattern is refused. Not an Error: capturing a stack trace would
 * cost more than most checks.
 */
class Unsafe {
  constructor(readonly message: string) {}
}

// ---- Analysis work --------------------------------------------------------------------
// One unit is about one elementary step of the checker (a set comparison, a mask operation,
// a few array writes); building a Poly costs POLY units.

/**
 * Units of analysis work for one pattern: about 0.6 ms in warm node (15-30 ns a unit), and
 * 5-10 ms as the very first check in a fresh process. The hostname patterns in GeoSite need
 * at most about 3,000; 512-character alternations of domains 13,000-15,000.
 */
const MAX_ANALYSIS = 30000;
/** Units per millisecond for a batch: node does 40,000-75,000 warm, depending on the patterns. */
const UNITS_PER_MS = 30000;
/** Units for building or combining a Poly (DEGREE + 1 numbers). */
const POLY = 8;
/** Units for setting up one analysis. */
const SETUP = 80;
/** Verdicts remembered by source. */
const MEMO_SIZE = 4096;

/** The current check ran out of work (its own limit, or the batch's). */
class OutOfWork {}

/** Work used by the current check, and the most it may use (checks never run nested). */
let used = 0;
let allowed = 0;

function work(units: number): void {
  used += units;
  if (used > allowed) throw new OutOfWork();
}

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

function union(a: Chars, b: Chars): Chars {
  const rest = a.rest > b.rest ? a.rest : b.rest;
  return { w0: a.w0 | b.w0, w1: a.w1 | b.w1, w2: a.w2 | b.w2, w3: a.w3 | b.w3, rest };
}

function overlaps(a: Chars, b: Chars): boolean {
  return ((a.w0 & b.w0) | (a.w1 & b.w1) | (a.w2 & b.w2) | (a.w3 & b.w3)) !== 0 || (a.rest !== 0 && b.rest !== 0);
}

function complement(s: Chars): Chars {
  return { w0: ~s.w0, w1: ~s.w1, w2: ~s.w2, w3: ~s.w3, rest: (2 - s.rest) as Rest };
}

const DIGIT = span(48, 57);
const WORD = union(union(DIGIT, span(65, 90)), span(95, 95));
const SPACE = union(union(span(9, 13), span(32, 32)), { ...NONE, rest: 1 });

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
      work(1 + 6 * alt.length);
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
  work(1 + 2 * terms.length);
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
const HEX2 = /^[0-9a-f]{2}/i;
const HEX4 = /^[0-9a-f]{4}/i;

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
      work(6);
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
    work(16);
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
    const hex = (digits: 2 | 4): Atom => {
      const m = (digits === 2 ? HEX2 : HEX4).exec(this.src.slice(this.i));
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
      work(2);
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
        if (a.code === null || b.code === null) set = union(union(set, a.set), union(b.set, span(45, 45)));
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

// The checks below depend only on the loop, so their results are kept per Term: the step
// bound reaches a loop once per copy of each group around it that is repeated up to UNROLL
// times, and again when it bounds the loops around it.
const loopProblems = new WeakMap<Term, string | null>();
const terminatedBodies = new WeakMap<Term, Term[][] | null>();

/** Why repeating group `t` could split one stretch of text into iterations in more than one way. */
function loopProblem(t: Term): string | null {
  let p = loopProblems.get(t);
  if (p === undefined) {
    const alts = (t.node as GroupNode).alts;
    work(alts.length);
    p = alts.some((alt) => seqMin(alt) === 0) ? SAME_TEXT : altsProblem(alts, t.first);
    loopProblems.set(t, p);
  }
  return p;
}

/** `after`: the characters that can be consumed after the group (cyclically, inside a loop). */
function altsProblem(alts: Term[][], after: Chars): string | null {
  if (alts.length > 1) {
    const firsts = alts.map((alt) => seqFirst(alt, NONE));
    for (let i = 0; i < alts.length; i++) {
      work(2 + i);
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
    work(2);
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
// text are a transition or empty match made in two ways, or two paths that the same text
// takes from the start, that part (are on different positions after some character) and
// that can then reach the end together. Bounded repetitions over 3 count as unbounded there,
// which only adds paths.

/** At most this many positions are checked. */
const MAX_POSITIONS = 48;
/** A set of positions: bit p % 32 of word p >> 5, in WORDS 32-bit words. */
type Mask = number[];
const WORDS = (MAX_POSITIONS + 31) >> 5;
const EMPTY: readonly number[] = new Array<number>(WORDS).fill(0);
const noPositions = (): Mask => EMPTY.slice();

/** The lowest bit set in a non-zero word (iterate with `for (let m = word; m; m &= m - 1)`). */
const lowest = (m: number): number => 31 - Math.clz32(m & -m);

function or(a: Mask, b: Mask): Mask {
  const r = a.slice();
  for (let w = 0; w < WORDS; w++) r[w]! |= b[w]!;
  return r;
}

function meet(a: Mask, b: Mask): boolean {
  for (let w = 0; w < WORDS; w++) if (a[w]! & b[w]!) return true;
  return false;
}

const has = (m: Mask, p: number): boolean => (m[p >> 5]! & (1 << (p & 31))) !== 0;

/**
 * Positions of the automaton that a part of the body can start and end on, and its ways to
 * match nothing (2: more than one).
 */
interface Frag {
  first: Mask;
  last: Mask;
  empty: number;
}

/** Masks in a Frag are never changed in place, so they can be shared. */
const NOTHING: Frag = { first: noPositions(), last: noPositions(), empty: 1 };

class Positions {
  sets: Chars[] = [];
  /** follow[p]: the positions that can come right after position p. */
  follow: Mask[] = [];
  /** Some text matches in two ways (or the body is too big to check). */
  ambiguous = false;

  alternatives(alts: Term[][]): Frag {
    let first = NOTHING.first;
    let last = NOTHING.last;
    let empty = 0;
    for (const alt of alts) {
      work(2);
      let f = NOTHING;
      for (const t of alt) f = this.concat(f, this.term(t));
      first = or(first, f.first);
      last = or(last, f.last);
      empty += f.empty;
    }
    if (empty > 1) this.ambiguous = true;
    return { first, last, empty: Math.min(empty, 2) };
  }

  private term(t: Term): Frag {
    work(2);
    const n = t.node;
    if (this.ambiguous || (n.kind !== 'char' && n.kind !== 'group')) return NOTHING;
    const copy = (): Frag => (n.kind === 'char' ? this.position(n.set) : this.alternatives(n.alts));
    let f = NOTHING;
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
    const p = this.sets.length;
    if (p >= MAX_POSITIONS) {
      this.ambiguous = true;
      return NOTHING;
    }
    this.sets.push(set);
    this.follow.push(noPositions());
    const m = noPositions();
    m[p >> 5] = 1 << (p & 31);
    return { first: m, last: m, empty: 0 };
  }

  private concat(a: Frag, b: Frag): Frag {
    this.link(a.last, b.first);
    return {
      first: a.empty ? or(a.first, b.first) : a.first,
      last: b.empty ? or(a.last, b.last) : b.last,
      empty: Math.min(a.empty * b.empty, 2),
    };
  }

  private link(from: Mask, to: Mask): void {
    work(2);
    for (let w = 0; w < WORDS; w++) {
      for (let m = from[w]!; m; m &= m - 1) {
        work(2);
        const f = this.follow[w * 32 + lowest(m)]!;
        if (meet(f, to)) this.ambiguous = true;
        for (let v = 0; v < WORDS; v++) f[v]! |= to[v]!;
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
  const { follow } = g;
  // meets[a]: the positions whose characters overlap those of a.
  const meets: Mask[] = [];
  for (let a = 0; a < n; a++) {
    work(n);
    const m = noPositions();
    for (let b = 0; b < n; b++) if (overlaps(g.sets[a]!, g.sets[b]!)) m[b >> 5]! |= 1 << (b & 31);
    meets.push(m);
  }
  const finals = body.last;
  // Two paths that have not parted are on the same position: `alone` holds the positions the
  // same text reaches that way. parted[a] has b: after parting, the two paths can be on a and b.
  const alone = noPositions();
  const parted = Array.from({ length: n }, noPositions);
  const singles: number[] = [];
  const pairs: number[] = []; // a * MAX_POSITIONS + b
  const others = noPositions();
  const fresh = noPositions();
  // Paths that have parted, one on a and the other on any of `others`; false when two can end together.
  const part = (a: number): boolean => {
    const seen = parted[a]!;
    let any = 0;
    for (let w = 0; w < WORDS; w++) any |= fresh[w] = others[w]! & ~seen[w]!;
    if (!any) return true;
    if (has(finals, a) && meet(fresh, finals)) return false;
    for (let w = 0; w < WORDS; w++) {
      work(1);
      seen[w]! |= fresh[w]!;
      for (let m = fresh[w]!; m; m &= m - 1) pairs.push(a * MAX_POSITIONS + w * 32 + lowest(m));
    }
    return true;
  };
  // Both paths take a character from the positions they can be on: `next` for the first, `second` for the other.
  const step = (next: Mask, second: Mask, together: boolean): boolean => {
    for (let w = 0; w < WORDS; w++) {
      for (let m = next[w]!; m; m &= m - 1) {
        work(3);
        const c = w * 32 + lowest(m);
        const bit = 1 << (c & 31);
        const near = meets[c]!;
        if (together && near[w]! & bit && !(alone[w]! & bit)) {
          alone[w]! |= bit;
          singles.push(c);
        }
        for (let v = 0; v < WORDS; v++) others[v] = second[v]! & near[v]!;
        if (together) others[w]! &= ~bit;
        if (!part(c)) return false;
      }
    }
    return true;
  };
  if (!step(body.first, body.first, true)) return false;
  for (let i = 0, j = 0; i < singles.length || j < pairs.length; ) {
    work(1);
    if (i < singles.length) {
      const a = singles[i++]!;
      if (!step(follow[a]!, follow[a]!, true)) return false;
    } else {
      const k = pairs[j++]!;
      if (!step(follow[Math.floor(k / MAX_POSITIONS)]!, follow[k % MAX_POSITIONS]!, false)) return false;
    }
  }
  return true;
}

/** The body of loop `t` when every alternative ends with a character nothing else in the body can match, or null. */
function terminated(t: Term): Term[][] | null {
  let body = terminatedBodies.get(t);
  if (body === undefined) {
    body = terminatedBody((t.node as GroupNode).alts);
    terminatedBodies.set(t, body);
  }
  return body;
}

function terminatedBody(alts: Term[][]): Term[][] | null {
  let end = NONE;
  for (const alt of alts) {
    work(2);
    const last = alt[alt.length - 1];
    if (!last || last.node.kind !== 'char' || last.min !== 1 || last.max !== 1) return null;
    end = union(end, last.node.set);
  }
  for (const alt of alts) {
    work(1 + alt.length);
    for (const u of alt.slice(0, -1)) if (overlaps(u.chars, end)) return null;
  }
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

// Plain loops: these run for every term of every path through the pattern.
const ZERO: readonly number[] = new Array<number>(DEGREE + 1).fill(0);
const zero = (): Poly => ZERO.slice();
const unit = (): Poly => {
  const p = zero();
  p[0] = 1;
  return p;
};
const add = (a: Poly, b: Poly): Poly => {
  const r = a.slice();
  for (let d = 0; d <= DEGREE; d++) r[d]! += b[d]!;
  return r;
};
const sub = (a: Poly, b: Poly): Poly => {
  const r = a.slice();
  for (let d = 0; d <= DEGREE; d++) r[d]! -= b[d]!;
  return r;
};
const scale = (a: Poly, k: number): Poly => {
  const r = a.slice();
  for (let d = 0; d <= DEGREE; d++) r[d]! *= k;
  return r;
};
const total = (a: Poly): number => {
  let s = 0;
  for (let d = 0; d <= DEGREE; d++) s += a[d]! * BIN[d]!;
  return s;
};
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
  for (let d = 0; d <= DEGREE; d++) {
    const c = p[d]!;
    if (!c) continue;
    const factor = (spread + 1) * BIN[d]!;
    const point = d < DEGREE ? BIN[d + 1]! : Infinity;
    const shared = guarded && d > 0 ? 2 * (MAX_INPUT + 1) * BIN[d - 1]! : Infinity;
    if (shared < factor && shared < point) out[d - 1]! += c * 2 * (MAX_INPUT + 1);
    else if (point <= 2 * factor || (points && point < Infinity)) {
      out[d + 1]! += c;
      moved[d + 1]! += c;
    } else out[d]! += c * (spread + 1);
  }
  return { out, moved };
}

/**
 * q[k - 1]: the smallest shift at which the first k characters of `run` could overlap
 * themselves (k if none). It never decreases with k. Past MAX_INPUT + 1 characters (more
 * than a hostname) it is not computed but kept, which only makes the bound larger.
 */
function periods(run: Chars[]): number[] {
  const out: number[] = [];
  let q = 1;
  work(run.length);
  for (let k = 1; k <= run.length; k++) {
    // q fits the first k - 1 characters (q = k - 1 always does), so only the new pair is
    // checked for it; larger shifts are checked in full.
    if (q < k && k <= MAX_INPUT + 1 && !overlaps(run[k - 1 - q]!, run[k - 1]!)) {
      for (q++; q < k; q++) {
        let fits = true;
        let i = 0;
        for (; i + q < k && fits; i++) fits = overlaps(run[i]!, run[i + q]!);
        work(1 + i);
        if (fits) break;
      }
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
  for (let d = 0; d <= DEGREE; d++) {
    const c = f[d]!;
    if (d > 0 && spots * BIN[d - 1]! < BIN[d]!) used[d - 1]! += c * spots;
    else kept[d]! += c;
  }
  return { kept, used };
}

/** Whether a term matches a fixed number (at most 16) of characters from one set. */
const isRun = (t: Term): t is Term & { node: CharNode } => t.node.kind === 'char' && t.min === t.max && t.min <= 16;

// Lookaround bodies and terminated loop bodies are bounded on their own, from fixed inputs,
// so the results are kept per node: a lookaround's steps without and with split points only
// (see loopEntrySteps), and a loop's steps per entry or why it is refused.
const lookSteps = new WeakMap<LookNode, [number?, number?]>();
const loopEntries = new WeakMap<Term[][], number | Unsafe>();

class Bound {
  cost = zero();
  /** Always use split points (see loopEntrySteps). */
  private points = false;

  charge(p: Poly): void {
    work(2 * POLY);
    this.cost = add(this.cost, p);
    if (total(this.cost) > MAX_STEPS) throw new Unsafe(TOO_MANY);
  }

  /** Paths that come out of `alts`, given the paths `x` going in. */
  alternatives(alts: Term[][], x: Paths, after: Chars, afterSkip: number, prev: Chars): Paths {
    const out = none();
    for (const alt of alts) {
      work(2 * POLY);
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
        work(1 + t.min);
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
    // Character k costs steps[k] for every stale path and for the fresh paths that matched the
    // k before it, located(fresh, q[k - 1]). Summed per degree: `keep[d]` for the fresh paths
    // of degree d that keep it, `drop[d]` for those that drop to d - 1 (see located).
    let rest = 0;
    const keep = zero();
    const drop = zero();
    work(2 * run.length);
    for (let k = 1; k < run.length; k++) {
      const s = steps[k]!;
      const spots = MAX_INPUT / q[k - 1]! + 1;
      rest += s;
      keep[0]! += s;
      for (let d = 1; d <= DEGREE; d++) {
        if (spots * BIN[d - 1]! < BIN[d]!) drop[d]! += s * spots;
        else keep[d]! += s;
      }
    }
    const cost = add(scale(add(stale, fresh), steps[0]!), scale(stale, rest));
    for (let d = 0; d <= DEGREE; d++) {
      cost[d]! += fresh[d]! * keep[d]!;
      if (d > 0) cost[d - 1]! += fresh[d]! * drop[d]!;
    }
    work(4 * POLY);
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
        let memo = lookSteps.get(n);
        if (!memo) lookSteps.set(n, (memo = []));
        let inner = memo[+this.points];
        if (inner === undefined) {
          const outer = this.cost;
          this.cost = zero();
          this.alternatives(n.alts, { all: unit(), fresh: zero() }, NONE, 0, ANY);
          inner = memo[+this.points] = total(this.cost);
          this.cost = outer;
        }
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
        work(4 * POLY);
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

  /**
   * A part that reaches each of its possible ends in at most one way: t.size steps per
   * character, or `entrySteps` per entry for a loop that ends on a terminator.
   */
  private variable(t: Term, x: Paths, next: Chars, skip: number, prev: Chars, entrySteps?: number): Paths {
    const perChar = entrySteps === undefined ? t.size : 0;
    if (t.minLen > MAX_INPUT) {
      this.charge(scale(x.all, entrySteps ?? (MAX_INPUT + 1) * perChar));
      return none();
    }
    work(6 * POLY);
    const spread = Math.min(t.maxLen, MAX_INPUT) - t.minLen;
    this.charge(scale(x.all, entrySteps ?? t.minLen * perChar)); // the characters it must match
    if (overlaps(t.chars, next)) {
      // The next part can start inside this one: every end goes on. Fresh paths stay fresh;
      // the others become fresh where they get a new split point.
      const stale = ends(sub(x.all, x.fresh), spread, false, this.points);
      const fresh = ends(x.fresh, spread, false, this.points).out;
      const all = add(stale.out, fresh);
      this.charge(scale(all, perChar));
      return { all, fresh: add(stale.moved, fresh) };
    }
    // Only the end followed by a character this part cannot match goes on; the others fail
    // after `skip` more steps.
    this.charge(scale(ends(x.all, spread, !overlaps(prev, t.chars), this.points).out, Math.max(perChar, 1) + skip));
    return { all: x.all, fresh: zero() };
  }

  /**
   * Steps one entry into a loop with this terminated `body` can take (proof above `Frag`).
   * A bounded part counted as a factor costs that factor in every iteration, but as a split
   * point it costs at most the iteration's length, so the body is also bounded with split
   * points only, and the smaller result is used.
   */
  private loopEntrySteps(body: Term[][]): number {
    let steps = loopEntries.get(body);
    if (steps === undefined) {
      const outer = { cost: this.cost, points: this.points };
      let best = Infinity;
      let failure: Unsafe | null = null;
      try {
        for (const points of [false, true]) {
          this.cost = zero();
          this.points = points;
          try {
            this.alternatives(body, { all: unit(), fresh: zero() }, ANY, 0, ANY);
            best = Math.min(best, total(this.cost) + (MAX_INPUT + 1) * this.cost.reduce((s, c) => s + c, 0));
          } catch (e) {
            if (!(e instanceof Unsafe)) throw e; // out of work, or a bug
            failure = e;
          }
        }
      } finally {
        this.cost = outer.cost;
        this.points = outer.points;
      }
      steps = best === Infinity ? failure! : best;
      loopEntries.set(body, steps);
    }
    if (steps instanceof Unsafe) throw steps;
    return steps;
  }
}

/** Why `source` could take too long to match, or null; throws OutOfWork past `allowed` units. */
function analyze(source: string): string | null {
  try {
    work(SETUP);
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

/**
 * A remembered verdict, and the units its analysis used (more than MAX_ANALYSIS for one
 * that was too complex to check).
 */
interface Verdict {
  reason: string | null;
  cost: number;
}

/** Verdicts by source, least recently used first. */
const verdicts = new Map<string, Verdict>();

export interface AnalysisBudget {
  remaining: number;
}

/**
 * A budget for checking many patterns in one go (one subscription file, one GeoSite category,
 * one settings load); roughly `ms` of analysis in total.
 */
export function analysisBudget(ms: number): AnalysisBudget {
  return { remaining: ms > 0 ? ms * UNITS_PER_MS : 0 };
}

/**
 * Why this pattern could take too long to match, or null if it looks safe.
 * The pattern must already compile with `new RegExp(source, 'i')`.
 *
 * The analysis stops at MAX_ANALYSIS units (the pattern is then too complex to check). With a
 * `budget`, the units used are taken from it, and once it is spent the remaining patterns are
 * refused without being analysed; that refusal depends on the batch, so it is not remembered.
 * A remembered verdict is answered from memory: for free without a budget, and with one for
 * the units its analysis used, exactly as if it were analysed again, so which patterns of a
 * batch fit in its budget does not depend on what earlier checks remembered.
 */
export function regexHazard(source: string, budget?: AnalysisBudget): string | null {
  if (source.length > MAX_REGEX_LENGTH) return `longer than ${MAX_REGEX_LENGTH} characters`;
  const known = verdicts.get(source);
  if (known !== undefined) {
    verdicts.delete(source); // now the most recently used
    verdicts.set(source, known);
    if (!budget) return known.reason;
  }
  // `!(x > 0)` also catches NaN.
  if (budget && !(budget.remaining > 0)) return SPENT;
  const batch = budget !== undefined && budget.remaining < MAX_ANALYSIS;
  allowed = batch ? budget.remaining : MAX_ANALYSIS;
  if (known !== undefined) {
    // Only reached with a budget: charged what analysing it again would use, which stops
    // once it passes `allowed`.
    budget!.remaining -= Math.min(known.cost, allowed);
    return batch && known.cost > allowed ? SPENT : known.reason;
  }
  used = 0;
  let verdict: string | null;
  try {
    verdict = analyze(source);
  } catch (e) {
    if (!(e instanceof OutOfWork)) throw e;
    if (batch) return SPENT; // the budget is now spent (below)
    verdict = COMPLEX;
  } finally {
    if (budget) budget.remaining -= Math.min(used, allowed);
  }
  if (verdicts.size >= MEMO_SIZE) verdicts.delete(verdicts.keys().next().value!);
  verdicts.set(source, { reason: verdict, cost: used });
  return verdict;
}

/** Forgets every remembered verdict (for tests and benchmarks). */
export function clearRegexVerdicts(): void {
  verdicts.clear();
}
