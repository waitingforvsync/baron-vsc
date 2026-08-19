// The workspace project model: one compilation unit per configured root source file
// (baron assembles each command-line file independently), plus ad-hoc units for stray
// files opened outside the configured set. Units are reparsed lazily on demand after
// any relevant change - parsing is cheap at these project sizes.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileIndex, FileProvider, Unit } from './core/model';
import { parseUnit } from './core/parser';

export class Project implements FileProvider {
  private units = new Map<string, Unit>();
  private adhoc = new Map<string, Unit>();
  private dirty = true;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.isRelevant(e.document)) {
          this.dirty = true;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('baron')) {
          this.dirty = true;
        }
      }),
      vscode.workspace.onDidCreateFiles(() => { this.dirty = true; }),
      vscode.workspace.onDidDeleteFiles(() => { this.dirty = true; }),
      vscode.workspace.onDidRenameFiles(() => { this.dirty = true; }),
    );
  }

  private isRelevant(doc: vscode.TextDocument): boolean {
    if (doc.languageId === 'baron') {
      return true;
    }
    const file = normalize(doc.uri.fsPath);
    for (const unit of this.allUnits()) {
      if (unit.files.has(file)) {
        return true;
      }
    }
    return false;
  }

  // ---- FileProvider ----

  getText(file: string): string | undefined {
    for (const doc of vscode.workspace.textDocuments) {
      if (normalize(doc.uri.fsPath) === file) {
        return doc.getText();
      }
    }
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  resolvePath(fromFile: string, relative: string): string {
    // baron resolves include paths relative to the including file's directory,
    // normalising backslashes (file_utils.c file_path_resolve).
    return normalize(path.resolve(path.dirname(fromFile), relative.replace(/\\/g, '/')));
  }

  // ---- units ----

  /** The configured root files, absolute, per workspace folder settings. */
  rootFiles(): string[] {
    const roots: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const config = vscode.workspace.getConfiguration('baron', folder.uri);
      for (const rel of config.get<string[]>('sourceFiles') ?? []) {
        roots.push(normalize(path.resolve(folder.uri.fsPath, rel)));
      }
    }
    return roots;
  }

  private ensureFresh(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.units.clear();
    this.adhoc.clear();
    for (const root of this.rootFiles()) {
      this.units.set(root, parseUnit(root, this));
    }
  }

  allUnits(): Unit[] {
    return [...this.units.values(), ...this.adhoc.values()];
  }

  /** Units containing this file; falls back to an ad-hoc unit rooted at the file itself. */
  unitsForFile(file: string): Unit[] {
    this.ensureFresh();
    const found = [...this.units.values()].filter((u) => u.files.has(file));
    if (found.length > 0) {
      return found;
    }
    let unit = this.adhoc.get(file);
    if (!unit) {
      unit = parseUnit(file, this);
      this.adhoc.set(file, unit);
    }
    return [unit];
  }

  /** All units relevant for a cross-project search (configured plus ad-hoc). */
  searchUnits(file: string): Unit[] {
    const primary = this.unitsForFile(file);
    const rest = this.allUnits().filter((u) => !primary.includes(u));
    return [...primary, ...rest];
  }

  indexFor(unit: Unit, file: string): FileIndex | undefined {
    return unit.files.get(file);
  }

  /** Whether the document belongs to any known unit (source or via includes). */
  contains(doc: vscode.TextDocument): boolean {
    const file = normalize(doc.uri.fsPath);
    return this.allUnits().some((u) => u.files.has(file));
  }

  /** Every file a check of these roots involves: the units' parsed files (the include
   *  graph, dirty buffers included) plus the binaries INCBIN pulls in. */
  filesForRoots(rootsAbs: string[]): Set<string> {
    const files = new Set<string>();
    for (const root of rootsAbs) {
      for (const unit of this.unitsForFile(normalize(root))) {
        for (const [file, index] of unit.files) {
          files.add(file);
          for (const fref of index.fileRefs) {
            if (fref.resolved) {
              files.add(fref.resolved);
            }
          }
        }
      }
    }
    return files;
  }
}

export function normalize(p: string): string {
  return path.normalize(p);
}

export function docFile(doc: vscode.TextDocument): string {
  return normalize(doc.uri.fsPath);
}
