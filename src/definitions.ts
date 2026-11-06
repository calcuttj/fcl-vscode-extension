import { ParseResult, Statement, Value } from "./parser/ast";
import { parse } from "./parser/parser";

export type DefKind = "table" | "sequence" | "atom" | "ref";

export interface DefLocation {
  /** 0-based range of the name. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  kind: DefKind;
  /** Source text of the whole statement (truncated). */
  snippet: string;
}

/** Normalized qualified name ("a.b[2].c") to every place it is defined, in source order. */
export type DefIndex = Map<string, DefLocation[]>;

export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  pos(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - this.starts[lo] };
  }
}

const kindOf = (v: Value): DefKind =>
  v.kind === "table" ? "table" : v.kind === "sequence" ? "sequence" : v.kind === "ref" ? "ref" : "atom";

const MAX_SNIPPET = 800;

/**
 * Index every definition in this one document (no #include following: names from included
 * files are deliberately out of scope for the editor). `a: @local::x` and `@table::x` bring x's
 * members along when x is defined earlier in the same file. Pure: no filesystem or vscode.
 */
export function buildIndex(text: string, result: ParseResult = parse(text)): DefIndex {
  const index: DefIndex = new Map();
  const li = new LineIndex(text);

  const add = (name: string, loc: DefLocation): void => {
    const list = index.get(name);
    if (list) list.push(loc);
    else index.set(name, [loc]);
  };

  // Single files are small, so a scan per copy is fine here.
  const copyChildren = (from: string, to: string): void => {
    for (const [k, locs] of [...index]) {
      let key: string | undefined;
      if (k.startsWith(from + ".")) key = to ? to + k.slice(from.length) : k.slice(from.length + 1);
      else if (to && k.startsWith(from + "[")) key = to + k.slice(from.length);
      if (key) for (const l of locs) add(key, l);
    }
  };

  const statement = (st: Statement, prefix: string): void => {
    if (st.kind === "assign") {
      const full = prefix ? `${prefix}.${st.name.text}` : st.name.text;
      const a = li.pos(st.name.start);
      const b = li.pos(st.name.end);
      add(full, {
        line: a.line,
        col: a.col,
        endLine: b.line,
        endCol: b.col,
        kind: kindOf(st.value),
        snippet: text.slice(st.start, Math.min(st.end, st.start + MAX_SNIPPET)),
      });
      if (st.value.kind === "table") for (const s of st.value.statements) statement(s, full);
      else if (st.value.kind === "ref" && st.value.ref.kind === "local") copyChildren(st.value.ref.name, full);
    } else if (st.kind === "insert") {
      copyChildren(st.ref.name, prefix);
    }
  };

  for (const st of result.statements) statement(st, "");
  return index;
}

function parentOf(name: string): string {
  const cut = Math.max(name.lastIndexOf("."), name.lastIndexOf("["));
  return cut > 0 ? name.slice(0, cut) : "";
}

/** Definitions of `name`, or, failing that, of its nearest defined ancestor (e.g. via an alias). */
export function lookupDefinition(index: DefIndex, name: string): DefLocation[] {
  for (let n = name; n; n = parentOf(n)) {
    const hit = index.get(n);
    if (hit && hit.length > 0) return hit;
  }
  return [];
}

/** Names offered after "@kind::" (tables for @table, sequences for @sequence, anything for @local). */
export function completeNames(index: DefIndex, refKind: "local" | "table" | "sequence", prefix: string): string[] {
  const out: string[] = [];
  for (const [name, locs] of index) {
    if (!name.startsWith(prefix) || name.includes("[")) continue;
    const kind = locs[locs.length - 1].kind;
    if (refKind === "table" && kind !== "table" && kind !== "ref") continue;
    if (refKind === "sequence" && kind !== "sequence" && kind !== "ref") continue;
    out.push(name);
  }
  return out.sort().slice(0, 3000);
}

/** For completion inside `#include "…`: the text typed so far after the opening quote. */
export function includePrefix(linePrefix: string): string | undefined {
  return /^#include "([^"]*)$/.exec(linePrefix)?.[1];
}

/** For completion after `@local::` etc.: which kind and what has been typed of the name. */
export function refPrefix(linePrefix: string): { kind: "local" | "table" | "sequence"; typed: string } | undefined {
  const m = /@(local|table|sequence)::([A-Za-z0-9_.\[\]]*)$/.exec(linePrefix);
  return m ? { kind: m[1] as "local" | "table" | "sequence", typed: m[2] } : undefined;
}

// ------------------------------------------------------------------ art conventions

export interface AtomHit {
  /** The atom's value with quotes removed. */
  word: string;
  start: number;
  end: number;
}

export interface KeyHit {
  /** Fully qualified key of the statement whose name is under the cursor. */
  key: string;
  start: number;
  end: number;
}

/** The plain (non-reference) atom value under `offset`, e.g. `largeant` in `simulate: [ rns, largeant ]`. */
export function atomAt(result: ParseResult, offset: number): AtomHit | undefined {
  const inValue = (v: Value): AtomHit | undefined => {
    if (offset < v.start || offset > v.end) return undefined;
    if (v.kind === "atom") {
      if (v.type !== "string") return undefined;
      const word = v.text.replace(/^(["'])(.*)\1$/s, "$2");
      return { word, start: v.start, end: v.end };
    }
    if (v.kind === "sequence") {
      for (const item of v.items) {
        const hit = inValue(item);
        if (hit) return hit;
      }
    }
    if (v.kind === "table") return inStatements(v.statements);
    return undefined;
  };
  const inStatements = (stmts: Statement[]): AtomHit | undefined => {
    for (const st of stmts) {
      if (st.kind === "assign" && offset >= st.start && offset <= st.end) return inValue(st.value);
    }
    return undefined;
  };
  return inStatements(result.statements);
}

/** The statement name under `offset`, as a fully qualified key (nested table names get their prefix). */
export function keyAt(result: ParseResult, offset: number): KeyHit | undefined {
  const walk = (stmts: Statement[], prefix: string): KeyHit | undefined => {
    for (const st of stmts) {
      if ((st.kind !== "assign" && st.kind !== "erase") || offset < st.start || offset > st.end) continue;
      const key = prefix ? `${prefix}.${st.name.text}` : st.name.text;
      if (offset >= st.name.start && offset <= st.name.end) return { key, start: st.name.start, end: st.name.end };
      if (st.kind === "assign" && st.value.kind === "table") return walk(st.value.statements, key);
    }
    return undefined;
  };
  return walk(result.statements, "");
}

/**
 * Where an art module label / path name used as a plain string is defined, following art's layout:
 * module labels live in physics.{producers,filters,analyzers} or outputs; path names in physics.
 * Falls back to any key whose last segment is the word.
 */
export function findLabelDefinitions(index: DefIndex, word: string): DefLocation[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return [];
  const conventional = [
    `physics.producers.${word}`,
    `physics.filters.${word}`,
    `physics.analyzers.${word}`,
    `outputs.${word}`,
    `physics.${word}`,
  ].flatMap((k) => index.get(k) ?? []);
  if (conventional.length > 0) return conventional;
  const out: DefLocation[] = [];
  for (const [k, locs] of index) if (k === word || k.endsWith("." + word)) out.push(...locs);
  return out;
}

/** Definitions of the key under the cursor, other than the one at the cursor (e.g. an override's original). */
export function otherDefinitions(index: DefIndex, hit: KeyHit, lineOf: (offset: number) => { line: number; col: number }): DefLocation[] {
  const here = lineOf(hit.start);
  return (index.get(hit.key) ?? []).filter((d) => !(d.line === here.line && d.col === here.col));
}
