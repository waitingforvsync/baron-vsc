# Changelog #

## 0.6.0 (2026-10-19) ##

Version aligned with baron 0.6.0.0.

- Section transforms: the `transform` attribute is highlighted and completed, and the name
  in `transform = "name"` goes to the `FUNCTION` that makes the section's bytes, with hover
  and find references too. The function can be defined anywhere in the program, since baron
  runs the transform once everything is defined, and an overload taking one argument comes
  first, since baron passes it the section's bytes alone.
- `BITLEN`, `BITPACK` and `LZ_PARSE`, baron's bit-packing and compression builtins, are
  highlighted, completed and parsed as builtins.
- Sections own their bytes (baron issue #17), so more of them can be reopened by naming
  them again: any top-level section, a virtual section inside a real one, and a section
  with its own `org` inside a virtual one. The second `SECTION` line goes to the first
  one's definition, as a reopened virtual section's already did.
- A `FUNCTION`'s locals count only from their assignment on, as baron now runs a body: a
  name read before a local of the same name is assigned goes to the outer definition.
- baron's new level-3 warning, a branch whose target is on another page, reaches the
  Problems panel with `--warn 3` in `baron.buildArgs`, which the background check uses too.

## 0.5.4 (2026-10-12) ##

- Files changed on disk outside VS Code (by a build script, git or an agent) are now
  picked up. Go to definition, hover, the outline and the colouring used to go on using a
  file's old text until something was edited in VS Code, and a new file wasn't seen even
  when an existing one INCLUDEd it. Such a change now reparses the files and reruns the
  check, unless `baron.check` is `off`.
- The extension no longer reads a file's last committed version in place of the file
  itself. The git extension keeps copies of the committed versions for diffs and the
  gutter change markers, and the extension could parse one of those instead, so it saw
  last commit's INCLUDEs and macros. The background check could pick up the same stale
  copy. The language features now ignore the committed side of a diff view as well.
- A macro invocation is now coloured like a directive keyword, the colour of `IF` or
  `EQUB`, rather than like the macro's name in its definition. That was the colour of
  labels and function names too, so a macro call looked like a label. A macro call still
  stays plain when baron wouldn't accept it.

## 0.5.3 (2026-10-11) ##

Version aligned with baron 0.5.3.0 (there was no 0.5.0, 0.5.1 or 0.5.2 plugin release).

- BASIC line splices (baron issue #12): a `{` ending a line inside `BASIC` ... `ENDBASIC`
  drops into Baron until its `}`, and the line carries on after it. The splice is
  highlighted as Baron and parsed in the current scope, so its labels show in the outline
  under the BASIC block, and go to definition, hover and the CMOS and call colouring all
  work inside it. The BASIC text after the `}` keeps its state: a string or a `REM`,
  `DATA` or `*` tail continues through the splice. A splice left open stops at the next
  numbered line or `ENDBASIC`, where baron reports it, so the rest of the file stays
  coloured correctly while you type.
- A BASIC string now ends at the end of its line, as in BBC BASIC. An unterminated one
  used to run on into the next line.
- `AS_STRING(n)` and `AS_NUMBER(s)`, baron's new number-to-text and text-to-number
  builtins, are highlighted, completed and parsed as builtins.
- The `virtual` section attribute is highlighted and completed. Naming a virtual section
  again reopens it: the second `SECTION` line now goes to the first one's definition,
  and its code keeps that section's `cmos` setting, as baron does.

## 0.4.3 (2026-10-02) ##

- New `baron.defines` setting: default `-D` symbol definitions passed to every build and
  background check, as a list like the C/C++ extension's `C_Cpp.default.defines`. Each
  entry is `NAME=expression`, or a bare `NAME` for `NAME=TRUE`. A name the build switches
  define themselves (`baron.buildArgs`, or **Assemble with Switches...**) overrides the
  default. `${defines}` in `baron.buildOverride` expands to them as `-D` switches.
  Changing the setting re-runs the check.
- Errors baron reports against a `-D` switch go to the output channel and a notification
  linking to the setting, instead of a Problems entry for a file that doesn't exist.

## 0.4.2 (2026-10-01) ##

- `ASSERT cond [, message...]` (baron 0.4.1): highlighted as a directive, completed at
  statement start, and parsed both as a statement and inside a `FUNCTION` body. It was
  previously misread as a call to an undefined macro.
- Go to definition (and hover / find references) on a macro invocation or a function
  call now goes to the macro or function, and to the specific overload the call
  matches. Macros and functions are now kept in their own namespaces as baron keeps
  them, so `OUT 0` next to a `.out` label no longer jumps to the label, and a symbol
  reference no longer resolves to a macro that shares its name.
- Macro and function calls are coloured (semantic token types `macroCall` /
  `functionCall`) when baron would accept them: defined earlier, with an overload that
  fits. Anything else stays plain, so a bad call stands out.
- Macro invocations are matched against the macro's signatures the way baron matches
  them, so a list literal argument (`palette {black, red}`) is an argument, not a
  scope, and its contents are no longer misread as statements. A `{` after the last
  argument still opens a scope.
- A function call is recognised only with its `(` directly after the name, as in baron;
  `f (x)` is a reference to the symbol `f`.

## 0.4.1 (2026-09-24) ##

- The check-on-type shadow copy now preserves the document's own encoding. It was
  always written as UTF-8, so a Latin-1/Windows-1252 source with high-bit bytes in a
  string literal (custom glyphs, say) turned each of them into a two-byte sequence -
  and the extension reported errors that running baron on the saved file did not
  (baron issue #8). Uses the VS Code encoding API (1.100+); older hosts keep the old
  behaviour, which is exact for UTF-8 buffers.

## 0.4.0 (2026-09-23) ##

Version aligned with baron 0.4.0.0 (there was no 0.3.x plugin release; baron 0.3.0's
sections redesign and the 0.4.0 keywords land here together).

- New allocator keywords: `ZA_WIPE` (placed after a zero-page wipe loop, blesses the
  sweep) and `ZA_INDEXEDBY` (declares an indexed access's index set - takes a value
  list). Both highlight in the `ZA_` category and complete at statement start.
- Verbatim assignments recognised: `@next = 5` binds `next` even when the name spells a
  keyword or mnemonic - highlighted, parsed and indexed as a symbol definition.
- A `{` now ends the statement before it, as in baron: `LDX #8 {`, `DEX {`, `ASL A {`
  and `mymacro 7 { ... }` all open a scope after the statement, and the parser's scope
  tracking follows.
- `INCSECTION` removed (baron 0.3.0 dropped it): no longer highlighted, parsed or
  completed.
- Nested `SECTION`s no longer inherit attributes (baron 0.3.0): a section without its
  own `cmos = TRUE` targets plain NMOS, so CMOS-only mnemonics inside it are flagged
  even under a CMOS-enabled outer section.

## 0.2.1 (2026-08-31) ##

- Brackets inside comments and strings are no longer rainbow-coloured by the
  editor's bracket-pair colorization (the grammar now declares
  `unbalancedBracketScopes` for comment and string tokens).

## 0.2.0 (2026-08-30) ##

- Zero-page allocator keywords renamed to match baron's new `ZA_` spelling:
  `ZPRESERVE` -> `ZA_POOL`, `ZPAUTO`/`ZPAUTO1`/`ZPAUTO2` -> `ZA_AUTO`/`ZA_AUTO1`/
  `ZA_AUTO2`, `UNREACHABLE` -> `ZA_UNREACHABLE`, `CANCALL` -> `ZA_CANCALL`,
  `CANJUMP` -> `ZA_CANJUMP`, `DISCARD` -> `ZA_DISCARD`, `ZPENTRY` -> `ZA_ENTRY`,
  `ZPINTERRUPT` -> `ZA_INTERRUPT`. The old spellings are no longer recognised.
- New allocator keywords: `ZA_RETURN` (this jump returns to our caller) and
  `ZA_RETURNTO` (where a JSR resumes - takes a target list).
- New pseudo-opcodes `BITZP` / `BITABS` (emit a BIT opcode that swallows the
  next one or two bytes), highlighted and completed as mnemonics.
- All `ZA_` keywords now highlight in their own syntax category
  (`support.type.zeropage.baron`), so they colour differently from the other
  directives.

## 0.1.3 (2026-08-28) ##

- `REPEATED` recognised by the highlighter, parser and completions - baron's new
  alias for the `FULL` builtin.
- The string and type builtins caught up: `TRUNC`, `CODES`, `CHR`, `FIND`,
  `IS_STRING`, `IS_NUMBER` and the `ERROR(...)` function form, plus the unary `~`
  hex-format operator, all recognised by the highlighter, parser and completions.

## 0.1.2 (2026-08-27) ##

- New directive keywords recognised by the highlighter, parser and completions:
  `DISCARD` (a ZPAUTO value is dead here - takes a variable list), and the bare
  markers `ZPENTRY` / `ZPINTERRUPT` (entry-point / interrupt-handler roots for the
  zero-page allocator).

## 0.1.1 (2026-08-19) ##

- **Live checking**: `baron --check` runs in the background as you type (debounced) and
  on save — full assembly diagnostics (branch range, undefined symbols, expression
  errors) in the Problems panel, with no output files written. Unsaved edits are checked
  via a shadow copy of the sources. Asynchronous and latest-run-wins; a slow assembly
  never blocks the editor. Also available manually as *Baron: Check*.
  (`baron.check`: `onType` (default) / `onSave` / `off`.)
- **`baron.buildOverride`**: a shell command that completely replaces the default build
  invocation (for *Baron: Assemble* and *Run in Emulator*'s build step) — e.g. a build
  script. Its stderr is still parsed into the Problems panel.
- **Run in Emulator** (*Baron: Run in Emulator*): assembles, then boots the built disc
  image in the configured emulator (defaults suit b2). Re-running replaces the previous
  emulator instance. (`baron.emulatorPath`, `baron.emulatorArgs` with `${image}`.)
- **Faithful BBC BASIC highlighting**: keywords match with the ROM tokeniser's real
  rules — no whitespace needed (`FORX=1TO10`), conditional-flag veto (`COUNT` vs
  `COUNTER`), `P.`-style abbreviations, `*` commands, `REM`/`DATA` raw tails.
- **Char literals** (`'X'`) recognised by the highlighter, the parser and hover
  evaluation.
- **Parser error recovery**: a syntax error skips to the next separator, with correct
  brace-nesting recovery inside multi-line list literals — broken code no longer
  confuses scope tracking for the rest of the file.
- **Keybindings**: `F5` run in emulator, `F7` assemble, `Ctrl+F7` assemble with
  switches (previously `Ctrl+Alt+R` / `Ctrl+Alt+B` / `Ctrl+Alt+Shift+B`).
- **Baron: Select Root Source Files...** — pick the root set from the workspace's
  `.6502` files; **Baron: Set Output Disc Image...** — sets `baron.outputFile`, passed
  to baron as `-o` automatically (no `-o` needed in `baron.buildArgs`).
- The extension icon is now the BBC Micro owl.

## 0.1.0 (2026-08-18) ##

First release.

- Syntax highlighting for the full Baron language, including inline BBC BASIC blocks.
- CMOS-aware opcode colouring via semantic tokens: 65C02-only mnemonics and addressing
  modes are marked invalid outside a `cmos = TRUE` section.
- Parser-backed go to definition, find references, hover, completion and outline, with
  full understanding of scopes, local labels, macros, functions, sections, includes and
  expressions (multi-line lists, ranges, subscripts).
- Build commands (`Ctrl+Alt+B` / `Ctrl+Alt+Shift+B`) with Problems-panel diagnostics and
  a `$baron` problem matcher.
