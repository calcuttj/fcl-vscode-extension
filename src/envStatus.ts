import * as vscode from "vscode";
import { FhiclEnv } from "./env";

/** Status-bar item showing (and switching) this window's FHiCL environment. */
export function registerEnvironmentUi(context: vscode.ExtensionContext, env: FhiclEnv): void {
  const item = vscode.window.createStatusBarItem("fhicl.environment", vscode.StatusBarAlignment.Right, 100);
  item.name = "FHiCL Environment";
  item.command = "fhicl.selectEnvironment";

  const update = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "fhicl") {
      item.hide();
      return;
    }
    const st = env.status();
    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = false;
    if (st.kind === "noProfiles") {
      item.text = "$(beaker) FHiCL: VS Code env";
      tip.appendMarkdown("No environments are defined, so tools use VS Code's own environment.\n\n");
      tip.appendMarkdown("Define named environments in the `fhicl.environments` setting to choose one per window.");
    } else if (st.kind === "none") {
      item.text = "$(beaker) FHiCL: no environment";
      tip.appendMarkdown("No environment selected for this window. Click to choose one.");
    } else {
      const e = st.env;
      const icon = env.captureState === "capturing" ? "$(sync~spin)" : env.captureState === "failed" ? "$(warning)" : "$(beaker)";
      item.text = `${icon} FHiCL: ${e.name}`;
      tip.appendMarkdown(`**${e.name}** (this window)\n\n`);
      if (e.setupCommand) tip.appendCodeblock(e.setupCommand, "bash");
      tip.appendMarkdown(`\nRun mode: \`${e.runMode}\`${e.commandPrefix.length ? ` · container: \`${e.commandPrefix[0]}\`` : ""}\n\n`);
      if (env.captureState === "capturing") tip.appendMarkdown("Setting up the environment…");
      else if (env.captureState === "failed") tip.appendMarkdown("Environment setup failed: see the FHiCL output channel.");
      else if (env.lastCapture)
        tip.appendMarkdown(
          `FHICL_FILE_PATH: ${env.lastCapture.env.fhiclFilePath.length} entries, captured ${new Date(env.lastCapture.capturedAt).toLocaleString()}`,
        );
      tip.appendMarkdown("\n\nClick to switch environment.");
    }
    item.tooltip = tip;
    item.show();
  };

  context.subscriptions.push(
    item,
    env.onDidChange(update),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.commands.registerCommand("fhicl.selectEnvironment", () => pickEnvironment(env)),
  );
  update();
}

/** QuickPick of the defined environments. Resolves true if an environment is now selected. */
export async function pickEnvironment(env: FhiclEnv): Promise<boolean> {
  type Item = vscode.QuickPickItem & { action: "select" | "none" | "edit"; name?: string };
  const current = env.activeName();
  const items: Item[] = env.profiles().map((p) => ({
    action: "select",
    name: p.name,
    label: `${p.name === current ? "$(check) " : ""}${p.name}`,
    description: p.runMode ?? "",
    detail: p.setupCommand || "(no setup command)",
  }));
  items.push(
    { action: "none", label: "", kind: vscode.QuickPickItemKind.Separator },
    { action: "none", label: "$(circle-slash) None", description: "no environment for this window" },
    { action: "edit", label: "$(gear) Edit environments…", description: "fhicl.environments" },
  );
  const pick = await vscode.window.showQuickPick(items, {
    title: "FHiCL environment for this window",
    placeHolder: items.length > 3 ? "Choose the UPS/mrb environment used by the preview in this window" : "No environments defined yet",
  });
  if (!pick) return env.status().kind === "active";
  if (pick.action === "edit") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "fhicl.environments");
    return false;
  }
  await env.select(pick.action === "select" ? pick.name : undefined);
  return pick.action === "select";
}
