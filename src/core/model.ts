// The semantic model a parsed compilation unit produces. Everything here is
// independent of the vscode API so it can be unit-tested under plain node.

export interface Loc {
  file: string;
  start: number;
  end: number;
}

export type DefKind =
  | 'label'
  | 'locallabel'
  | 'symbol'
  | 'macro'
  | 'function'
  | 'section'
  | 'param'
  | 'forvar'
  | 'zpvar';

export interface Definition {
  kind: DefKind;
  name: string;
  nameLower: string;
  /** The range of the name itself. */
  loc: Loc;
  /** Full range of the defining statement line (for hover extracts). */
  stmtLoc: Loc;
  /** The scope the definition binds in. */
  scope: Scope;
  /** For a label that names a scope: the scope it names. */
  namedScope?: Scope;
  /** Extra signature text, e.g. a macro's parameter list. */
  detail?: string;
  /** For symbols: the defining expression, for constant evaluation. */
  valueExpr?: Expr;
}

export class Scope {
  parent: Scope | undefined;
  children: Scope[] = [];
  /** The label definition naming this scope, if any. */
  namingDef: Definition | undefined;
  symbols = new Map<string, Definition[]>();
  /** Anonymous .@ labels bound in this scope, in source order per file. */
  localLabels: Definition[] = [];

  constructor(parent?: Scope) {
    this.parent = parent;
    parent?.children.push(this);
  }

  define(def: Definition): void {
    const list = this.symbols.get(def.nameLower);
    if (list) {
      list.push(def);
    } else {
      this.symbols.set(def.nameLower, [def]);
    }
  }

  lookupLocal(nameLower: string): Definition[] | undefined {
    return this.symbols.get(nameLower);
  }

  lookupChain(nameLower: string): Definition[] | undefined {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const found = s.symbols.get(nameLower);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
}

// ---- expressions ----
// A small AST, kept only as far as constant evaluation needs (section attributes,
// hover values). References are recorded separately during parsing.

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; parts: string[]; scope: Scope }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'opaque' };

/** What a dotted reference chain looks like: one entry per name part. */
export interface Reference {
  parts: { name: string; loc: Loc }[];
  scope: Scope;
  kind: 'value' | 'macrocall' | 'section';
}

/** A reference to @- or @+ . */
export interface LocalLabelRef {
  loc: Loc;
  dir: -1 | 1;
  scope: Scope;
}

/** INCLUDE / INCBIN file reference. */
export interface FileRef {
  loc: Loc;
  raw: string;
  resolved?: string;
  kind: 'include' | 'incbin';
}

/** A mnemonic occurrence, annotated for cmos-aware semantic colouring. */
export interface MnemonicTok {
  loc: Loc;
  mnemonic: string;
  /** True when this instruction (mnemonic or addressing mode) needs the 65C02. */
  cmosOnly: boolean;
  /** True when the enclosing section context has cmos enabled. */
  cmosContext: boolean;
}

export type OutlineKind = DefKind | 'scope' | 'basic';

export interface OutlineNode {
  name: string;
  kind: OutlineKind;
  /** Selection range (the name). */
  loc: Loc;
  /** Full extent of the construct. */
  fullLoc: Loc;
  detail?: string;
  children: OutlineNode[];
}

export interface FileIndex {
  file: string;
  text: string;
  lineStarts: number[];
  /** Scope in effect from each offset onward (sorted by offset). */
  scopeEvents: { offset: number; scope: Scope }[];
  outline: OutlineNode[];
  mnemonics: MnemonicTok[];
  refs: Reference[];
  localRefs: LocalLabelRef[];
  fileRefs: FileRef[];
  defs: Definition[];
  /** Content ranges of BASIC..ENDBASIC blocks. */
  basicRanges: { start: number; end: number }[];
}

export interface Unit {
  rootFile: string;
  files: Map<string, FileIndex>;
  globalScope: Scope;
  macros: Map<string, Definition[]>;
  functions: Map<string, Definition[]>;
  sections: Map<string, Definition[]>;
}

export interface FileProvider {
  /** Returns file contents, or undefined if unreadable. Paths are absolute. */
  getText(file: string): string | undefined;
  /** Resolve a relative include path against the including file. */
  resolvePath(fromFile: string, relative: string): string;
}

export function scopeAt(index: FileIndex, offset: number): Scope {
  const events = index.scopeEvents;
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].offset <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return events[lo].scope;
}

/** The dotted path of a named scope, e.g. "outer.inner", for display. */
export function scopePath(scope: Scope): string {
  const parts: string[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    if (s.namingDef) {
      parts.unshift(s.namingDef.name);
    }
  }
  return parts.join('.');
}

/** Evaluate an expression to a constant number if trivially possible. */
export function evalConst(expr: Expr | undefined, depth = 0): number | undefined {
  if (!expr || depth > 16) {
    return undefined;
  }
  switch (expr.t) {
    case 'num':
      return expr.v;
    case 'str':
      return undefined;
    case 'ident': {
      if (expr.parts.length === 1) {
        const lower = expr.parts[0].toLowerCase();
        if (lower === 'true') return 1;
        if (lower === 'false') return 0;
        if (lower === 'pi') return Math.PI;
      }
      // Walk the dotted chain through named scopes.
      let defs = expr.scope.lookupChain(expr.parts[0].toLowerCase());
      for (let i = 1; i < expr.parts.length && defs; i++) {
        const named = defs.find((d) => d.namedScope);
        defs = named?.namedScope?.lookupLocal(expr.parts[i].toLowerCase());
      }
      const def = defs?.find((d) => d.kind === 'symbol' && d.valueExpr);
      return def ? evalConst(def.valueExpr, depth + 1) : undefined;
    }
    case 'un': {
      const v = evalConst(expr.e, depth + 1);
      if (v === undefined) return undefined;
      switch (expr.op) {
        case '-': return -v;
        case '+': return v;
        case '<': return Math.floor(v) & 0xff;
        case '>': return (Math.floor(v) >> 8) & 0xff;
        default: return undefined;
      }
    }
    case 'bin': {
      const l = evalConst(expr.l, depth + 1);
      const r = evalConst(expr.r, depth + 1);
      if (l === undefined || r === undefined) return undefined;
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? undefined : l / r;
        case '^': return Math.pow(l, r);
        case 'div': return r === 0 ? undefined : Math.floor(l / r);
        case 'mod': return r === 0 ? undefined : l - Math.floor(l / r) * r;
        case '<<': return (l | 0) << (r | 0);
        case '>>': return (l | 0) >> (r | 0);
        case 'and': return (l | 0) & (r | 0);
        case 'or': return (l | 0) | (r | 0);
        case 'eor': return (l | 0) ^ (r | 0);
        case '=': case '==': return l === r ? 1 : 0;
        case '!=': case '<>': return l !== r ? 1 : 0;
        case '<': return l < r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        default: return undefined;
      }
    }
    case 'opaque':
      return undefined;
  }
}
