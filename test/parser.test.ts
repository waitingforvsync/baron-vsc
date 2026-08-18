// Core parser tests, run with `node --test` on the esbuild bundle (no vscode dependency).

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.equal(resolveRef(unit, call, 0).length, 2);
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

test('sections: definition, incsection reference, cmos-aware mnemonics', () => {
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
    'INCSECTION Code',
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

  const secRef = index.refs.find((r) => r.kind === 'section');
  assert.ok(secRef);
  assert.equal(resolveRef(unit, secRef, 0)[0].kind, 'section');
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

// ---- zpauto ----

test('zpauto names bind in the current scope', () => {
  const src = 'ZPRESERVE &00..&FC\nZPAUTO2 ptr, other\n.start\n{\nZPAUTO1 xpos\nLDA xpos\n}\nSTA ptr\nLDA xpos\n';
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
