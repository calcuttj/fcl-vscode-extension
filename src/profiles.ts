/**
 * Named FHiCL environments ("profiles"). Defined once in settings (fhicl.environments); each VS Code
 * window picks one, so two windows can use two different UPS/mrb setups. Pure: no vscode import.
 */
import * as crypto from "node:crypto";
import { EnvConfig } from "./command";

export type RunMode = "container" | "cachedHost";

export interface EnvProfile {
  name: string;
  setupCommand?: string;
  commandPrefix?: string[];
  runMode?: RunMode;
  extraLibraryPath?: string[];
  fhiclFilePath?: string[];
}

/** Top-level fhicl.* settings, used for any field a profile does not set. */
export interface EnvDefaults {
  commandPrefix: string[];
  runMode: RunMode;
  extraLibraryPath: string[];
  fhiclFilePath: string[];
}

export interface ResolvedEnv extends EnvConfig {
  name: string;
  runMode: RunMode;
  extraLibraryPath: string[];
  /** Profile entries first, then the top-level ones. */
  fhiclFilePath: string[];
}

export function resolveProfile(p: EnvProfile, d: EnvDefaults): ResolvedEnv {
  return {
    name: p.name,
    setupCommand: p.setupCommand ?? "",
    commandPrefix: p.commandPrefix ?? d.commandPrefix,
    runMode: p.runMode ?? d.runMode,
    extraLibraryPath: (p.extraLibraryPath ?? d.extraLibraryPath).filter((x) => x.length > 0),
    fhiclFilePath: [...(p.fhiclFilePath ?? []), ...d.fhiclFilePath].filter((x) => x.length > 0),
  };
}

/** Identity of what a capture depends on (setup + container). Used as the capture cache key. */
export function profileHash(e: EnvConfig): string {
  return crypto.createHash("sha1").update(JSON.stringify([e.setupCommand, e.commandPrefix])).digest("hex");
}

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Turn the raw setting value into usable profiles, reporting (not throwing on) anything malformed. */
export function validateProfiles(raw: unknown): { profiles: EnvProfile[]; problems: string[] } {
  const profiles: EnvProfile[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { profiles, problems };
  if (!Array.isArray(raw)) return { profiles, problems: ["fhicl.environments must be a list of objects"] };
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const where = `fhicl.environments[${i}]`;
    if (typeof item !== "object" || item === null) {
      problems.push(`${where} is not an object; ignored`);
      return;
    }
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) {
      problems.push(`${where} has no "name"; ignored`);
      return;
    }
    if (seen.has(name)) {
      problems.push(`${where}: duplicate name "${name}"; only the first is used`);
      return;
    }
    seen.add(name);
    const p: EnvProfile = { name };
    if (typeof o.setupCommand === "string") p.setupCommand = o.setupCommand;
    else if (o.setupCommand !== undefined) problems.push(`${where}.setupCommand must be a string`);
    for (const k of ["commandPrefix", "extraLibraryPath", "fhiclFilePath"] as const) {
      if (isStrArray(o[k])) p[k] = o[k] as string[];
      else if (o[k] !== undefined) problems.push(`${where}.${k} must be a list of strings`);
    }
    if (o.runMode === "container" || o.runMode === "cachedHost") p.runMode = o.runMode;
    else if (o.runMode !== undefined) problems.push(`${where}.runMode must be "container" or "cachedHost"`);
    profiles.push(p);
  });
  return { profiles, problems };
}
