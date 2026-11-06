import * as cp from "node:child_process";
import * as vscode from "vscode";
import {
  buildCaptureInvocation,
  buildHostInvocation,
  buildInvocation,
  CapturedEnv,
  EnvConfig,
  isWrapped,
  parseCapturedEnv,
} from "./command";
import { looksLikeStartFailure, missingLibrary } from "./dumpErrors";
import { EnvDefaults, EnvProfile, profileHash, ResolvedEnv, resolveProfile, RunMode, validateProfiles } from "./profiles";
import { setCapturedSearchPath, setProfileSearchPath } from "./searchPath";

export interface RunResult {
  /** Exit code, or an error code such as "ENOENT" / "ETIMEDOUT" / a signal, or "NO_ENV" (none selected). */
  code: number | string | undefined;
  stdout: string;
  stderr: string;
}

/** What this window is using. */
export type EnvStatus =
  | { kind: "noProfiles" } // fhicl.environments is empty: tools run with VS Code's own environment
  | { kind: "none" } // profiles exist, but this window has not picked one
  | { kind: "active"; env: ResolvedEnv };

export type CaptureState = "idle" | "capturing" | "ready" | "failed";

interface CaptureEntry {
  env: CapturedEnv;
  capturedAt: number;
}

const ACTIVE_KEY = "fhicl.activeEnvironment"; // workspaceState: per workspace, i.e. per window
const CAPTURES_KEY = "fhicl.captures.v3"; // globalState: shared by windows using the same setup
const MAX_CAPTURES = 20;

/**
 * Owns "where do FHiCL tools run" for this window: the active named environment (profile), its
 * captured FHICL_FILE_PATH/PATH/LD_LIBRARY_PATH (cached across windows by setup+container), and
 * running tools. Nothing starts a container unless the user picked a profile that needs one.
 */
export class FhiclEnv implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel("FHiCL");
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.output, this.changed];
  private reloadSeq = 0;
  private warnedStart = false;
  private appliedHash: string | undefined;
  private problemsShown = "";
  captureState: CaptureState = "idle";
  lastCapture: CaptureEntry | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("fhicl")) this.onSettingsChanged();
      }),
    );
    this.apply(false);
  }

  // ------------------------------------------------------------------ settings

  private defaults(): EnvDefaults {
    const c = vscode.workspace.getConfiguration("fhicl");
    return {
      commandPrefix: c.get<string[]>("commandPrefix", []),
      runMode: (c.get<string>("runMode", "container") === "cachedHost" ? "cachedHost" : "container") as RunMode,
      extraLibraryPath: c.get<string[]>("extraLibraryPath", []),
      fhiclFilePath: [], // top-level fhicl.fhiclFilePath is applied by searchPath.ts itself
    };
  }

  profiles(): EnvProfile[] {
    const { profiles, problems } = validateProfiles(vscode.workspace.getConfiguration("fhicl").get("environments"));
    const text = problems.join("\n");
    if (text && text !== this.problemsShown) {
      this.problemsShown = text;
      this.output.appendLine(`Problems in fhicl.environments:\n${text}`);
      void vscode.window
        .showWarningMessage(`FHiCL: ${problems.length} problem(s) in fhicl.environments.`, "Show Output")
        .then((c) => c && this.output.show(true));
    }
    return profiles;
  }

  private tools() {
    const c = vscode.workspace.getConfiguration("fhicl");
    return {
      dumpPath: c.get<string>("dumpPath", "") || "fhicl-dump",
      expandPath: c.get<string>("expandPath", "") || "fhicl-expand",
      timeoutMs: Math.max(1, c.get<number>("timeoutSeconds", 120)) * 1000,
    };
  }

  activeName(): string | undefined {
    return this.ctx.workspaceState.get<string>(ACTIVE_KEY);
  }

  status(): EnvStatus {
    const profiles = this.profiles();
    if (profiles.length === 0) return { kind: "noProfiles" };
    const p = profiles.find((x) => x.name === this.activeName());
    return p ? { kind: "active", env: resolveProfile(p, this.defaults()) } : { kind: "none" };
  }

  // ----------------------------------------------------------- selection/state

  /** Choose this window's environment (undefined = none). */
  async select(name: string | undefined): Promise<void> {
    await this.ctx.workspaceState.update(ACTIVE_KEY, name);
    this.output.appendLine(`Environment for this window: ${name ?? "(none)"}`);
    this.apply(true);
  }

  private onSettingsChanged(): void {
    const name = this.activeName();
    if (name && !this.profiles().some((p) => p.name === name)) {
      void vscode.window.showInformationMessage(`FHiCL: environment "${name}" no longer exists; this window now has none selected.`);
      void this.select(undefined);
      return;
    }
    this.apply(false);
  }

  /** Make the current status take effect: search paths, cached capture, or a fresh capture. */
  private apply(force: boolean): void {
    const st = this.status();
    setProfileSearchPath(st.kind === "active" ? st.env.fhiclFilePath : []);
    if (st.kind !== "active" || !isWrapped(st.env)) {
      this.appliedHash = undefined;
      this.lastCapture = undefined;
      this.captureState = "idle";
      setCapturedSearchPath(undefined);
      this.changed.fire();
      return;
    }
    const hash = profileHash(st.env);
    if (!force && hash === this.appliedHash) {
      this.changed.fire(); // e.g. runMode or library path changed: nothing to recapture
      return;
    }
    this.appliedHash = hash;
    const cached = this.cached(st.env);
    if (cached) {
      this.lastCapture = cached;
      this.captureState = "ready";
      setCapturedSearchPath(cached.env.fhiclFilePath);
      this.changed.fire();
    } else {
      void this.reload(false);
    }
  }

  private cached(env: EnvConfig): CaptureEntry | undefined {
    const all = this.ctx.globalState.get<Record<string, CaptureEntry>>(CAPTURES_KEY) ?? {};
    return all[profileHash(env)];
  }

  private async storeCapture(env: EnvConfig, entry: CaptureEntry): Promise<void> {
    const all = { ...(this.ctx.globalState.get<Record<string, CaptureEntry>>(CAPTURES_KEY) ?? {}) };
    all[profileHash(env)] = entry;
    const keys = Object.keys(all).sort((a, b) => all[b].capturedAt - all[a].capturedAt);
    for (const k of keys.slice(MAX_CAPTURES)) delete all[k];
    await this.ctx.globalState.update(CAPTURES_KEY, all);
  }

  private exec(file: string, args: string[], env: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
      cp.execFile(
        file,
        args,
        { env: env ?? process.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
          // A tool that abort()s (fhicl-dump does, on any config error) is reported as a signal, not an exit code.
          const code = !e ? 0 : e.killed ? "ETIMEDOUT" : typeof e.code === "number" ? e.code : (e.signal ?? e.code ?? undefined);
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  /** (Re)capture the active environment by running its setup (in its container, if any). */
  async reload(userInitiated: boolean): Promise<boolean> {
    const seq = ++this.reloadSeq;
    const st = this.status();
    if (st.kind !== "active") {
      if (userInitiated) {
        void vscode.window.showInformationMessage(
          st.kind === "none"
            ? "FHiCL: no environment is selected for this window."
            : "FHiCL: no environments are defined (fhicl.environments), so tools use VS Code's own environment.",
        );
      }
      return false;
    }
    const env = st.env;
    if (!isWrapped(env)) {
      if (userInitiated) void vscode.window.showInformationMessage(`FHiCL: "${env.name}" has no setup command or container; nothing to capture.`);
      return false;
    }
    this.captureState = "capturing";
    this.changed.fire();
    this.output.appendLine(`[${env.name}] capturing environment (prefix: [${env.commandPrefix.join(" ")}], setup: ${env.setupCommand ? "yes" : "no"})…`);
    const inv = buildCaptureInvocation(env);
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `FHiCL: setting up "${env.name}"…` },
      () => this.exec(inv.file, inv.args, inv.env, this.tools().timeoutMs),
    );
    if (seq !== this.reloadSeq) return false; // superseded (e.g. the user switched environments meanwhile)
    const captured = r.code === 0 ? parseCapturedEnv(r.stdout) : undefined;
    if (!captured) {
      this.captureState = "failed";
      this.changed.fire();
      this.output.appendLine(`[${env.name}] capture failed (exit ${r.code}).\n${r.stderr || r.stdout}`);
      void vscode.window
        .showWarningMessage(`FHiCL: could not set up environment "${env.name}".`, "Show Output")
        .then((c) => c && this.output.show(true));
      return false;
    }
    const entry: CaptureEntry = { env: captured, capturedAt: Date.now() };
    await this.storeCapture(env, entry);
    this.lastCapture = entry;
    this.captureState = "ready";
    this.appliedHash = profileHash(env);
    setCapturedSearchPath(captured.fhiclFilePath);
    this.output.appendLine(
      `[${env.name}] captured FHICL_FILE_PATH (${captured.fhiclFilePath.length} entries), PATH (${captured.path.length}), LD_LIBRARY_PATH (${captured.ldLibraryPath.length}).`,
    );
    this.changed.fire();
    if (userInitiated) void vscode.window.showInformationMessage(`FHiCL: "${env.name}" ready (${captured.fhiclFilePath.length} FHICL_FILE_PATH entries).`);
    return true;
  }

  // --------------------------------------------------------------------- tools

  /**
   * Run a FHiCL tool ("dump" or "expand") in this window's environment. Returns code "NO_ENV" when
   * profiles exist but none is selected. In cachedHost mode it runs directly on the host with the
   * captured environment; if that cannot even start, it falls back to the container.
   */
  async runTool(tool: "dump" | "expand", args: string[], extraPath: string[]): Promise<RunResult> {
    const st = this.status();
    if (st.kind === "none") return { code: "NO_ENV", stdout: "", stderr: "" };
    const t = this.tools();
    const program = tool === "dump" ? t.dumpPath : t.expandPath;
    const env: EnvConfig = st.kind === "active" ? st.env : { setupCommand: "", commandPrefix: [] };
    const label = st.kind === "active" ? st.env.name : "VS Code environment";

    if (st.kind === "active" && st.env.runMode === "cachedHost" && isWrapped(st.env)) {
      const cap = this.cached(st.env);
      if (!cap) {
        this.output.appendLine(`[${label}] cachedHost: no captured environment yet; using the container this time.`);
      } else {
        const inv = buildHostInvocation(cap.env, st.env.extraLibraryPath, extraPath, program, args, process.env);
        this.output.appendLine(`[${label}] $ ${program} ${args.join(" ")}   (host, cached environment)`);
        const r = await this.exec(inv.file, inv.args, inv.env, t.timeoutMs);
        this.output.appendLine(`  exit ${r.code}`);
        const out = `${r.stderr}\n${r.stdout}`;
        if (!looksLikeStartFailure(r.code, out)) return r;
        this.output.appendLine(`  could not start on the host; falling back to the container.\n  ${out.trim().split("\n")[0]}`);
        this.warnStartFailure(out);
      }
    }

    const inv = buildInvocation(env, program, args, extraPath, process.env);
    this.output.appendLine(`[${label}] $ ${program} ${args.join(" ")}${inv.file === program ? "" : `   (via ${inv.file})`}`);
    const r = await this.exec(inv.file, inv.args, inv.env, t.timeoutMs);
    this.output.appendLine(`  exit ${r.code}`);
    return r;
  }

  private warnStartFailure(output: string): void {
    if (this.warnedStart) return;
    this.warnedStart = true;
    const lib = missingLibrary(output);
    const what = lib ? `the host is missing the library ${lib}` : "the tool could not be started on the host";
    void vscode.window
      .showWarningMessage(
        `FHiCL: ${what}, so this run used the container instead. Add a directory containing it to extraLibraryPath (in the environment or fhicl.extraLibraryPath), or use runMode "container".`,
        "Show Output",
      )
      .then((c) => c && this.output.show(true));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
