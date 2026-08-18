# baron-vsc journal #

Development journal for the Baron VS Code extension. Language behaviour is always verified
against the Baron C source (`~/dev/baron/src/`) — the docs are descriptive, the source is
authoritative.

## 2026-08-18 — project start ##

Goals (from Rich):
- Syntax highlighting, including inline BBC BASIC programs (stretch goal). **Done: TextMate grammar.**
- A parser in TS/JS understanding symbol/label definitions, includes, macro and function
  definitions, named scopes, local labels, sections — go-to-definition on a hotkey.
- Expression parsing: multi-line lists, ranges, subscripts.
- Configurable root set of source files (the ones passed on the baron command line).
- Launch baron with custom switches from a hotkey-bindable command.
- Extras agreed: completion, hover, outline, find-references, diagnostics from baron output.
- CMOS-aware opcode colouring (mid-session request): colour 65C02-only mnemonics/modes
  according to whether the enclosing section has `cmos = TRUE` — implemented as semantic
  tokens, since TextMate grammars cannot see section context.
- No debugger/emulator integration for now.

Decisions:
- File extension: `.6502` (what starglobe uses; conflicts with beeb-vsc noted and accepted).
- TypeScript, bundled with esbuild into `dist/extension.js`. Plain extension-host providers,
  no LSP split — simpler, and everything is in-process anyway.
- Parser core (`src/core/`) has no vscode dependency, so it is testable under plain `node --test`.
- Config: `baron.executablePath`, `baron.sourceFiles` (root set, also drives the include graph),
  `baron.buildArgs`, `baron.diagnosticsOnSave` (default off — a successful baron run writes its
  output files; there is no check-only switch). Problem matcher `$baron` also contributed.
- Commands: `baron.build` (Ctrl+Alt+B), `baron.buildWithArgs` (Ctrl+Alt+Shift+B, prompts for
  switches), `baron.setRootFiles`.

## Discoveries from the Baron source ##

### lexer.c ###
- Whitespace is space/tab/CR. Comments run from `;` **or a single `\`** to end of line
  (colon does not end a comment).
- Terminators: a run of `:`/newlines (with interleaved whitespace/comments) coalesces into ONE
  terminator lexeme, with a `newline` flag true only when the run had no `:`. Lists skip
  newline-only terminators; a `:` inside a list is a hard stop (unclosed-list error).
- Numbers: decimal with optional fraction (a `.` is consumed only if a digit follows, so `1..2`
  lexes as `1` `..` `2`); `&`/`$` hex; `%` binary. No exponent form.
- Strings: `"..."`, `""` is a literal quote.
- **Identifiers are dotted at the lexer level**: `ident('.' ident)*`, consuming `.` only when an
  identifier-start follows (`a.b` is one token; `a..b` stops at `a`). Ident chars: `[A-Za-z_]`
  then `[A-Za-z0-9_]`.
- `P%` is a single token (token-table entry), as are `@-`, `@+`, `*` (const_pc), `..`, `..<`.

### expression.c ###
- Precedence ladder (higher binds tighter): unary `<`/`>` lo/hi = 1 (swallow the whole following
  expression), range `..`/`..<` = 5 (right-assoc, special-cased), `or`/`eor` = 10, `and` = 20,
  comparisons `= == != <> < > <= >=` = 30, `+ -` = 40, `* / div mod << >>` = 50, unary `+ -` = 60
  (so `-2^2` is `-(2^2)`), `^` = 70 (right-assoc), subscript `[...]` = 80.
- List literals `{...}`: newline terminators are skipped inside the braces (before and after
  elements and separators); nested and empty lists fine.
- Constants tokens: `true`, `false`, `pi`, `*`, `P%`, `@-`, `@+`.

### assemble.c ###
- Statement token table: mnemonics + directives + closers + `.`, `.@`, `{` + reserved constants
  (`true`/`false`/`pi` reserved at statement start so `pi = 5` is rejected). Macro names are
  appended per-pass, so an already-defined macro name is recognised at statement start.
- `handle_label`: name binds **in the enclosing scope** at the current pc. Then: if the next
  token is `{`, or exactly one terminator then `{` (terminators coalesce, so any run of blank
  lines/comments counts), the label names the scope (`scopes_get_or_make_child(scope, name)`).
  Otherwise the label owns nothing — the rest of the line is the parent loop's.
- A dotted name after `.` is a lexable token but an illegal label name (semantic error).
- `handle_open_brace`: anonymous scope keyed by source position (`@src:pos`) — truly private.
- IF/ELIF/ELSE/ENDIF does **not** open a scope: labels in the live branch leak to the enclosing
  scope, and the construct must close in the scope it opened in. ELIF is IF in the else position.
- SECTION: nested sections inherit parent attrs; `cmos` attribute is numeric-evaluated, `!= 0`
  enables the 65C02 set for the section (sections_set_cmos); org/cmos/guard may be
  forward-referenced (multi-pass).
- FOR: each iteration gets its own scope keyed `@src:pos:iteration`.

### scopes.c ###
- Bare-name lookup walks the parent chain (nearest enclosing definition wins); a dotted path
  finds its head the same way, then descends child scopes by name — the leaf scope is the
  declaring one.

### opcodes.c ###
- Mnemonics (from the mnemonic enum): all NMOS + 65C02 `bra dea ina phx phy plx ply stz trb tsb`,
  plus `clr` as an alias of `stz`. CMOS-only entirely: those eleven.
- CMOS-only addressing modes on NMOS mnemonics (per the opcode table / 65C02 delta):
  `(zp)` plain indirect on adc/and/cmp/eor/lda/ora/sbc/sta; `bit #imm`, `bit zp,x`, `bit abs,x`;
  `inc a` / `dec a`; `jmp (abs,x)`.

### basic.c ###
- BASIC 4 keyword table in ROM order (&8456); tokens compose (`TO`+`P`, `TIME`+`$`); keyword flag
  `conditional` = not a keyword if a variable character follows (COUNTER stays a variable).
  Keywords are uppercase-only. The grammar's BASIC block sorts alternation longest-first and
  right-guards with `(?![0-9A-Za-z_])` (allowing `$` to follow, for TIME$/keyword composition),
  with PROC/FN followed by a name handled separately.

### Command line / diagnostics (main.c, reference confirmed) ###
- Diagnostics on stderr: `file:line:col: error: message` (also `warning`). Exit 0 iff every file
  assembled. Every root file assembles independently — fresh symbol table per file. So each root
  file is a separate "compilation unit" in the extension's project model.

### Verified in source (second sweep) ###
- **handle_macro**: name from the STATIC table (so overloads/fill-ins reuse the name); signature
  slots up to the required terminator are identifiers (params), string literals (verbatim
  tokens, interned per-macro), and commas (their own slot kind); bare punctuation must be
  quoted (`error_type_unquoted_macro_token`). Body scanned inactively to ENDMACRO. Empty body
  (first meaningful token is ENDMACRO) = forward declaration. Overloads reconciled by shape.
- **handle_function**: `FUNCTION name(params)` — parens required, params are bare identifiers,
  comma-separated, empty allowed. Body = assignments (`name = expr`, immutable, bound in a
  child scope at call time) and IF/ELIF/ELSE/ENDIF, ending at a top-level `=` return
  (one-liner form is just the return arriving immediately). Empty body + empty return =
  forward declaration. Overloads by arity. Function names may not collide with builtins.
- **handle_for**: `FOR name = expr`, terminator, body to NEXT; each iteration in its own scope
  keyed `@src:pos:iteration`; a malformed header is fatal (can't find NEXT).
- **handle_print**: optional channel is `#` + single digit + `,`.
- **handle_basic**: BASIC insists on a separator after it; then any statement starting with a
  digit is one opaque BASIC line to end-of-line (the lexer never sees inside it); blank/comment
  lines allowed between; anything else must be the ENDBASIC closer; EOF first = unclosed.
- **handle_zpauto***: comma-separated bare identifier names bound as symbols in the CURRENT
  scope (zpauto placeholder values); `a` is refused as a name (accumulator collision); dotted
  names refused. ZPAUTO without a prior ZPRESERVE is a semantic error.
- **file_path_resolve** (file_utils.c): include paths resolve relative to the including file's
  directory; backslashes normalised to `/`.
- **parse_one_statement**: opcode | keyword | registered-macro-name (lexeme_type_macro) |
  identifier → assignment (anything else after an identifier is `expected_assign`). So an
  unknown bare identifier statement is only ever a macro call if the macro is already defined —
  the IDE parser treats unknown ones as macro-call references anyway, tolerantly.
- **opcode_parse** operand grammar: no operand (terminator or `}`) → implied, else accumulator;
  `#expr` → immediate; `(expr,X)` → indexed-indirect (but the indexed dispatch `ind16x` for
  JMP); `(expr),Y` → indirect-indexed; `(expr)` → indirect (JMP ind16, else the CMOS zp
  indirect); bare `A` (only when a terminator or `}` follows, and only on acc-capable
  mnemonics) → accumulator; else expr with optional `,X`/`,Y`. Registers are only registers
  after a comma / in the accumulator slot; elsewhere `a x y` are ordinary symbols.
- **CMOS cells in opcode_defs** (what baron flags `| cmos`): `(zp)` ind mode on
  adc/and/cmp/eor/lda/ora/sbc/sta; `BIT #imm`; `INC A`/`DEC A` acc mode; `JMP (abs,X)`
  ind16x; `BRA`; the wholly-CMOS mnemonics (dea ina phx phy plx ply stz/clr trb tsb) in
  all their modes. **Found and fixed a Baron bug here** (confirmed by Rich): `BIT zp,X` and
  `BIT abs,X` (0x34/0x3C, real 65C02 additions) were missing their `cmos` flag, so plain
  NMOS sections would silently accept them. Fixed in baron's opcodes.c with a new
  `cmos_bit_indexed` test (322/322 pass); change left uncommitted in ~/dev/baron for
  review. The extension flags them as CMOS-only to match.
- **Local labels**: `.@` binds an anonymous local at the current pc in the current scope;
  `@-`/`@+` are expression constants resolving to the nearest one behind/ahead in the current
  scope only (no parent walk).

## Progress ##

### 2026-08-18 — v0.1.0 complete ###
- `src/core/` (vscode-free, testable): `lexer.ts` (mirrors lexer.c: coalesced terminators,
  dotted identifiers, P% folding), `parser.ts` (statement grammar per assemble.c, expression
  precedence per expression.c, operand grammar per opcodes.c, cmos tracking per sections),
  `model.ts` (scopes, definitions, references, outline, constant evaluation), `resolve.ts`
  (dotted-path resolution per scopes.c, @-/@+ nearest-in-scope).
- `src/project.ts`: one unit per configured root file (`baron.sourceFiles`), includes parsed
  transitively into the same unit/scope; ad-hoc unit for files outside the root set; lazy
  reparse on change.
- `src/providers.ts`: definition, references, hover (with evaluated symbol values and doc
  comments), completion (context-aware: statement start, expressions, `scope.` members,
  INCSECTION names, SECTION attrs), document symbols, and the semantic-tokens provider for
  CMOS-aware opcode colouring (mnemonicCmos / mnemonicInvalid → invalid.illegal).
- `src/build.ts`: `baron.build` (Ctrl+Alt+B), `baron.buildWithArgs` (Ctrl+Alt+Shift+B,
  remembered input), `baron.setRootFiles`; stderr `file:line:col: severity: message` parsed
  into the Problems panel; `$baron` problem matcher contributed for custom tasks.
- Grammar: full assembler + embedded BBC BASIC block (BASIC 4 keyword table from basic.c,
  longest-first alternation, PROC/FN names, REM, line numbers).
- Tests: 21 core parser tests under `node --test` (scopes, dotted paths, includes, macros,
  functions, FOR scoping, cmos flags incl. the BIT ,X fix, multi-line lists, lo/hi,
  BASIC opacity, zpauto, plus the real starglobe demo as a fixture). All pass.
- Packaged `baron-vsc-0.1.0.vsix` (24.7 KB); grammar regexes compile-checked.
- Also fixed in ~/dev/baron (uncommitted): BIT zp,X / abs,X missing `| cmos` in opcodes.c,
  with new `cmos_bit_indexed` test — 322/322 baron tests pass.

### 2026-08-18 — faithful BBC BASIC highlighting ###
Rich pointed out BASIC doesn't require whitespace after most tokens. Re-read basic.c
properly; the rules now encoded in the grammar (regexes generated by a script that also
verifies them against a simulation of the ROM matcher — 35/35 nasty samples agree,
including FORX=1TO10, COUNTER, PRINTER, GET., TO., COU.X, CALLTOP, REPEATUNTILFALSE):
- Keywords match at any reachable position in **ROM table order** (the order IS the
  abbreviation precedence: A. means AND because AND is first). No whitespace needed:
  PRINT in PRINTER matches, leaving ER as a variable — authentic ROM behaviour.
- Only entries with flag 0x01 (conditional) are vetoed by a following variable character
  (letters/digits/`_`/`` ` `` — NOT `$`, so TIME$ still reads TIME + '$'). Conditional
  set: BGET BPUT CLEAR CLOSE CLG CLS COUNT ENDPROC END ERL EOF ERR EXT FALSE HIMEM LOMEM
  NEW OLD PAGE PTR PI POS RETURN REPORT RUN RND STOP TIME TRUE VPOS.
- A failed keyword match consumes a whole variable-name run, so keywords never match
  mid-name (xFOR is one variable). The grammar reproduces this with an explicit
  variable-run rule after the keyword rules.
- Abbreviations: prefix + '.' binds to the FIRST table entry with that prefix, full-text
  entries winning outright (GET. is GET$'s abbreviation; TO. is full TO plus a dot;
  COU.X is a variable — the veto applies after the dot). Prefix→entry assignment is
  generated; REM cannot be abbreviated (RETURN owns RE), DATA owns D./DA./DAT.,
  PROC owns PRO., FN has no abbreviation (FOR owns F).
- '*' at statement start (line start after the line number, or after ':') = raw OS
  command to end of line. REM/DATA rest-raw. '&' hex is digits + UPPERCASE A-F only.
  Numbers are digit/dot runs. Variable chars include backtick (the Beeb's pound sign).
- Assembler ;/\ comments inside a BASIC block only match at line start (between lines);
  mid-line they are BASIC text, since a BASIC line is opaque to end of line.
Generator + simulator live in `tools/gen-basic-grammar.js` (run it to regenerate the
basic-block rules after a table change; it refuses to write if the simulation disagrees);
the generated alternations are embedded in syntaxes/baron.tmLanguage.json.

### 2026-08-18 — marketplace prep ###
- Author credited as Rich Talbot-Watkins in package.json (LICENSE already carried it).
- Icon: `images/icon.png` — the dotted BBC Micro owl (cream dots on dark maroon), at
  Rich's direction, downscaled with lanczos from the 283x283 original at
  https://ramdor.co.uk/wp-content/uploads/2016/07/owl.png to 128x128. (A first attempt
  at an original pixel-art owl stand-in was replaced by this; its generator
  tools/gen-icon.js was removed with it.)
- Release workflow `.github/workflows/release.yml`: pushing a `vX.Y.Z` tag runs tests,
  packages, publishes to the Marketplace (needs repo secret `VSCE_PAT`, an Azure DevOps
  PAT with Marketplace:Manage), and attaches the .vsix to a GitHub release. It refuses
  to publish if the tag doesn't match package.json's version. Flow: `npm version minor`,
  `git push && git push --tags`.
- .vscodeignore now also excludes tools/, .github/ (and .claude/, JOURNAL.md) from the
  .vsix; images/icon.png ships.
