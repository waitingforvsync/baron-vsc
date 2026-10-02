// Core parser tests, run with `node --test` on the esbuild bundle (no vscode dependency).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineSwitches, shellQuote } from '../src/core/defines';
import { Lexer, TokKind } from '../src/core/lexer';
import { evalConst, FileProvider, scopeAt, Unit } from '../src/core/model';
import { parseUnit } from '../src/core/parser';
import { resolveLocal, resolveRef } from '../src/core/resolve';

function provider(files: Record<string, string>): FileProvider {
  return {
    getText: (file) => files[file],
    resolvePath: (from, rel) => {
      const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
      return dir + rel.replace(/\\/g, '/');
    },
  };
}

function parse(src: string): Unit {
  return parseUnit('main.6502', provider({ 'main.6502': src }));
}

// ---- lexer ----

test('lexer: dotted identifiers, ranges and numbers', () => {
  const lx = new Lexer('wipe.nonzero 1..2 &FF %1010 1.5 a..<b p% @+ @-');
  const kinds: Array<[TokKind, string]> = [];
  for (;;) {
    const t = lx.next();
    if (t.kind === TokKind.Eof) {
      break;
    }
    kinds.push([t.kind, t.text]);
  }
  assert.deepEqual(kinds, [
    [TokKind.Ident, 'wipe.nonzero'],
    [TokKind.Number, '1'],
    [TokKind.Punct, '..'],
    [TokKind.Number, '2'],
    [TokKind.Number, '&FF'],
    [TokKind.Number, '%1010'],
    [TokKind.Number, '1.5'],
    [TokKind.Ident, 'a'],
    [TokKind.Punct, '..<'],
    [TokKind.Ident, 'b'],
    [TokKind.Ident, 'p%'],
    [TokKind.Punct, '@+'],
    [TokKind.Punct, '@-'],
  ]);
});

test('lexer: comments, terminators and strings', () => {
  const lx = new Lexer('lda #1 ; comment\n\\ another\n: :\nsta "he""llo"');
  assert.equal(lx.next().text, 'lda');
  assert.equal(lx.next().text, '#');
  assert.equal(lx.next().num, 1);
  const term = lx.next();
  assert.equal(term.kind, TokKind.Terminator);
  assert.equal(term.newlineOnly, false); // the run contains ':'
  assert.equal(lx.next().text, 'sta');
  assert.equal(lx.next().str, 'he"llo');
});

// ---- definitions and scopes ----

const SCOPED = `
screen = &4000
.reset
{
    .loop
    DEX
    BNE loop
    RTS
}
JSR reset.loop
LDA screen
`;

test('labels, named scopes, dotted paths', () => {
  const unit = parse(SCOPED);
  const index = unit.files.get('main.6502')!;

  // `loop` resolves inside the scope; `reset.loop` resolves from outside.
  const dotted = index.refs.find((r) => r.parts.length === 2 && r.parts[0].name === 'reset');
  assert.ok(dotted);
  const resolved = resolveRef(unit, dotted, 1);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, 'loop');

  // The bare `loop` reference inside the scope resolves to the same label.
  const bare = index.refs.find((r) => r.parts.length === 1 && r.parts[0].name === 'loop');
  assert.ok(bare);
  assert.equal(resolveRef(unit, bare, 0)[0], resolved[0]);

  // `screen` resolves to the symbol, and its value evaluates.
  const screenRef = index.refs.filter((r) => r.parts[0].name === 'screen').pop();
  assert.ok(screenRef);
  const screenDef = resolveRef(unit, screenRef, 0)[0];
  assert.equal(screenDef.kind, 'symbol');
  assert.equal(evalConst(screenDef.valueExpr), 0x4000);
});

test('anonymous scopes are private', () => {
  const unit = parse('{\nsecret = 1\n}\nEQUB secret\n');
  const index = unit.files.get('main.6502')!;
  const ref = index.refs.find((r) => r.parts[0].name === 'secret');
  assert.ok(ref);
  assert.equal(resolveRef(unit, ref, 0).length, 0); // not reachable from outside
});

test('label names scope across a blank line (one coalesced terminator)', () => {
  const unit = parse('.wipe\n\n; comment\n{\n.nonzero\nRTS\n}\nJSR wipe.nonzero\n');
  const index = unit.files.get('main.6502')!;
  const dotted = index.refs.find((r) => r.parts.length === 2);
  assert.ok(dotted);
  assert.equal(resolveRef(unit, dotted, 1)[0].name, 'nonzero');
});

// ---- local labels ----

test('local labels resolve nearest in scope', () => {
  const src = 'LDA &70 : BPL @+\nINC speed\n.@\nLDX #0\n.@\nBNE @-\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  assert.equal(index.localRefs.length, 2);

  const fwd = index.localRefs[0];
  const back = index.localRefs[1];
  const fwdDef = resolveLocal(index, fwd)!;
  const backDef = resolveLocal(index, back)!;
  assert.ok(fwdDef.loc.start > fwd.loc.start);
  assert.equal(fwdDef, index.defs.filter((d) => d.kind === 'locallabel')[0]);
  assert.equal(backDef, index.defs.filter((d) => d.kind === 'locallabel')[1]);
});

// ---- includes ----

test('includes splice into the current scope', () => {
  const unit = parseUnit('main.6502', provider({
    'main.6502': 'INCLUDE "sub/inc.6502"\nJSR helper\n',
    'sub/inc.6502': '.helper\nRTS\n',
  }));
  assert.ok(unit.files.has('sub/inc.6502'));
  const index = unit.files.get('main.6502')!;
  const ref = index.refs.find((r) => r.parts[0].name === 'helper');
  assert.ok(ref);
  const def = resolveRef(unit, ref, 0)[0];
  assert.equal(def.loc.file, 'sub/inc.6502');
});

test('include cycles do not hang', () => {
  const unit = parseUnit('a.6502', provider({
    'a.6502': 'INCLUDE "b.6502"\n',
    'b.6502': 'INCLUDE "a.6502"\n.end\n',
  }));
  assert.ok(unit.files.has('b.6502'));
});

// ---- macros and functions ----

test('macros: definition, params, overloads, invocation reference', () => {
  const src = 'MACRO ADD n : CLC : ADC n : ENDMACRO\nMACRO ADD "#" n : CLC : ADC #n : ENDMACRO\nADD &70\n';
  const unit = parse(src);
  assert.equal(unit.macros.get('add')?.length, 2);
  const index = unit.files.get('main.6502')!;
  const call = index.refs.find((r) => r.kind === 'macrocall');
  assert.ok(call);
  // `ADD &70` has no '#', so only the plain overload fits - and that is where it resolves.
  const target = resolveRef(unit, call, 0);
  assert.equal(target.length, 1);
  assert.equal(target[0].detail, 'n');
  // The param `n` is visible inside the body.
  const nRef = index.refs.find((r) => r.parts[0].name === 'n');
  assert.ok(nRef);
  assert.equal(resolveRef(unit, nRef, 0)[0].kind, 'param');
});

test('functions: one-liner and multi-line bodies', () => {
  const src = [
    'FUNCTION sqr(x) = x*x',
    'FUNCTION ball(n)',
    '    y = n * 2',
    '    IF y > 10',
    '        y2 = y',
    '    ENDIF',
    '= 128 + y',
    'EQUB sqr(0..15)',
    '.after',
    '',
  ].join('\n');
  const unit = parse(src);
  assert.equal(unit.functions.get('sqr')?.length, 1);
  assert.equal(unit.functions.get('ball')?.length, 1);
  const index = unit.files.get('main.6502')!;

  // `x` inside sqr's return resolves to the parameter.
  const xRef = index.refs.find((r) => r.parts[0].name === 'x');
  assert.ok(xRef);
  assert.equal(resolveRef(unit, xRef, 0)[0].kind, 'param');

  // The body local `y` resolves to the assignment in the function scope, and the
  // function scope closed before `.after` (the label is in the global scope).
  const after = index.defs.find((d) => d.name === 'after')!;
  assert.equal(after.scope, unit.globalScope);
  // The call reference to sqr resolves to the function.
  const sqrCall = index.refs.filter((r) => r.parts[0].name === 'sqr').pop()!;
  assert.equal(resolveRef(unit, sqrCall, 0)[0].kind, 'function');
});

// ---- for loops ----

test('for variables are scoped to the body', () => {
  const src = 'FOR i = 0..9\nEQUB i\nNEXT\nEQUB i\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const refs = index.refs.filter((r) => r.parts[0].name === 'i');
  assert.equal(refs.length, 2);
  assert.equal(resolveRef(unit, refs[0], 0).length, 1); // inside: resolves
  assert.equal(resolveRef(unit, refs[1], 0).length, 0); // outside: does not
});

// ---- sections and cmos ----

test('sections: definition and cmos-aware mnemonics', () => {
  const src = [
    'SECTION Code, org = &1100, cmos = TRUE',
    'PHX',
    'LDA (&70)',
    'BIT #1',
    'BIT &70,X',
    'SECTION Inner, cmos = FALSE',
    'STZ &70',
    'ENDSECTION',
    'JMP (tbl,X)',
    'ENDSECTION',
    'BRA out',
    '',
  ].join('\n');
  const unit = parse(src);
  assert.ok(unit.sections.has('code'));
  assert.ok(unit.sections.has('inner'));

  const index = unit.files.get('main.6502')!;
  const byName = (mn: string) => index.mnemonics.filter((m) => m.mnemonic === mn);

  assert.deepEqual(byName('phx').map((m) => [m.cmosOnly, m.cmosContext]), [[true, true]]);
  assert.deepEqual(byName('lda').map((m) => [m.cmosOnly, m.cmosContext]), [[true, true]]);
  assert.deepEqual(byName('bit').map((m) => [m.cmosOnly, m.cmosContext]), [[true, true], [true, true]]);
  // Inner section opts back out: STZ flagged as needing cmos in an NMOS context.
  assert.deepEqual(byName('stz').map((m) => [m.cmosOnly, m.cmosContext]), [[true, false]]);
  // Back in the outer section: cmos again.
  assert.deepEqual(byName('jmp').map((m) => [m.cmosOnly, m.cmosContext]), [[true, true]]);
  // Outside all sections: NMOS.
  assert.deepEqual(byName('bra').map((m) => [m.cmosOnly, m.cmosContext]), [[true, false]]);
});

test('sections: attributes are not inherited by nested sections', () => {
  // baron 0.3.0: a nested section without its own cmos attribute targets plain NMOS,
  // whatever the enclosing section had; the parent's setting returns at ENDSECTION.
  const src = [
    'SECTION Outer, cmos = TRUE',
    'PHX',
    'SECTION Inner',
    'STZ &70',
    'ENDSECTION',
    'PLX',
    'ENDSECTION',
    '',
  ].join('\n');
  const index = parse(src).files.get('main.6502')!;
  const byName = (mn: string) => index.mnemonics.filter((m) => m.mnemonic === mn);
  assert.deepEqual(byName('phx').map((m) => m.cmosContext), [true]);
  assert.deepEqual(byName('stz').map((m) => m.cmosContext), [false]);
  assert.deepEqual(byName('plx').map((m) => m.cmosContext), [true]);
});

test('nmos indirect modes are not flagged', () => {
  const src = 'LDA (&70),Y\nLDA (&70,X)\nJMP (&2000)\nASL A\nINC &70\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  for (const m of index.mnemonics) {
    assert.equal(m.cmosOnly, false, m.mnemonic);
  }
});

test('inc a / dec a are cmos', () => {
  const unit = parse('INC A\nDEC a\n');
  const index = unit.files.get('main.6502')!;
  assert.deepEqual(index.mnemonics.map((m) => m.cmosOnly), [true, true]);
});

// ---- expressions ----

test('multi-line lists, ranges and subscripts keep references', () => {
  const src = [
    'table = {',
    '    1, 2, base + 3,',
    '    {4, 5}, other[2..4],',
    '}',
    'base = &100',
    'other = {9, 8, 7, 6, 5}',
    'EQUB table[0], (100..200)[idx], "hello"[1..3]',
    'idx = 10',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const names = index.refs.map((r) => r.parts[0].name);
  assert.ok(names.includes('base'));
  assert.ok(names.includes('other'));
  assert.ok(names.includes('table'));
  assert.ok(names.includes('idx'));
  // All resolve (forward references included).
  for (const name of ['base', 'other', 'table', 'idx']) {
    const ref = index.refs.find((r) => r.parts[0].name === name)!;
    assert.equal(resolveRef(unit, ref, 0).length, 1, name);
  }
  // The defs after the list are in the global scope (the list did not derail parsing).
  assert.ok(unit.globalScope.lookupLocal('base'));
});

test('lo/hi prefix operators swallow the following expression', () => {
  const unit = parse('LDX #LO(oscli)\nLDA #<start+1\nLDY #>start\n.oscli\n.start\n');
  const index = unit.files.get('main.6502')!;
  for (const name of ['oscli', 'start']) {
    const ref = index.refs.find((r) => r.parts[0].name === name)!;
    assert.equal(resolveRef(unit, ref, 0).length, 1, name);
  }
});

test('evalConst follows symbols and operators', () => {
  const unit = parse('a = 4\nb = a * 3 + 1\nc = b << 2\n');
  const b = unit.globalScope.lookupLocal('b')![0];
  const c = unit.globalScope.lookupLocal('c')![0];
  assert.equal(evalConst(b.valueExpr), 13);
  assert.equal(evalConst(c.valueExpr), 52);
});

// ---- char literals ----

test('char literals lex as numbers and evaluate', () => {
  const unit = parse("x = 'A' + 1\nEQUB 'z', ':', ';'\n");
  const x = unit.globalScope.lookupLocal('x')![0];
  assert.equal(evalConst(x.valueExpr), 66);
  // The ':' and ';' inside char literals did not terminate or comment the statement.
  const index = unit.files.get('main.6502')!;
  assert.equal(index.defs.filter((d) => d.name === 'x').length, 1);
});

// ---- error recovery ----

test('an error inside a multi-line list never leaks its tail as statements', () => {
  const src = [
    '.outer',
    '{',
    'table = {',
    '    1, 2, ?? 3,',           // syntax error mid-list
    '    {4, 5}, 6,',
    '}',
    '.inner',
    '}',
    '.after',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  // The list's lines were not misread as statements, its '}' did not close the scope:
  // inner is still inside outer's scope, after is back at global scope.
  const inner = index.defs.find((d) => d.name === 'inner')!;
  const outer = index.defs.find((d) => d.name === 'outer')!;
  assert.equal(inner.scope, outer.namedScope);
  const after = index.defs.find((d) => d.name === 'after')!;
  assert.equal(after.scope, unit.globalScope);
});

test('a hard terminator inside a broken list stops recovery at the separator', () => {
  const src = 'bad = { 1, ?? : LDA #1\n.next\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  // The statement after the ':' still parses, and the label lands in global scope.
  assert.deepEqual(index.mnemonics.map((m) => m.mnemonic), ['lda']);
  assert.equal(index.defs.find((d) => d.name === 'next')!.scope, unit.globalScope);
});

test('junk after a statement ends at a brace, which opens a real scope', () => {
  // baron's brace-as-separator: a '{' met at a statement boundary (during error
  // recovery included) ends the statement and opens a scope - `EQUB 1 {2, 3}` is a
  // malformed EQUB, then a scope holding `2, 3`.
  const src = 'EQUB 1 ?? {2, 3}\n.after\nsym = 4\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  assert.equal(unit.globalScope.children.length, 1); // the brace opened (and '}' closed) a scope
  assert.equal(index.defs.find((d) => d.name === 'after')!.scope, unit.globalScope);
  assert.equal(evalConst(unit.globalScope.lookupLocal('sym')![0].valueExpr), 4);
});

test('recovery keeps later definitions and references intact', () => {
  const src = 'LDA # # nonsense\nvalid = 42\nSTA valid\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const ref = index.refs.find((r) => r.parts[0].name === 'valid')!;
  assert.equal(evalConst(resolveRef(unit, ref, 0)[0].valueExpr), 42);
});

// ---- BASIC blocks ----

test('basic blocks are opaque', () => {
  const src = [
    'SECTION Loader, filename="LOADER"',
    'BASIC',
    '  10Y%=PAGE DIV256',
    '  20CALLTOP',
    'ENDBASIC',
    'LDX #LO(oscli):JMP &FFF7',
    '.oscli',
    'ENDSECTION',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  assert.equal(index.basicRanges.length, 1);
  // Nothing inside the BASIC block was parsed as assembler...
  assert.ok(!index.refs.some((r) => r.parts[0].name === 'PAGE' || r.parts[0].name === 'CALLTOP'));
  // ...and parsing resumed cleanly after ENDBASIC.
  const ref = index.refs.find((r) => r.parts[0].name === 'oscli');
  assert.ok(ref);
  assert.equal(resolveRef(unit, ref, 0).length, 1);
  assert.deepEqual(index.mnemonics.map((m) => m.mnemonic), ['ldx', 'jmp']);
});

// ---- za_auto ----

test('za_auto names bind in the current scope', () => {
  const src = 'ZA_POOL &00..&FC\nZA_AUTO2 ptr, other\n.start\n{\nZA_AUTO1 xpos\nLDA xpos\n}\nSTA ptr\nLDA xpos\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const inner = index.refs.find((r) => r.parts[0].name === 'xpos')!;
  assert.equal(resolveRef(unit, inner, 0)[0].kind, 'zpvar');
  const outer = index.refs.filter((r) => r.parts[0].name === 'xpos').pop()!;
  assert.equal(resolveRef(unit, outer, 0).length, 0); // scoped: invisible outside
  const ptr = index.refs.find((r) => r.parts[0].name === 'ptr')!;
  assert.equal(resolveRef(unit, ptr, 0)[0].detail, '2 bytes');
});

// ---- scope events ----

test('scopeAt tracks braces and for bodies', () => {
  const src = '.outer\n{\ninner = 1\n}\ntail = 2\n';
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const innerOffset = src.indexOf('inner');
  const tailOffset = src.indexOf('tail');
  assert.notEqual(scopeAt(index, innerOffset), unit.globalScope);
  assert.equal(scopeAt(index, tailOffset), unit.globalScope);
});

// ---- the real starglobe sources, as a smoke test ----

test('starglobe demo parses without derailing', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = 'test/fixtures/demo.6502';
  if (!fs.existsSync(path)) {
    return; // fixture not present: skip quietly
  }
  const text = fs.readFileSync(path, 'utf8');
  const unit = parseUnit('demo.6502', provider({ 'demo.6502': text }));
  const index = unit.files.get('demo.6502')!;
  assert.ok(index.defs.length > 50);
  assert.ok(unit.sections.size >= 1);
  // Every recorded mnemonic should be flagged NMOS-legal (the demo targets a stock Beeb).
  assert.ok(index.mnemonics.every((m) => !m.cmosOnly));
});

// ---- 0.4.0: new keywords and brace-as-separator ----

test('za_wipe and za_indexedby parse as directives', () => {
  const src = [
    'ZA_POOL &70..&7F',
    'ZA_AUTO 4, table',
    'LDA table,X',
    'ZA_INDEXEDBY 0..3',
    'ZA_WIPE',
    '.after RTS',
    '',
  ].join('\n');
  const index = parse(src).files.get('main.6502')!;
  // Both keywords consume cleanly and parsing carries on past them.
  assert.ok(index.defs.some((d) => d.name === 'after' && d.kind === 'label'));
  assert.ok(index.defs.some((d) => d.name === 'table' && d.kind === 'zpvar'));
  assert.ok(index.mnemonics.some((m) => m.mnemonic === 'rts'));
});

test('verbatim assignment binds keyword-spelled names', () => {
  const index = parse('@next = 5\n@foo = 2\nLDA #next\n').files.get('main.6502')!;
  const next = index.defs.find((d) => d.name === 'next');
  assert.ok(next);
  assert.equal(next.kind, 'symbol');
  const foo = index.defs.find((d) => d.name === 'foo');
  assert.ok(foo);
  assert.equal(foo.kind, 'symbol');
});

test('a brace ends the statement before it', () => {
  const src = [
    'LDX #8 {',
    '.here RTS',
    '}',
    'DEX {',
    '.two RTS',
    '}',
    'ASL A { .three RTS }',
    'mymacro 7 { .four RTS }',
    '',
  ].join('\n');
  const index = parse(src).files.get('main.6502')!;
  for (const name of ['here', 'two', 'three', 'four']) {
    assert.ok(index.defs.some((d) => d.name === name && d.kind === 'label'), name);
  }
  // The braces opened real scopes, and the instructions before them still recorded.
  assert.ok(index.mnemonics.some((m) => m.mnemonic === 'dex'));
  assert.ok(index.mnemonics.some((m) => m.mnemonic === 'asl'));
});

// ---- 0.4.2: ASSERT, macro / function call matching ----

function calls(unit: Unit) {
  return unit.files.get('main.6502')!.refs.filter((r) => r.kind === 'macrocall' || r.kind === 'funccall');
}

test('ASSERT parses as a statement and as a function body statement', () => {
  const src = [
    'size = 3',
    'ASSERT size < 10, "size is ", size',
    'ASSERT * <= &3000',
    'FUNCTION checked(w)',
    '    ASSERT w >= 0, "bad width: ", w',
    '= w * 2',
    'EQUB checked(4)',
    '.after',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  // Not mistaken for a macro call, and its condition / message references are collected.
  assert.ok(!index.refs.some((r) => r.parts[0].name.toLowerCase() === 'assert'));
  assert.equal(index.refs.filter((r) => r.parts[0].name === 'size').length, 2);
  // The body's ASSERT sees the parameter, and the function still closes at its return.
  const w = index.refs.find((r) => r.parts[0].name === 'w')!;
  assert.equal(resolveRef(unit, w, 0)[0].kind, 'param');
  assert.equal(index.defs.find((d) => d.name === 'after')!.scope, unit.globalScope);
  assert.equal(calls(unit)[0].matched?.name, 'checked');
});

test('macro calls resolve to the macro, never a same-named label', () => {
  const src = [
    'MACRO OUT n',
    '    STA &70 + n',
    'ENDMACRO',
    '.routine',
    '{',
    '    BMI out',
    '.out',
    '    OUT 0',
    '}',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const call = index.refs.find((r) => r.kind === 'macrocall')!;
  assert.equal(call.parts[0].name, 'OUT');
  assert.deepEqual(resolveRef(unit, call, 0).map((d) => d.kind), ['macro']);
  // ...and the branch target is the label, not the macro.
  const branch = index.refs.find((r) => r.kind === 'value' && r.parts[0].name === 'out')!;
  assert.deepEqual(resolveRef(unit, branch, 0).map((d) => d.kind), ['label']);
});

test('macro overloads match by shape, literals first', () => {
  const src = [
    'MACRO LD n : LDA n : ENDMACRO',
    'MACRO LD "#" n : LDA #n : ENDMACRO',
    'MACRO LD n, "X" : LDA n,X : ENDMACRO',
    'LD #5',
    'LD &70',
    'LD &70, x',
    'LD &70, xy',
    '',
  ].join('\n');
  const [imm, zp, indexed, bad] = calls(parse(src));
  assert.equal(imm.matched?.detail, '"#" n');
  assert.equal(zp.matched?.detail, 'n');
  assert.equal(indexed.matched?.detail, 'n, "X"');
  // `xy` is an identifier longer than the X literal, so nothing fits.
  assert.equal(bad.matched, undefined);
});

test('a list literal is a macro argument; a brace after the last slot opens a scope', () => {
  const src = [
    'black = 0 : red = 1',
    'MACRO palette cols',
    '    EQUB cols',
    'ENDMACRO',
    'palette {black, red}',
    'MACRO mymacro n : EQUB n : ENDMACRO',
    'mymacro 7 { .four RTS }',
    '.after',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const [palette, mymacro] = calls(unit);
  assert.equal(palette.matched?.name, 'palette');
  assert.equal(mymacro.matched?.name, 'mymacro');
  // The list's names are value references, not misread as statements.
  assert.equal(resolveRef(unit, index.refs.find((r) => r.parts[0].name === 'black')!, 0)[0].kind, 'symbol');
  // The brace after `mymacro 7` opened a real scope, closed again by `.after`.
  const four = index.defs.find((d) => d.name === 'four')!;
  assert.notEqual(four.scope, unit.globalScope);
  assert.equal(index.defs.find((d) => d.name === 'after')!.scope, unit.globalScope);
});

test('calls before the definition do not match, but still navigate', () => {
  const src = [
    'early 1',
    'EQUB twice(1)',
    'MACRO early n : EQUB n : ENDMACRO',
    'FUNCTION twice(x) = x * 2',
    'early 1',
    'EQUB twice(1)',
    '',
  ].join('\n');
  const unit = parse(src);
  const [m1, f1, m2, f2] = calls(unit);
  assert.equal(m1.matched, undefined);
  assert.equal(f1.matched, undefined);
  assert.equal(resolveRef(unit, m1, 0)[0].kind, 'macro');
  assert.equal(resolveRef(unit, f1, 0)[0].kind, 'function');
  assert.ok(m2.matched);
  assert.ok(f2.matched);
});

test('function calls: own namespace, arity overloads, paren hard against the name', () => {
  const src = [
    'FUNCTION f(x) = x',
    'FUNCTION f(x, y) = x + y',
    'f = 7',
    'EQUB f(1), f(1, 2), f(1, 2, 3), f()',
    'EQUB f',
    'EQUB f (1)',
    '',
  ].join('\n');
  const unit = parse(src);
  const index = unit.files.get('main.6502')!;
  const [one, two, three, none] = calls(unit);
  assert.equal(one.matched?.detail, '(x)');
  assert.equal(two.matched?.detail, '(x, y)');
  assert.equal(three.matched, undefined);
  assert.equal(none.matched, undefined);
  assert.equal(resolveRef(unit, three, 0).length, 2); // no fit: every overload
  // A bare `f`, or `f` with a space before the paren, is the symbol.
  const values = index.refs.filter((r) => r.kind === 'value' && r.parts[0].name === 'f');
  assert.equal(values.length, 2);
  for (const v of values) {
    assert.deepEqual(resolveRef(unit, v, 0).map((d) => d.kind), ['symbol']);
  }
});

test('a self-call inside a macro body matches', () => {
  const src = [
    'MACRO countdown n',
    '    IF n > 0',
    '        countdown n - 1',
    '    ENDIF',
    'ENDMACRO',
    'countdown 3',
    '',
  ].join('\n');
  const [inner, outer] = calls(parse(src));
  assert.equal(inner.matched?.name, 'countdown');
  assert.equal(outer.matched?.name, 'countdown');
});

// ---- 0.4.3: default -D defines ----

test('defines become -D switches; bare names are TRUE', () => {
  assert.deepEqual(defineSwitches(['MAP=7', 'DEBUG', ' TITLE = "A B" ', ''], []),
    ['-D', 'MAP=7', '-D', 'DEBUG=TRUE', '-D', 'TITLE = "A B"']);
});

test('defines are defaults: explicit -D switches and earlier entries win', () => {
  const base = ['-v', '-D', 'MAP=9', '-o', 'x.ssd'];
  // MAP is left to the switches; names are case-sensitive, so `map` still passes; the
  // second DEBUG entry is dropped rather than handing baron a duplicate.
  assert.deepEqual(defineSwitches(['MAP=7', 'map=1', 'DEBUG=1', 'DEBUG=2'], base),
    ['-D', 'map=1', '-D', 'DEBUG=1']);
});

test('shell quoting for ${defines} in buildOverride', () => {
  assert.equal(shellQuote('MAP=7', 'linux'), 'MAP=7');
  assert.equal(shellQuote('TITLE="it\'s"', 'linux'), `'TITLE="it'\\''s"'`);
  assert.equal(shellQuote('TITLE="A B"', 'win32'), '"TITLE=\\"A B\\""');
});
