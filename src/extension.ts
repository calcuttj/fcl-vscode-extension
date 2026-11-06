import * as vscode from "vscode";
import { FhiclDiagnostics } from "./diagnostics";
import { FhiclEnv } from "./env";
import { registerEnvironmentUi } from "./envStatus";
import { registerNavigation } from "./navigation";
import { FhiclPreview } from "./preview";
import { FhiclValidator } from "./validate";

export function activate(context: vscode.ExtensionContext): void {
  const env = new FhiclEnv(context);
  const diagnostics = new FhiclDiagnostics();
  const validator = new FhiclValidator(env);
  const preview = new FhiclPreview(env);
  const active = () => vscode.window.activeTextEditor?.document;
  registerNavigation(context);
  registerEnvironmentUi(context, env);

  context.subscriptions.push(
    env,
    diagnostics,
    validator,
    preview,
    vscode.commands.registerCommand("fhicl.preview", () => preview.show(active())),
    vscode.commands.registerCommand("fhicl.validate", () => {
      const doc = active();
      if (doc) void validator.validate(doc, true);
      else void vscode.window.showInformationMessage("FHiCL: open a .fcl file first.");
    }),
    vscode.commands.registerCommand("fhicl.reloadEnvironment", () => env.reload(true)),
    vscode.commands.registerCommand("fhicl.showResolved", () => validator.showTool(active(), "dump")),
    vscode.commands.registerCommand("fhicl.showExpanded", () => validator.showTool(active(), "expand")),
  );
}

export function deactivate(): void {}
