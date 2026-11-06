import * as vscode from "vscode";
import { Diagnostic } from "./parser/ast";
import { parse } from "./parser/parser";

const SOURCE = "fhicl";

/**
 * Live syntax checking of the open document only. Never follows #include and never runs
 * external tools; the resolved view (and semantic errors) come from fhicl-dump in the preview.
 */
export class FhiclDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(SOURCE);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [this.collection];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("fhicl.diagnostics")) this.refreshAll();
      }),
    );
    this.refreshAll();
  }

  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
  }

  private schedule(doc: vscode.TextDocument): void {
    if (doc.languageId !== "fhicl") return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc);
      }, 200),
    );
  }

  private clear(doc: vscode.TextDocument): void {
    clearTimeout(this.timers.get(doc.uri.toString()));
    this.timers.delete(doc.uri.toString());
    this.collection.delete(doc.uri);
  }

  refresh(doc: vscode.TextDocument): void {
    if (doc.languageId !== "fhicl") return;
    if (!vscode.workspace.getConfiguration("fhicl", doc.uri).get<boolean>("diagnostics.enable", true)) {
      this.collection.delete(doc.uri);
      return;
    }
    const { diagnostics } = parse(doc.getText());
    this.collection.set(
      doc.uri,
      diagnostics.map((x) => toVsCode(doc, x)),
    );
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

function toVsCode(doc: vscode.TextDocument, d: Diagnostic): vscode.Diagnostic {
  const range = new vscode.Range(doc.positionAt(d.start), doc.positionAt(Math.max(d.end, d.start + 1)));
  const diag = new vscode.Diagnostic(
    range,
    d.message,
    d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
  );
  diag.source = SOURCE;
  return diag;
}
