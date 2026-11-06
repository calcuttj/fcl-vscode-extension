import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parse } from "../parser/parser";

const errors = (t: string) => parse(t).diagnostics.filter((d) => d.severity === "error");
const msgs = (t: string) => errors(t).map((d) => d.message);

test("accepts a typical file", () => {
  const src = `#include "a.fcl"
BEGIN_PROLOG
base: { x: 1  y: "s"  z: [1, 2, 3] }
END_PROLOG
process_name: Demo # comment
physics.analyzers.a: { @table::base  t: @local::base  q: @erase }
w: (1.5, -2)
n: @nil
tags: [ @sequence::s, foo ]
a @protect_ignore: 3
`;
  assert.deepEqual(errors(src), []);
});

test("both comment styles and multi-line strings", () => {
  assert.deepEqual(errors('a: 1 // c\nb: "x\ny" # c\n'), []);
});

test("names", () => {
  assert.match(msgs("1ab: 5")[0], /cannot start with a digit/);
  assert.match(msgs("foo-bar: 5")[0], /Invalid character '-'/);
  assert.match(msgs("t: { a.b: 1 }")[0], /only allowed at top level/);
  assert.deepEqual(errors("a.b[3].c: 1"), []);
});

test("values must be valid atoms", () => {
  assert.match(msgs("a: foo-bar")[0], /must be quoted/);
  assert.match(msgs("a: http://x")[0], /must be quoted/);
  assert.deepEqual(errors("a: 1abc\nb: infinity\nc: -infinity\nd: 0x1F\ne: 1e-3\nf: 'x y'"), []);
  assert.match(msgs("a:")[0], /Expected a value/);
});

test("unterminated and unbalanced constructs", () => {
  assert.match(msgs('a: "oops')[0], /Unterminated string/);
  assert.match(msgs("a: [1, 2")[0], /Unclosed '\['/);
  assert.match(msgs("a: { b: 1")[0], /Unclosed '\{'/);
  assert.match(msgs("a: [1,]")[0], /Expected a value/);
  assert.match(msgs("a: 1 }")[0], /Unmatched '}'/);
  assert.match(msgs("a: [1 2]")[0], /Expected ',' or '\]'/);
});

test("prolog rules", () => {
  assert.match(msgs("BEGIN_PROLOG a: 1")[0], /without matching END_PROLOG/);
  assert.match(msgs("END_PROLOG")[0], /without matching BEGIN_PROLOG/);
  assert.match(msgs("BEGIN_PROLOG BEGIN_PROLOG END_PROLOG")[0], /Nested/);
  assert.match(msgs("x: 1\nBEGIN_PROLOG a: 1 END_PROLOG")[0], /before all other parameters/);
  assert.deepEqual(errors("BEGIN_PROLOG a: 1 END_PROLOG BEGIN_PROLOG b: 2 END_PROLOG c: 3"), []);
});

test("references", () => {
  assert.match(msgs("y: @local:x")[0], /Unknown or malformed/);
  const r = parse("x: 1\ny: @local::x\nz: [@sequence::s]\nt: {@table::x}");
  assert.deepEqual(
    r.references.map((x) => `${x.kind}:${x.name}`),
    ["local:x", "sequence:s", "table:x"],
  );
  const w = parse("a: @table::x").diagnostics;
  assert.equal(w[0].severity, "warning");
});

test("malformed #include is an error", () => {
  for (const bad of ['#include"f"', "#include f", '#include "f', '#include  "f"', '#include "f" # why']) {
    assert.match(msgs(bad)[0], /Malformed #include/, bad);
  }
  assert.deepEqual(errors('#include "f.fcl"'), []);
  // not in column 0: just an ordinary comment, not an include
  assert.deepEqual(errors('  #include "f.fcl"'), []);
  assert.equal(parse('  #include "f.fcl"').includes.length, 0);
  const inc = parse('x: 1\n#include "dir/f.fcl"').includes[0];
  assert.equal(inc.file, "dir/f.fcl");
});

// ---- corpus from fhicl-cpp: ground truth is the real parser's own test suite
const corpus = path.resolve(__dirname, "../../../fhicl-cpp/fhiclcpp/test/testFiles");
const have = fs.existsSync(corpus);
// Failures that are semantic or about file lookup, not syntax.
const notSyntactic = new Set(["adv_ref_fail.fcl", "include4_fail.fcl"]);

test("corpus: every pass/ file parses without errors", { skip: !have }, () => {
  for (const f of fs.readdirSync(path.join(corpus, "pass"))) {
    const e = errors(fs.readFileSync(path.join(corpus, "pass", f), "utf8"));
    assert.deepEqual(e, [], f);
  }
});

test("corpus: every syntactic fail/ file reports an error", { skip: !have }, () => {
  for (const f of fs.readdirSync(path.join(corpus, "fail"))) {
    if (notSyntactic.has(f)) continue;
    const e = errors(fs.readFileSync(path.join(corpus, "fail", f), "utf8"));
    assert.ok(e.length > 0, `${f} should report an error`);
  }
});
