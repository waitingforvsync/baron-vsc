// Language feature providers, all built on the parsed unit model.

import * as vscode from 'vscode';
import {
  BUILTIN_FUNCTIONS,
  DIRECTIVES,
  MNEMONICS,
  SECTION_ATTRIBUTES,
} from './core/data';
import { offsetToLineChar } from './core/lexer';
import {
  Definition,
  evalConst,
  FileIndex,
  Scope,
  scopeAt,
  scopePath,
  Unit,
} from './core/model';
import { defKey, findAt, resolveLocal, resolveRef } from './core/resolve';
import { docFile, Project } from './project';

// ---- position conversion ----

function toPosition(index: FileIndex, offset: number): vscode.Position {
  const lc = offsetToLineChar(index.lineStarts, offset);
  return new vscode.Position(lc.line, lc.character);
}

function toRange(index: FileIndex, start: number, end: number): vscode.Range {
  return new vscode.Range(toPosition(index, start), toPosition(index, end));
}

function toLocation(unit: Unit, file: string, start: number, end: number): vscode.Location | undefined {
  const index = unit.files.get(file);
  if (!index) {
    return undefined;
  }
  return new vscode.Location(vscode.Uri.file(file), toRange(index, start, end));
}

function positionToOffset(index: FileIndex, pos: vscode.Position): number {
  const line = Math.min(pos.line, index.lineStarts.length - 1);
  return index.lineStarts[line] + pos.character;
}

/** Every definition the cursor position denotes, across all units containing the file. */
function definitionsAt(project: Project, doc: vscode.TextDocument, pos: vscode.Position):
  { defs: Definition[]; units: Unit[] } {
  const file = docFile(doc);
  const units = project.unitsForFile(file);
  const defs: Definition[] = [];
  for (const unit of units) {
    const index = unit.files.get(file);
    if (!index) {
      continue;
    }
    const offset = positionToOffset(index, pos);
    const found = findAt(index, offset);
    if (!found) {
      continue;
    }
    if (found.type === 'def') {
      defs.push(found.def);
    } else if (found.type === 'ref') {
      defs.push(...resolveRef(unit, found.ref, found.partIndex));
    } else if (found.type === 'local') {
      const d = resolveLocal(index, found.lref);
      if (d) {
        defs.push(d);
      }
    }
  }
  return { defs, units };
}

// ---- definition provider ----

export class BaronDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly project: Project) {}

  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Definition | undefined {
    const file = docFile(doc);
    const units = this.project.unitsForFile(file);

    // Include/incbin strings jump to the file.
    for (const unit of units) {
      const index = unit.files.get(file);
      if (!index) {
        continue;
      }
      const found = findAt(index, positionToOffset(index, pos));
      if (found?.type === 'file' && found.resolved) {
        return new vscode.Location(vscode.Uri.file(found.resolved), new vscode.Position(0, 0));
      }
    }

    const { defs, units: found } = definitionsAt(this.project, doc, pos);
    const seen = new Set<string>();
    const locations: vscode.Location[] = [];
    for (const def of defs) {
      if (seen.has(defKey(def))) {
        continue;
      }
      seen.add(defKey(def));
      for (const unit of found) {
        const loc = toLocation(unit, def.loc.file, def.loc.start, def.loc.end);
        if (loc) {
          locations.push(loc);
          break;
        }
      }
    }
    return locations.length > 0 ? locations : undefined;
  }
}

// ---- references provider ----

export class BaronReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly project: Project) {}

  provideReferences(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    ctx: vscode.ReferenceContext,
  ): vscode.Location[] {
    const file = docFile(doc);
    const { defs } = definitionsAt(this.project, doc, pos);
    if (defs.length === 0) {
      return [];
    }
    const targets = new Set(defs.map(defKey));
    const results: vscode.Location[] = [];
    const seen = new Set<string>();
    const push = (unit: Unit, f: string, start: number, end: number) => {
      const key = `${f}:${start}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const loc = toLocation(unit, f, start, end);
      if (loc) {
        results.push(loc);
      }
    };

    for (const unit of this.project.searchUnits(file)) {
      for (const index of unit.files.values()) {
        for (const ref of index.refs) {
          for (let i = 0; i < ref.parts.length; i++) {
            if (resolveRef(unit, ref, i).some((d) => targets.has(defKey(d)))) {
              push(unit, index.file, ref.parts[i].loc.start, ref.parts[i].loc.end);
            }
          }
        }
        for (const lref of index.localRefs) {
          const d = resolveLocal(index, lref);
          if (d && targets.has(defKey(d))) {
            push(unit, index.file, lref.loc.start, lref.loc.end);
          }
        }
        if (ctx.includeDeclaration) {
          for (const def of index.defs) {
            if (targets.has(defKey(def))) {
              push(unit, index.file, def.loc.start, def.loc.end);
            }
          }
        }
      }
    }
    return results;
  }
}

// ---- hover provider ----

const KIND_LABEL: Record<Definition['kind'], string> = {
  label: 'label',
  locallabel: 'local label',
  symbol: 'symbol',
  macro: 'macro',
  function: 'function',
  section: 'section',
  param: 'parameter',
  forvar: 'loop variable',
  zpvar: 'zero-page variable',
};

function defLineText(unit: Unit, def: Definition): string | undefined {
  const index = unit.files.get(def.loc.file);
  if (!index) {
    return undefined;
  }
  const lc = offsetToLineChar(index.lineStarts, def.loc.start);
  const start = index.lineStarts[lc.line];
  const end = lc.line + 1 < index.lineStarts.length
    ? index.lineStarts[lc.line + 1] - 1
    : index.text.length;
  return index.text.slice(start, end).trim();
}

function docComment(unit: Unit, def: Definition): string | undefined {
  const index = unit.files.get(def.loc.file);
  if (!index) {
    return undefined;
  }
  const lc = offsetToLineChar(index.lineStarts, def.loc.start);
  const lines: string[] = [];
  for (let line = lc.line - 1; line >= 0; line--) {
    const start = index.lineStarts[line];
    const end = index.lineStarts[line + 1] - 1;
    const text = index.text.slice(start, end).trim();
    const m = /^[;\\]+\s?(.*)$/.exec(text);
    if (!m) {
      break;
    }
    lines.unshift(m[1]);
  }
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export class BaronHoverProvider implements vscode.HoverProvider {
  constructor(private readonly project: Project) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const { defs, units } = definitionsAt(this.project, doc, pos);
    if (defs.length === 0) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    const shown = new Set<string>();
    for (const def of defs.slice(0, 4)) {
      if (shown.has(defKey(def))) {
        continue;
      }
      shown.add(defKey(def));
      const unit = units.find((u) => u.files.has(def.loc.file)) ?? units[0];
      const line = defLineText(unit, def);
      if (line) {
        md.appendCodeblock(line, 'baron');
      }
      const where = scopePath(def.scope);
      const lc = unit.files.get(def.loc.file)
        ? offsetToLineChar(unit.files.get(def.loc.file)!.lineStarts, def.loc.start)
        : undefined;
      let detail = `*${KIND_LABEL[def.kind]}*`;
      if (where) {
        detail += ` in scope \`${where}\``;
      }
      if (lc !== undefined) {
        detail += ` — ${vscode.workspace.asRelativePath(def.loc.file)}:${lc.line + 1}`;
      }
      md.appendMarkdown(detail + '\n\n');
      if (def.kind === 'symbol') {
        const v = evalConst(def.valueExpr);
        if (v !== undefined && Number.isFinite(v)) {
          const hex = Number.isInteger(v) && v >= 0 ? ` (&${v.toString(16).toUpperCase()})` : '';
          md.appendMarkdown(`value: \`${v}\`${hex}\n\n`);
        }
      }
      const comment = docComment(unit, def);
      if (comment) {
        md.appendMarkdown(comment.replace(/\n/g, '  \n') + '\n\n');
      }
    }
    return new vscode.Hover(md);
  }
}

// ---- document symbols ----

const OUTLINE_KIND: Record<string, vscode.SymbolKind> = {
  section: vscode.SymbolKind.Module,
  scope: vscode.SymbolKind.Namespace,
  label: vscode.SymbolKind.Function,
  locallabel: vscode.SymbolKind.Function,
  symbol: vscode.SymbolKind.Constant,
  macro: vscode.SymbolKind.Method,
  function: vscode.SymbolKind.Function,
  zpvar: vscode.SymbolKind.Variable,
  param: vscode.SymbolKind.Variable,
  forvar: vscode.SymbolKind.Variable,
  basic: vscode.SymbolKind.Object,
};

export class BaronDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly project: Project) {}

  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const file = docFile(doc);
    const [unit] = this.project.unitsForFile(file);
    const index = unit?.files.get(file);
    if (!index) {
      return [];
    }
    const convert = (nodes: typeof index.outline): vscode.DocumentSymbol[] =>
      nodes.map((n) => {
        const full = toRange(index, Math.min(n.fullLoc.start, n.loc.start), Math.max(n.fullLoc.end, n.loc.end));
        const sel = toRange(index, n.loc.start, n.loc.end);
        const sym = new vscode.DocumentSymbol(
          n.name,
          n.detail ?? '',
          OUTLINE_KIND[n.kind] ?? vscode.SymbolKind.Object,
          full,
          sel,
        );
        sym.children = convert(n.children);
        return sym;
      });
    return convert(index.outline);
  }
}

// ---- completion ----

export class BaronCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly project: Project) {}

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const file = docFile(doc);
    const units = this.project.unitsForFile(file);
    const unit = units[0];
    const index = unit?.files.get(file);
    if (!index) {
      return [];
    }
    const offset = positionToOffset(index, pos);
    if (index.basicRanges.some((r) => offset >= r.start && offset <= r.end)) {
      return []; // no assembler completion inside a BASIC block
    }
    const linePrefix = doc.lineAt(pos.line).text.slice(0, pos.character);
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    const add = (label: string, kind: vscode.CompletionItemKind, detail?: string) => {
      const key = label.toLowerCase() + ':' + kind;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const item = new vscode.CompletionItem(label, kind);
      if (detail) {
        item.detail = detail;
      }
      items.push(item);
    };

    // On a SECTION line after a comma: attribute names.
    if (/(?:^|:)\s*section\s+\w+\s*,[^=]*$/i.test(linePrefix) && !/=\s*[^,]*$/.test(linePrefix)) {
      for (const attr of SECTION_ATTRIBUTES) {
        add(attr, vscode.CompletionItemKind.Property, 'section attribute');
      }
      return items;
    }

    // Dotted member access: descend the named scopes.
    const dotted = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.\w*$/.exec(linePrefix);
    if (dotted) {
      const scope = scopeAt(index, offset);
      const parts = dotted[1].split('.');
      for (const u of units) {
        const idx = u.files.get(file);
        if (!idx) {
          continue;
        }
        let defs: Definition[] | undefined = scopeAt(idx, offset).lookupChain(parts[0].toLowerCase());
        for (let i = 1; i < parts.length && defs; i++) {
          defs = defs.flatMap((d) => d.namedScope?.lookupLocal(parts[i].toLowerCase()) ?? []);
        }
        for (const d of defs ?? []) {
          if (d.namedScope) {
            for (const [, members] of d.namedScope.symbols) {
              for (const m of members) {
                add(m.name, completionKind(m), m.detail);
              }
            }
          }
        }
      }
      void scope;
      return items;
    }

    // Statement start: keywords, mnemonics, macros.
    const statementStart = /(?:^|:)\s*[A-Za-z_]?\w*$/.test(linePrefix) && !/[=#(,\[]/.test(linePrefix);
    if (statementStart) {
      for (const kw of DIRECTIVES) {
        add(kw.toUpperCase(), vscode.CompletionItemKind.Keyword);
      }
      for (const kw of ['endif', 'else', 'elif', 'next', 'endmacro', 'endsection', 'endbasic']) {
        add(kw.toUpperCase(), vscode.CompletionItemKind.Keyword);
      }
      for (const mn of MNEMONICS) {
        add(mn.toUpperCase(), vscode.CompletionItemKind.Operator, 'mnemonic');
      }
      for (const u of units) {
        for (const defs of u.macros.values()) {
          for (const def of defs) {
            add(def.name, vscode.CompletionItemKind.Method, `macro ${def.detail ?? ''}`.trim());
          }
        }
      }
    }

    // Expression context (also useful at statement start for operands on the same line).
    const scope = scopeAt(index, offset);
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      for (const [, defs] of s.symbols) {
        for (const def of defs) {
          add(def.name, completionKind(def), def.detail);
        }
      }
    }
    for (const u of units) {
      for (const defs of u.functions.values()) {
        for (const def of defs) {
          add(def.name, vscode.CompletionItemKind.Function, `function ${def.detail ?? ''}`.trim());
        }
      }
    }
    if (!statementStart) {
      for (const fn of BUILTIN_FUNCTIONS) {
        add(fn.toUpperCase(), vscode.CompletionItemKind.Function, 'built-in');
      }
      for (const c of ['TRUE', 'FALSE', 'PI', 'P%']) {
        add(c, vscode.CompletionItemKind.Constant);
      }
    }
    return items;
  }
}

function completionKind(def: Definition): vscode.CompletionItemKind {
  switch (def.kind) {
    case 'label': return vscode.CompletionItemKind.Function;
    case 'symbol': return vscode.CompletionItemKind.Constant;
    case 'macro': return vscode.CompletionItemKind.Method;
    case 'function': return vscode.CompletionItemKind.Function;
    case 'section': return vscode.CompletionItemKind.Module;
    case 'zpvar': case 'param': case 'forvar': return vscode.CompletionItemKind.Variable;
    default: return vscode.CompletionItemKind.Value;
  }
}

// ---- semantic tokens: cmos-aware mnemonic colouring ----

export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(['mnemonicCmos', 'mnemonicInvalid']);

export class BaronSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(private readonly project: Project) {}

  provideDocumentSemanticTokens(doc: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
    const file = docFile(doc);
    const [unit] = this.project.unitsForFile(file);
    const index = unit?.files.get(file);
    if (index) {
      for (const mn of index.mnemonics) {
        if (!mn.cmosOnly) {
          continue;
        }
        const range = toRange(index, mn.loc.start, mn.loc.end);
        builder.push(range, mn.cmosContext ? 'mnemonicCmos' : 'mnemonicInvalid');
      }
    }
    return builder.build();
  }
}
