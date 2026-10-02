// The baron.defines setting turned into -D switches. Pure, so testable without vscode.

/** The name a -D definition binds: everything before the first '=', trimmed. */
function defineName(def: string): string {
  const eq = def.indexOf('=');
  return (eq < 0 ? def : def.slice(0, eq)).trim();
}

/** Default definitions as -D switches, C_Cpp.default.defines style: each entry is
 *  `NAME=expr`, or a bare `NAME`, which defines it as TRUE (baron's -D insists on the
 *  `=`). They are defaults: baron rejects a second -D of the same name, so a name the
 *  switches in `base` define (`-D NAME=...`) is left to them, as is a repeated entry to
 *  its first occurrence. Names are case-sensitive, as baron's symbols are. */
export function defineSwitches(defines: readonly unknown[], base: readonly string[]): string[] {
  const taken = new Set<string>();
  for (let i = 0; i + 1 < base.length; i++) {
    if (base[i] === '-D') {
      taken.add(defineName(base[i + 1]));
    }
  }
  const args: string[] = [];
  for (const raw of defines) {
    const def = String(raw).trim();
    const name = defineName(def);
    if (name === '' || taken.has(name)) {
      continue;
    }
    taken.add(name);
    args.push('-D', def.includes('=') ? def : `${name}=TRUE`);
  }
  return args;
}

/** Quote one argument for the shell baron.buildOverride runs in. */
export function shellQuote(arg: string, platform: string = process.platform): string {
  if (/^[A-Za-z0-9_\-=.,/:+]+$/.test(arg)) {
    return arg;
  }
  if (platform === 'win32') {
    return '"' + arg.replace(/"/g, '\\"') + '"';
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
