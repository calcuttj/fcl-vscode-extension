import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildIndex, completeNames, includePrefix, lookupDefinition, refPrefix } from "../definitions";

test("index: nested names, kinds, locations; aliases and @table:: copy members", () => {
  const src = "BEGIN_PROLOG\nbase: { a: 1\n  b: { c: 2 } }\nseq: [1, 2]\nEND_PROLOG\nx: @local::base\nt: { @table::base  extra: 5 }\n";
  const idx = buildIndex(src);
  const base = idx.get("base")!;
  assert.equal(base.length, 1);
  assert.deepEqual([base[0].line, base[0].col, base[0].endCol], [1, 0, 4]);
  assert.equal(base[0].kind, "table");
  assert.match(base[0].snippet, /^base: \{ a: 1/);
  assert.ok(idx.has("base.b.c"));
  assert.equal(idx.get("seq")![0].kind, "sequence");
  assert.equal(idx.get("x")![0].kind, "ref");
  // alias and @table:: point at the original member definitions
  assert.equal(idx.get("x.a")![0].line, 1);
  assert.equal(idx.get("t.b.c")![0].line, 2);
  assert.equal(idx.get("t.extra")![0].line, 6);
});

test("index: never follows #include", () => {
  const idx = buildIndex('#include "elsewhere.fcl"\nz: @local::from_include\n');
  assert.deepEqual([...idx.keys()], ["z"]);
});

test("index: multiple definitions are all kept, in order", () => {
  const idx = buildIndex("a: 1\nb: 2\na: 3\n");
  assert.deepEqual(idx.get("a")!.map((l) => l.line), [0, 2]);
});

test("index: top-level qualified names", () => {
  const idx = buildIndex("t: { u: 1 }\nt.u: 2\n");
  assert.equal(idx.get("t.u")!.length, 2);
});

test("lookup falls back to the nearest defined ancestor", () => {
  const idx = buildIndex("a: @local::elsewhere\n");
  assert.equal(lookupDefinition(idx, "a.deep.name")[0].line, 0);
  assert.deepEqual(lookupDefinition(idx, "nope.x"), []);
});

test("completion helpers", () => {
  const idx = buildIndex("tbl: { x: 1 }\nsq: [1]\nv: 3\nal: @local::tbl\n");
  assert.deepEqual(completeNames(idx, "table", ""), ["al", "tbl"]);
  assert.deepEqual(completeNames(idx, "sequence", ""), ["al", "sq"]);
  assert.deepEqual(completeNames(idx, "local", "tbl."), ["tbl.x"]);
  assert.equal(includePrefix('#include "dune/fo'), "dune/fo");
  assert.equal(includePrefix('  #include "x'), undefined); // not column 0: not an include
  assert.equal(includePrefix('#include "done"'), undefined);
  assert.deepEqual(refPrefix("a: @local::foo.b"), { kind: "local", typed: "foo.b" });
  assert.deepEqual(refPrefix("[ @sequence::"), { kind: "sequence", typed: "" });
  assert.equal(refPrefix("a: 1"), undefined);
});

// Trimmed from dunesw fcl/protodunehd/g4/standard_g4_protodunehd.fcl
const G4 = `#include "LArG4_dune.fcl"
process_name: G4
physics:
{
  producers:
  {
    largeant:     @local::protodune_larg4
    rns: {module_type: "RandomNumberSaver"}
  }
  simulate:      [  rns, largeant ]
  stream1:       [ out1 ]
  trigger_paths: [  simulate ]
  end_paths:     [  stream1  ]
}
outputs: { out1: { module_type: RootOutput } }
physics.producers.largeant.Verbosity: 2
`;

test("art labels in paths resolve to their module/path definitions", async () => {
  const { parse } = await import("../parser/parser");
  const { atomAt, findLabelDefinitions, keyAt, otherDefinitions, LineIndex } = await import("../definitions");
  const r = parse(G4);
  const idx = buildIndex(G4, r);
  const at = (needle: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = G4.indexOf(needle, i + 1);
    return i + 1; // inside the word
  };
  // nth = which occurrence of the word is the one inside a path list
  const lineOfDef = (word: string, nth = 1) => findLabelDefinitions(idx, atomAt(r, at(word, nth))!.word).map((d) => d.line);
  assert.deepEqual(lineOfDef("largeant"), [6]); // physics.producers.largeant
  assert.deepEqual(lineOfDef("rns"), [7]);
  assert.deepEqual(lineOfDef("out1", 0), [14]); // outputs.out1
  assert.deepEqual(lineOfDef("simulate"), [9]); // physics.simulate (path)
  assert.deepEqual(lineOfDef("stream1"), [10]);
  // a quoted value that is not a label finds nothing
  assert.deepEqual(findLabelDefinitions(idx, atomAt(r, at("RandomNumberSaver"))!.word), []);
  // not a string atom: no hit
  assert.equal(atomAt(r, at("@local::protodune_larg4")), undefined);
  // override key jumps to the original nested definition (and not to itself)
  const li = new LineIndex(G4);
  const hit = keyAt(r, at("physics.producers.largeant.Verbosity"));
  assert.equal(hit?.key, "physics.producers.largeant.Verbosity");
  const orig = keyAt(r, at("largeant:"));
  assert.equal(orig?.key, "physics.producers.largeant");
  assert.deepEqual(otherDefinitions(idx, orig!, (o) => li.pos(o)), []); // only defined once
});
