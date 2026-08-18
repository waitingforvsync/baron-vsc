// Launching baron and turning its stderr diagnostics into Problems.

import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

const DIAG_RE = /^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.*)$/;

export class BaronBuild {
  private readonly output: vscode.OutputChannel;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private running = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Baron');
    this.diagnostics = vscode.languages.createDiagnosticCollection('baron');
    context.subscriptions.push(this.output, this.diagnostics);
  }

  private workspaceFolder(): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder;
      }
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  /** The root files passed to baron: the configured set, else the active baron file. */
  private sourceFiles(folder: vscode.WorkspaceFolder | undefined): string[] {
    const config = vscode.workspace.getConfiguration('baron', folder?.uri);
    const configured = config.get<string[]>('sourceFiles') ?? [];
    if (configured.length > 0) {
      return configured;
    }
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && doc.languageId === 'baron') {
      return [folder ? path.relative(folder.uri.fsPath, doc.uri.fsPath) : doc.uri.fsPath];
    }
    return [];
  }

  async build(extraArgs?: string[], quiet = false): Promise<void> {
    if (this.running) {
      vscode.window.showInformationMessage('Baron is already running.');
      return;
    }
    const folder = this.workspaceFolder();
    const cwd = folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '.');
    const config = vscode.workspace.getConfiguration('baron', folder?.uri);
    const exe = config.get<string>('executablePath') || 'baron';
    const sources = this.sourceFiles(folder);
    if (sources.length === 0) {
      vscode.window.showWarningMessage(
        'Baron: no source files. Set "baron.sourceFiles" or open a .6502 file (use the "Baron: Set Root Source Files" command).',
      );
      return;
    }
    const args = [...(extraArgs ?? config.get<string[]>('buildArgs') ?? []), ...sources];

    // Save dirty baron documents first, as any build tool expects.
    await vscode.workspace.saveAll(false);

    this.output.appendLine(`> ${exe} ${args.join(' ')}`);
    this.running = true;

    const chunks: string[] = [];
    const stderrChunks: string[] = [];
    await new Promise<void>((resolve) => {
      let proc: cp.ChildProcess;
      try {
        proc = cp.spawn(exe, args, { cwd });
      } catch (err) {
        this.output.appendLine(`failed to launch: ${err}`);
        this.running = false;
        resolve();
        return;
      }
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
      proc.on('error', (err) => {
        this.output.appendLine(`failed to launch '${exe}': ${err.message}`);
        this.output.show(true);
        this.running = false;
        resolve();
      });
      proc.on('close', (code) => {
        const stdout = chunks.join('');
        const stderr = stderrChunks.join('');
        if (stdout) {
          this.output.append(stdout.endsWith('\n') ? stdout : stdout + '\n');
        }
        if (stderr) {
          this.output.append(stderr.endsWith('\n') ? stderr : stderr + '\n');
        }
        const count = this.publishDiagnostics(stderr, cwd);
        if (code === 0) {
          this.output.appendLine('baron: ok');
          if (!quiet) {
            vscode.window.setStatusBarMessage('Baron: assembled ok', 5000);
          }
        } else {
          this.output.appendLine(`baron: exit code ${code}`);
          if (!quiet) {
            this.output.show(true);
            vscode.window.setStatusBarMessage(
              `Baron: ${count.errors} error${count.errors === 1 ? '' : 's'}` +
              (count.warnings ? `, ${count.warnings} warning${count.warnings === 1 ? '' : 's'}` : ''),
              8000,
            );
          }
        }
        this.running = false;
        resolve();
      });
    });
  }

  private publishDiagnostics(stderr: string, cwd: string): { errors: number; warnings: number } {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let errors = 0;
    let warnings = 0;
    for (const line of stderr.split(/\r?\n/)) {
      const m = DIAG_RE.exec(line);
      if (!m) {
        continue;
      }
      const [, file, lineStr, colStr, severity, message] = m;
      const lineNo = Math.max(0, parseInt(lineStr, 10) - 1);
      const colNo = Math.max(0, parseInt(colStr, 10) - 1);
      const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
      const range = new vscode.Range(lineNo, colNo, lineNo, colNo + 1);
      const diag = new vscode.Diagnostic(
        range,
        message,
        severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
      );
      diag.source = 'baron';
      if (severity === 'warning') {
        warnings++;
      } else {
        errors++;
      }
      const list = byFile.get(abs) ?? [];
      list.push(diag);
      byFile.set(abs, list);
    }
    for (const [file, diags] of byFile) {
      this.diagnostics.set(vscode.Uri.file(file), diags);
    }
    return { errors, warnings };
  }

  async buildWithArgs(): Promise<void> {
    const folder = this.workspaceFolder();
    const config = vscode.workspace.getConfiguration('baron', folder?.uri);
    const last = this.context.workspaceState.get<string>(
      'baron.lastArgs',
      (config.get<string[]>('buildArgs') ?? []).join(' '),
    );
    const input = await vscode.window.showInputBox({
      prompt: 'baron command line switches (source files are appended automatically)',
      value: last,
      placeHolder: '-v -o demo.ssd --opt 3 --title DEMO',
    });
    if (input === undefined) {
      return;
    }
    await this.context.workspaceState.update('baron.lastArgs', input);
    await this.build(splitArgs(input));
  }
}

/** Split a command line into arguments, honouring double quotes. */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    args.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return args;
}
