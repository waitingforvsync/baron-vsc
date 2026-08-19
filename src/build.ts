// Launching baron and turning its stderr diagnostics into Problems.

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { docFile, Project } from './project';

const DIAG_RE = /^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.*)$/;

export class BaronBuild {
  private readonly output: vscode.OutputChannel;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private running = false;
  /** The in-flight `baron --check` process, if any. */
  private checkProc: cp.ChildProcess | undefined;
  /** The emulator instance we last launched, if any. */
  private emuProc: cp.ChildProcess | undefined;
  /** Generation counter: only the newest check (or build) may publish diagnostics. */
  private generation = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly project: Project,
  ) {
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

  /** The switches actually passed to baron: the given base set, plus "-o <outputFile>"
   *  from baron.outputFile when the base doesn't already carry a -o of its own. */
  private effectiveArgs(config: vscode.WorkspaceConfiguration, base: string[]): string[] {
    const outputFile = config.get<string>('outputFile') ?? '';
    if (outputFile !== '' && !base.includes('-o')) {
      return [...base, '-o', outputFile];
    }
    return base;
  }

  /** The disc image a build produces: baron.outputFile, else the -o value in the args. */
  private discImage(config: vscode.WorkspaceConfiguration): string | undefined {
    const outputFile = config.get<string>('outputFile') ?? '';
    const buildArgs = config.get<string[]>('buildArgs') ?? [];
    const oIndex = buildArgs.indexOf('-o');
    if (oIndex >= 0 && oIndex + 1 < buildArgs.length) {
      return buildArgs[oIndex + 1]; // an explicit -o in the switches wins
    }
    return outputFile !== '' ? outputFile : undefined;
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

  /** Mirror the check's file set into a shadow tree under the OS temp dir, with dirty
   *  editor buffers written out and clean files hardlinked (copied on failure), so a
   *  check can see unsaved edits. Returns the shadow root, or undefined when mirroring
   *  is not possible (a file lives outside the workspace folder). */
  private prepareMirror(wsRoot: string, files: Set<string>): string | undefined {
    const dir = path.join(
      os.tmpdir(),
      'baron-vsc-check-' + crypto.createHash('md5').update(wsRoot).digest('hex').slice(0, 12),
    );
    for (const file of files) {
      const rel = path.relative(wsRoot, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined; // outside the workspace: fall back to a plain on-disk check
      }
      const dest = path.join(dir, rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // Always remove first: writing through a stale hardlink would edit the ORIGINAL.
        fs.rmSync(dest, { force: true });
        const doc = vscode.workspace.textDocuments.find((d) => docFile(d) === file);
        if (doc) {
          fs.writeFileSync(dest, doc.getText());
        } else {
          try {
            fs.linkSync(file, dest);
          } catch {
            fs.copyFileSync(file, dest); // cross-device or exotic fs: copy instead
          }
        }
      } catch {
        // A missing source file: leave it absent and let baron report the include error.
      }
    }
    return dir;
  }

  /** Run `baron --check`: assemble everything, write nothing, refresh the Problems
   *  panel. Entirely asynchronous - baron runs as a separate process and we only listen
   *  for its output, so the editor never waits on a slow assembly. If a newer check (or
   *  a build) starts while one is in flight, the old process is killed and its results
   *  discarded - the newest run always wins. Unsaved edits are included by mirroring
   *  the involved files into a shadow tree and running the check there. */
  runCheck(): void {
    if (this.running) {
      return; // a real build is in flight; it will publish fresh diagnostics itself
    }
    const folder = this.workspaceFolder();
    const wsRoot = folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '.');
    const config = vscode.workspace.getConfiguration('baron', folder?.uri);
    const exe = config.get<string>('executablePath') || 'baron';
    const sources = this.sourceFiles(folder);
    if (sources.length === 0) {
      return; // nothing configured and no active baron file: silently do nothing
    }
    const args = ['--check', ...this.effectiveArgs(config, config.get<string[]>('buildArgs') ?? []), ...sources];

    // Check unsaved work: when any involved document is dirty, run against a shadow
    // copy of the file set with the editor buffers' contents.
    let cwd = wsRoot;
    const involved = this.project.filesForRoots(sources.map((s) => path.resolve(wsRoot, s)));
    const anyDirty = vscode.workspace.textDocuments.some((d) => d.isDirty && involved.has(docFile(d)));
    if (anyDirty) {
      cwd = this.prepareMirror(wsRoot, involved) ?? wsRoot;
    }

    const gen = ++this.generation;
    this.checkProc?.kill(); // supersede any in-flight check
    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn(exe, args, { cwd });
    } catch {
      return;
    }
    this.checkProc = proc;

    const stderrChunks: string[] = [];
    proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
    proc.stdout?.on('data', () => { /* PRINT output is uninteresting for a check */ });
    proc.on('error', (err) => {
      if (gen === this.generation) {
        this.output.appendLine(`baron --check: failed to launch '${exe}': ${err.message}`);
      }
    });
    proc.on('close', (code, signal) => {
      if (gen !== this.generation || signal) {
        return; // superseded (or killed): a newer run owns the Problems panel
      }
      this.checkProc = undefined;
      // Diagnostics resolve against the real workspace, never the shadow tree.
      const stderr = stderrChunks.join('').split(cwd + path.sep).join('');
      if (code !== 0 && /unknown option '--check'/.test(stderr)) {
        this.output.appendLine(
          "baron --check: this baron does not support --check; rebuild baron or disable baron.checkOnSave",
        );
        return; // never publish the usage error as diagnostics
      }
      const count = this.publishDiagnostics(stderr, wsRoot);
      this.output.appendLine(
        code === 0
          ? 'baron --check: ok'
          : `baron --check: ${count.errors} error${count.errors === 1 ? '' : 's'}` +
            (count.warnings ? `, ${count.warnings} warning${count.warnings === 1 ? '' : 's'}` : ''),
      );
    });
  }

  /** Run a full build; resolves true when baron exited cleanly. */
  async build(extraArgs?: string[], quiet = false): Promise<boolean> {
    if (this.running) {
      vscode.window.showInformationMessage('Baron is already running.');
      return false;
    }
    this.generation++;      // a build's diagnostics must not be overwritten by a stale check
    this.checkProc?.kill();
    const folder = this.workspaceFolder();
    const cwd = folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '.');
    const config = vscode.workspace.getConfiguration('baron', folder?.uri);
    const exe = config.get<string>('executablePath') || 'baron';

    // baron.buildOverride replaces the whole default invocation (for the plain build
    // only - "Assemble with Switches..." always builds a baron command line, that being
    // its point). It runs through the shell, so a script or pipeline works.
    const override = extraArgs === undefined ? (config.get<string>('buildOverride') ?? '').trim() : '';

    let args: string[] = [];
    if (override === '') {
      const sources = this.sourceFiles(folder);
      if (sources.length === 0) {
        vscode.window.showWarningMessage(
          'Baron: no source files. Set "baron.sourceFiles" or open a .6502 file (use the "Baron: Set Root Source Files" command).',
        );
        return false;
      }
      args = [...this.effectiveArgs(config, extraArgs ?? config.get<string[]>('buildArgs') ?? []), ...sources];
    }

    // Save dirty baron documents first, as any build tool expects.
    await vscode.workspace.saveAll(false);

    this.output.appendLine(override !== '' ? `> ${override}` : `> ${exe} ${args.join(' ')}`);
    this.running = true;

    const chunks: string[] = [];
    const stderrChunks: string[] = [];
    return await new Promise<boolean>((resolve) => {
      let proc: cp.ChildProcess;
      try {
        proc = override !== ''
          ? cp.spawn(override, { cwd, shell: true })
          : cp.spawn(exe, args, { cwd });
      } catch (err) {
        this.output.appendLine(`failed to launch: ${err}`);
        this.running = false;
        resolve(false);
        return;
      }
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString()));
      proc.on('error', (err) => {
        this.output.appendLine(`failed to launch '${exe}': ${err.message}`);
        this.output.show(true);
        this.running = false;
        resolve(false);
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
        resolve(code === 0);
      });
    });
  }

  /** Build, then launch the configured emulator with the disc image from -o. The
   *  previous emulator instance we launched (if still alive) is killed first, so
   *  rebuild-and-run iterates with one keypress. */
  async runInEmulator(): Promise<void> {
    const folder = this.workspaceFolder();
    const cwd = folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '.');
    const config = vscode.workspace.getConfiguration('baron', folder?.uri);

    const image = this.discImage(config);
    if (!image) {
      vscode.window.showWarningMessage(
        'Baron: no disc image to run. Use "Baron: Set Output Disc Image..." (or add -o to baron.buildArgs).',
      );
      return;
    }
    const imagePath = path.resolve(cwd, image);

    if (!(await this.build())) {
      return; // the build already reported its errors
    }

    const emu = config.get<string>('emulatorPath') || 'b2';
    const emuArgs = (config.get<string[]>('emulatorArgs') ?? []).map((a) =>
      a.split('${image}').join(imagePath),
    );
    if (!emuArgs.some((a) => a.includes(imagePath))) {
      emuArgs.push(imagePath); // no ${image} placeholder anywhere: append the image
    }

    this.emuProc?.kill();
    this.output.appendLine(`> ${emu} ${emuArgs.join(' ')}`);
    try {
      const proc = cp.spawn(emu, emuArgs, { cwd, detached: true, stdio: 'ignore' });
      proc.on('error', (err) => {
        vscode.window.showErrorMessage(`Baron: failed to launch emulator '${emu}': ${err.message}`);
      });
      proc.unref(); // the emulator outlives the editor if the editor closes first
      this.emuProc = proc;
      vscode.window.setStatusBarMessage(`Baron: running ${path.basename(imagePath)} in ${path.basename(emu)}`, 5000);
    } catch (err) {
      vscode.window.showErrorMessage(`Baron: failed to launch emulator '${emu}': ${err}`);
    }
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
