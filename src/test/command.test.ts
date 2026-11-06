import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildCaptureInvocation,
  buildHostInvocation,
  buildInvocation,
  filterHostEntries,
  parseCapture,
  parseCapturedEnv,
} from "../command";
import { looksLikeMissingTool, looksLikeStartFailure, missingLibrary, parseDumpError } from "../dumpErrors";

const none = { setupCommand: "", commandPrefix: [] as string[] };

test("unwrapped: runs the tool directly and extends FHICL_FILE_PATH via env", () => {
  const inv = buildInvocation(none, "fhicl-dump", ["-c", "/a b/x.fcl"], ["/extra"], { FHICL_FILE_PATH: "/p" });
  assert.equal(inv.file, "fhicl-dump");
  assert.deepEqual(inv.args, ["-c", "/a b/x.fcl"]);
  assert.equal(inv.env?.FHICL_FILE_PATH, "/p:/extra");
});

test("setup only: bash -lc, operands passed positionally, never interpolated", () => {
  const cfg = { setupCommand: "source /x/setup; setup foo v1", commandPrefix: [] };
  const evil = "/tmp/$(touch pwned); `id`.fcl";
  const inv = buildInvocation(cfg, "fhicl-dump", ["-c", evil], ["/e1", "/e2"], {});
  assert.equal(inv.file, "bash");
  assert.equal(inv.args[0], "-lc");
  const script = inv.args[1];
  assert.ok(script.includes("source /x/setup; setup foo v1"));
  assert.ok(!script.includes(evil), "file name must not appear in the script text");
  assert.deepEqual(inv.args.slice(2), ["bash", "/e1:/e2", "fhicl-dump", "-c", evil]);
  // setup must run after $@ has been cleared, and before the tool is exec'd
  assert.ok(script.indexOf("set --") < script.indexOf("source /x/setup"));
  assert.ok(script.indexOf("source /x/setup") < script.indexOf("exec "));
});

test("apptainer prefix wraps bash", () => {
  const cfg = { setupCommand: "setup x", commandPrefix: ["apptainer", "exec", "-B", "/cvmfs", "img.sif"] };
  const inv = buildInvocation(cfg, "fhicl-dump", ["-c", "f.fcl"], [], {});
  assert.equal(inv.file, "apptainer");
  assert.deepEqual(inv.args.slice(0, 5), ["exec", "-B", "/cvmfs", "img.sif", "bash"]);
  assert.equal(inv.args[5], "-lc");
  assert.deepEqual(inv.args.slice(-4), ["", "fhicl-dump", "-c", "f.fcl"]);
});

test("capture: markers survive setup chatter", () => {
  const inv = buildCaptureInvocation({ setupCommand: "setup x", commandPrefix: [] });
  assert.equal(inv.file, "bash");
  assert.match(inv.args[1], /printf/);
  const out = "Welcome to UPS!\nsetting up...\n\n<<FHICL_FILE_PATH:/a:/b::/c>>\n";
  assert.deepEqual(parseCapture(out), ["/a", "/b", "/c"]);
  assert.equal(parseCapture("no marker here"), undefined);
  assert.deepEqual(parseCapture("<<FHICL_FILE_PATH:>>"), []);
});

// Verbatim output captured from the real fhicl-dump (fhiclcpp v4, dunesw v10_26_00d05).
const REAL_PARSE_ERROR = `perl: warning: Setting locale failed.
perl: warning: Falling back to the standard locale ("C").
terminate called after throwing an instance of 'cet::coded_exception<fhicl::error, &fhicl::detail::translate[abi:cxx11]>'
  what():  ---- Parse error BEGIN
  detected at or near line 3, character 1, of file "/w/bad.fcl"
  
  c: 3
  ^
---- Parse error END
`;
const REAL_LOOKUP_ERROR = `terminate called after throwing an instance of 'cet::coded_exception<fhicl::error, &fhicl::detail::translate[abi:cxx11]>'
  what():  ---- Parse error BEGIN
  Local lookup error
  ---- Can't find key BEGIN
    nope (at part "nope")
  ---- Can't find key END
  at line 2, character 4, of file "/w/badref.fcl"
  
  y: @local::nope
     ^
---- Parse error END
`;
const REAL_INCLUDE_ERROR = `terminate called after throwing an instance of 'cet::exception'
  what():  ---- search_path BEGIN
  Can't find file "nonexistent_zzz.fcl"
---- search_path END
`;

test("parses real fhicl-dump parse errors", () => {
  const e = parseDumpError(REAL_PARSE_ERROR);
  assert.deepEqual(e.location, { line: 3, character: 1, file: "/w/bad.fcl" });
  assert.equal(e.category, "Parse error");
  assert.ok(!/perl|terminate|what\(\)/.test(e.message), e.message);
  assert.match(e.message, /detected at or near line 3/);
  assert.match(e.message, /c: 3/);
});

test("parses real lookup error and failed include", () => {
  const l = parseDumpError(REAL_LOOKUP_ERROR);
  assert.deepEqual(l.location, { line: 2, character: 4, file: "/w/badref.fcl" });
  assert.match(l.message, /Local lookup error/);
  const i = parseDumpError(REAL_INCLUDE_ERROR);
  assert.equal(i.location, undefined);
  assert.equal(i.missingFile, "nonexistent_zzz.fcl");
  assert.equal(i.category, "search_path");
});

test("errors without a location, and missing tool detection", () => {
  const e = parseDumpError("---- Configuration BEGIN\n  Unable to open file\n---- Configuration END");
  assert.equal(e.location, undefined);
  assert.match(e.message, /^Configuration: Unable to open file/);
  assert.match(parseDumpError("perl: warning: x\nsomething odd").message, /something odd/);
  assert.ok(!looksLikeMissingTool(134, REAL_PARSE_ERROR), "abort (134) is a config error, not a missing tool");
  assert.ok(looksLikeMissingTool(127, "bash: fhicl-dump: command not found"));
  assert.ok(looksLikeMissingTool("ENOENT", ""));
  assert.ok(!looksLikeMissingTool(1, "---- Parse error BEGIN"));
});

// ---- end-to-end with real bash, a fake setup script and a fake fhicl-dump
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("e2e: setup runs with empty $@, extra path is appended, tool gets exact args", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhicl-e2e-"));
  try {
    fs.writeFileSync(
      path.join(dir, "setup.sh"),
      'echo "UPS banner: setup saw $# args"\nexport FHICL_FILE_PATH=/from/setup:/also\nexport PATH="' + dir + ':$PATH"\n',
    );
    fs.writeFileSync(
      path.join(dir, "fhicl-dump"),
      '#!/bin/bash\nprintf "ARGS:"; printf "[%s]" "$@"; echo\necho "FFP:$FHICL_FILE_PATH"\n[ "$1" = "-q" ] && [ "$2" = "-c" ] && [[ "$3" == *BAD* ]] && { echo "line 2, character 4, of file \\"$3\\"" >&2; exit 1; }\nexit 0\n',
      { mode: 0o755 },
    );
    const cfg = { setupCommand: `source ${dir}/setup.sh`, commandPrefix: [] as string[] };

    const cap = buildCaptureInvocation(cfg);
    const capOut = execFileSync(cap.file, cap.args, { encoding: "utf8" });
    assert.match(capOut, /setup saw 0 args/); // positional args were hidden from the setup script
    assert.deepEqual(parseCapture(capOut), ["/from/setup", "/also"]);

    const weird = path.join(dir, "we ird $(x) 'q'.fcl");
    const inv = buildInvocation(cfg, "fhicl-dump", ["-q", "-c", weird], ["/extra1", "/extra2"], process.env);
    const out = execFileSync(inv.file, inv.args, { encoding: "utf8" });
    assert.ok(out.includes(`ARGS:[-q][-c][${weird}]`), out);
    assert.match(out, /FFP:\/from\/setup:\/also:\/extra1:\/extra2/);

    const bad = buildInvocation(cfg, "fhicl-dump", ["-q", "-c", path.join(dir, "BAD.fcl")], [], process.env);
    const r = spawnSync(bad.file, bad.args, { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(parseDumpError(r.stderr).location?.line, 2);

    // missing tool inside a working setup => exit 127 and recognized as such
    const missing = buildInvocation(cfg, "no-such-tool", [], [], process.env);
    const m = spawnSync(missing.file, missing.args, { encoding: "utf8" });
    assert.ok(looksLikeMissingTool(m.status ?? undefined, m.stderr), `status=${m.status} ${m.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture parsing: all three variables, immune to chatter", () => {
  const out = "banner\n\n<<FHICL_FILE_PATH:/a:/b>>\n<<PATH:/cvmfs/x/bin:/usr/bin>>\n<<LD_LIBRARY_PATH:/cvmfs/x/lib::/.singularity.d/libs>>\n";
  assert.deepEqual(parseCapturedEnv(out), {
    fhiclFilePath: ["/a", "/b"],
    path: ["/cvmfs/x/bin", "/usr/bin"],
    ldLibraryPath: ["/cvmfs/x/lib", "/.singularity.d/libs"],
  });
  assert.equal(parseCapturedEnv("nothing"), undefined);
});

test("host entries: drop container system dirs, keep products and home", () => {
  assert.deepEqual(
    filterHostEntries(["/cvmfs/a/bin", "/usr/bin", "/bin", "/usr/lib64", "/lib64", "/.singularity.d/libs", "/home/j/lp/bin", "relative/dir", "/usrlocal/x"]),
    ["/cvmfs/a/bin", "/home/j/lp/bin", "/usrlocal/x"],
  );
});

test("host invocation: env is built from the capture; no container, no setup", () => {
  const cap = { fhiclFilePath: ["/f1", "."], path: ["/cvmfs/x/bin", "/usr/bin"], ldLibraryPath: ["/cvmfs/x/lib", "/lib64"] };
  const inv = buildHostInvocation(cap, ["/shim"], ["/extra"], "fhicl-dump", ["-q", "-c", "a b.fcl"], {
    PATH: "/host/bin",
    LD_LIBRARY_PATH: "/snap/junk",
    HOME: "/home/j",
  });
  assert.equal(inv.file, "bash");
  assert.deepEqual(inv.args.slice(2), ["bash", "fhicl-dump", "-q", "-c", "a b.fcl"]);
  assert.equal(inv.args[1], 'exec "$@"');
  assert.equal(inv.env?.FHICL_FILE_PATH, "/f1:.:/extra");
  assert.equal(inv.env?.PATH, "/cvmfs/x/bin:/host/bin");
  assert.equal(inv.env?.LD_LIBRARY_PATH, "/cvmfs/x/lib:/shim"); // host's snap path not inherited
  assert.equal(inv.env?.HOME, "/home/j");
});

test("start failures are distinguished from tool errors", () => {
  const loader = "/x/fhicl-dump: error while loading shared libraries: libcrypto.so.10: cannot open shared object file: No such file or directory";
  assert.equal(missingLibrary(loader), "libcrypto.so.10");
  assert.ok(looksLikeStartFailure(127, loader));
  assert.ok(looksLikeStartFailure(127, "bash: line 1: fhicl-dump: command not found"));
  assert.ok(!looksLikeStartFailure(134, "terminate called after throwing ... ---- Parse error BEGIN"));
  assert.ok(!looksLikeStartFailure(0, ""));
});

test("e2e host mode: fake tool sees the captured env and exact args", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhicl-host-"));
  try {
    fs.writeFileSync(
      path.join(dir, "fhicl-dump"),
      '#!/bin/bash\nprintf "ARGS:"; printf "[%s]" "$@"; echo\necho "FFP:$FHICL_FILE_PATH"\necho "LD:$LD_LIBRARY_PATH"\n',
      { mode: 0o755 },
    );
    const cap = { fhiclFilePath: ["/f1"], path: [dir], ldLibraryPath: ["/cvmfs/l"] };
    const weird = "/tmp/we ird $(x).fcl";
    const inv = buildHostInvocation(cap, ["/shim"], ["/e"], "fhicl-dump", ["-q", "-c", weird], process.env);
    const out = execFileSync(inv.file, inv.args, { encoding: "utf8", env: inv.env });
    assert.ok(out.includes(`ARGS:[-q][-c][${weird}]`), out);
    assert.match(out, /FFP:\/f1:\/e\n/);
    assert.match(out, /LD:\/cvmfs\/l:\/shim\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
