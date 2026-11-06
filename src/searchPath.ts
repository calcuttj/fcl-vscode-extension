import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * FHICL_FILE_PATH captured from the UPS environment (set by env.ts once the container
 * integration exists). Until then we fall back to settings and the process environment.
 */
let captured: string[] | undefined;

export function setCapturedSearchPath(dirs: string[] | undefined): void {
  captured = dirs;
}

/** fhiclFilePath entries from this window's active environment (profile), added before the top-level ones. */
let profileDirs: string[] = [];

export function setProfileSearchPath(dirs: string[]): void {
  profileDirs = dirs;
}

/** Expand ${workspaceFolder} in a setting value, relative to the folder containing `resource`. */
export function expandVars(value: string, resource?: vscode.Uri): string {
  const folder =
    (resource && vscode.workspace.getWorkspaceFolder(resource)) ?? vscode.workspace.workspaceFolders?.[0];
  return value.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? "");
}

/** The user's extra search directories (fhicl.fhiclFilePath), with variables expanded. */
export function getExtraSearchPath(resource?: vscode.Uri): string[] {
  const cfg = vscode.workspace.getConfiguration("fhicl", resource);
  return [...profileDirs, ...cfg.get<string[]>("fhiclFilePath", [])]
    .map((d) => expandVars(d, resource))
    .filter((d) => d.length > 0);
}

export function getSearchPath(resource?: vscode.Uri): string[] {
  const env = (process.env.FHICL_FILE_PATH ?? "").split(":");
  // Relative entries ("." , "./job") are relative to wherever the tool ran, which we cannot know.
  const capturedAbs = (captured ?? []).filter((d) => path.isAbsolute(d));
  return [...capturedAbs, ...getExtraSearchPath(resource), ...env].filter((d) => d.length > 0);
}

/** Directories searched for #include files, in lookup order. */
export function includeDirs(fromPath: string | undefined): string[] {
  const dirs = [...getSearchPath(fromPath ? vscode.Uri.file(fromPath) : undefined)];
  // Lenient fallbacks so we under-report rather than produce false warnings;
  // fhicl-dump validation is the authority.
  if (fromPath) dirs.push(path.dirname(fromPath));
  for (const f of vscode.workspace.workspaceFolders ?? []) dirs.push(f.uri.fsPath);
  return [...new Set(dirs)];
}

/** Candidate absolute paths for an #include, in lookup order. */
export function includeCandidates(file: string, fromPath: string | undefined): string[] {
  if (path.isAbsolute(file)) return [file];
  return includeDirs(fromPath).map((d) => path.join(d, file));
}

/** The first existing file an #include resolves to, if any. */
export function findInclude(file: string, fromPath: string | undefined): string | undefined {
  for (const c of includeCandidates(file, fromPath)) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Async variant for editor features, so lookups on /cvmfs or sshfs never block the editor. */
export async function findIncludeAsync(file: string, fromPath: string | undefined): Promise<string | undefined> {
  for (const c of includeCandidates(file, fromPath)) {
    try {
      if ((await fs.promises.stat(c)).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return undefined;
}
