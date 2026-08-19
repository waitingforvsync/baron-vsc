import * as path from 'path';
import * as vscode from 'vscode';
import { BaronBuild } from './build';
import { Project } from './project';
import {
  BaronCompletionProvider,
  BaronDefinitionProvider,
  BaronDocumentSymbolProvider,
  BaronHoverProvider,
  BaronReferenceProvider,
  BaronSemanticTokensProvider,
  SEMANTIC_LEGEND,
} from './providers';

export function activate(context: vscode.ExtensionContext): void {
  const project = new Project(context);
  const build = new BaronBuild(context, project);
  const selector: vscode.DocumentSelector = { language: 'baron' };
  let checkTimer: ReturnType<typeof setTimeout> | undefined;

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new BaronDefinitionProvider(project)),
    vscode.languages.registerReferenceProvider(selector, new BaronReferenceProvider(project)),
    vscode.languages.registerHoverProvider(selector, new BaronHoverProvider(project)),
    vscode.languages.registerDocumentSymbolProvider(selector, new BaronDocumentSymbolProvider(project)),
    vscode.languages.registerCompletionItemProvider(selector, new BaronCompletionProvider(project), '.'),
    vscode.languages.registerDocumentSemanticTokensProvider(
      selector,
      new BaronSemanticTokensProvider(project),
      SEMANTIC_LEGEND,
    ),

    vscode.commands.registerCommand('baron.build', () => build.build()),
    vscode.commands.registerCommand('baron.buildWithArgs', () => build.buildWithArgs()),
    vscode.commands.registerCommand('baron.check', () => build.runCheck()),
    vscode.commands.registerCommand('baron.runInEmulator', () => build.runInEmulator()),
    vscode.commands.registerCommand('baron.setRootFiles', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.languageId !== 'baron') {
        vscode.window.showWarningMessage('Baron: open a Baron source file first.');
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) {
        vscode.window.showWarningMessage('Baron: the file is not inside a workspace folder.');
        return;
      }
      const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
      const config = vscode.workspace.getConfiguration('baron', folder.uri);
      await config.update('sourceFiles', [rel], vscode.ConfigurationTarget.WorkspaceFolder);
      updateContextKey();
      vscode.window.showInformationMessage(`Baron: root source files set to ["${rel}"].`);
    }),

    vscode.commands.registerCommand('baron.selectRootFiles', async () => {
      const folder = activeFolder();
      if (!folder) {
        vscode.window.showWarningMessage('Baron: open a workspace folder first.');
        return;
      }
      const config = vscode.workspace.getConfiguration('baron', folder.uri);
      const current = config.get<string[]>('sourceFiles') ?? [];
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.6502'),
        '**/node_modules/**',
      );
      const rels = uris.map((u) => path.relative(folder.uri.fsPath, u.fsPath)).sort();
      if (rels.length === 0) {
        vscode.window.showWarningMessage('Baron: no .6502 files found in the workspace.');
        return;
      }
      const items = rels.map((r) => ({ label: r, picked: current.includes(r) }));
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'The root source files passed to baron (sections land on the disc in this order)',
      });
      if (picked === undefined) {
        return; // cancelled
      }
      // Order matters to baron (disc catalogue order), so keep the configured order for
      // files that stay selected and append newly ticked ones after them.
      const pickedNames = picked.map((p) => p.label);
      const kept = current.filter((f) => pickedNames.includes(f));
      const added = pickedNames.filter((f) => !kept.includes(f));
      const result = [...kept, ...added];
      await config.update('sourceFiles', result, vscode.ConfigurationTarget.WorkspaceFolder);
      updateContextKey();
      vscode.window.setStatusBarMessage(
        `Baron: source files set to ${result.join(', ') || '(none)'}`, 5000,
      );
    }),

    vscode.commands.registerCommand('baron.setOutputFile', async () => {
      const folder = activeFolder();
      if (!folder) {
        vscode.window.showWarningMessage('Baron: open a workspace folder first.');
        return;
      }
      const config = vscode.workspace.getConfiguration('baron', folder.uri);
      const current = config.get<string>('outputFile') || '';
      const value = await vscode.window.showInputBox({
        prompt: 'Output disc image, relative to the workspace folder (passed to baron as -o). Empty clears it.',
        value: current || `${path.basename(folder.uri.fsPath)}.ssd`,
        validateInput: (v) =>
          v.trim() === '' || /\.ssd$/i.test(v.trim())
            ? null
            : 'baron currently only writes .ssd images',
      });
      if (value === undefined) {
        return; // cancelled
      }
      const trimmed = value.trim();
      await config.update('outputFile', trimmed, vscode.ConfigurationTarget.WorkspaceFolder);
      const buildArgs = config.get<string[]>('buildArgs') ?? [];
      if (trimmed !== '' && buildArgs.includes('-o')) {
        vscode.window.showWarningMessage(
          'Baron: baron.buildArgs already contains -o, which takes precedence over baron.outputFile.',
        );
      } else {
        vscode.window.setStatusBarMessage(
          trimmed === '' ? 'Baron: output disc image cleared' : `Baron: output disc image set to ${trimmed}`,
          5000,
        );
      }
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'baron' && !project.contains(doc)) {
        return;
      }
      const config = vscode.workspace.getConfiguration('baron', doc.uri);
      if (config.get<string>('check') !== 'off') {
        build.runCheck();
      }
    }),

    // onType checks: debounced so a burst of typing produces one check shortly after
    // the last keystroke (hitting Enter therefore checks the line just finished).
    // Unsaved edits are seen via the shadow copy the check runner builds.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }
      if (e.document.languageId !== 'baron' && !project.contains(e.document)) {
        return;
      }
      const config = vscode.workspace.getConfiguration('baron', e.document.uri);
      if (config.get<string>('check') !== 'onType') {
        return;
      }
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => build.runCheck(), 500);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('baron.sourceFiles')) {
        updateContextKey();
      }
    }),
  );

  updateContextKey();

  function activeFolder(): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder;
      }
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  function updateContextKey(): void {
    const hasRoots = (vscode.workspace.workspaceFolders ?? []).some((folder) => {
      const config = vscode.workspace.getConfiguration('baron', folder.uri);
      return (config.get<string[]>('sourceFiles') ?? []).length > 0;
    });
    void vscode.commands.executeCommand('setContext', 'baron.hasRootFiles', hasRoots);
  }
}

export function deactivate(): void {
  // nothing to clean up beyond context subscriptions
}
