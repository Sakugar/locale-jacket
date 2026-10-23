// Screening of regular expressions for catastrophic backtracking.
//
// JavaScript's regex engine backtracks, so a pattern such as ^(a+)+$ takes exponential
// time on some hostnames. Rule regexes run in the service worker while a page's request
// waits at the navigation gate, and they can come from subscriptions and data sets the
// user does not control, so one bad pattern would stall every tab. A pattern is refused when:
//   * it repeats a group (more than once) that contains an alternation, or whose
//     iterations could be split in more than one way: every two variable-length parts
//     must be separated by a fixed character neither can match. ([a-z0-9-]+\.)* and
//     (-[a-z0-9]+)* pass; (a+)+, (.+\.)* and (a|aa)+ do not;
//   * it uses back-references;
//   * it has more than MAX_UNBOUNDED unbounded quantifiers (each one multiplies the work);
//   * it is longer than MAX_REGEX_LENGTH.
// The check is conservative: it may refuse a pattern that is actually fast.

export const MAX_REGEX_LENGTH = 512;
export const MAX_UNBOUNDED = 4;
/** A quantifier allowing more repetitions than this counts as unbounded. */
const UNBOUNDED_ABOVE = 16;

type CharTest = (c: string) => boolean;

interface CharAtom {
  kind: 'char';
  test: CharTest;
  /** The character when the atom matches exactly one (case-insensitively). */
  literal: string | null;
}

interface GroupAtom {
  kind: 'group';
  alternatives: Term[][];
}

interface Term {
  /** null for assertions and lookarounds (they consume nothing). */
  atom: CharAtom | GroupAtom | null;
  min: number;
  max: number;
}

class Unsafe extends Error {}

const ANY: CharTest = () => true;
const DIGIT: CharTest = (c) => c >= '0' && c <= '9';
const WORD: CharTest = (c) => /\w/.test(c);
const SPACE: CharTest = (c) => /\s/.test(c);
const not = (f: CharTest): CharTest => (c) => !f(c);

function sameLetter(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function literal(ch: string): CharAtom {
  return { kind: 'char', test: (c) => sameLetter(c, ch), literal: ch };
}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): Term[][] {
    const alts = this.alternatives();
    if (this.i < this.src.length) throw new Unsafe('unbalanced parenthesis');
    return alts;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private alternatives(): Term[][] {
    const alts: Term[][] = [this.sequence()];
    while (this.peek() === '|') {
      this.i++;
      alts.push(this.sequence());
    }
    return alts;
  }

  private sequence(): Term[] {
    const terms: Term[] = [];
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.atom();
      const [min, max] = this.quantifier();
      terms.push({ atom, min, max });
    }
    return terms;
  }

  private atom(): CharAtom | GroupAtom | null {
    const c = this.src[this.i++]!;
    switch (c) {
      case '^':
      case '$':
        return null;
      case '.':
        return { kind: 'char', test: ANY, literal: null };
      case '[':
        return this.charClass();
      case '\\':
        return this.escape(false) as CharAtom | null;
      case '(': {
        let zeroWidth = false;
        if (this.src.startsWith('?:', this.i)) this.i += 2;
        else if (this.src.startsWith('?=', this.i) || this.src.startsWith('?!', this.i)) {
          this.i += 2;
          zeroWidth = true;
        } else if (this.src.startsWith('?<=', this.i) || this.src.startsWith('?<!', this.i)) {
          this.i += 3;
          zeroWidth = true;
        } else if (this.src.startsWith('?<', this.i)) {
          const end = this.src.indexOf('>', this.i);
          if (end < 0) throw new Unsafe('unreadable group name');
          this.i = end + 1;
        }
        const alternatives = this.alternatives();
        if (this.src[this.i++] !== ')') throw new Unsafe('unbalanced parenthesis');
        // A lookaround consumes nothing, but its body still runs: check it like a group.
        if (zeroWidth) {
          lookarounds.push({ kind: 'group', alternatives });
          return null;
        }
        return { kind: 'group', alternatives };
      }
      default:
        return literal(c);
    }
  }

  /** After a backslash. In a class, \b is a backspace character. */
  private escape(inClass: boolean): CharAtom | null {
    const c = this.src[this.i++];
    if (c === undefined) throw new Unsafe('trailing backslash');
    if (/[1-9]/.test(c) || (c === 'k' && this.peek() === '<')) throw new Unsafe('back-references are not allowed');
    switch (c) {
      case 'd':
        return { kind: 'char', test: DIGIT, literal: null };
      case 'D':
        return { kind: 'char', test: not(DIGIT), literal: null };
      case 'w':
        return { kind: 'char', test: WORD, literal: null };
      case 'W':
        return { kind: 'char', test: not(WORD), literal: null };
      case 's':
        return { kind: 'char', test: SPACE, literal: null };
      case 'S':
        return { kind: 'char', test: not(SPACE), literal: null };
      case 'b':
        return inClass ? literal('\b') : null;
      case 'B':
        return null;
      case 'p':
      case 'P':
        if (this.peek() === '{') this.i = Math.max(this.i, this.src.indexOf('}', this.i) + 1);
        return { kind: 'char', test: ANY, literal: null };
      case 'x': {
        const hex = /^[0-9a-f]{2}/i.exec(this.src.slice(this.i));
        if (!hex) return literal('x');
        this.i += 2;
        return literal(String.fromCharCode(parseInt(hex[0], 16)));
      }
      case 'u': {
        const rest = this.src.slice(this.i);
        const m = /^[0-9a-f]{4}/i.exec(rest) ?? /^\{([0-9a-f]{1,6})\}/i.exec(rest);
        if (!m) return literal('u');
        this.i += m[0].length;
        return literal(String.fromCodePoint(parseInt(m[1] ?? m[0], 16)));
      }
      case 'c':
        this.i++;
        return { kind: 'char', test: ANY, literal: null };
      case 'n':
        return literal('\n');
      case 'r':
        return literal('\r');
      case 't':
        return literal('\t');
      case 'f':
        return literal('\f');
      case 'v':
        return literal('\v');
      case '0':
        return literal('\0');
      default:
        return literal(c);
    }
  }

  private charClass(): CharAtom {
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.i++;
    }
    const parts: CharTest[] = [];
    let prev: string | null = null;
    for (;;) {
      if (this.i >= this.src.length) throw new Unsafe('unterminated character class');
      const c = this.src[this.i++]!;
      if (c === ']') break;
      let single: string | null = null;
      if (c === '\\') {
        const a = this.escape(true);
        if (a?.literal) single = a.literal;
        else if (a) parts.push(a.test);
      } else if (c === '-' && prev !== null && this.peek() !== ']' && this.peek() !== undefined) {
        let hi = this.src[this.i++]!;
        if (hi === '\\') hi = this.escape(true)?.literal ?? hi;
        const lo = prev;
        parts.push((x) => (x >= lo && x <= hi) || (x.toLowerCase() >= lo && x.toLowerCase() <= hi) || (x.toUpperCase() >= lo && x.toUpperCase() <= hi));
        prev = null;
        continue;
      } else {
        single = c;
      }
      if (single !== null) {
        const s = single;
        parts.push((x) => sameLetter(x, s));
      }
      prev = single;
    }
    const inSet: CharTest = (x) => parts.some((p) => p(x));
    return { kind: 'char', test: negate ? not(inSet) : inSet, literal: null };
  }

  /** [min, max] of the quantifier at the current position (default exactly once). */
  private quantifier(): [number, number] {
    let q: [number, number] = [1, 1];
    const c = this.peek();
    if (c === '*') q = [0, Infinity];
    else if (c === '+') q = [1, Infinity];
    else if (c === '?') q = [0, 1];
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) return q; // a literal "{"
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
      this.i += m[0].length - 1;
      q = [min, max];
    } else return q;
    this.i++;
    if (this.peek() === '?') this.i++; // lazy: same cost when the match fails
    return q;
  }
}

/** Lookaround bodies collected while parsing (checked like other groups). */
let lookarounds: GroupAtom[] = [];

/** One position of a flattened group body: a fixed character, or a variable-length part. */
interface Item {
  test: CharTest;
  variable: boolean;
  literal: string | null;
}

function anyCharOf(alts: Term[][]): CharTest {
  const tests: CharTest[] = [];
  for (const seq of alts) {
    for (const term of seq) {
      if (!term.atom) continue;
      tests.push(term.atom.kind === 'char' ? term.atom.test : anyCharOf(term.atom.alternatives));
    }
  }
  return (c) => tests.some((t) => t(c));
}

function hasAlternation(alts: Term[][]): boolean {
  return alts.length > 1 || alts.some((seq) => seq.some((t) => t.atom?.kind === 'group' && hasAlternation(t.atom.alternatives)));
}

function flatten(seq: Term[], out: Item[]): void {
  for (const term of seq) {
    if (!term.atom || term.max === 0) continue;
    const variable = term.min !== term.max;
    if (term.atom.kind === 'char') {
      const lit = !variable ? term.atom.literal : null;
      out.push({ test: term.atom.test, variable, literal: lit });
      continue;
    }
    if (!variable && term.atom.alternatives.length === 1) {
      for (let k = 0; k < Math.min(term.min, 4); k++) flatten(term.atom.alternatives[0]!, out);
      continue;
    }
    out.push({ test: anyCharOf(term.atom.alternatives), variable: true, literal: null });
  }
}

/** Why repeating this group can backtrack exponentially, or null if it cannot. */
function repeatedGroupProblem(group: GroupAtom): string | null {
  if (hasAlternation(group.alternatives)) return 'a repeated group contains an alternative (|)';
  const items: Item[] = [];
  flatten(group.alternatives[0] ?? [], items);
  const vars = items.map((x, i) => (x.variable ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < vars.length; k++) {
    const a = vars[k]!;
    const b = vars[(k + 1) % vars.length]!;
    // Fixed characters between a and b, going forward (across the end of one iteration
    // into the next when b comes first).
    const between: Item[] = [];
    for (let i = (a + 1) % items.length; i !== b; i = (i + 1) % items.length) between.push(items[i]!);
    const A = items[a]!;
    const B = items[b]!;
    const separated = between.some((x) => x.literal !== null && !A.test(x.literal) && !B.test(x.literal));
    if (!separated) return 'a repeated group can match the same text in more than one way';
  }
  return null;
}

function walk(alts: Term[][], stats: { unbounded: number }): string | null {
  for (const seq of alts) {
    for (const term of seq) {
      if (term.max > UNBOUNDED_ABOVE) stats.unbounded++;
      if (term.atom?.kind !== 'group') continue;
      if (term.max > 1) {
        const p = repeatedGroupProblem(term.atom);
        if (p) return p;
      }
      const inner = walk(term.atom.alternatives, stats);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Why this pattern could take too long to match, or null if it looks safe.
 * The pattern must already compile with `new RegExp(source, 'i')`.
 */
export function regexHazard(source: string): string | null {
  if (source.length > MAX_REGEX_LENGTH) return `longer than ${MAX_REGEX_LENGTH} characters`;
  lookarounds = [];
  try {
    const alts = new Parser(source).parse();
    const stats = { unbounded: 0 };
    const problem = walk(alts, stats) ?? walk(lookarounds.map((g) => [{ atom: g, min: 1, max: 1 }]), stats);
    if (problem) return problem;
    if (stats.unbounded > MAX_UNBOUNDED) return `more than ${MAX_UNBOUNDED} unbounded repetitions (*, + or {n,})`;
    return null;
  } catch (e) {
    if (e instanceof Unsafe) return e.message;
    throw e;
  } finally {
    lookarounds = [];
  }
}
