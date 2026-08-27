# Changelog #

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
