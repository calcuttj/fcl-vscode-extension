import { strict as assert } from "node:assert";
import { test } from "node:test";
import { profileHash, resolveProfile, validateProfiles } from "../profiles";

const defaults = {
  commandPrefix: ["apptainer", "exec", "img.sif"],
  runMode: "container" as const,
  extraLibraryPath: ["/shim"],
  fhiclFilePath: ["/top"],
};

test("resolveProfile: profile fields override, defaults fill in", () => {
  const a = resolveProfile({ name: "dunesw", setupCommand: "setup dunesw v1" }, defaults);
  assert.deepEqual(a, {
    name: "dunesw",
    setupCommand: "setup dunesw v1",
    commandPrefix: ["apptainer", "exec", "img.sif"],
    runMode: "container",
    extraLibraryPath: ["/shim"],
    fhiclFilePath: ["/top"],
  });
  const b = resolveProfile(
    { name: "dev", setupCommand: "mrbslp", commandPrefix: [], runMode: "cachedHost", extraLibraryPath: [], fhiclFilePath: ["/mine"] },
    defaults,
  );
  assert.deepEqual(b.commandPrefix, []); // explicit empty list = no container for this profile
  assert.equal(b.runMode, "cachedHost");
  assert.deepEqual(b.extraLibraryPath, []);
  assert.deepEqual(b.fhiclFilePath, ["/mine", "/top"]); // profile first, then shared
  assert.equal(resolveProfile({ name: "bare" }, defaults).setupCommand, "");
});

test("profileHash: stable, depends only on setup and prefix", () => {
  const base = resolveProfile({ name: "a", setupCommand: "s" }, defaults);
  assert.equal(profileHash(base), profileHash({ ...base }));
  const renamed = { ...base, name: "renamed", runMode: "cachedHost" as const };
  assert.equal(profileHash(base), profileHash(renamed));
  assert.notEqual(profileHash(base), profileHash({ ...base, setupCommand: "s2" }));
  assert.notEqual(profileHash(base), profileHash({ ...base, commandPrefix: [] }));
});

test("validateProfiles: tolerant of bad input, reports problems", () => {
  assert.deepEqual(validateProfiles(undefined), { profiles: [], problems: [] });
  assert.equal(validateProfiles("nope").problems.length, 1);
  const r = validateProfiles([
    { name: "ok", setupCommand: "x", runMode: "cachedHost" },
    { setupCommand: "no name" },
    { name: "  ok  " },
    "junk",
    { name: "bad fields", commandPrefix: "apptainer exec", runMode: "fast", setupCommand: 3 },
  ]);
  assert.deepEqual(r.profiles.map((p) => p.name), ["ok", "bad fields"]);
  assert.equal(r.profiles[0].runMode, "cachedHost");
  assert.deepEqual(r.profiles[1], { name: "bad fields" }); // bad fields dropped, profile kept
  assert.equal(r.problems.length, 6);
  assert.ok(r.problems.some((p) => /duplicate name "ok"/.test(p)));
});
