// Pure reference resolution over the parsed model - shared by the providers and the tests.

import { Definition, FileIndex, LocalLabelRef, Reference, Unit } from './model';

export type Found =
  | { type: 'def'; def: Definition }
  | { type: 'ref'; ref: Reference; partIndex: number }
  | { type: 'local'; lref: LocalLabelRef }
  | { type: 'file'; resolved?: string };

export function findAt(index: FileIndex, offset: number): Found | undefined {
  for (const def of index.defs) {
    if (offset >= def.loc.start && offset <= def.loc.end) {
      return { type: 'def', def };
    }
  }
  for (const ref of index.refs) {
    for (let i = 0; i < ref.parts.length; i++) {
      const loc = ref.parts[i].loc;
      if (offset >= loc.start && offset <= loc.end) {
        return { type: 'ref', ref, partIndex: i };
      }
    }
  }
  for (const lref of index.localRefs) {
    if (offset >= lref.loc.start && offset <= lref.loc.end) {
      return { type: 'local', lref };
    }
  }
  for (const fref of index.fileRefs) {
    if (offset >= fref.loc.start && offset <= fref.loc.end) {
      return { type: 'file', resolved: fref.resolved };
    }
  }
  return undefined;
}

/** Resolve a dotted reference up to (and including) partIndex, per scopes.c: the head is
 *  a parent-chain lookup, subsequent parts descend named scopes. */
export function resolveRef(unit: Unit, ref: Reference, partIndex: number): Definition[] {
  const headLower = ref.parts[0].name.toLowerCase();
  let defs: Definition[] | undefined = ref.scope.lookupChain(headLower);
  if (!defs || defs.length === 0) {
    if (ref.kind === 'section') {
      defs = unit.sections.get(headLower);
    } else if (ref.kind === 'macrocall') {
      defs = unit.macros.get(headLower);
    } else {
      defs = unit.functions.get(headLower) ?? unit.macros.get(headLower) ?? unit.sections.get(headLower);
    }
  }
  if (!defs) {
    return [];
  }
  for (let i = 1; i <= partIndex && i < ref.parts.length; i++) {
    const partLower = ref.parts[i].name.toLowerCase();
    const next: Definition[] = [];
    for (const d of defs) {
      const inner = d.namedScope?.lookupLocal(partLower);
      if (inner) {
        next.push(...inner);
      }
    }
    defs = next;
    if (defs.length === 0) {
      return [];
    }
  }
  return defs;
}

/** @- / @+: the nearest .@ behind / ahead within the current scope only (expression.c). */
export function resolveLocal(index: FileIndex, lref: LocalLabelRef): Definition | undefined {
  const candidates = lref.scope.localLabels.filter((d) => d.loc.file === index.file);
  let best: Definition | undefined;
  if (lref.dir < 0) {
    for (const d of candidates) {
      if (d.loc.start < lref.loc.start && (!best || d.loc.start > best.loc.start)) {
        best = d;
      }
    }
  } else {
    for (const d of candidates) {
      if (d.loc.start > lref.loc.start && (!best || d.loc.start < best.loc.start)) {
        best = d;
      }
    }
  }
  return best;
}

export function defKey(def: Definition): string {
  return `${def.loc.file}:${def.loc.start}`;
}
