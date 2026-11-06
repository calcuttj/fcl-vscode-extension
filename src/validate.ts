import * as path from "node:path";
import * as vscode from "vscode";
import { looksLikeMissingTool, parseDumpError } from "./dumpErrors";
import { FhiclEnv } from "./env";
import { getExtraSearchPath } from "./searchPath";

const SOURCE = "fhicl-dump";

/** Authoritative validation with the real fhicl-dump. Opt-in: nothing runs unless asked (or validateOnSave). */
export class FhiclValidator implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(SOURCE);
  private readonly running = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [this.collection];
  private quietMissingToolLogged = false;

  constructor(private readonly env: FhiclEnv) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const on = vscode.workspace.getConfiguration("fhicl", doc.uri).get<boolean>("validateOnSave", false);
        if (on && doc.languageId === "fhicl") void this.validate(doc, false);
      }),
      // Stale authoritative results are misleading once the text changes.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0 && this.collection.has(e.document.uri)) this.collection.delete(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
    );
  }

  /** Returns the document's file path if it is a real saved-able FHiCL file, else tells the user why not. */
  static target(doc: vscode.TextDocument | undefined, interactive: boolean): string | undefined {
    if (!doc || doc.languageId !== "fhicl" || doc.uri.scheme !== "file") {
      if (interactive) void vscode.window.showInformationMessage("FHiCL: open a .fcl file on disk first.");
      return undefined;
    }
    if (doc.isDirty && interactive) {
      void vscode.window.showInformationMessage("FHiCL: the tool reads the file from disk; unsaved edits are not included.");
    }
    return doc.uri.fsPath;
  }

  async validate(doc: vscode.TextDocument, interactive: boolean): Promise<void> {
    const file = FhiclValidator.target(doc, interactive);
    if (!file || this.running.has(file)) return;
    this.running.add(file);
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "FHiCL: running fhicl-dump…" },
        () => this.env.runTool("dump", ["-q", "-c", file], getExtraSearchPath(doc.uri)),
      );
      const output = `${r.stderr}\n${r.stdout}`;
      if (r.code === "NO_ENV") {
        if (interactive) {
          void vscode.window
            .showInformationMessage("FHiCL: no environment is selected for this window.", "Select Environment")
            .then((c) => c && vscode.commands.executeCommand("fhicl.selectEnvironment"));
        }
        return;
      }
      if (r.code === 0) {
        this.collection.delete(doc.uri);
        if (interactive) void vscode.window.showInformationMessage(`FHiCL: ${path.basename(file)} is valid (fhicl-dump).`);
        return;
      }
      if (looksLikeMissingTool(r.code, output)) {
        this.reportMissingTool(interactive);
        return;
      }
      if (r.code === "ETIMEDOUT") {
        this.env.output.appendLine("fhicl-dump timed out; raise fhicl.timeoutSeconds if the container is slow to start.");
        if (interactive) void vscode.window.showWarningMessage("FHiCL: fhicl-dump timed out (see fhicl.timeoutSeconds).");
        return;
      }
      this.env.output.appendLine(output.trim());
      this.collection.set(doc.uri, [this.toDiagnostic(doc, file, output)]);
      if (interactive) void vscode.window.showErrorMessage(`FHiCL: fhicl-dump reported an error in ${path.basename(file)}.`);
    } finally {
      this.running.delete(file);
    }
  }

  private toDiagnostic(doc: vscode.TextDocument, file: string, output: string): vscode.Diagnostic {
    const err = parseDumpError(output);
    let range = new vscode.Range(0, 0, 0, 1);
    let message = err.message;
    const loc = err.location;
    if (!loc && err.missingFile) {
      // Failed #include: point at the directive that names the file.
      const at = doc.getText().indexOf(`"${err.missingFile}"`);
      if (at >= 0) {
        const p = doc.positionAt(at);
        range = new vscode.Range(p, p.translate(0, err.missingFile.length + 2));
      }
    }
    if (loc) {
      if (path.resolve(loc.file) === path.resolve(file) || path.basename(loc.file) === path.basename(file)) {
        const line = Math.min(Math.max(loc.line - 1, 0), doc.lineCount - 1);
        const text = doc.lineAt(line).text;
        const col = Math.min(Math.max(loc.character - 1, 0), text.length);
        const end = Math.max(col + 1, text.search(/\s|$/) > col ? text.search(/\s|$/) : col + 1);
        range = new vscode.Range(line, col, line, Math.min(end, Math.max(text.length, col + 1)));
      } else {
        message = `In included file ${loc.file}, line ${loc.line}, character ${loc.character}:\n${message}`;
      }
    }
    const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    d.source = SOURCE;
    return d;
  }

  private reportMissingTool(interactive: boolean): void {
    const hint =
      "FHiCL: could not run fhicl-dump in this window's environment. Pick or edit an environment (status bar, fhicl.environments), or set fhicl.dumpPath. Syntax checking works without it.";
    this.env.output.appendLine(hint);
    if (interactive) {
      void vscode.window.showWarningMessage(hint, "Open Settings").then((c) => {
        if (c) void vscode.commands.executeCommand("workbench.action.openSettings", "fhicl");
      });
    } else if (!this.quietMissingToolLogged) {
      this.quietMissingToolLogged = true; // on-save: stay quiet after the first log line
    }
  }

  /** Show fhicl-dump -a (resolved/annotated) or fhicl-expand output for a file in a new editor tab. */
  async showTool(doc: vscode.TextDocument | undefined, tool: "dump" | "expand"): Promise<void> {
    const file = FhiclValidator.target(doc, true);
    if (!file) return;
    const args = tool === "dump" ? ["-a", "-c", file] : [file];
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `FHiCL: running fhicl-${tool}…` },
      () => this.env.runTool(tool, args, getExtraSearchPath(doc!.uri)),
    );
    if (r.code !== 0) {
      const output = `${r.stderr}\n${r.stdout}`;
      if (looksLikeMissingTool(r.code, output)) {
        this.reportMissingTool(true);
      } else {
        this.env.output.appendLine(output.trim());
        void vscode.window
          .showErrorMessage(`FHiCL: fhicl-${tool} failed: ${parseDumpError(output).message.split("\n")[0]}`, "Show Output")
          .then((c) => c && this.env.output.show(true));
      }
      return;
    }
    const shown = await vscode.workspace.openTextDocument({ content: r.stdout, language: "fhicl" });
    await vscode.window.showTextDocument(shown, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
