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
The parser tracks `SECTION` nesting and evaluates each section's own `cmos` attribute
(not inherited by nested sections, exactly as baron does). 65C02-only instructions — the extra mnemonics,
and the CMOS-only addressing modes such as `LDA (zp)`, `BIT #`, `BIT zp,X`, `INC A` and
`JMP (abs,X)` — are coloured as ordinary opcodes inside a `cmos = TRUE` section, and as
**invalid** (red) in plain NMOS context, via semantic tokens.

### Macro and function call colouring ###
A macro invocation or `FUNCTION` call is coloured like the macro or function name in its
definition, but only when baron would accept the call where it stands: the macro or
function is defined *earlier* (both are define-before-use), and one of its overloads fits
the call — the macro signature's parameters, commas and quoted literal tokens, matched
the way baron matches them, or the function's argument count. A misspelt, misordered or
mis-shaped call stays plain text, so you can see at a glance whether it is right. A
function call needs its `(` directly after the name (`f(x)`, not `f (x)`), as in baron.
The semantic token types are `macroCall` and `functionCall`, if you want to give them
their own colours with `editor.semanticTokenColorCustomizations`.

### Navigation and editing ###
A TypeScript parser mirroring baron's own (lexer.c / assemble.c / expression.c are the
reference) understands symbols, labels, named and anonymous scopes, local labels
(`.@`, `@-`, `@+`), macros (with overloads), functions, sections, `INCLUDE`s, and full
expressions including multi-line lists, ranges and subscripts. On top of it:

- **Go to definition** (F12) — works on dotted paths (`wipe.nonzero`), macro
  invocations and function calls (straight to the overload the call matches; macros
  and functions are their own namespaces, so a label sharing a macro's name never gets
  in the way), `@-`/`@+`, and `INCLUDE`/`INCBIN` file names.
- **Find all references** (Shift+F12).
- **Hover** — the defining line, its scope, doc comments above it, and the evaluated
  value of constant symbols (decimal and hex).
- **Completion** — keywords, mnemonics, macros at statement start; visible symbols,
  functions, built-ins in expressions; members after `scope.`; attribute names on
  `SECTION` lines.
- **Outline / breadcrumbs** — sections, scopes, labels, macros, functions, symbols.

Scoping follows baron precisely: labels bind in the enclosing scope, a label immediately
before `{` names the scope (one separator allowed between), anonymous scopes are private,
`IF` does not scope, `FOR` bodies and macro/function bodies do.

### Checking and building ###
- **Live checking** (`baron.check`, default `onType`) — `baron --check` runs in the
  background shortly after you stop typing (and on save): a full assembly of the root
  set (branch range, undefined symbols, expression errors — everything the real
  assembler knows) that writes no output files. Unsaved edits are included: the check
  runs against a shadow copy of the sources carrying the live editor buffers. Errors
  land in the Problems panel as red squiggles. Checks are asynchronous and a newer one
  kills and supersedes an in-flight one, so slow assemblies never block the editor.
  Set `baron.check` to `onSave` or `off` to dial it back; **Baron: Check** runs one
  manually. Requires a baron built with `--check` support.
- **Baron: Assemble** (`F7`) — runs baron on the configured root files with the
  configured switches. Errors and warnings land in the Problems panel and the *Baron*
  output channel.
- **Baron: Assemble with Switches...** (`Ctrl+F7`) — prompts for the switches
  first (remembered per workspace).
- **Baron: Run in Emulator** (`F5`) — assembles, then launches the configured
  emulator with the disc image (`baron.outputFile`, or an explicit `-o` in
  `baron.buildArgs`, which wins if both are set). Defaults suit
  [b2](https://github.com/tom-seddon/b2) (`b2 -b -0 <image>`: boot drive 0); point
  `baron.emulatorPath` at the binary and shape `baron.emulatorArgs` for other emulators —
  `${image}` in an argument is replaced by the image path (appended if absent).
  Re-running kills the previously launched emulator instance, so build-and-try is one
  keypress.
- **Baron: Select Root Source Files...** — tick the root files from a list of the
  workspace's `.6502` files (sets `baron.sourceFiles`; the configured order is kept for
  files that stay selected, since sections land on the disc in file order).
- **Baron: Set Output Disc Image...** — sets `baron.outputFile`, which is passed to
  baron as `-o` automatically, so the switches never need one.
- **Baron: Set Root Source Files from Active Editor** — quick way to set
  `baron.sourceFiles` to just the current file.
- A `$baron` problem matcher is contributed for custom tasks.

## Setup ##

In your workspace `.vscode/settings.json`:

```json
{
  "baron.executablePath": "/path/to/baron",
  "baron.sourceFiles": ["boot.6502", "loader.6502", "demo.6502"],
  "baron.outputFile": "demo.ssd",
  "baron.buildArgs": ["--opt", "3", "--title", "STARGLOBE", "-v"],
  "baron.defines": ["MAP=7", "DEBUG"]
}
```

(Or use the commands: *Baron: Select Root Source Files...* and *Baron: Set Output Disc
Image...* write these settings for you.)

`baron.sourceFiles` is the root set — the files you would pass on the baron command line.
Each assembles independently (its own symbol table), and together with their `INCLUDE`
graphs they define what go-to-definition can see. With no root files configured, the
active editor's file is used.

`baron.defines` holds default `-D` symbol definitions, in the same shape as the C/C++
extension's `C_Cpp.default.defines`: a list of `NAME=expression` entries (edited as a
list in the Settings UI), where a bare `NAME` means `NAME=TRUE`. They are passed to every
build and every background check. They are defaults: a name the switches already define
(`-D NAME=...` in `baron.buildArgs`, or typed into **Assemble with Switches...**) uses
that value instead, since baron rejects the same name defined twice. Names are
case-sensitive, as baron's symbols are. If baron rejects a definition, the error appears
in the *Baron* output channel with a link to the setting.

If baron isn't on your PATH, point `baron.executablePath` at the binary. Set
`baron.check` to `onSave` or `off` to dial back the live checking.

To build with your own script instead of the default invocation, set
`baron.buildOverride` to any shell command (e.g. `"./build.sh"`): **Baron: Assemble**
and the build step of **Run in Emulator** then run it verbatim (its stderr is still
parsed for `file:line:col` diagnostics; `${defines}` in it expands to the
`baron.defines` entries as `-D` switches, each quoted for the shell, e.g.
`"./build.sh ${defines}"`), while checks and **Assemble with Switches...**
keep invoking baron directly with `baron.sourceFiles`.

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
