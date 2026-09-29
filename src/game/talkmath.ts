import { warnOnce } from '../data/warn';

// A small evaluator for CDDA's dialogue "math" expressions (doc/JSON/NPCs.md, math.md):
//   "u_counter += 2"   "time_since('cataclysm', 'unit':'days') >= 30"   "!has_var(u_x)"
//   "npc_randomize_dialogue_direction == 3"   "max( a, 1 )"   "u_val('age') >= 18"
// Variables: `u_x` is the survivor's var x, `n_x` the NPC's, `_x` a context var, anything
// else a global. CDDA stores variables as strings; math reads them as numbers (non-numeric
// -> 0) and writes numbers back. Unknown functions warn once and evaluate to 0, so a
// condition we can't reason about is false rather than an exception.

export interface MathHost {
  getVar(scope: VarScope, name: string): string | undefined;
  setVar(scope: VarScope, name: string, value: string | undefined): void;
  /** Named functions (time_since, u_skill, rng...). `kw` holds 'key': value arguments. */
  call(name: string, args: MathValue[], kw: Record<string, MathValue>): number | undefined;
  /** Write through a mutator function (n_npc_anger() += 1); false when unsupported. */
  assign?(name: string, args: MathValue[], value: number): boolean;
}

export type VarScope = 'u' | 'npc' | 'global' | 'context';
export type MathValue = number | string;

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'var'; scope: VarScope; name: string }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'tern'; c: Node; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[]; kw: Record<string, Node> }
  | { t: 'assign'; op: string; target: Node; v?: Node };

const TOKEN = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|('(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(\+\+|--|\+=|-=|\*=|\/=|%=|==|!=|>=|<=|&&|\|\||[-+*/%^()<>!=,:?]))/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`math: bad token at "${src.slice(pos, pos + 12)}" in "${src}"`);
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
    pos = TOKEN.lastIndex;
  }
  return out;
}

export function varNode(name: string): Node {
  if (name.startsWith('u_')) return { t: 'var', scope: 'u', name: name.slice(2) };
  if (name.startsWith('n_')) return { t: 'var', scope: 'npc', name: name.slice(2) };
  if (name.startsWith('_')) return { t: 'var', scope: 'context', name: name.slice(1) };
  return { t: 'var', scope: 'global', name };
}

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 8,
};

class Parser {
  i = 0;
  constructor(readonly toks: string[], readonly src: string) {}
  peek(): string | undefined {
    return this.toks[this.i];
  }
  next(): string {
    const t = this.toks[this.i++];
    if (t === undefined) throw new Error(`math: unexpected end of "${this.src}"`);
    return t;
  }
  expect(t: string): void {
    const n = this.next();
    if (n !== t) throw new Error(`math: expected ${t}, got ${n} in "${this.src}"`);
  }
  statement(): Node {
    // Assignments: target op value | target++ | target--
    const save = this.i;
    const first = this.peek();
    if (first && /^[A-Za-z_]/.test(first) && this.toks[this.i + 1] !== '(') {
      const op = this.toks[this.i + 1];
      if (op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=') {
        this.i += 2;
        return { t: 'assign', op, target: varNode(first), v: this.expr(0) };
      }
      if (op === '++' || op === '--') {
        this.i += 2;
        return { t: 'assign', op, target: varNode(first) };
      }
    }
    this.i = save;
    const e = this.expr(0);
    // Mutator functions: "n_npc_anger() += 2", "u_val('strength') = 6".
    const op = this.peek();
    if (e.t === 'call' && op && ['=', '+=', '-=', '*=', '/=', '%=', '++', '--'].includes(op)) {
      this.next();
      return op === '++' || op === '--' ? { t: 'assign', op, target: e } : { t: 'assign', op, target: e, v: this.expr(0) };
    }
    return e;
  }
  expr(minPrec: number): Node {
    let a = this.unary();
    for (;;) {
      const op = this.peek();
      if (op === '?' && minPrec === 0) {
        this.next();
        const x = this.expr(0);
        this.expect(':');
        const y = this.expr(0);
        a = { t: 'tern', c: a, a: x, b: y };
        continue;
      }
      const p = op !== undefined ? BIN_PREC[op] : undefined;
      if (p === undefined || p < minPrec) return a;
      this.next();
      // ^ is right associative
      const b = this.expr(op === '^' ? p : p + 1);
      a = { t: 'bin', op: op!, a, b };
    }
  }
  unary(): Node {
    const t = this.peek();
    if (t === '-' || t === '!' || t === '+') {
      this.next();
      return { t: 'un', op: t, a: this.unary() };
    }
    return this.primary();
  }
  primary(): Node {
    const t = this.next();
    if (t === '(') {
      const e = this.expr(0);
      this.expect(')');
      return e;
    }
    if (/^[\d.]/.test(t)) return { t: 'num', v: Number(t) };
    if (t.startsWith("'")) return { t: 'str', v: t.slice(1, -1) };
    if (/^[A-Za-z_]/.test(t)) {
      if (this.peek() === '(') {
        this.next();
        const args: Node[] = [];
        const kw: Record<string, Node> = {};
        while (this.peek() !== ')') {
          const a = this.expr(0);
          if (this.peek() === ':' && a.t === 'str') {
            this.next();
            kw[a.v] = this.expr(0);
          } else args.push(a);
          if (this.peek() === ',') this.next();
          else break;
        }
        this.expect(')');
        return { t: 'call', name: t, args, kw };
      }
      return varNode(t);
    }
    throw new Error(`math: unexpected "${t}" in "${this.src}"`);
  }
}

const cache = new Map<string, Node | Error>();

export function parseMath(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    try {
      const p = new Parser(tokenize(src), src);
      n = p.statement();
      if (p.i < p.toks.length) throw new Error(`math: trailing tokens in "${src}"`);
    } catch (e) {
      n = e as Error;
    }
    cache.set(src, n);
  }
  if (n instanceof Error) throw n;
  return n;
}

const num = (s: string | undefined): number => {
  if (s === undefined) return 0;
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};

function evalNode(n: Node, h: MathHost): MathValue {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'var': return num(h.getVar(n.scope, n.name));
    case 'un': {
      const a = Number(evalNode(n.a, h));
      return n.op === '-' ? -a : n.op === '!' ? (a ? 0 : 1) : a;
    }
    case 'tern': return Number(evalNode(n.c, h)) ? evalNode(n.a, h) : evalNode(n.b, h);
    case 'bin': {
      if (n.op === '&&') return Number(evalNode(n.a, h)) && Number(evalNode(n.b, h)) ? 1 : 0;
      if (n.op === '||') return Number(evalNode(n.a, h)) || Number(evalNode(n.b, h)) ? 1 : 0;
      const a = Number(evalNode(n.a, h)), b = Number(evalNode(n.b, h));
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '%': return b === 0 ? 0 : a % b;
        case '^': return a ** b;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
      }
      return 0;
    }
    case 'call': {
      // has_var(u_x) takes the variable itself, not its value.
      if (n.name === 'has_var') {
        const v = n.args[0];
        return v?.t === 'var' && h.getVar(v.scope, v.name) !== undefined ? 1 : 0;
      }
      const args = n.args.map((a) => evalNode(a, h));
      const kw: Record<string, MathValue> = {};
      for (const [k, v] of Object.entries(n.kw)) kw[k] = evalNode(v, h);
      switch (n.name) {
        case 'max': return Math.max(...args.map(Number));
        case 'min': return Math.min(...args.map(Number));
        case 'abs': return Math.abs(Number(args[0]));
        case 'floor': return Math.floor(Number(args[0]));
        case 'ceil': return Math.ceil(Number(args[0]));
        case 'round': return Math.round(Number(args[0]));
        case 'sqrt': return Math.sqrt(Number(args[0]));
        case 'clamp': return Math.max(Number(args[1]), Math.min(Number(args[2]), Number(args[0])));
      }
      const r = h.call(n.name, args, kw);
      if (r === undefined) {
        warnOnce('math_function', n.name);
        return 0;
      }
      return r;
    }
    case 'assign': {
      const t = n.target;
      let cur: number;
      if (t.t === 'var') cur = num(h.getVar(t.scope, t.name));
      else if (t.t === 'call') cur = Number(evalNode(t, h));
      else return 0;
      const v = n.v ? Number(evalNode(n.v, h)) : 0;
      const next = n.op === '=' ? v : n.op === '+=' ? cur + v : n.op === '-=' ? cur - v : n.op === '*=' ? cur * v : n.op === '/=' ? (v ? cur / v : 0)
        : n.op === '%=' ? (v ? cur % v : 0) : n.op === '++' ? cur + 1 : cur - 1;
      if (t.t === 'var') h.setVar(t.scope, t.name, String(next));
      else if (!h.assign?.(t.name, t.args.map((a) => evalNode(a, h)), next)) warnOnce('math_assign', t.name, `[talk] can't assign to ${t.name}()`);
      return next;
    }
  }
}

/** Evaluate an expression string; assignment statements write variables through the host. */
export function evalMath(src: string, h: MathHost): number {
  try {
    return Number(evalNode(parseMath(src), h)) || 0;
  } catch (e) {
    warnOnce('math_parse', src, String((e as Error).message));
    return 0;
  }
}

/**
 * A CDDA "math" array: ["expr"] (condition or assignment), or the legacy 3-element form
 * ["lhs", "op", "rhs"] with a comparison or assignment operator.
 */
export function evalMathArray(arr: unknown[], h: MathHost): number {
  if (arr.length === 1 && typeof arr[0] === 'string') return evalMath(arr[0], h);
  if (arr.length === 3 && arr.every((x) => typeof x === 'string')) return evalMath(`${arr[0]} ${arr[1]} ${arr[2]}`, h);
  warnOnce('math_shape', JSON.stringify(arr).slice(0, 80));
  return 0;
}
