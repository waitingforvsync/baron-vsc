# Changelog #

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
