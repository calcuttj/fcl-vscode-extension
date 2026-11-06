import {
  AtomType,
  Binding,
  Diagnostic,
  Include,
  NameNode,
  ParseResult,
  Reference,
  RefKind,
  Statement,
  Value,
} from "./ast";

class ParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

// cetlib's includer treats a line as an #include directive iff it starts with "#include"
// in column 0; it must then be exactly: #include "file" (one space, closing quote last,
// trailing " \t\r" ignored). Anything else starting with "#include" is a hard error.
const INCLUDE_LINE_RE = /^#include[^\n]*/gm;
const GOOD_INCLUDE_RE = /^#include "(.+)"$/;
const NUMBER_RE =
  /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+|0[bB][01]+|infinity)$/;
const isAss = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

export function scanIncludes(text: string): { includes: Include[]; bad: Diagnostic[] } {
  const includes: Include[] = [];
  const bad: Diagnostic[] = [];
  for (const m of text.matchAll(INCLUDE_LINE_RE)) {
    const start = m.index!;
    const line = m[0].replace(/[ \t\r]+$/, "");
    const good = GOOD_INCLUDE_RE.exec(line);
    if (good && !good[1].includes("\n")) {
      includes.push({
        file: good[1],
        start,
        end: start + line.length,
        fileStart: start + 10,
        fileEnd: start + 10 + good[1].length,
      });
    } else {
      bad.push({
        start,
        end: start + Math.max(line.length, 1),
        severity: "error",
        message: 'Malformed #include; expected exactly: #include "file.fcl" (at the start of the line, nothing after the closing quote)',
      });
    }
  }
  return { includes, bad };
}

class Parser {
  i = 0;
  readonly statements: Statement[] = [];
  readonly references: Reference[] = [];
  readonly warnings: Diagnostic[] = [];

  constructor(readonly s: string) {}

  fail(message: string, start = this.i, end?: number): never {
    const e = end ?? Math.min(start + 1, this.s.length);
    throw new ParseError(message, start, Math.max(e, start));
  }

  warn(message: string, start: number, end: number): void {
    this.warnings.push({ message, start, end, severity: "warning" });
  }

  /** Skip whitespace and # / // comments. */
  ws(): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
        this.i++;
      } else if (c === "#" || (c === "/" && s[this.i + 1] === "/")) {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else {
        return;
      }
    }
  }

  eof(): boolean {
    return this.i >= this.s.length;
  }

  at(lit: string): boolean {
    return this.s.startsWith(lit, this.i);
  }

  /**
   * A name token (fhicl::ass): [A-Za-z0-9_]+ that does not start with a digit and is
   * not directly followed by another "graph" character such as '-' or '@'.
   * Returns "" if there is no name at the current position.
   */
  ass(): string {
    const st = this.i;
    while (isAss(this.s[this.i])) this.i++;
    const text = this.s.slice(st, this.i);
    if (!text) return "";
    if (/\d/.test(text[0])) {
      this.fail(`Name '${text}' cannot start with a digit`, st, this.i);
    }
    const c = this.s[this.i];
    if (c !== undefined && /[^\s.\[:#/,\]}]/.test(c)) {
      this.fail(`Invalid character '${c}' in name '${text}' (names may only contain letters, digits and '_')`, this.i, this.i + 1);
    }
    return text;
  }

  /** name ( '.' name | '[' uint ']' )*  — whitespace allowed around delimiters. */
  qualname(): NameNode {
    const start = this.i;
    let text = this.ass();
    if (!text) this.unexpectedAtNameStart();
    let end = this.i;
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === ".") {
        this.i++;
        this.ws();
        const seg = this.ass();
        if (!seg) this.fail("Expected a name after '.'");
        text += "." + seg;
      } else if (c === "[") {
        this.i++;
        this.ws();
        const st = this.i;
        while (/\d/.test(this.s[this.i] ?? "")) this.i++;
        if (st === this.i) this.fail("Expected an integer index after '['");
        const n = this.s.slice(st, this.i);
        this.ws();
        if (this.s[this.i] !== "]") this.fail("Expected ']'");
        this.i++;
        text += `[${n}]`;
      } else {
        break;
      }
      end = this.i;
    }
    this.i = end;
    return { text, start, end };
  }

  /** Name immediately following a @kind:: prefix (no whitespace allowed). */
  noskipQualname(kind: RefKind, start: number): Reference {
    const nameStart = this.i;
    let name = this.ass();
    if (!name) this.fail(`Expected a name after '@${kind}::'`);
    for (;;) {
      const save = this.i;
      this.ws();
      const c = this.s[this.i];
      if (c === "." && isAss(this.s[this.i + 1])) {
        this.i++;
        name += "." + this.ass();
      } else if (c === "[") {
        this.i++;
        this.ws();
        const st = this.i;
        while (/\d/.test(this.s[this.i] ?? "")) this.i++;
        if (st === this.i) this.fail("Expected an integer index after '['");
        const n = this.s.slice(st, this.i);
        this.ws();
        if (this.s[this.i] !== "]") this.fail("Expected ']'");
        this.i++;
        name += `[${n}]`;
      } else {
        this.i = save;
        break;
      }
    }
    const ref: Reference = { kind, name, start, end: this.i, nameStart };
    this.references.push(ref);
    return ref;
  }

  unexpectedAtNameStart(): never {
    const c = this.s[this.i];
    if (c === undefined) this.fail("Unexpected end of file");
    if (c === "}" || c === "]" || c === ")") this.fail(`Unmatched '${c}'`);
    if (c === ":") this.fail("Expected a name before ':'");
    if (c === ",") this.fail("Unexpected ','");
    if (c === '"' || c === "'") this.fail("Expected a parameter name, found a quoted string");
    this.fail(`Invalid character '${c}' in parameter name (names may only contain letters, digits and '_')`);
  }

  // ---------------------------------------------------------------- statements

  statement(top: boolean, out: Statement[]): void {
    this.ws();
    const start = this.i;
    if (this.at("@table::")) {
      this.i += 8;
      const ref = this.noskipQualname("table", start);
      out.push({ kind: "insert", ref, start, end: this.i });
      return;
    }
    let name: NameNode;
    if (top) {
      name = this.qualname();
    } else {
      const text = this.ass();
      if (!text) this.unexpectedAtNameStart();
      name = { text, start, end: this.i };
      this.ws();
      const c = this.s[this.i];
      if (c === "." || c === "[") {
        this.fail(
          `Qualified name '${text}${c}…' is only allowed at top level; inside a table use a simple name`,
          start,
          this.i + 1,
        );
      }
    }
    const binding = this.binding(name.text);
    this.ws();
    if (this.at("@erase") && !isAss(this.s[this.i + 6])) {
      this.i += 6;
      out.push({ kind: "erase", name, start, end: this.i });
      return;
    }
    const value = this.value();
    out.push({ kind: "assign", name, binding, value, start, end: this.i });
  }

  binding(name: string): Binding {
    this.ws();
    if (this.s[this.i] === ":") {
      this.i++;
      return "normal";
    }
    for (const b of ["protect_ignore", "protect_error"] as const) {
      if (this.at("@" + b) && this.s[this.i + 1 + b.length] === ":") {
        this.i += b.length + 2;
        return b;
      }
    }
    if (this.eof()) this.fail(`Expected ':' after '${name}', found end of file`, this.i - 1, this.i);
    this.fail(`Expected ':' after '${name}'`);
  }

  // -------------------------------------------------------------------- values

  value(): Value {
    this.ws();
    const s = this.s;
    const start = this.i;
    const c = s[start];
    if (c === undefined) this.fail("Expected a value, found end of file", start - 1, start);
    if (c === "," || c === "]" || c === "}") this.fail("Expected a value");
    if (c === ":") this.fail("Unexpected ':' (missing value, or missing name?)");
    if (c === "[") return this.sequence();
    if (c === "{") return this.table();
    if (c === "(") return this.complex();
    if (c === '"' || c === "'") return this.quoted(c);
    if (c === "@") return this.atValue();
    return this.bare();
  }

  quoted(q: string): Value {
    const s = this.s;
    const start = this.i;
    this.i++;
    for (;;) {
      if (this.i >= s.length) this.fail("Unterminated string", start, start + 1);
      if (q === '"' && s.startsWith('\\"', this.i)) {
        this.i += 2;
      } else if (s[this.i] === q) {
        this.i++;
        break;
      } else {
        this.i++;
      }
    }
    const next = s[this.i];
    if (next !== undefined && /[^\s,\]}#/]/.test(next)) {
      this.fail(`Unexpected '${next}' after string; expected whitespace, ',', ']' or '}'`, this.i, this.i + 1);
    }
    return { kind: "atom", type: "string", text: s.slice(start, this.i), start, end: this.i };
  }

  complex(): Value {
    const s = this.s;
    const start = this.i;
    const close = s.indexOf(")", start);
    if (close < 0) this.fail("Unclosed '('", start, start + 1);
    const text = s.slice(start, close + 1);
    const m = /^\(\s*([^,\s]+)\s*,\s*([^,\s)]+)\s*\)$/.exec(text);
    if (!m || !NUMBER_RE.test(m[1]) || !NUMBER_RE.test(m[2])) {
      this.fail("Invalid complex number; expected (real, imaginary)", start, close + 1);
    }
    this.i = close + 1;
    return { kind: "atom", type: "complex", text, start, end: this.i };
  }

  atValue(): Value {
    const start = this.i;
    for (const kind of ["local", "db", "id"] as const) {
      const p = `@${kind}::`;
      if (this.at(p)) {
        this.i += p.length;
        if (kind === "id") {
          const st = this.i;
          while (/[0-9a-fA-F]/.test(this.s[this.i] ?? "")) this.i++;
          if (this.i === st) this.fail("Expected a hex id after '@id::'");
          const ref: Reference = { kind, name: this.s.slice(st, this.i), start, end: this.i, nameStart: st };
          return { kind: "ref", ref, start, end: this.i };
        }
        const ref = this.noskipQualname(kind, start);
        return { kind: "ref", ref, start, end: this.i };
      }
    }
    if (this.at("@nil") && !/[^\s,\]}#]/.test(this.s[this.i + 4] ?? " ")) {
      this.i += 4;
      return { kind: "atom", type: "nil", text: "@nil", start, end: this.i };
    }
    for (const kind of ["table", "sequence"] as const) {
      const p = `@${kind}::`;
      if (this.at(p)) {
        this.i += p.length;
        const ref = this.noskipQualname(kind, start);
        this.warn(
          kind === "table"
            ? "'@table::' can only be used as a statement inside a table ({ @table::name }); use '@local::' to assign a table"
            : "'@sequence::' can only be used as an element of a sequence ([ @sequence::name, ... ]); use '@local::' to assign a whole sequence",
          start,
          this.i,
        );
        return { kind: "ref", ref, start, end: this.i };
      }
    }
    const m = /^@[^\s,\]}#]*/.exec(this.s.slice(start))!;
    this.fail(
      `Unknown or malformed '${m[0]}'; expected @local::, @table::, @sequence::, @db::, @id:: or @nil`,
      start,
      start + m[0].length,
    );
  }

  bare(): Value {
    const s = this.s;
    const start = this.i;
    while (this.i < s.length && !/[\s,\]}#]/.test(s[this.i]) && !s.startsWith("//", this.i)) this.i++;
    if (this.i === start) this.fail("Expected a value");
    const text = s.slice(start, this.i);
    let type: AtomType;
    if (text === "true" || text === "false") type = "bool";
    else if (NUMBER_RE.test(text)) type = "number";
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) || /^\d[A-Za-z0-9_]*$/.test(text)) type = "string";
    else {
      this.fail(
        `Invalid value '${text}'; strings containing characters other than letters, digits and '_' must be quoted`,
        start,
        this.i,
      );
    }
    return { kind: "atom", type, text, start, end: this.i };
  }

  sequence(): Value {
    const open = this.i;
    this.i++;
    const items: Value[] = [];
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return { kind: "sequence", items, start: open, end: this.i };
    }
    for (;;) {
      this.ws();
      if (this.eof()) this.fail("Unclosed '['", open, open + 1);
      if (this.at("@sequence::")) {
        const st = this.i;
        this.i += 11;
        const ref = this.noskipQualname("sequence", st);
        items.push({ kind: "ref", ref, start: st, end: this.i });
      } else {
        items.push(this.value());
      }
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
      } else if (c === "]") {
        this.i++;
        return { kind: "sequence", items, start: open, end: this.i };
      } else if (this.eof()) {
        this.fail("Unclosed '['", open, open + 1);
      } else {
        this.fail(c === "}" ? "Unmatched '}' inside sequence; expected ',' or ']'" : "Expected ',' or ']'");
      }
    }
  }

  table(): Value {
    const open = this.i;
    this.i++;
    const statements: Statement[] = [];
    for (;;) {
      this.ws();
      if (this.eof()) this.fail("Unclosed '{'", open, open + 1);
      if (this.s[this.i] === "}") {
        this.i++;
        return { kind: "table", statements, start: open, end: this.i };
      }
      this.statement(false, statements);
    }
  }

  // ------------------------------------------------------------------ document

  document(): void {
    let sawParam = false;
    let inProlog = false;
    let prologStart = 0;
    for (;;) {
      this.ws();
      if (this.eof()) break;
      const start = this.i;
      if (this.at("BEGIN_PROLOG") && !isAss(this.s[start + 12])) {
        if (inProlog) {
          this.fail("Nested BEGIN_PROLOG; PROLOG blocks must be contiguous and not nested", start, start + 12);
        }
        if (sawParam) {
          this.fail(
            "BEGIN_PROLOG after parameters; PROLOG blocks must come before all other parameters, contiguous and not nested",
            start,
            start + 12,
          );
        }
        inProlog = true;
        prologStart = start;
        this.i += 12;
        this.statements.push({ kind: "prolog", which: "begin", start, end: this.i });
        continue;
      }
      if (this.at("END_PROLOG") && !isAss(this.s[start + 10])) {
        if (!inProlog) this.fail("END_PROLOG without matching BEGIN_PROLOG", start, start + 10);
        inProlog = false;
        this.i += 10;
        this.statements.push({ kind: "prolog", which: "end", start, end: this.i });
        continue;
      }
      this.statement(true, this.statements);
      if (!inProlog) sawParam = true;
    }
    if (inProlog) this.fail("BEGIN_PROLOG without matching END_PROLOG", prologStart, prologStart + 12);
  }
}

export function parse(text: string): ParseResult {
  const p = new Parser(text);
  const { includes, bad } = scanIncludes(text);
  const diagnostics: Diagnostic[] = [...bad];
  try {
    p.document();
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    diagnostics.push({ message: e.message, start: e.start, end: e.end, severity: "error" });
  }
  diagnostics.push(...p.warnings);
  return { statements: p.statements, includes, diagnostics, references: p.references };
}
