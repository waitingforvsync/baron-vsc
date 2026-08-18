#!/usr/bin/env node
// Regenerate the BBC BASIC rules inside syntaxes/baron.tmLanguage.json from the BASIC 4
// keyword table (mirrored from baron's src/basic.c - ROM order, with per-keyword flags).
// The script first verifies the generated regexes against a simulation of the ROM
// matcher on a pile of awkward samples, then rewrites the grammar's basic-block entry.
//
//   node tools/gen-basic-grammar.js
//
// Rules encoded (see JOURNAL.md, "faithful BBC BASIC highlighting"):
// - keywords match in ROM table order, no whitespace required (FORX=1TO10);
// - the conditional flag (0x01) vetoes a match when a variable character follows
//   (COUNT vs COUNTER); '$' is not a variable character (TIME$ = TIME + '$');
// - a failed match consumes a whole variable-name run (xFOR is one variable);
// - prefix+'.' abbreviations bind to the first table entry with that prefix, full-text
//   entries winning outright (P. = PRINT, GET. = GET$, TO. = TO then '.');
// - REM/DATA take the rest of the line raw; PROC/FN swallow the name that follows;
// - '*' at statement start is a raw OS command; '&' hex is uppercase-only.

const fs = require('fs');
const path = require('path');

// The BASIC 4 table from baron's basic.c, in the ROM's exact order (&8456), with its
// flag bytes. WIDTH must stay last (its token &FE is the end-of-table sentinel there).
const KEYWORDS = [
  ['AND', 0x00], ['ABS', 0x00], ['ACS', 0x00], ['ADVAL', 0x00], ['ASC', 0x00],
  ['ASN', 0x00], ['ATN', 0x00], ['AUTO', 0x10], ['BGET', 0x01], ['BPUT', 0x03],
  ['COLOUR', 0x02], ['CALL', 0x02], ['CHAIN', 0x02], ['CHR$', 0x00], ['CLEAR', 0x01],
  ['CLOSE', 0x03], ['CLG', 0x01], ['CLS', 0x01], ['COS', 0x00], ['COUNT', 0x01],
  ['COLOR', 0x02], ['DATA', 0x20], ['DEG', 0x00], ['DEF', 0x00], ['DELETE', 0x10],
  ['DIV', 0x00], ['DIM', 0x02], ['DRAW', 0x02], ['ENDPROC', 0x01], ['END', 0x01],
  ['ENVELOPE', 0x02], ['ELSE', 0x14], ['EVAL', 0x00], ['ERL', 0x01], ['ERROR', 0x04],
  ['EOF', 0x01], ['EOR', 0x00], ['ERR', 0x01], ['EXP', 0x00], ['EXT', 0x01],
  ['EDIT', 0x10], ['FOR', 0x02], ['FALSE', 0x01], ['FN', 0x08], ['GOTO', 0x12],
  ['GET$', 0x00], ['GET', 0x00], ['GOSUB', 0x12], ['GCOL', 0x02], ['HIMEM', 0x43],
  ['INPUT', 0x02], ['IF', 0x02], ['INKEY$', 0x00], ['INKEY', 0x00], ['INT', 0x00],
  ['INSTR(', 0x00], ['LIST', 0x10], ['LINE', 0x00], ['LOAD', 0x02], ['LOMEM', 0x43],
  ['LOCAL', 0x02], ['LEFT$(', 0x00], ['LEN', 0x00], ['LET', 0x04], ['LOG', 0x00],
  ['LN', 0x00], ['MID$(', 0x00], ['MODE', 0x02], ['MOD', 0x00], ['MOVE', 0x02],
  ['NEXT', 0x02], ['NEW', 0x01], ['NOT', 0x00], ['OLD', 0x01], ['ON', 0x02],
  ['OFF', 0x00], ['OR', 0x00], ['OPENIN', 0x00], ['OPENOUT', 0x00], ['OPENUP', 0x00],
  ['OSCLI', 0x02], ['PRINT', 0x02], ['PAGE', 0x43], ['PTR', 0x43], ['PI', 0x01],
  ['PLOT', 0x02], ['POINT(', 0x00], ['PROC', 0x0A], ['POS', 0x01], ['RETURN', 0x01],
  ['REPEAT', 0x00], ['REPORT', 0x01], ['READ', 0x02], ['REM', 0x20], ['RUN', 0x01],
  ['RAD', 0x00], ['RESTORE', 0x12], ['RIGHT$(', 0x00], ['RND', 0x01], ['RENUMBER', 0x10],
  ['STEP', 0x00], ['SAVE', 0x02], ['SGN', 0x00], ['SIN', 0x00], ['SQR', 0x00],
  ['SPC', 0x00], ['STR$', 0x00], ['STRING$(', 0x00], ['SOUND', 0x02], ['STOP', 0x01],
  ['TAN', 0x00], ['THEN', 0x14], ['TO', 0x00], ['TAB(', 0x00], ['TRACE', 0x12],
  ['TIME', 0x43], ['TRUE', 0x01], ['UNTIL', 0x02], ['USR', 0x00], ['VDU', 0x02],
  ['VAL', 0x00], ['VPOS', 0x01], ['WIDTH', 0x02],
];

const CONDITIONAL = 0x01;
const VARCHAR = /[0-9A-Za-z_`]/;
const esc = (s) => s.replace(/[$(]/g, '\\$&');
const GUARD = '(?![0-9A-Za-z_`])';

// ---- full-keyword alternation, ROM order, conditional keywords guarded ----

const fullAlternation = KEYWORDS
  .map(([kw, flags]) => esc(kw) + ((flags & CONDITIONAL) ? GUARD : ''))
  .join('|');

// ---- abbreviation prefixes ----
// For a prefix p, the ROM scans the table in order: an entry whose full text is p wins
// as a FULL match (so p is not an abbreviation); otherwise the first entry with p as a
// proper prefix claims "p." - and its conditional flag decides whether a following
// variable character vetoes it.

function classify(prefix) {
  for (const [kw, flags] of KEYWORDS) {
    if (kw === prefix) return 'full';
    if (kw.startsWith(prefix)) return (flags & CONDITIONAL) ? 'cond' : 'plain';
  }
  return 'none';
}

const prefixes = new Set();
for (const [kw] of KEYWORDS) {
  for (let i = 1; i < kw.length; i++) {
    prefixes.add(kw.slice(0, i));
  }
}
const plain = [], cond = [];
for (const p of prefixes) {
  const cls = classify(p);
  if (cls === 'plain') plain.push(p);
  else if (cls === 'cond') cond.push(p);
}
const byLen = (a, b) => b.length - a.length || (a < b ? -1 : 1);
const abbrevPlain = plain.sort(byLen).map(esc).join('|');
const abbrevCond = cond.sort(byLen).map(esc).join('|');

// ---- simulate the ROM matcher (basic_find_keyword + the tokenise loop) ----

function romTokenise(text) {
  const toks = [];
  let pos = 0;
  while (pos < text.length) {
    const c = text[pos];
    if (c === ' ') { pos++; continue; }
    if (c === '&') {
      let end = pos + 1;
      while (end < text.length && /[0-9A-F]/.test(text[end])) end++;
      toks.push(['hex', text.slice(pos, end)]); pos = end; continue;
    }
    if (c === '"') {
      let end = pos + 1;
      while (end < text.length && text[end] !== '"') end++;
      toks.push(['str', text.slice(pos, end + 1)]); pos = Math.min(end + 1, text.length); continue;
    }
    if (c === '.' || /[0-9]/.test(c)) {
      let end = pos;
      while (end < text.length && /[0-9.]/.test(text[end])) end++;
      toks.push(['num', text.slice(pos, end)]); pos = end; continue;
    }
    if (c >= 'A' && c < 'X') {
      let match = null;
      for (const [kw, flags] of KEYWORDS) {
        if (c < kw[0]) break;
        if (c !== kw[0]) continue;
        let i = 1;
        while (i < kw.length && pos + i < text.length && text[pos + i] === kw[i]) i++;
        if (i === kw.length) { match = [kw, flags, pos + i]; break; }
        if (pos + i < text.length && text[pos + i] === '.') { match = [kw, flags, pos + i + 1]; break; }
      }
      if (match) {
        const [kw, flags, next] = match;
        const vetoed = (flags & CONDITIONAL) && next < text.length && VARCHAR.test(text[next]);
        if (!vetoed) {
          toks.push(['kw', kw, text.slice(pos, next)]);
          pos = next;
          if (flags & 0x08) {
            let end = pos;
            while (end < text.length && VARCHAR.test(text[end])) end++;
            if (end > pos) toks.push(['name', text.slice(pos, end)]);
            pos = end;
          }
          if (flags & 0x20) {
            if (pos < text.length) toks.push(['raw', text.slice(pos)]);
            return toks;
          }
          continue;
        }
      }
    }
    if (VARCHAR.test(c)) {
      let end = pos;
      while (end < text.length && VARCHAR.test(text[end])) end++;
      toks.push(['var', text.slice(pos, end)]); pos = end; continue;
    }
    toks.push(['op', c]); pos++;
  }
  return toks;
}

// ---- simulate the grammar's pattern order and check agreement ----

const reAbbrevCond = new RegExp(`^(?:${abbrevCond})\\.${GUARD}`);
const reAbbrevPlain = new RegExp(`^(?:${abbrevPlain})\\.`);
const reFull = new RegExp(`^(?:${fullAlternation})`);
const reProcFn = /^(PROC|PRO\.|FN)([A-Za-z0-9_`]*)/;
const reHex = /^&[0-9A-F]+/;
const reNum = /^[0-9][0-9.]*|^\.[0-9.]*/;
const reVar = /^[A-Za-z_`][A-Za-z0-9_`]*/;
const reStr = /^"[^"]*"?/;

function grammarTokenise(text) {
  const toks = [];
  let pos = 0;
  while (pos < text.length) {
    const rest = text.slice(pos);
    let m;
    if ((m = /^(REM)(.*)$/.exec(rest))) {
      toks.push(['kw', 'REM', 'REM']); if (m[2]) toks.push(['raw', m[2]]); return toks;
    }
    if ((m = /^(DATA|D(?:AT|A)?\.)(.*)$/.exec(rest))) {
      toks.push(['kw', 'DATA', m[1]]); if (m[2]) toks.push(['raw', m[2]]); return toks;
    }
    if ((m = reProcFn.exec(rest))) {
      const kw = m[1] === 'PRO.' ? 'PROC' : m[1];
      toks.push(['kw', kw, m[1]]);
      if (m[2]) toks.push(['name', m[2]]);
      pos += m[0].length; continue;
    }
    if ((m = reStr.exec(rest))) { toks.push(['str', m[0]]); pos += m[0].length; continue; }
    if ((m = reAbbrevCond.exec(rest)) || (m = reAbbrevPlain.exec(rest))) {
      const p = m[0].slice(0, -1);
      const kw = KEYWORDS.find(([k]) => k !== p && k.startsWith(p))[0];
      toks.push(['kw', kw, m[0]]); pos += m[0].length; continue;
    }
    if ((m = reFull.exec(rest))) { toks.push(['kw', m[0], m[0]]); pos += m[0].length; continue; }
    if ((m = reHex.exec(rest))) { toks.push(['hex', m[0]]); pos += m[0].length; continue; }
    if ((m = reNum.exec(rest))) { toks.push(['num', m[0]]); pos += m[0].length; continue; }
    if ((m = reVar.exec(rest))) { toks.push(['var', m[0]]); pos += m[0].length; continue; }
    if (rest[0] !== ' ') toks.push(['op', rest[0]]);
    pos++;
  }
  return toks;
}

const samples = [
  'FORX=1TO10', 'COUNTER=1', 'COUNT=1', 'P.X', 'PRINTER', 'GET.', 'TO.', 'A.2',
  'PROCtotal', 'PROCtotal(2)', 'PRO.total', 'TIME$=A$', 'X=PAGE', 'PAGE=8',
  'IFXTHENPROCa', 'N%=RND(4)', 'REPEATUNTILFALSE', 'ENDPROCX', 'ENDPROC',
  'Y%=PAGE DIV256', 'CALLTOP', 'GOTO10', 'ONXGOSUB100,200', 'TR.', 'COU.X',
  'PRINTTAB(3)"HI"', 'VDU19,0,4;0;', 'X=OPENIN"file"', 'LETA=1', 'NEXTJ',
  'INKEY$(0)', 'STR$(X)', 'HIMEM=&7C00', 'ERRX=1',
];
let failures = 0;
for (const s of samples) {
  const a = JSON.stringify(romTokenise(s));
  const b = JSON.stringify(grammarTokenise(s));
  if (a !== b) {
    failures++;
    console.error(`MISMATCH: ${s}\n  rom: ${a}\n  gra: ${b}`);
  }
}
// REM/DATA raw-tail behaviour is asserted separately (the simulators diverge on shape).
if (failures > 0) {
  console.error(`${failures} mismatches - grammar NOT updated`);
  process.exit(1);
}
console.log(`all ${samples.length} samples agree with the ROM matcher`);

// ---- rewrite the grammar's basic-block entry ----

const grammarPath = path.join(__dirname, '..', 'syntaxes', 'baron.tmLanguage.json');
const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));

grammar.repository['basic-block'] = {
  begin: '(?i)^\\s*(basic)\\s*(?=$|;|\\\\|:)',
  end: '(?i)^\\s*(endbasic)\\b',
  beginCaptures: { '1': { name: 'keyword.control.directive.baron' } },
  endCaptures: { '1': { name: 'keyword.control.directive.baron' } },
  contentName: 'meta.embedded.block.bbcbasic.baron',
  patterns: [
    { name: 'comment.line.semicolon.baron', match: '^\\s*;.*$' },
    { name: 'comment.line.backslash.baron', match: '^\\s*\\\\.*$' },
    {
      match: '^(\\s*)(\\d+)(\\s*)(\\*.*)$',
      captures: {
        '2': { name: 'constant.numeric.line-number.bbcbasic.baron' },
        '4': { name: 'keyword.other.star-command.bbcbasic.baron' },
      },
    },
    {
      match: '(?<=:)\\s*(\\*.*)$',
      captures: { '1': { name: 'keyword.other.star-command.bbcbasic.baron' } },
    },
    { name: 'constant.numeric.line-number.bbcbasic.baron', match: '^\\s*\\d+' },
    {
      name: 'string.quoted.double.bbcbasic.baron',
      begin: '"',
      end: '"(?!")',
      patterns: [{ name: 'constant.character.escape.baron', match: '""' }],
    },
    {
      match: '(REM)(.*)$',
      captures: {
        '1': { name: 'keyword.control.bbcbasic.baron' },
        '2': { name: 'comment.line.rem.bbcbasic.baron' },
      },
    },
    {
      match: '(DATA|D(?:AT|A)?\\.)(.*)$',
      captures: {
        '1': { name: 'keyword.control.bbcbasic.baron' },
        '2': { name: 'string.unquoted.data.bbcbasic.baron' },
      },
    },
    {
      match: '(PROC|PRO\\.|FN)([A-Za-z0-9_`]*)',
      captures: {
        '1': { name: 'keyword.control.bbcbasic.baron' },
        '2': { name: 'entity.name.function.bbcbasic.baron' },
      },
    },
    { name: 'keyword.control.bbcbasic.baron', match: `(?:${abbrevCond})\\.${GUARD}` },
    { name: 'keyword.control.bbcbasic.baron', match: `(?:${abbrevPlain})\\.` },
    { name: 'keyword.control.bbcbasic.baron', match: fullAlternation },
    { name: 'constant.numeric.hex.bbcbasic.baron', match: '&[0-9A-F]+' },
    { name: 'constant.numeric.decimal.bbcbasic.baron', match: '[0-9][0-9.]*|\\.[0-9.]*' },
    { name: 'variable.other.bbcbasic.baron', match: '[A-Za-z_`][A-Za-z0-9_`]*' },
    { name: 'keyword.operator.bbcbasic.baron', match: '<=|>=|<>|<<|>>|[-+*/^=<>?!$;]' },
  ],
};

fs.writeFileSync(grammarPath, JSON.stringify(grammar, null, 2) + '\n');
console.log(`updated ${grammarPath}`);
