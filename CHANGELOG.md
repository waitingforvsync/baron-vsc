# Changelog #

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
