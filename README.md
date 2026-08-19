# baron-vsc #

Visual Studio Code language support for the [Baron](https://github.com/waitingforvsync/baron)
6502 assembler — the spiritual successor to BeebAsm (and to
[beeb-vsc](https://github.com/simondotm/beeb-vsc), which inspired this extension).

## Features ##

### Syntax highlighting ###
A TextMate grammar covering the whole Baron language: mnemonics (NMOS and 65C02),
directives, labels, scopes, strings (with `""` escapes), `&`/`$` hex and `%` binary
numbers, lists, ranges (`..` / `..<`), operators, built-in functions, and both `;` and
`\` comments. Inline `BASIC` … `ENDBASIC` blocks are highlighted as BBC BASIC with the
ROM tokeniser's real matching rules (generated from baron's `basic.c` table): keywords
match in ROM table order without needing whitespace (`FORX=1TO10` is `FOR`, `X`, `TO`),
the conditional-flag veto applies (`COUNT` is a keyword, `COUNTER` a variable), `P.`-style
abbreviations resolve to the right keyword, `PROC`/`FN` names, `*` commands, `REM`/`DATA`
raw tails, uppercase-only `&` hex, and line numbers.

### CMOS-aware opcode colouring ###
The parser tracks `SECTION` nesting and evaluates the `cmos` attribute (inherited by
nested sections, exactly as baron does). 65C02-only instructions — the extra mnemonics,
and the CMOS-only addressing modes such as `LDA (zp)`, `BIT #`, `BIT zp,X`, `INC A` and
`JMP (abs,X)` — are coloured as ordinary opcodes inside a `cmos = TRUE` section, and as
**invalid** (red) in plain NMOS context, via semantic tokens.

### Navigation and editing ###
A TypeScript parser mirroring baron's own (lexer.c / assemble.c / expression.c are the
reference) understands symbols, labels, named and anonymous scopes, local labels
(`.@`, `@-`, `@+`), macros (with overloads), functions, sections, `INCLUDE`s, and full
expressions including multi-line lists, ranges and subscripts. On top of it:

- **Go to definition** (F12) — works on dotted paths (`wipe.nonzero`), macro calls,
  `INCSECTION` names, `@-`/`@+`, and `INCLUDE`/`INCBIN` file names.
- **Find all references** (Shift+F12).
- **Hover** — the defining line, its scope, doc comments above it, and the evaluated
  value of constant symbols (decimal and hex).
- **Completion** — keywords, mnemonics, macros at statement start; visible symbols,
  functions, built-ins in expressions; members after `scope.`; section names after
  `INCSECTION`; attribute names on `SECTION` lines.
- **Outline / breadcrumbs** — sections, scopes, labels, macros, functions, symbols.

Scoping follows baron precisely: labels bind in the enclosing scope, a label immediately
before `{` names the scope (one separator allowed between), anonymous scopes are private,
`IF` does not scope, `FOR` bodies and macro/function bodies do.

### Checking and building ###
- **Check on save** (`baron.checkOnSave`, on by default) — every save runs
  `baron --check` in the background: a full assembly of the root set (branch range,
  undefined symbols, expression errors — everything the real assembler knows) that
  writes no output files. Errors land in the Problems panel as red squiggles. The check
  runs asynchronously and a newer save kills and supersedes an in-flight one, so slow
  assemblies never block the editor. Requires a baron built with `--check` support;
  also available manually as **Baron: Check**.
- **Baron: Assemble** (`Ctrl+Alt+B`) — runs baron on the configured root files with the
  configured switches. Errors and warnings land in the Problems panel and the *Baron*
  output channel.
- **Baron: Assemble with Switches...** (`Ctrl+Alt+Shift+B`) — prompts for the switches
  first (remembered per workspace).
- **Baron: Run in Emulator** (`Ctrl+Alt+R`) — assembles, then launches the configured
  emulator with the disc image named by `-o` in `baron.buildArgs`. Defaults suit
  [b2](https://github.com/tom-seddon/b2) (`b2 -b -0 <image>`: boot drive 0); point
  `baron.emulatorPath` at the binary and shape `baron.emulatorArgs` for other emulators —
  `${image}` in an argument is replaced by the image path (appended if absent).
  Re-running kills the previously launched emulator instance, so build-and-try is one
  keypress.
- **Baron: Set Root Source Files from Active Editor** — quick way to set
  `baron.sourceFiles`.
- A `$baron` problem matcher is contributed for custom tasks.

## Setup ##

In your workspace `.vscode/settings.json`:

```json
{
  "baron.executablePath": "/path/to/baron",
  "baron.sourceFiles": ["boot.6502", "loader.6502", "demo.6502"],
  "baron.buildArgs": ["--opt", "3", "--title", "STARGLOBE", "-o", "demo.ssd", "-v"]
}
```

`baron.sourceFiles` is the root set — the files you would pass on the baron command line.
Each assembles independently (its own symbol table), and together with their `INCLUDE`
graphs they define what go-to-definition can see. With no root files configured, the
active editor's file is used.

If baron isn't on your PATH, point `baron.executablePath` at the binary. Set
`baron.checkOnSave` to `false` to turn off the on-save check.

## Development ##

```
npm install
npm run build     # bundle to dist/extension.js
npm test          # core parser tests (no VS Code needed)
npm run package   # build the .vsix
```

Press F5 in VS Code to launch an Extension Development Host. `JOURNAL.md` records the
verified-against-baron-source behaviour notes; when the language and the docs disagree,
the baron C source is the authority.
