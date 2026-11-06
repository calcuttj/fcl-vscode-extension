import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isBlock, parseAnnotatedDump, renderBody } from "../dumpView";
import { parse } from "../parser/parser";

// Verbatim output of the real `fhicl-dump --prefix-annotate` (fhiclcpp v4_18_04).
const REAL = `# Produced from '/cvmfs/x/bin/fhicl-dump' using:
#   Input  : fcl/rich.fcl
#   Policy : cet::filepath_maker
#   Path   : "FHICL_FILE_PATH"

#KEY|physics|
#SRC|./fcl/rich.fcl:5|
physics: {
#KEY|physics.extra|
#SRC|./fcl/rich.fcl:5|
   extra: {
#KEY|physics.extra.x|
#SRC|./fcl/rich.fcl:5|
      x: "nil"
   }
#KEY|physics.t|
#SRC|./fcl/rich.fcl:5|
   t: {
#KEY|physics.t.a|
#SRC|./fcl/rich.fcl:6|
      a: 7
#KEY|physics.t.seq|
#SRC|./fcl/rich.fcl:2|
      seq: [
#KEY|physics.t.seq[0]|
#SRC|./fcl/rich.fcl:2|
         1,
#KEY|physics.t.seq[2]|
#SRC|./fcl/rich.fcl:2|
         true
      ]
   }
}
#KEY|process_name|
#SRC|./fcl/rich.fcl:4|
process_name: "Demo"
`;

test("parses real prefix-annotated output into a tree with sources", () => {
  const m = parseAnnotatedDump(REAL);
  assert.equal(m.header[1], "  Input  : fcl/rich.fcl");
  assert.equal(m.root.length, 2);
  const physics = m.root[0];
  assert.ok(isBlock(physics));
  if (!isBlock(physics)) return;
  assert.equal(physics.open.key, "physics");
  assert.equal(physics.open.src, "./fcl/rich.fcl:5");
  assert.equal(physics.children.length, 2);
  const t = physics.children[1];
  assert.ok(isBlock(t));
  if (!isBlock(t)) return;
  assert.equal(t.close?.text, "}");
  const seq = t.children[1];
  assert.ok(isBlock(seq));
  if (isBlock(seq)) assert.deepEqual(seq.children.map((c) => (c as { key?: string }).key), ["physics.t.seq[0]", "physics.t.seq[2]"]);
  const last = m.root[1];
  assert.ok(!isBlock(last));
  assert.equal((last as { text: string }).text, 'process_name: "Demo"');
});

test("plain text drops annotations and header", () => {
  const m = parseAnnotatedDump(REAL);
  assert.ok(!m.plain.includes("#KEY"));
  assert.ok(!m.plain.includes("#SRC"));
  assert.ok(m.plain.startsWith("physics: {\n"));
  assert.ok(m.plain.endsWith('process_name: "Demo"\n'));
});

test("synthesized values (src \"\") have no source link", () => {
  const m = parseAnnotatedDump('#KEY|a|\n#SRC|""|\na: 1\n');
  assert.equal((m.root[0] as { src?: string }).src, undefined);
});

test("html: structure, colouring, and escaping of hostile content", () => {
  const html = renderBody(parseAnnotatedDump(REAL));
  assert.match(html, /<details open class="blk">/); // top level expanded
  assert.match(html, /<details class="blk">/); // nested collapsed
  assert.match(html, /<span class="k">process_name<\/span>: <span class="v-str">&quot;Demo&quot;<\/span>/);
  assert.match(html, /<span class="v-num">7<\/span>/);
  assert.match(html, /data-src="\.\/fcl\/rich\.fcl:6"/);
  const evil = renderBody(parseAnnotatedDump('#KEY|x|\n#SRC|"><img src=x onerror=alert(1)>:1|\nx: "<script>alert(1)</script>"\n'));
  assert.ok(!evil.includes("<script>"), evil);
  assert.ok(!evil.includes("<img"), evil);
});

test("a bare nil is a plain string in FHiCL (only @nil is nil)", () => {
  const r = parse("a: nil\nb: @nil\n");
  const [a, b] = r.statements as unknown as Array<{ value: { type: string } }>;
  assert.equal(a.value.type, "string");
  assert.equal(b.value.type, "nil");
});
