import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { esc, parseAnnotatedDump, renderBody } from "./dumpView";
import { looksLikeMissingTool, parseDumpError } from "./dumpErrors";
import { FhiclEnv } from "./env";
import { pickEnvironment } from "./envStatus";
import { findInclude, getExtraSearchPath } from "./searchPath";

type View =
  | { state: "running"; file: string; dirty: boolean }
  | { state: "ok"; file: string; dirty: boolean; bodyHtml: string; plain: string; header: string[]; ms: number }
  | { state: "error"; file: string; dirty: boolean; message: string; line?: number; character?: number; missingTool: boolean }
  | { state: "noenv"; file: string; dirty: boolean };

/**
 * A side panel, like Markdown preview, showing the resolved configuration from `fhicl-dump`.
 * It only runs when asked: the title-bar button / command, or the panel's own Refresh button.
 * Never on save and never on typing.
 */
export class FhiclPreview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: vscode.Uri | undefined;
  private busy = false;
  private plain = "";

  constructor(private readonly env: FhiclEnv) {}

  async show(doc: vscode.TextDocument | undefined): Promise<void> {
    if (!doc || doc.languageId !== "fhicl" || doc.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("FHiCL: open a .fcl file on disk first.");
      return;
    }
    this.current = doc.uri;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "fhiclPreview",
        "FHiCL preview",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        // enableFindWidget: Ctrl+F / Cmd+F search inside the rendered configuration.
        { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
      });
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    } else {
      this.panel.reveal(undefined, true);
    }
    await this.run();
  }

  private async run(): Promise<void> {
    const uri = this.current;
    if (!uri || !this.panel || this.busy) return;
    this.busy = true;
    const file = uri.fsPath;
    const dirty = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty);
    this.panel.title = `Resolved: ${path.basename(file)}`;
    this.render({ state: "running", file, dirty });
    const t0 = Date.now();
    try {
      const r = await this.env.runTool("dump", ["--prefix-annotate", "-c", file], getExtraSearchPath(uri));
      const output = `${r.stderr}\n${r.stdout}`;
      if (r.code === "NO_ENV") {
        this.render({ state: "noenv", file, dirty });
      } else if (r.code === 0 && r.stdout.trim() !== "") {
        const model = parseAnnotatedDump(r.stdout);
        this.plain = model.plain;
        this.render({ state: "ok", file, dirty, bodyHtml: renderBody(model), plain: model.plain, header: model.header, ms: Date.now() - t0 });
      } else if (looksLikeMissingTool(r.code, output)) {
        this.render({
          state: "error",
          file,
          dirty,
          missingTool: true,
          message:
            "Could not run fhicl-dump in this window's environment. Pick or edit an environment (status bar, fhicl.environments), or set fhicl.dumpPath. Syntax checking works without it.",
        });
      } else {
        this.env.output.appendLine(output.trim());
        const err = parseDumpError(output);
        const inThis = err.location && path.resolve(err.location.file) === path.resolve(file);
        this.render({
          state: "error",
          file,
          dirty,
          missingTool: false,
          message: r.code === "ETIMEDOUT" ? "fhicl-dump timed out (see fhicl.timeoutSeconds)." : err.message,
          line: inThis ? err.location!.line : undefined,
          character: inThis ? err.location!.character : undefined,
        });
      }
    } finally {
      this.busy = false;
    }
  }

  private async onMessage(m: { type?: string; src?: string; line?: number; character?: number }): Promise<void> {
    switch (m.type) {
      case "refresh":
        await this.run();
        break;
      case "copy":
        await vscode.env.clipboard.writeText(this.plain);
        void vscode.window.setStatusBarMessage("FHiCL: resolved configuration copied", 3000);
        break;
      case "settings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "fhicl.environments");
        break;
      case "selectEnv":
        if (await pickEnvironment(this.env)) await this.run();
        break;
      case "goto":
        if (this.current && typeof m.line === "number") {
          const p = new vscode.Position(Math.max(m.line - 1, 0), Math.max((m.character ?? 1) - 1, 0));
          await vscode.window.showTextDocument(this.current, { selection: new vscode.Range(p, p), viewColumn: vscode.ViewColumn.One });
        }
        break;
      case "open":
        if (typeof m.src === "string") await this.openSource(m.src);
        break;
    }
  }

  /** "file:line" as printed by fhicl-dump, relative to wherever it ran. */
  private async openSource(src: string): Promise<void> {
    const cut = src.lastIndexOf(":");
    const file = cut > 0 ? src.slice(0, cut) : src;
    const line = cut > 0 ? Number(src.slice(cut + 1)) : 1;
    const resolved = path.isAbsolute(file) ? file : findInclude(file.replace(/^\.\//, ""), this.current?.fsPath);
    if (!resolved) {
      void vscode.window.showWarningMessage(`FHiCL: could not find ${file} on the include path.`);
      return;
    }
    const p = new vscode.Position(Math.max((Number.isFinite(line) ? line : 1) - 1, 0), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(resolved), {
      selection: new vscode.Range(p, p),
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private render(v: View): void {
    if (!this.panel) return;
    const nonce = crypto.randomBytes(16).toString("hex");
    const name = esc(path.basename(v.file));
    const dirty = v.dirty
      ? `<div class="banner">The file has unsaved changes. fhicl-dump reads the saved version.</div>`
      : "";
    let main = "";
    if (v.state === "noenv") {
      main =
        `<div class="err-title">No FHiCL environment selected for this window</div>` +
        `<p>Choose which UPS/mrb environment fhicl-dump runs in. Each window can use a different one.</p>` +
        `<div><button data-act="selectEnv">Select environment</button></div>`;
    } else if (v.state === "running") {
      main = `<div class="status">Running fhicl-dump… (container start-up can take several seconds)</div>`;
    } else if (v.state === "error") {
      const goto = v.line
        ? `<button data-act="goto" data-line="${v.line}" data-char="${v.character ?? 1}">Go to line ${v.line}</button>`
        : "";
      const settings = v.missingTool
        ? `<button data-act="selectEnv">Select environment</button> <button data-act="settings">Edit environments</button>`
        : "";
      main = `<div class="err-title">fhicl-dump reported an error</div><pre class="err">${esc(v.message)}</pre><div>${goto}${settings}</div>`;
    } else {
      main =
        `<div class="meta">${v.header.map((h) => esc(h.trim())).filter((h) => h.startsWith("Input") || h.startsWith("Path")).join(" · ")}` +
        ` · ran in ${v.ms} ms at ${new Date().toLocaleTimeString()}</div><div class="tree">${v.bodyHtml}</div>`;
    }
    const disabled = v.state === "running" ? " disabled" : "";
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    this.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width">
<style nonce="${nonce}">${CSS}</style></head><body>
<div class="bar"><b>${name}</b>
<button data-act="refresh"${disabled}>Refresh</button>
<button data-act="expand"${v.state === "ok" ? "" : " disabled"}>Expand all</button>
<button data-act="collapse"${v.state === "ok" ? "" : " disabled"}>Collapse all</button>
<button data-act="copy"${v.state === "ok" ? "" : " disabled"}>Copy</button></div>
${dirty}${main}
<script nonce="${nonce}">${JS}</script></body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

const CSS = `
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 12px 24px}
.bar{position:sticky;top:0;background:var(--vscode-editor-background);padding:8px 0;display:flex;gap:6px;align-items:center;z-index:2;border-bottom:1px solid var(--vscode-panel-border)}
.bar b{margin-right:8px}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 10px;border-radius:2px;cursor:pointer}
button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.5;cursor:default}
.meta,.status{color:var(--vscode-descriptionForeground);margin:8px 0;font-size:.9em}
.banner{background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);padding:4px 8px;margin:8px 0}
.err-title{color:var(--vscode-errorForeground);font-weight:bold;margin:12px 0 4px}
pre.err{font-family:var(--vscode-editor-font-family);white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px}
.tree{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5}
details>summary{cursor:pointer;list-style:none;display:block}details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"\\25B8";display:inline-block;width:1em;color:var(--vscode-descriptionForeground)}details[open]>summary::before{content:"\\25BE"}
.kids{margin-left:1.4em;border-left:1px solid var(--vscode-tree-indentGuidesStroke)}.kids>.line{padding-left:.6em}.kids details{padding-left:.6em}
.line{display:inline}.line.sum{display:inline}.line:not(.sum){display:block}.close{display:block;color:var(--vscode-descriptionForeground);padding-left:1em}
.k{color:var(--vscode-symbolIcon-propertyForeground,var(--vscode-textLink-foreground))}.br{color:var(--vscode-descriptionForeground)}
.v-str{color:var(--vscode-debugTokenExpression-string,#ce9178)}.v-num{color:var(--vscode-debugTokenExpression-number,#b5cea8)}.v-bool{color:var(--vscode-debugTokenExpression-boolean,#569cd6)}
.count{color:var(--vscode-descriptionForeground);font-size:.8em;margin-left:.6em}
a.src{color:var(--vscode-descriptionForeground);font-size:.8em;margin-left:1.2em;text-decoration:none;opacity:.8}a.src:hover{text-decoration:underline;opacity:1}
`;

const JS = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-src]');
  if (!el) return;
  if (el.dataset.src) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({type:'open', src: el.dataset.src}); return; }
  const act = el.dataset.act;
  if (act === 'expand') document.querySelectorAll('details').forEach(d => d.open = true);
  else if (act === 'collapse') document.querySelectorAll('details').forEach(d => d.open = false);
  else if (act === 'goto') vscode.postMessage({type:'goto', line: Number(el.dataset.line), character: Number(el.dataset.char)});
  else vscode.postMessage({type: act});
});
`;
