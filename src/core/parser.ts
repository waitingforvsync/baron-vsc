// The unit parser: parses a root source file and everything it INCLUDEs into one
// compilation unit (baron assembles each command-line file independently, with a fresh
// symbol table - so each root is its own unit). The parse is tolerant: malformed input
// never throws, it just yields fewer definitions/references.
//
// Statement grammar follows baron's assemble.c (parse_one_statement and the handle_*
// handlers); expressions follow expression.c; operands follow opcodes.c. See JOURNAL.md
// for the verified behaviour notes.

import {
  CMOS_INDIRECT_MNEMONICS,
  CMOS_ONLY_MNEMONICS,
  DIRECTIVES,
  CLOSERS,
  BUILTIN_FUNCTIONS,
  MNEMONICS,
  RESERVED_CONSTANTS,
  WORD_OPERATORS,
} from './data';
import { computeLineStarts, Lexer, Token, TokKind } from './lexer';
import {
  Definition,
  DefKind,
  Expr,
  FileIndex,
  FileProvider,
  Loc,
  OutlineNode,
  Reference,
  Scope,
  Unit,
} from './model';

const MAX_INCLUDE_DEPTH = 32;

// Binary operator precedence, from expression.c's ladder (range and lo/hi are handled
// structurally, not via this table).
const BINARY_PREC: Record<string, number> = {
  'or': 10, 'eor': 10,
  'and': 20,
  '=': 30, '==': 30, '!=': 30, '<>': 30, '<': 30, '>': 30, '<=': 30, '>=': 30,
  '+': 40, '-': 40,
  '*': 50, '/': 50, 'div': 50, 'mod': 50, '<<': 50, '>>': 50,
  '^': 70,
};
const RIGHT_ASSOC = new Set(['^']);

const ACC_MNEMONICS = new Set(['asl', 'lsr', 'rol', 'ror', 'inc', 'dec']);

interface Block {
  type: 'scope' | 'for' | 'macro' | 'function' | 'section';
  prevScope?: Scope;
  prevCmos?: boolean;
  outlineNode?: OutlineNode;
  outlinePushed?: boolean;
}

export function parseUnit(rootFile: string, provider: FileProvider): Unit {
  const unit: Unit = {
    rootFile,
    files: new Map(),
    globalScope: new Scope(),
    macros: new Map(),
    functions: new Map(),
    sections: new Map(),
  };
  const up = new UnitParser(unit, provider);
  up.parseFile(rootFile, unit.globalScope, false, 0);
  return unit;
}

class UnitParser {
  constructor(readonly unit: Unit, readonly provider: FileProvider) {}

  parseFile(file: string, scope: Scope, cmos: boolean, depth: number): void {
    if (depth > MAX_INCLUDE_DEPTH || this.unit.files.has(file)) {
      return; // include cycle or runaway depth: parse each file once per unit
    }
    const text = this.provider.getText(file);
    if (text === undefined) {
      return;
    }
    const index: FileIndex = {
      file,
      text,
      lineStarts: computeLineStarts(text),
      scopeEvents: [{ offset: 0, scope }],
      outline: [],
      mnemonics: [],
      refs: [],
      localRefs: [],
      fileRefs: [],
      defs: [],
      basicRanges: [],
    };
    this.unit.files.set(file, index);
    new FileParser(this, index, scope, cmos, depth).run();
  }

  addGlobal(map: Map<string, Definition[]>, def: Definition): void {
    const list = map.get(def.nameLower);
    if (list) {
      list.push(def);
    } else {
      map.set(def.nameLower, [def]);
    }
  }
}

class FileParser {
  private readonly lx: Lexer;
  private scope: Scope;
  private cmos: boolean;
  private readonly blocks: Block[] = [];
  private readonly outlineStack: OutlineNode[][];

  constructor(
    private readonly up: UnitParser,
    private readonly index: FileIndex,
    scope: Scope,
    cmos: boolean,
    private readonly depth: number,
  ) {
    this.lx = new Lexer(index.text);
    this.scope = scope;
    this.cmos = cmos;
    this.outlineStack = [this.index.outline];
  }

  // ---- small helpers ----

  private loc(tok: Token): Loc {
    return { file: this.index.file, start: tok.start, end: tok.end };
  }

  private peek(): Token {
    return this.lx.peek();
  }

  private next(): Token {
    return this.lx.next();
  }

  private isPunct(tok: Token, text: string): boolean {
    return tok.kind === TokKind.Punct && tok.lower === text;
  }

  private atStatementEnd(tok: Token): boolean {
    return tok.kind === TokKind.Eof || tok.kind === TokKind.Terminator || this.isPunct(tok, '}');
  }

  private skipToStatementEnd(): void {
    while (!this.atStatementEnd(this.peek())) {
      this.next();
    }
  }

  private define(kind: DefKind, nameTok: Token, scope: Scope, detail?: string): Definition {
    const def: Definition = {
      kind,
      name: nameTok.text,
      nameLower: nameTok.lower,
      loc: this.loc(nameTok),
      stmtLoc: this.loc(nameTok),
      scope,
      detail,
    };
    scope.define(def);
    this.index.defs.push(def);
    return def;
  }

  private outlineAdd(node: OutlineNode): void {
    this.outlineStack[this.outlineStack.length - 1].push(node);
  }

  private scopeEvent(offset: number, scope: Scope): void {
    this.index.scopeEvents.push({ offset, scope });
  }

  // ---- the statement loop ----

  run(): void {
    for (;;) {
      const tok = this.peek();
      if (tok.kind === TokKind.Eof) {
        break;
      }
      if (tok.kind === TokKind.Terminator) {
        this.next();
        continue;
      }
      const before = this.lx.getPos();
      this.parseStatement(tok);
      if (this.lx.getPos() === before) {
        this.next(); // guarantee progress whatever the input
      }
    }
    // Close anything left open (tolerance for a file mid-edit).
    const eof = this.index.text.length;
    while (this.blocks.length > 0) {
      this.closeBlock(this.blocks[this.blocks.length - 1].type, eof);
    }
  }

  private parseStatement(tok: Token): void {
    if (tok.kind === TokKind.Punct) {
      if (tok.lower === '.') {
        this.parseLabel();
        return;
      }
      if (tok.lower === '{') {
        this.next();
        this.openScope(tok, undefined);
        return;
      }
      if (tok.lower === '}') {
        const brace = this.next();
        this.closeBlock('scope', brace.end);
        return;
      }
      if (tok.lower === '=') {
        // A function body's top-level return (or a stray '='): parse the expression.
        this.next();
        this.parseExpr();
        this.closeFunctionIfOpen();
        return;
      }
      if (tok.lower === '@+' || tok.lower === '@-') {
        // A stray local-label ref at statement start: record and skip.
        this.next();
        this.index.localRefs.push({ loc: this.loc(tok), dir: tok.lower === '@+' ? 1 : -1, scope: this.scope });
        this.skipToStatementEnd();
        return;
      }
      this.next();
      return;
    }

    if (tok.kind !== TokKind.Ident) {
      this.next();
      return;
    }

    const lower = tok.lower;
    if (MNEMONICS.has(lower)) {
      this.next();
      this.parseInstruction(tok);
      return;
    }
    if (DIRECTIVES.has(lower)) {
      this.next();
      this.parseDirective(tok);
      return;
    }
    if (CLOSERS.has(lower)) {
      this.next();
      this.parseCloser(tok);
      return;
    }
    if (RESERVED_CONSTANTS.has(lower)) {
      this.next();
      this.skipToStatementEnd();
      return;
    }

    // Identifier statement: `name = expr` assignment, else a macro invocation.
    this.next();
    const after = this.peek();
    if (this.isPunct(after, '=')) {
      this.next();
      if (tok.text.includes('.')) {
        // A dotted path is not a binding target (baron rejects it); record as a reference.
        this.recordIdentRef(tok, 'value');
        this.parseExpr();
        return;
      }
      const def = this.define('symbol', tok, this.scope);
      const rhsStart = this.lx.getPos();
      def.valueExpr = this.parseExpr() ?? undefined;
      const rhsEnd = this.lx.getPos();
      def.detail = '= ' + this.index.text.slice(rhsStart, Math.min(rhsEnd, rhsStart + 60)).trim();
      // In a function body an assignment is a local; elsewhere it's an ordinary symbol.
      this.outlineAdd({
        name: tok.text, kind: 'symbol', loc: def.loc, fullLoc: def.loc,
        detail: def.detail, children: [],
      });
      return;
    }

    // Macro invocation (or a macro not yet defined - record it anyway).
    this.recordIdentRef(tok, 'macrocall');
    this.parseMacroArgs();
  }

  private parseCloser(tok: Token): void {
    switch (tok.lower) {
      case 'next':
        this.closeBlock('for', tok.end);
        break;
      case 'endmacro':
        this.closeBlock('macro', tok.end);
        break;
      case 'endsection':
        this.closeBlock('section', tok.end);
        break;
      case 'elif': {
        this.parseExpr();
        break;
      }
      default:
        // else / endif / endbasic: structural only, nothing to record.
        break;
    }
  }

  // ---- scopes and blocks ----

  private openScope(braceTok: Token, namingDef: Definition | undefined): void {
    const child = new Scope(this.scope);
    if (namingDef) {
      child.namingDef = namingDef;
      namingDef.namedScope = child;
    }
    const block: Block = { type: 'scope', prevScope: this.scope };
    if (namingDef) {
      const node: OutlineNode = {
        name: namingDef.name,
        kind: 'scope',
        loc: namingDef.loc,
        fullLoc: { file: this.index.file, start: namingDef.loc.start, end: braceTok.end },
        children: [],
      };
      this.outlineAdd(node);
      this.outlineStack.push(node.children);
      block.outlineNode = node;
      block.outlinePushed = true;
    }
    this.blocks.push(block);
    this.scope = child;
    this.scopeEvent(braceTok.end, child);
  }

  /** Close the innermost block of the given type, tolerantly unwinding anything above it. */
  private closeBlock(type: Block['type'], offset: number): void {
    let found = -1;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].type === type) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      return; // a closer with nothing to close: baron errors, we shrug
    }
    while (this.blocks.length > found) {
      const block = this.blocks.pop()!;
      if (block.prevScope) {
        this.scope = block.prevScope;
        this.scopeEvent(offset, this.scope);
      }
      if (block.prevCmos !== undefined) {
        this.cmos = block.prevCmos;
      }
      if (block.outlineNode) {
        block.outlineNode.fullLoc.end = offset;
        if (block.outlinePushed) {
          this.outlineStack.pop();
        }
      }
    }
  }

  private closeFunctionIfOpen(): void {
    const top = this.blocks[this.blocks.length - 1];
    if (top && top.type === 'function') {
      this.closeBlock('function', this.lx.getPos());
    }
  }

  // ---- labels ----

  private parseLabel(): void {
    this.next(); // '.'
    const tok = this.peek();
    if (tok.kind === TokKind.Punct && (tok.lower === '@' || tok.lower === '@+' || tok.lower === '@-')) {
      // `.@` local label. ('@+'/'@-' here would really be `.@` followed by +/-, but at
      // statement position after '.', baron lexes `.@` as its own keyword; treat the '@'
      // prefix as the label and leave any trailing +/- alone.)
      this.next();
      const def: Definition = {
        kind: 'locallabel',
        name: '@',
        nameLower: '@',
        loc: { file: this.index.file, start: tok.start - 1, end: tok.start + 1 },
        stmtLoc: { file: this.index.file, start: tok.start - 1, end: tok.start + 1 },
        scope: this.scope,
      };
      this.scope.localLabels.push(def);
      this.index.defs.push(def);
      return;
    }
    if (tok.kind !== TokKind.Ident || tok.text.includes('.')) {
      return; // malformed / dotted label: baron reports, we skip
    }
    this.next();
    const def = this.define('label', tok, this.scope);

    // A '{' next - or exactly one terminator then '{' - makes the label name the scope.
    const nb = this.peek();
    if (this.isPunct(nb, '{')) {
      this.next();
      this.openScope(nb, def);
      return;
    }
    if (nb.kind === TokKind.Terminator) {
      const save = this.lx.getPos();
      this.next();
      const after = this.peek();
      if (this.isPunct(after, '{')) {
        this.next();
        this.openScope(after, def);
        return;
      }
      this.lx.setPos(save); // stand-alone label: leave the terminator for the loop
    }
    this.outlineAdd({ name: tok.text, kind: 'label', loc: def.loc, fullLoc: def.loc, children: [] });
  }

  // ---- directives ----

  private parseDirective(tok: Token): void {
    switch (tok.lower) {
      case 'equb': case 'equs': case 'equw': case 'equd':
      case 'cancall': case 'canjump': case 'zpreserve':
        this.parseExprList();
        break;
      case 'skip': case 'skipto': case 'align': case 'if':
        this.parseExpr();
        break;
      case 'print': {
        if (this.isPunct(this.peek(), '#')) {
          this.next();
          if (this.peek().kind === TokKind.Number) {
            this.next();
          }
          if (this.isPunct(this.peek(), ',')) {
            this.next();
          }
        }
        if (!this.atStatementEnd(this.peek())) {
          this.parseExprList();
        }
        break;
      }
      case 'error':
        if (!this.atStatementEnd(this.peek())) {
          this.parseExprList();
        }
        break;
      case 'include': case 'incbin':
        this.parseInclude(tok.lower);
        break;
      case 'incsection': {
        const name = this.peek();
        if (name.kind === TokKind.Ident) {
          this.next();
          this.recordIdentRef(name, 'section');
        }
        break;
      }
      case 'section':
        this.parseSection(tok);
        break;
      case 'for':
        this.parseFor(tok);
        break;
      case 'macro':
        this.parseMacro(tok);
        break;
      case 'function':
        this.parseFunction(tok);
        break;
      case 'basic':
        this.parseBasic(tok);
        break;
      case 'zpauto1':
        this.parseZpNames('1 byte');
        break;
      case 'zpauto2':
        this.parseZpNames('2 bytes');
        break;
      case 'zpauto': {
        const sizeStart = this.lx.getPos();
        this.parseExpr();
        const sizeText = this.index.text.slice(sizeStart, this.lx.getPos()).trim();
        if (this.isPunct(this.peek(), ',')) {
          this.next();
        }
        this.parseZpNames(`${sizeText} bytes`);
        break;
      }
      case 'unreachable':
        break;
      default:
        this.skipToStatementEnd();
        break;
    }
  }

  private parseZpNames(detail: string): void {
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== TokKind.Ident) {
        break;
      }
      this.next();
      if (!tok.text.includes('.') && tok.lower !== 'a') {
        const def = this.define('zpvar', tok, this.scope, detail);
        this.outlineAdd({ name: tok.text, kind: 'zpvar', loc: def.loc, fullLoc: def.loc, detail, children: [] });
      }
      if (this.isPunct(this.peek(), ',')) {
        this.next();
        continue;
      }
      break;
    }
  }

  private parseInclude(kind: 'include' | 'incbin'): void {
    const tok = this.peek();
    if (tok.kind !== TokKind.String || tok.str === undefined) {
      return;
    }
    this.next();
    const resolved = this.up.provider.resolvePath(this.index.file, tok.str);
    this.index.fileRefs.push({ loc: this.loc(tok), raw: tok.str, resolved, kind });
    if (kind === 'include') {
      // Splice: the included file parses in the current scope and cmos context.
      this.up.parseFile(resolved, this.scope, this.cmos, this.depth + 1);
    }
  }

  private parseSection(kw: Token): void {
    const name = this.peek();
    if (name.kind !== TokKind.Ident) {
      this.skipToStatementEnd();
      return;
    }
    this.next();
    const def = this.define('section', name, this.scope);
    this.up.addGlobal(this.up.unit.sections, def);

    const prevCmos = this.cmos; // nested sections inherit attributes (assemble.c)
    let cmosSeen = false;

    const attrs: string[] = [];
    while (this.isPunct(this.peek(), ',')) {
      this.next();
      const key = this.peek();
      if (key.kind !== TokKind.Ident) {
        break;
      }
      this.next();
      if (!this.isPunct(this.peek(), '=')) {
        break;
      }
      this.next();
      const expr = this.parseExpr();
      attrs.push(key.lower);
      if (key.lower === 'cmos') {
        cmosSeen = true;
        const v = evalCmos(expr);
        // Unresolvable (forward-referenced) cmos: assume enabled, so we never flag
        // valid CMOS code as illegal on incomplete information.
        this.cmos = v === undefined ? true : v !== 0;
      }
    }
    if (!cmosSeen) {
      this.cmos = prevCmos;
    }

    const node: OutlineNode = {
      name: name.text,
      kind: 'section',
      loc: def.loc,
      fullLoc: { file: this.index.file, start: kw.start, end: def.loc.end },
      detail: attrs.length ? attrs.join(', ') : undefined,
      children: [],
    };
    this.outlineAdd(node);
    this.outlineStack.push(node.children);
    this.blocks.push({ type: 'section', prevCmos, outlineNode: node, outlinePushed: true });
  }

  private parseFor(kw: Token): void {
    const varTok = this.peek();
    if (varTok.kind !== TokKind.Ident || varTok.text.includes('.')) {
      this.skipToStatementEnd();
      return;
    }
    this.next();
    if (!this.isPunct(this.peek(), '=')) {
      this.skipToStatementEnd();
      return;
    }
    this.next();

    // The body runs in its own scope per iteration; one scope stands in for all of them.
    const child = new Scope(this.scope);
    const def: Definition = {
      kind: 'forvar',
      name: varTok.text,
      nameLower: varTok.lower,
      loc: this.loc(varTok),
      stmtLoc: this.loc(varTok),
      scope: child,
    };
    child.define(def);
    this.index.defs.push(def);

    // The sequence expression evaluates in the ENCLOSING scope.
    this.parseExpr();

    this.blocks.push({ type: 'for', prevScope: this.scope });
    this.scope = child;
    this.scopeEvent(this.lx.getPos(), child);
    void kw;
  }

  private parseMacro(kw: Token): void {
    const name = this.peek();
    if (name.kind !== TokKind.Ident || name.text.includes('.')) {
      this.skipToStatementEnd();
      return;
    }
    this.next();
    const def = this.define('macro', name, this.scope);
    this.up.addGlobal(this.up.unit.macros, def);

    // Signature slots up to the terminator: params, quoted verbatim tokens, commas.
    const child = new Scope(this.scope);
    const sigStart = this.lx.getPos();
    for (;;) {
      const tok = this.peek();
      if (this.atStatementEnd(tok)) {
        break;
      }
      this.next();
      if (tok.kind === TokKind.Ident && !tok.text.includes('.')) {
        const p: Definition = {
          kind: 'param',
          name: tok.text,
          nameLower: tok.lower,
          loc: this.loc(tok),
          stmtLoc: this.loc(tok),
          scope: child,
        };
        child.define(p);
        this.index.defs.push(p);
      }
      // Strings are verbatim tokens, commas are their own slot; anything else baron
      // rejects as unquoted - all just skipped here.
    }
    def.detail = this.index.text.slice(sigStart, this.lx.getPos()).trim();

    const node: OutlineNode = {
      name: name.text,
      kind: 'macro',
      loc: def.loc,
      fullLoc: { file: this.index.file, start: kw.start, end: def.loc.end },
      detail: def.detail || undefined,
      children: [],
    };
    this.outlineAdd(node);
    this.outlineStack.push(node.children);
    this.blocks.push({ type: 'macro', prevScope: this.scope, outlineNode: node, outlinePushed: true });
    this.scope = child;
    this.scopeEvent(this.lx.getPos(), child);
  }

  private parseFunction(kw: Token): void {
    const name = this.peek();
    if (name.kind !== TokKind.Ident || name.text.includes('.')) {
      this.skipToStatementEnd();
      return;
    }
    this.next();
    const def = this.define('function', name, this.scope);
    this.up.addGlobal(this.up.unit.functions, def);

    const child = new Scope(this.scope);
    const params: string[] = [];
    if (this.isPunct(this.peek(), '(')) {
      this.next();
      for (;;) {
        const tok = this.peek();
        if (this.isPunct(tok, ')')) {
          this.next();
          break;
        }
        if (this.atStatementEnd(tok)) {
          break;
        }
        this.next();
        if (tok.kind === TokKind.Ident && !tok.text.includes('.')) {
          params.push(tok.text);
          const p: Definition = {
            kind: 'param',
            name: tok.text,
            nameLower: tok.lower,
            loc: this.loc(tok),
            stmtLoc: this.loc(tok),
            scope: child,
          };
          child.define(p);
          this.index.defs.push(p);
        }
        // commas just separate
      }
    }
    def.detail = `(${params.join(', ')})`;

    const node: OutlineNode = {
      name: name.text,
      kind: 'function',
      loc: def.loc,
      fullLoc: { file: this.index.file, start: kw.start, end: this.lx.getPos() },
      detail: def.detail,
      children: [],
    };

    // One-liner: `FUNCTION name(params) = expr` - the return arrives immediately.
    if (this.isPunct(this.peek(), '=')) {
      this.next();
      const prev = this.scope;
      this.scope = child;
      this.parseExpr();
      this.scope = prev;
      node.fullLoc.end = this.lx.getPos();
      this.outlineAdd(node);
      return;
    }

    // Multi-line body: assignments and IFs until a top-level '=' return.
    this.outlineAdd(node);
    this.outlineStack.push(node.children);
    this.blocks.push({ type: 'function', prevScope: this.scope, outlineNode: node, outlinePushed: true });
    this.scope = child;
    this.scopeEvent(this.lx.getPos(), child);
  }

  private parseBasic(kw: Token): void {
    // BASIC lines are opaque spans: a statement starting with a digit runs to end of line
    // and the lexer must not see inside it (assemble.c handle_basic). Scan textually.
    const text = this.index.text;
    let pos = this.lx.getPos();
    const contentStart = pos;
    let end = text.length;
    let closed = false;
    while (pos < text.length) {
      // skip leading whitespace on the line
      let i = pos;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === ':')) {
        i++;
      }
      const lineEnd = text.indexOf('\n', i);
      const stop = lineEnd < 0 ? text.length : lineEnd;
      const ch = text[i];
      if (i >= text.length) {
        pos = i;
        break;
      }
      if (ch >= '0' && ch <= '9') {
        pos = stop + 1; // a BASIC line
        continue;
      }
      if (ch === ';' || ch === '\\' || ch === '\n') {
        pos = stop + 1; // blank / comment line
        continue;
      }
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, stop))?.[0];
      if (word && word.toLowerCase() === 'endbasic') {
        end = i;
        pos = i + word.length;
        closed = true;
      } else {
        end = i; // anything else: baron errors; we stop the block here tolerantly
        pos = i;
      }
      break;
    }
    if (!closed && pos >= text.length) {
      end = text.length;
    }
    this.index.basicRanges.push({ start: contentStart, end });
    this.outlineAdd({
      name: 'BASIC',
      kind: 'basic',
      loc: { file: this.index.file, start: kw.start, end: kw.end },
      fullLoc: { file: this.index.file, start: kw.start, end: pos },
      children: [],
    });
    this.lx.setPos(pos);
  }

  // ---- instructions ----

  private parseInstruction(mn: Token): void {
    const lower = mn.lower;
    let cmosOnly = CMOS_ONLY_MNEMONICS.has(lower);

    const tok = this.peek();
    if (this.atStatementEnd(tok)) {
      // implied / accumulator, nothing to parse
    } else if (this.isPunct(tok, '#')) {
      this.next();
      this.parseExpr();
      if (lower === 'bit') {
        cmosOnly = true; // BIT #imm is 65C02-only (opcodes.c: 0x89 | cmos)
      }
    } else if (this.isPunct(tok, '(')) {
      this.next();
      this.parseExpr();
      const a = this.peek();
      if (this.isPunct(a, ',')) {
        // (expr,X): indexed-indirect for the ALU ops (NMOS), the indexed dispatch for JMP (CMOS).
        this.next();
        if (this.peek().kind === TokKind.Ident && this.peek().lower === 'x') {
          this.next();
        }
        if (this.isPunct(this.peek(), ')')) {
          this.next();
        }
        if (lower === 'jmp') {
          cmosOnly = true; // JMP (abs,X) is 65C02-only (0x7C | cmos)
        }
      } else if (this.isPunct(a, ')')) {
        this.next();
        if (this.isPunct(this.peek(), ',')) {
          this.next(); // (expr),Y - NMOS
          if (this.peek().kind === TokKind.Ident && this.peek().lower === 'y') {
            this.next();
          }
        } else if (CMOS_INDIRECT_MNEMONICS.has(lower)) {
          cmosOnly = true; // plain (zp) indirect is 65C02-only on the ALU ops
        }
      }
    } else if (
      tok.kind === TokKind.Ident && tok.lower === 'a' && ACC_MNEMONICS.has(lower)
    ) {
      // Bare A counts as the accumulator only when nothing but a terminator (or '}') follows.
      const save = this.lx.getPos();
      this.next();
      if (this.atStatementEnd(this.peek())) {
        if (lower === 'inc' || lower === 'dec') {
          cmosOnly = true; // INC A / DEC A are 65C02-only (0x1A/0x3A | cmos)
        }
      } else {
        this.lx.setPos(save); // a real expression starting with symbol `a`
        this.parseExpr();
        if (this.parseIndexSuffix() === 'x' && lower === 'bit') {
          cmosOnly = true; // BIT zp,X / abs,X are 65C02-only
        }
      }
    } else {
      this.parseExpr();
      if (this.parseIndexSuffix() === 'x' && lower === 'bit') {
        cmosOnly = true; // BIT zp,X / abs,X are 65C02-only
      }
    }

    this.index.mnemonics.push({
      loc: this.loc(mn),
      mnemonic: lower,
      cmosOnly,
      cmosContext: this.cmos,
    });
  }

  private parseIndexSuffix(): 'x' | 'y' | undefined {
    if (this.isPunct(this.peek(), ',')) {
      this.next();
      const reg = this.peek();
      if (reg.kind === TokKind.Ident && (reg.lower === 'x' || reg.lower === 'y')) {
        this.next();
        return reg.lower as 'x' | 'y';
      }
    }
    return undefined;
  }

  // ---- macro invocation arguments ----

  private parseMacroArgs(): void {
    // Slots are expressions, quoted verbatim tokens and commas; parse expressions where
    // they can start so their references are collected, and skip everything else.
    for (;;) {
      const tok = this.peek();
      if (this.atStatementEnd(tok)) {
        break;
      }
      if (this.canStartExpr(tok)) {
        const before = this.lx.getPos();
        this.parseExpr();
        if (this.lx.getPos() === before) {
          this.next();
        }
      } else {
        this.next(); // ',', '#', quoted literals, etc.
      }
    }
  }

  // ---- expressions ----
  // Precedence per expression.c: lo/hi prefixes swallow the whole following expression;
  // ranges sit below the binary ladder; the ladder itself is in BINARY_PREC.

  private parseExprList(): void {
    for (;;) {
      if (!this.canStartExpr(this.peek())) {
        break;
      }
      const before = this.lx.getPos();
      this.parseExpr();
      if (this.lx.getPos() === before) {
        break;
      }
      if (this.isPunct(this.peek(), ',')) {
        this.next();
        continue;
      }
      break;
    }
  }

  private canStartExpr(tok: Token): boolean {
    if (tok.kind === TokKind.Number || tok.kind === TokKind.String) {
      return true;
    }
    if (tok.kind === TokKind.Ident) {
      return !CLOSERS.has(tok.lower);
    }
    if (tok.kind === TokKind.Punct) {
      return ['(', '{', '-', '+', '<', '>', '*', '@+', '@-', '..', '..<'].includes(tok.lower);
    }
    return false;
  }

  /** Parse one expression; returns null (consuming nothing) if none can start here. */
  parseExpr(): Expr | null {
    const tok = this.peek();
    if (this.isPunct(tok, '<') || this.isPunct(tok, '>')) {
      this.next();
      const e = this.parseExpr();
      return e ? { t: 'un', op: tok.lower, e } : { t: 'opaque' };
    }
    return this.parseRange();
  }

  private parseRange(): Expr | null {
    let first: Expr | null = null;
    if (!this.isPunct(this.peek(), '..') && !this.isPunct(this.peek(), '..<')) {
      first = this.parseBinary(0);
      if (first === null) {
        return null;
      }
    }
    let isRange = false;
    while (this.isPunct(this.peek(), '..') || this.isPunct(this.peek(), '..<')) {
      isRange = true;
      this.next();
      if (this.canStartExpr(this.peek()) && !this.isPunct(this.peek(), '..') && !this.isPunct(this.peek(), '..<')) {
        this.parseBinary(0);
      }
    }
    return isRange ? { t: 'opaque' } : first;
  }

  private parseBinary(minPrec: number): Expr | null {
    let left = this.parseUnary();
    if (left === null) {
      return null;
    }
    for (;;) {
      const tok = this.peek();
      let op: string | undefined;
      if (tok.kind === TokKind.Punct && BINARY_PREC[tok.lower] !== undefined) {
        op = tok.lower;
      } else if (tok.kind === TokKind.Ident && WORD_OPERATORS.has(tok.lower)) {
        op = tok.lower;
      }
      if (op === undefined) {
        return left;
      }
      const prec = BINARY_PREC[op];
      if (prec < minPrec) {
        return left;
      }
      this.next();
      const right = this.parseBinary(RIGHT_ASSOC.has(op) ? prec : prec + 1);
      if (right === null) {
        return left;
      }
      left = { t: 'bin', op, l: left, r: right };
    }
  }

  private parseUnary(): Expr | null {
    const tok = this.peek();
    if (this.isPunct(tok, '-') || this.isPunct(tok, '+')) {
      this.next();
      const e = this.parseUnary();
      return e ? { t: 'un', op: tok.lower, e } : { t: 'opaque' };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr | null {
    let e = this.parsePrimary();
    if (e === null) {
      return null;
    }
    while (this.isPunct(this.peek(), '[')) {
      this.next();
      this.parseSelectorList();
      if (this.isPunct(this.peek(), ']')) {
        this.next();
      }
      e = { t: 'opaque' };
    }
    return e;
  }

  private parseSelectorList(): void {
    for (;;) {
      if (this.canStartExpr(this.peek())) {
        this.parseExpr();
      }
      if (this.isPunct(this.peek(), ',')) {
        this.next();
        continue;
      }
      break;
    }
  }

  private parsePrimary(): Expr | null {
    const tok = this.peek();
    switch (tok.kind) {
      case TokKind.Number:
        this.next();
        return { t: 'num', v: tok.num ?? 0 };
      case TokKind.String:
        this.next();
        return { t: 'str', v: tok.str ?? '' };
      case TokKind.Ident: {
        if (CLOSERS.has(tok.lower) || WORD_OPERATORS.has(tok.lower)) {
          return null;
        }
        this.next();
        if (tok.lower === 'p%') {
          return { t: 'opaque' }; // the current pc
        }
        if (BUILTIN_FUNCTIONS.has(tok.lower) && this.isPunct(this.peek(), '(')) {
          this.parseCallArgs();
          return { t: 'opaque' };
        }
        const ref = this.recordIdentRef(tok, 'value');
        if (this.isPunct(this.peek(), '(')) {
          this.parseCallArgs(); // a user FUNCTION call
          return { t: 'opaque' };
        }
        return { t: 'ident', parts: ref.parts.map((p) => p.name), scope: this.scope };
      }
      case TokKind.Punct:
        switch (tok.lower) {
          case '(': {
            this.next();
            const e = this.parseExpr();
            if (this.isPunct(this.peek(), ')')) {
              this.next();
            }
            return e ?? { t: 'opaque' };
          }
          case '{': {
            // List literal: newline-only terminators are whitespace inside the braces.
            this.next();
            for (;;) {
              this.skipSoftNewlines();
              if (this.isPunct(this.peek(), '}')) {
                this.next();
                break;
              }
              if (!this.canStartExpr(this.peek())) {
                break; // unclosed / hard-terminated list: stop tolerantly
              }
              this.parseExpr();
              this.skipSoftNewlines();
              if (this.isPunct(this.peek(), ',')) {
                this.next();
                continue;
              }
              if (this.isPunct(this.peek(), '}')) {
                this.next();
                break;
              }
              break;
            }
            return { t: 'opaque' };
          }
          case '*':
            this.next();
            return { t: 'opaque' }; // the current pc
          case '@+':
          case '@-':
            this.next();
            this.index.localRefs.push({
              loc: this.loc(tok),
              dir: tok.lower === '@+' ? 1 : -1,
              scope: this.scope,
            });
            return { t: 'opaque' };
          default:
            return null;
        }
      default:
        return null;
    }
  }

  private skipSoftNewlines(): void {
    while (this.peek().kind === TokKind.Terminator && this.peek().newlineOnly) {
      this.next();
    }
  }

  private parseCallArgs(): void {
    if (!this.isPunct(this.peek(), '(')) {
      return;
    }
    this.next();
    for (;;) {
      if (this.isPunct(this.peek(), ')')) {
        this.next();
        break;
      }
      if (!this.canStartExpr(this.peek())) {
        break;
      }
      this.parseExpr();
      if (this.isPunct(this.peek(), ',')) {
        this.next();
        continue;
      }
      if (this.isPunct(this.peek(), ')')) {
        this.next();
      }
      break;
    }
  }

  // ---- references ----

  private recordIdentRef(tok: Token, kind: Reference['kind']): Reference {
    const parts: Reference['parts'] = [];
    let offset = tok.start;
    for (const name of tok.text.split('.')) {
      parts.push({
        name,
        loc: { file: this.index.file, start: offset, end: offset + name.length },
      });
      offset += name.length + 1;
    }
    const ref: Reference = { parts, scope: this.scope, kind };
    this.index.refs.push(ref);
    return ref;
  }
}

/** Constant-evaluate a section attribute expression as evalConst does, imported lazily
 *  to avoid a circular import at module load. */
import { evalConst } from './model';
function evalCmos(expr: Expr | null): number | undefined {
  return evalConst(expr ?? undefined);
}
