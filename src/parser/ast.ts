export interface Range {
  start: number; // offset, inclusive
  end: number; // offset, exclusive
}

export type Severity = "error" | "warning";

export interface Diagnostic extends Range {
  message: string;
  severity: Severity;
}

export type RefKind = "local" | "table" | "sequence" | "db" | "id";

export interface Reference extends Range {
  kind: RefKind;
  /** The referenced (possibly dotted) name, without the @kind:: prefix. */
  name: string;
  /** Range of just the name part. */
  nameStart: number;
}

export type AtomType = "number" | "string" | "bool" | "nil" | "bare" | "complex";

export type Value =
  | { kind: "atom"; type: AtomType; text: string; start: number; end: number }
  | { kind: "ref"; ref: Reference; start: number; end: number }
  | { kind: "sequence"; items: Value[]; start: number; end: number }
  | { kind: "table"; statements: Statement[]; start: number; end: number };

export type Binding = "normal" | "protect_ignore" | "protect_error";

export interface NameNode extends Range {
  /** Normalized qualified name, e.g. "a.b[2].c". */
  text: string;
}

export type Statement =
  | { kind: "assign"; name: NameNode; binding: Binding; value: Value; start: number; end: number }
  | { kind: "erase"; name: NameNode; start: number; end: number }
  | { kind: "insert"; ref: Reference; start: number; end: number }
  | { kind: "prolog"; which: "begin" | "end"; start: number; end: number };

export interface Include extends Range {
  /** File name as written between the quotes. */
  file: string;
  /** Range of the quoted file name. */
  fileStart: number;
  fileEnd: number;
}

export interface ParseResult {
  statements: Statement[];
  includes: Include[];
  /** Syntax error (the real parser stops at the first one) plus parser warnings. */
  diagnostics: Diagnostic[];
  /** Every @local/@table/@sequence/@db reference, including nested ones. */
  references: Reference[];
}
