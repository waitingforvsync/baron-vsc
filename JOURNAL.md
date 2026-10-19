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

## 2026-08-19 — check-on-save and parser error recovery ##

### baron --check (in ~/dev/baron, uncommitted — Rich will review/commit) ###
Added `--check` to main.c: assemble and validate EVERYTHING (all passes, the output
spec, even building the disc image so a full disc fails a check) but write nothing —
no binaries, no image, no -logN files. Diagnostics and exit codes unchanged. Verified:
a full starglobe check run writes zero files; undefined symbols and branch-out-of-range
report exactly as a real build. 322/322 tests still pass.

### Char literals (missed the first time - the docs don't mention them) ###
lexer.c lex_char: `'X'` is exactly one character (not a quote, not a newline), no
escapes, valued as its byte. Added to the extension lexer (malformed ones fall back to
a lone punct for recovery) and to the grammar (constant.numeric.character.baron).
Another the-source-is-authoritative catch: reference.md's value table omits them.

### Parser error recovery (per Rich's design) ###
Recovery = skip to the next separator, with comments/strings/char literals already
hidden by the lexer, PLUS list-awareness, since list literals span lines:
- `skipToStatementEnd()`: consumes to terminator / `}` / EOF; a `{` met while skipping
  is a LIST brace (expression territory) and is consumed through its balanced close.
- `recoverList()`: entered past a `{` whose contents broke; tracks brace nesting,
  treats newline-only terminators as whitespace, stops AT a hard (`:`) terminator
  leaving it in place (baron's unclosed-list behaviour).
- List braces vs scope braces by context: statement position → scope; inside an
  expression (or statement-tail junk) → list.
- Every full-statement handler now ends with skipToStatementEnd(), so trailing junk
  can never be misread as new statements (previously a stray `{` in junk could open a
  phantom scope, and an error inside a multi-line list leaked its tail lines and its
  closing `}` into the statement loop, spuriously closing the enclosing scope).
Five new tests cover: mid-list errors not leaking (scope integrity preserved), hard
terminator stopping list recovery, junk not opening phantom scopes, recovery keeping
later defs/refs intact, char literals. 26/26 pass.

### Check-on-save in the extension ###
- `baron.checkOnSave` (default ON, replaces diagnosticsOnSave) runs `baron --check` on
  every save of a baron file; `baron.check` command for manual runs. Uses
  `baron.executablePath` (the existing setting) + `baron.buildArgs` + the root set.
- Fully asynchronous: baron is a separate process and the extension only listens for
  its output events, so a slow assembly never blocks editing. Latest-run-wins: a newer
  check (or a build) kills the in-flight check process and its results are discarded
  via a generation counter, so stale diagnostics can never overwrite fresh ones.
- A baron without --check support is detected from the usage error and reported once in
  the output channel rather than polluting the Problems panel.

### Run in emulator ###
`baron.runInEmulator` (Ctrl+Alt+R): full build first (so the image is fresh; a failed
build stops there), then launch `baron.emulatorPath` (default `b2`) with
`baron.emulatorArgs` (default `-b -0 ${image}`, b2's boot-drive-0 form). `${image}`
substitutes the path named by `-o` in baron.buildArgs, resolved against the workspace
folder; with no placeholder the path is appended, so other emulators configure easily.
The previous emulator instance we launched is killed on re-run (one-keypress iterate);
the process is detached/unref'd so it survives the editor closing.

### Root-file picker and output-image setting ###
- `baron.selectRootFiles` ("Baron: Select Root Source Files..."): multi-select QuickPick
  over the workspace's .6502 files → baron.sourceFiles. Order preserved for files that
  stay selected, new picks appended — order matters because sections land on the disc
  in collection order.
- `baron.setOutputFile` ("Baron: Set Output Disc Image..."): sets `baron.outputFile`
  (validated .ssd; empty clears). Build/check/emulator all go through effectiveArgs():
  `-o <outputFile>` is appended unless the switches already carry a -o, in which case
  the explicit -o wins (and the command warns about the shadowing). The emulator's
  discImage() follows the same precedence.

### buildOverride and live (onType) checking ###
- `baron.buildOverride`: a shell command replacing the whole default build invocation
  for `baron.build` and Run in Emulator's build step (runs via `shell: true` in the
  workspace folder; stderr still parsed for diagnostics). Checks and buildWithArgs
  still construct the baron command line themselves — that is their point.
- `baron.check` enum replaces checkOnSave: `onType` (default) debounces a check 500ms
  after the last edit (so Enter effectively triggers one), `onSave`, `off`. Change
  events from any file in the include graph count, not just .6502-language docs.
- The soundness problem with onType: baron reads from DISK, but the buffer is dirty.
  Solved with a shadow tree under os.tmpdir() (`baron-vsc-check-<hash of ws root>`):
  every file a check involves (the units' include graphs plus INCBIN targets, via
  Project.filesForRoots) is mirrored — dirty buffers written out, clean files
  hardlinked (copy fallback). IMPORTANT trap avoided: always rm the mirror entry
  before writing, or writing a dirty buffer through a stale hardlink would edit the
  original file. The check runs with cwd = shadow root and identical relative args;
  diagnostics are stripped of the shadow prefix and resolved against the real
  workspace. A file outside the workspace folder disables mirroring (plain disk check).
  The mirror is only built when something is actually dirty.
- runCheck now also declines to start while a real build is in flight (the build's
  diagnostics would be fresher anyway).

### Rebind + docs (Rich's request) ###
Default keybindings are now F5 = run in emulator, F7 = build, Ctrl+F7 = build with
switches (retro-IDE style; they shadow VS Code's debug-start/next-diff only in Baron
contexts via the `when` clause). Rich bumped to 0.1.1 and renamed the display name to
"Baron BBC Micro Assembler" directly in package.json. README and CHANGELOG brought up
to date (earlier journal entries keep the old bindings they were written under).

## 2026-08-30: 0.2.0 - ZA_ keyword rename ##

Baron renamed the zero-page allocator keywords to a uniform `ZA_` prefix (verified
against ~/dev/baron/src/assemble.c keyword table): ZPRESERVE->ZA_POOL,
ZPAUTO/1/2->ZA_AUTO/1/2, UNREACHABLE->ZA_UNREACHABLE, CANCALL->ZA_CANCALL,
CANJUMP->ZA_CANJUMP, DISCARD->ZA_DISCARD, ZPENTRY->ZA_ENTRY,
ZPINTERRUPT->ZA_INTERRUPT. New keywords: ZA_RETURN (bare marker - a jump that
returns to our caller), ZA_RETURNTO (target list, like ZA_CANCALL - where a JSR
resumes), and BITZP/BITABS (no operands - emit &24/&2C to swallow the next 1/2
bytes; these are ordinary directives, not ZA_).

Updated: data.ts DIRECTIVES, parser.ts parseDirective cases (ZA_RETURNTO joins the
expr-list group; ZA_RETURN/BITZP/BITABS join the bare-marker group), tmLanguage,
tests + demo fixture. Old spellings dropped entirely - baron no longer accepts them.

Per Rich's request the ZA_ keywords get their own grammar rule (`za-directives`,
scope `support.type.zeropage.baron`, included before `directives`) so they colour
differently from keyword.control directives - teal vs purple in the default Dark+
theme. Packaged baron-vsc-0.2.0.vsix.

### Correction (same day) ###
Rich: BITZP/BITABS count as opcodes category-wise, not directives. Moved to
MNEMONICS in data.ts (plain NMOS - they emit &24/&2C, so not CMOS_ONLY), the
mnemonics rule in the grammar (bitzp|bitabs listed before bit so the longer
match wins), and out of parseDirective - parseInstruction's implied path handles
their no-operand form. Repackaged 0.2.0.

## 2026-08-31: 0.2.1 - bracket colorization in comments ##

Rich noticed VS Code's bracket-pair colorization rainbow-colouring ()/{} inside
comments. Cause: bracket-pair colorization colours every bracket in every token
unless the grammar contribution says otherwise - the TextMate scope name being
comment.* is NOT enough. Fix: `"unbalancedBracketScopes": ["comment", "string"]`
on the grammars entry in package.json (scope-prefix selectors, so they cover the
bbcbasic comment/string scopes inside BASIC blocks too). Strings included for the
same reason even though Rich only reported comments.
(Postscript: the fix was briefly folded into 0.2.0, but the marketplace refuses
re-uploads of an existing version number, so it shipped as 0.2.1 after all.)

## 2026-09-23: 0.4.0 - catching up with baron 0.3.0 + 0.4.0 ##

Rich asked for the plugin to match baron's new surface ("at least ZA_INDEXEDBY and
ZA_WIPE - anything else?"). Diffing plugin 0.2.1 (synced 2026-08-31) against baron
0.4.0.0 turned up five language changes, not two:

- ZA_WIPE + ZA_INDEXEDBY: data.ts DIRECTIVES, parseDirective (wipe joins the
  bare-marker group, indexedby the expr-list group), the za-directives grammar rule,
  completions for free via DIRECTIVES.
- `@name = expr` verbatim assignments (baron 0.2.2-era peek_symbol work): a new '@'
  arm in parseStatement delegating to a factored parseAssignmentTo (shared with the
  plain-identifier path), plus an optional `@` in the grammar's assignment rule.
  TRUE/FALSE/PI stay refused, dotted names skipped.
- Brace-as-separator: new endsStatement() helper (atStatementEnd || '{') used by
  skipToStatementEnd, parseInstruction's no-operand and bare-A peeks, and
  parseMacroArgs - mirroring baron's peek_separator unification. skipToStatementEnd
  no longer swallows a '{' as a list; the brace is left to open a real scope.
  GOTCHA: recoverList has a SECOND caller inside parsePrimary's list handling - it
  stays, for genuinely-started list literals; only the statement-skip use is gone.
  The "junk cannot open a phantom scope" test asserted the old semantics and flipped:
  under baron's rule the phantom scope is the real parse.
- INCSECTION removed everywhere (baron 0.3.0): data.ts, parseDirective, its grammar
  rules, the section-name completion block, two README lines, the sections test.
- Nested sections no longer inherit attributes (baron 0.3.0): parseSection's
  cmos-inheritance default is now plain false, so CMOS-only mnemonics flag inside an
  attribute-less inner section; new test pins outer TRUE / inner default / outer
  restored.

Checked and fine as-is: keyword-spelled labels (.next etc. - parseLabel and the
label-def grammar rule never gated on keyword spellings), the DIAG_RE stderr parse
(baron's format is still name:line:col: error|warning: message), `baron --check`
(still present), SECTION_ATTRIBUTES (org/filename/load/exec/cmos/guard unchanged).

30/30 tests, typecheck clean, packaged baron-vsc-0.4.0.vsix. Version 0.2.1 -> 0.4.0
per Rich, aligning with baron 0.4.0.0 (three-part semver: the marketplace and npm
refuse a fourth segment, so 0.4.0 IS the aligned spelling; no 0.3.x plugin ever
shipped).

## 2026-09-24: 0.4.1 - the shadow copy honours the document's encoding ##

Baron issue #8's side complaint, confirmed real: prepareMirror wrote dirty buffers with
fs.writeFileSync(dest, doc.getText()) - a string write is always UTF-8 - so a Latin-1 source's
one-byte &9A became C2 9A in the shadow tree and check-on-type disagreed with baron-on-disk.
Fix: doc.encoding + vscode.workspace.encode (the 1.100 encoding API; @types 1.125 already has
it) with a typeof feature-guard so the ^1.85 engine floor stands - older hosts keep the UTF-8
write, exact for UTF-8 buffers. encode() is async, so prepareMirror and runCheck went async;
the check GENERATION is now claimed before the mirror and re-checked after the await, else a
check superseded mid-mirror would kill its successor's process (all runCheck callers are
fire-and-forget, so the signature change ripples nowhere). utf8bom stays faithful for free -
encode re-adds the BOM, matching the bytes baron sees in the real file. Typecheck + 30/30 +
packaged baron-vsc-0.4.1.vsix.

## 2026-10-01: 0.4.2 - ASSERT, call navigation and call colouring ##

Rich asked for three things: the new ASSERT keyword, F12 on macro and function
invocations, and colouring those invocations so a correct call shows at a glance.

### Verified in source (baron 0.4.2.0) ###
- **ASSERT** (assemble.c handle_assert, expression.c interpret_assert): `ASSERT cond
  [, value...]` = `IF NOT(cond) : ERROR value... : ENDIF`; the message is ERROR's value
  list, evaluated only on failure. Also a FUNCTION body statement (the body token table
  gained `assert` beside if/elif/else/endif), where a failure becomes the call's result.
  It is the only language addition since the 0.4.0 sync (checked the git log and the
  reference.md diff). Added to DIRECTIVES, parseDirective (cond + message =
  parseExprList) and the grammar's directives rule.
- **Macros are their own namespace.** Macro names go in the statement token table
  (macros_statement_tokens), so at statement start a defined macro's name lexes as the
  macro whatever symbols share it, and whatever follows (even `=`). They are never
  symbols.
- **Functions are their own namespace too.** functions_index_for_name interns the
  operand token `name(`, with the paren baked in like every builtin. So `f(` is a call
  even beside a symbol `f`, and `f (x)` (with a space) is not a call at all ("Expected
  a newline or ':'").
- Both are **define-before-use**: the token tables are rebuilt each pass
  (macros_reset / functions_reset), so a call above its definition fails ("Expected '='"
  for a macro, the separator error for a function). The name registers before the body,
  so self-calls work.
- **Macro call matching** (handle_macro_invocation / macro_try_match): overloads are tried
  in macro_signature_before order. At the first slot two signatures differ, a fixed token
  (literal/comma) beats a parameter. Otherwise the longer one wins, then definition order
  (stable insertion). A param slot takes one eval'd expression (so a `{...}` list
  literal), a comma slot takes a comma, and a literal slot lexes against the macro's
  literal table. Then peek_separator must hold. If no overload fits, the resync runs to
  the terminator, passing over `{`.
- **Literal lexing** (lexer.c lexer_next, token.c token_table_find): strings, numbers,
  `&`/`$`/`%`, char literals, commas and terminators lex intrinsically first. Then the
  longest table entry matches case-insensitively, and an identifier starting there wins
  if it is LONGER than the match (so a literal "X" does not match `xy`).
- FUNCTION breadcrumbs (baron fd63a0d) print as plain `error: Note: Called from here`
  lines at the call site, so DIAG_RE already picks them up. No change needed.

### The F12 bug ###
It was not that calls were never resolved. Probing every macro/function call in portalc
and the baron examples showed resolveRef walking the SCOPE CHAIN first for a macrocall.
macros and functions were define()d into scope.symbols, so in portalc's test/s2.6502
`OUT 0` and `CALL x` resolved to the `.out` / `.call` labels in the same scope. Fixes:
- define() takes `bind = false` for macros and functions: they go into index.defs and
  unit.macros / unit.functions only, never the symbol table.
- resolveRef: a macrocall / funccall returns `ref.matched` (the overload the call fits),
  else every overload of the name. Value refs no longer fall back to functions/macros
  (sections only), so a bare `trap` no longer also finds the TRAP macro.
- New Reference kind `funccall`, recorded in parsePrimary only for an ident with `(`
  hard against it (paren.start === tok.end) and not dotted. `f (x)` stays a value ref.

### Signature-aware macro calls (a second bug found by the probe) ###
`palette {black, ...}` (baron's spritescale example) was split at the `{` by the 0.4.0
brace-as-separator rule. That opened a phantom scope and read `black` as a macro call.
parseMacroCall now mirrors macro_try_match. It orders the overloads as above, then
trial-parses each with mark()/rewind(), restoring lexer position and truncating
refs/localRefs, since an expression parse records references as a side effect. A known
macro with no fitting overload is consumed with `{` read as a list (baron's resync passes
over it). An undefined name keeps the old rule where `{` ends the statement (baron's
parse is a syntax error there anyway, so no faithful recovery exists). parseMacro now
records `macroSlots`, parseFunction `arity`, and parseCallArgs returns the argument count.

### Colouring ###
Semantic token types `macroCall` (superType macro) and `functionCall` (superType
function) are mapped to the scopes the definition names already use
(entity.name.function.macro.baron / entity.name.function.baron), so a call matches its
definition's colour. A call is coloured only when `matched` is set: defined earlier in
unit parse order, with an overload that fits. So a misspelt, misordered or mis-shaped
call stays plain. Calls usually live in a different file from their macros (portalc's
arith.6502), so the provider now fires onDidChangeSemanticTokens 300ms after any edit
in the unit, and when baron.sourceFiles changes.

### Verification ###
- Differential dump (every ref's resolution, defs, mnemonics, local refs) between HEAD
  and the new parser over portalc (portal/harness/boot) and all four baron examples.
  The only changes are the intended OUT/CALL/ASSERT/trap ones.
- All 172 calls in portalc and 64 in spritescale match an overload.
- Every new test's premise was checked with baron 0.4.2.0 --check first: the overload
  and literal rules, `xy` beating literal X, list args, a brace after the last slot,
  `f` symbol beside function `f`, `f (1)` rejected, use-before-define rejected, OUT
  beside .out, ASSERT in both forms, and macro self-recursion.
- 37/37 tests, typecheck clean, packaged baron-vsc-0.4.2.vsix.
- Also corrected a stale README line that still said nested sections inherit `cmos`.

## 2026-10-02: 0.4.3 - default -D defines ##

Rich asked for default `-D` values, used by both the background check and the real build,
specified "the way the C/C++ tools do". That means `C_Cpp.default.defines`, which he
already uses: an array of `NAME` / `NAME=value` strings, edited as a list in the Settings
UI. So `baron.defines` is `string[]`.

Verified against baron 0.4.2.0 (main.c, assemble.c apply_define) before encoding:
- Only the two-argument form `-D name=expr` is accepted (`-DMAP=7` is an unknown
  option), and the `=` is mandatory. So a bare `NAME` entry maps to `NAME=TRUE`, C's
  "defined as 1" (TRUE coerces to 1, and `-D DEBUG=TRUE` is baron's own help example).
- A second `-D` of the same name is an error: "Duplicate symbol", with a "First defined
  here" note. So the configured entries really are DEFAULTS. A name the base switches
  define (buildArgs, or the Assemble-with-Switches line) is dropped from them, as is a
  repeated entry after its first. This mirrors the existing baron.outputFile / `-o` rule.
- Symbol names are case-sensitive (`-D MAP=7` leaves `map` undefined; `-D MAP` plus
  `-D map` is no duplicate), so overrides match case-sensitively.
- Defines apply in argv order, and an expression may name an earlier define
  (`-D N=MAP` works). So the defaults go BEFORE the base switches, which lets an explicit
  `-D` build on a default.
- A `-D` diagnostic names the switch as its "file": `-D MAP=7+:1:6: error: ...`.
  publishDiagnostics used to resolve that as a relative path, giving a Problems entry
  for a nonexistent file. Those lines now go to the output channel plus a notification
  with an "Open Settings" button, shown only when the text changes (onType checks would
  otherwise repeat it every keystroke). They still count in the error totals.

Wiring: effectiveArgs() (shared by build, check and Assemble with Switches) prepends
defineSwitches(). baron.buildOverride runs an arbitrary shell command, so nothing can be
injected safely. Instead a `${defines}` placeholder expands to shell-quoted switches
(single quotes on POSIX, double quotes with `\"` on win32). Changing baron.defines
triggers a check. The logic is pure in src/core/defines.ts, with 3 tests. End to end:
real baron accepted the generated switches both spawned and through the shell-quoted
form, and an explicit `-D MAP=9` overrode a default `MAP=7`. Bumped to 0.4.3, since
0.4.2 was already pushed for publishing. 40/40 tests, typecheck clean.

## 2026-10-11: BASIC line splices, virtual sections ##

Rich asked for the extension to understand Baron statements spliced into BASIC lines
(baron issue #12, commit d1b1da8), and for a check that the keywords are up to date.

### Verified in source (baron 0.5.2.0, d1b1da8) ###
- **parse_basic_line / basic_splice_at**: a `{` that is the last non-blank character
  (space, tab, CR) of a numbered line's text opens a splice. The body is `parse_scope`
  in the CURRENT scope, so a label in it belongs to the program. Its `}` resumes the
  same line: the text after it runs to the end of that physical line, and may end in
  another `{`. The `{` test is purely textual, so a REM or string ending in `{` is a
  splice too. One that never closes runs on until something can't be Baron (the next
  numbered line, ENDBASIC), which is an error with a "Note: In the BASIC splice opened
  here" line at the `{`.
- Probed with a fresh build: `PR{`/`}INT 5` gives the INT token (a splice ends a token,
  then matching restarts), statement start carries (`20{`, `}*FX 0` is a raw star
  command), `}{` splices again at once, and nested scope braces, list literals, `'}'`
  and a `}` in a `;` comment all leave the splice open.
- **Keyword audit** against 016a764 (the 0.4.2 sync): the statement token table
  (assemble.c) and the builtin `name(` table (expression.c) are unchanged, so ASSERT and
  the rest were already covered. The only new syntax is the `virtual` section attribute
  and reopening: `SECTION name` again finds the section (sections_find) and, if it is
  virtual, carries on with it. A reopening's attributes are an error and are not applied,
  so the first line's `cmos` still holds (verified: STZ in a reopened cmos section
  assembles). Character literals, range limits, SKIP/ALIGN bounds, the &FFFF overflow
  check, the symbol dump and the ZA_CAN* label lookup change no syntax.
- Section names are not symbols: `LDA ws` is "Undefined symbol". The extension's value
  reference fallback to sections (resolve.ts) is a navigation nicety and stays.

### Grammar ###
gen-basic-grammar.js now also writes `basic-splice` and `braces`. The splice is a
begin/end rule (`{` before trailing blanks, to `}`) holding `$self`, with `braces` so a
nested `{...}` keeps its own `}`. The state that carries through a splice is modelled
by nesting. The BASIC string and the REM/DATA/`*` tails became begin/end rules with the
splice inside them, and each names its text piecewise rather than with a rule `name`.
A name on the rule would sit on the scope stack inside the splice, and every unscoped
Baron token there would pick up the REM or string colour. The splice is
`meta.embedded.splice.baron`. vscode-textmate maps `meta.embedded` back to the "Other"
token type, so VS Code pairs the splice's `{` and `}` as brackets even when the `{`
sits in a REM or a string. An unclosed splice, and the string or tail around it, end
zero-width at a line starting with a digit or ENDBASIC, as baron's error does. BASIC
strings also end at the end of the line now (they used to run on).

Tested with vscode-textmate 9.1.0 + vscode-oniguruma 2.0.1 in a scratch directory, by
dumping token scopes. Every .6502 in portalc, the baron examples and the test fixture
tokenises as before, except portalc's boot.6502 (it already uses splices, and now
colours them as Baron) and the colours loader (`*/COLOURS` is now two tokens with the
same scope).

### Parser ###
- A `splice` Block. scanBasic scans BASIC text as before, and at a line ending in `{`
  pushes a splice and hands the statement loop the position past it. A `}` closes the
  nearer of a brace scope and a splice; a splice's `}` calls resumeBasic, which scans on
  from the rest of that line. A numbered line or ENDBASIC met inside a splice resumes
  the BASIC there too (baron's error point).
- basicRanges now holds one range per stretch of BASIC text, so completion works inside
  a splice. The spliced labels sit under the BASIC block in the outline.
- A second `SECTION name` records a `section` reference (resolved straight to
  unit.sections) instead of a second definition, and takes the first one's cmos, kept
  on the new `Definition.cmos`. `virtual` joined SECTION_ATTRIBUTES and the grammar's
  section-attrs rule.

### Verification ###
- Differential dump of every def, ref resolution and mnemonic, HEAD vs new, over
  portalc and the baron examples. The only changes are intended: boot.6502's spliced
  labels now resolve (`cmd`, `message`, `basic_entry`), `.start` is found (it used to be
  skipped as junk after the opaque `10REM{` line), the junk refs `CALLPAGE` and `EQUB`
  are gone, and portalc's reopened `Tables` section is one definition plus a reference.
- Three new tests (splice scope and BASIC text, unclosed-splice recovery, reopening).
  Each fails against the old parser. Every premise was checked with baron first.
- 43/43 tests, typecheck clean. Bumped to 0.5.2 at Rich's request, aligning with baron
  0.5.2.0, then to 0.5.3 once baron moved to 0.5.3.0 for the splices and STR/VAL (package-lock.json still said 0.2.1; `npm version` brought it into line).

### STR and VAL (same day) ###
Rich asked for BASIC's STR and VAL in baron. Implemented there (uncommitted; see baron's
JOURNAL): both are element-wise `name(` operand tokens, so the extension only needed the
names in BUILTIN_FUNCTIONS (completion, and the parser's builtin check, so `STR(n)` is no
longer an undefined funccall) and in the grammar's builtin-functions rule (hand-written,
not generated). One test. 44/44.
Renamed the same day to AS_STRING / AS_NUMBER (Rich's call): they pair with IS_STRING /
IS_NUMBER, and a builtin reserves its name against user FUNCTIONs, so STR and VAL would
have broken programs that define their own. data.ts, the grammar rule and the test follow.

### Macro calls coloured as keywords (2026-10-12) ###
Rich found macro calls hard to tell from labels: `macroCall` mapped to
entity.name.function.macro.baron, which Dark+ (like most themes) colours the same as
labels, function names and builtins. At Rich's request it now maps to
keyword.control.directive.macro.baron, the directives' colour (purple in Dark+), not the
mnemonics' `keyword` blue or the ZA_ teal. Its superType is now `keyword`, so a theme
with semantic keyword colours treats it as one too. The MACRO line's own name and
`functionCall` are unchanged.

Rich had also seen cross-file macro calls go uncoloured for a while. A dump of portalc's
two units from disk resolved and matched all 58 macro calls through their INCLUDEs, and it
came right by itself. The real cause turned up next (below).

### Stale units: disk writes and git's HEAD copies (2026-10-12) ###
It came back: VCACHE_VERT gave "no definition found" in capture.6502, though portal.6502
INCLUDEs src/vcache_macros.6502 first. The disk dump resolved it fine, so the cached
units were stale. An agent is rewriting portalc outside VS Code (it had just split the
macros into new src/*_macros.6502 files and rewritten portal.6502's INCLUDEs). Two holes:

- Project marked itself dirty only on onDidChangeTextDocument, configuration changes and
  onDidCreate/Delete/RenameFiles. Those last three fire only for operations VS Code makes
  itself, and the first only for loaded documents. So a file written on disk and not
  loaded in VS Code kept its old parse, offsets and INCLUDEs included, until some
  document change in VS Code. Now a FileSystemWatcher on `**/*` marks the units dirty
  for any file they involve: a root, a parsed file, or an INCLUDE/INCBIN target, the
  latter recorded even when missing, so a file created later counts. It fires
  onDidChangeOnDisk, and extension.ts then recolours and runs a check, unless
  baron.check is off. Files loaded in VS Code are skipped: VS Code reloads them itself,
  with a change event, and counting them as well would check every save twice. The
  three workspace file-operation handlers went, since the watcher sees those writes too.
- getText took the first workspace.textDocuments entry whose fsPath matched. The git
  extension's HEAD copies (scheme `git`, loaded for diffs and the quick-diff gutter)
  have the same fsPath, so a unit could be parsed from last commit's portal.6502, whose
  INCLUDEs predate the *_macros files. The check's mirror had the same lookup, so it
  could write the HEAD text into the shadow tree. Both now take only `file` and
  `untitled` documents (project.ts isSourceDoc). The providers' selector is narrowed
  the same way: a diff's git: side is last commit's text, so tokens and lookups computed
  from the working file don't fit it.

Not covered: the watcher sees the workspace folders only, so a file INCLUDEd from outside
them is still read fresh only when something else marks the units dirty. Typecheck and
44/44 tests (the core tests can't reach the VS Code layer, so this needs trying in VS Code).

### 0.5.4 (2026-10-12) ###
0.5.3 had already gone to the marketplace (2026-10-11 20:46, after the AS_STRING rename),
so the macro-call colour and the two stale-unit fixes ship as 0.5.4, at Rich's request.
The extension is now ahead of baron's 0.5.3.0.
