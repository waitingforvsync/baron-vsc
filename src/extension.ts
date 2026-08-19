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
  const build = new BaronBuild(context);
  const selector: vscode.DocumentSelector = { language: 'baron' };

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

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'baron') {
        return;
      }
      const config = vscode.workspace.getConfiguration('baron', doc.uri);
      if (config.get<boolean>('checkOnSave')) {
        build.runCheck();
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('baron.sourceFiles')) {
        updateContextKey();
      }
    }),
  );

  updateContextKey();

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
