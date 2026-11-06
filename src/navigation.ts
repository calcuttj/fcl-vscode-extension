import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  atomAt,
  buildIndex,
  completeNames,
  DefIndex,
  DefLocation,
  findLabelDefinitions,
  includePrefix,
  keyAt,
  lookupDefinition,
  otherDefinitions,
  refPrefix,
} from "./definitions";
import { Reference, Statement } from "./parser/ast";
import { parse } from "./parser/parser";
import { findIncludeAsync, includeDirs } from "./searchPath";

const SELECTOR: vscode.DocumentSelector = { language: "fhicl" };

function selfPathOf(doc: vscode.TextDocument): string | undefined {
  return doc.uri.scheme === "file" ? doc.uri.fsPath : undefined;
}

/** Parse + definition index per document version (current file only). */
class Cache {
  private parsed = new Map<string, { version: number; result: ReturnType<typeof parse> }>();
  private indexes = new Map<string, { version: number; index: DefIndex }>();

  parse(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    const hit = this.parsed.get(key);
    if (hit && hit.version === doc.version) return hit.result;
    const result = parse(doc.getText());
    this.parsed.set(key, { version: doc.version, result });
    return result;
  }

  index(doc: vscode.TextDocument): DefIndex {
    const key = doc.uri.toString();
    const hit = this.indexes.get(key);
    if (hit && hit.version === doc.version) return hit.index;
    const index = buildIndex(doc.getText(), this.parse(doc));
    this.indexes.set(key, { version: doc.version, index });
    return index;
  }

  forget(doc: vscode.TextDocument): void {
    this.parsed.delete(doc.uri.toString());
    this.indexes.delete(doc.uri.toString());
  }
}

function locationOf(doc: vscode.TextDocument, d: DefLocation): vscode.Location {
  return new vscode.Location(doc.uri, new vscode.Range(d.line, d.col, d.endLine, d.endCol));
}

function referenceAt(doc: vscode.TextDocument, cache: Cache, pos: vscode.Position): Reference | undefined {
  const off = doc.offsetAt(pos);
  return cache.parse(doc).references.find((r) => r.start <= off && off <= r.end && r.kind !== "db" && r.kind !== "id");
}

function includeAt(doc: vscode.TextDocument, cache: Cache, pos: vscode.Position) {
  const off = doc.offsetAt(pos);
  return cache.parse(doc).includes.find((i) => i.start <= off && off <= i.end);
}

// ------------------------------------------------------------------- outline

function symbolFor(doc: vscode.TextDocument, st: Statement): vscode.DocumentSymbol | undefined {
  const range = new vscode.Range(doc.positionAt(st.start), doc.positionAt(st.end));
  if (st.kind === "insert") {
    const sel = new vscode.Range(doc.positionAt(st.ref.start), doc.positionAt(st.ref.end));
    return new vscode.DocumentSymbol(`@table::${st.ref.name}`, "", vscode.SymbolKind.Interface, range, sel);
  }
  if (st.kind !== "assign") return undefined;
  const sel = new vscode.Range(doc.positionAt(st.name.start), doc.positionAt(st.name.end));
  const v = st.value;
  const kind =
    v.kind === "table"
      ? vscode.SymbolKind.Struct
      : v.kind === "sequence"
        ? vscode.SymbolKind.Array
        : v.kind === "ref"
          ? vscode.SymbolKind.Constant
          : v.type === "number"
            ? vscode.SymbolKind.Number
            : v.type === "bool"
              ? vscode.SymbolKind.Boolean
              : vscode.SymbolKind.String;
  const detail =
    v.kind === "atom"
      ? v.text.slice(0, 60)
      : v.kind === "ref"
        ? `@${v.ref.kind}::${v.ref.name}`
        : v.kind === "sequence"
          ? `[${v.items.length}]`
          : "";
  const sym = new vscode.DocumentSymbol(st.name.text, detail, kind, range, sel);
  if (v.kind === "table") {
    for (const child of v.statements) {
      const c = symbolFor(doc, child);
      if (c) sym.children.push(c);
    }
  }
  return sym;
}

// ------------------------------------------------------------------ register

export function registerNavigation(context: vscode.ExtensionContext): void {
  const cache = new Cache();

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((d) => cache.forget(d)),

    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols(doc) {
        const out: vscode.DocumentSymbol[] = [];
        for (const st of cache.parse(doc).statements) {
          const s = symbolFor(doc, st);
          if (s) out.push(s);
        }
        return out;
      },
    }),

    vscode.languages.registerDocumentLinkProvider(SELECTOR, {
      async provideDocumentLinks(doc) {
        const from = selfPathOf(doc);
        const links: vscode.DocumentLink[] = [];
        for (const inc of cache.parse(doc).includes) {
          const target = await findIncludeAsync(inc.file, from);
          if (!target) continue;
          const link = new vscode.DocumentLink(
            new vscode.Range(doc.positionAt(inc.fileStart), doc.positionAt(inc.fileEnd)),
            vscode.Uri.file(target),
          );
          link.tooltip = target;
          links.push(link);
        }
        return links;
      },
    }),

    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition(doc, pos) {
        const ref = referenceAt(doc, cache, pos);
        if (ref) return lookupDefinition(cache.index(doc), ref.name).map((d) => locationOf(doc, d));
        const off = doc.offsetAt(pos);
        // A plain string used as an art module label or path name, e.g. largeant in simulate: [ rns, largeant ].
        const atom = atomAt(cache.parse(doc), off);
        if (atom) return findLabelDefinitions(cache.index(doc), atom.word).map((d) => locationOf(doc, d));
        // A key: jump to its other definitions (e.g. from an override to the original).
        const key = keyAt(cache.parse(doc), off);
        if (key) {
          const lineOf = (o: number) => {
            const p = doc.positionAt(o);
            return { line: p.line, col: p.character };
          };
          return otherDefinitions(cache.index(doc), key, lineOf).map((d) => locationOf(doc, d));
        }
        return undefined;
      },
    }),

    vscode.languages.registerHoverProvider(SELECTOR, {
      async provideHover(doc, pos) {
        const ref = referenceAt(doc, cache, pos);
        if (ref) {
          const defs = lookupDefinition(cache.index(doc), ref.name);
          const range = new vscode.Range(doc.positionAt(ref.start), doc.positionAt(ref.end));
          if (defs.length === 0) {
            return new vscode.Hover(
              new vscode.MarkdownString(
                `\`${ref.name}\` is not defined in this file. It may come from an #include: use the preview (title-bar button) to see the resolved configuration.`,
              ),
              range,
            );
          }
          const last = defs[defs.length - 1];
          const md = new vscode.MarkdownString();
          md.appendCodeblock(last.snippet.split("\n").slice(0, 14).join("\n"), "fhicl");
          const where = `line ${last.line + 1}`;
          md.appendText(defs.length > 1 ? `Last of ${defs.length} definitions. ${where}` : where);
          return new vscode.Hover(md, range);
        }
        const atom = atomAt(cache.parse(doc), doc.offsetAt(pos));
        if (atom) {
          const defs = findLabelDefinitions(cache.index(doc), atom.word);
          if (defs.length > 0) {
            const d = defs[0];
            const md = new vscode.MarkdownString();
            md.appendCodeblock(d.snippet.split("\n").slice(0, 14).join("\n"), "fhicl");
            md.appendText(`line ${d.line + 1}${defs.length > 1 ? ` (1 of ${defs.length} matches)` : ""}`);
            return new vscode.Hover(md, new vscode.Range(doc.positionAt(atom.start), doc.positionAt(atom.end)));
          }
        }
        const inc = includeAt(doc, cache, pos);
        if (inc) {
          const target = await findIncludeAsync(inc.file, selfPathOf(doc));
          const range = new vscode.Range(doc.positionAt(inc.start), doc.positionAt(inc.end));
          return new vscode.Hover(
            new vscode.MarkdownString(target ? `Resolves to \`${target}\`` : `\`${inc.file}\` was not found on the include path.`),
            range,
          );
        }
        return undefined;
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        async provideCompletionItems(doc, pos) {
          const linePrefix = doc.lineAt(pos).text.slice(0, pos.character);

          const inc = includePrefix(linePrefix);
          if (inc !== undefined) return completeIncludes(doc, pos, inc);

          const ref = refPrefix(linePrefix);
          if (ref) {
            const range = new vscode.Range(pos.translate(0, -ref.typed.length), pos);
            return completeNames(cache.index(doc), ref.kind, ref.typed).map((name) => {
              const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
              item.range = range;
              return item;
            });
          }
          return undefined;
        },
      },
      '"',
      "/",
      ":",
      ".",
    ),
  );
}

async function completeIncludes(doc: vscode.TextDocument, pos: vscode.Position, typed: string): Promise<vscode.CompletionItem[]> {
  const slash = typed.lastIndexOf("/");
  const subdir = slash >= 0 ? typed.slice(0, slash) : "";
  const range = new vscode.Range(pos.translate(0, -(typed.length - (slash + 1))), pos);
  const seen = new Set<string>();
  const items: vscode.CompletionItem[] = [];
  const dirs = includeDirs(selfPathOf(doc));
  await Promise.all(
    dirs.map(async (d) => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(path.join(d, subdir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const isDir = e.isDirectory() || (e.isSymbolicLink() && isDirSafe(path.join(d, subdir, e.name)));
        if (!isDir && !e.name.endsWith(".fcl")) continue;
        const key = (isDir ? "d:" : "f:") + e.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = new vscode.CompletionItem(
          e.name,
          isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
        );
        item.range = range;
        item.detail = path.join(d, subdir);
        if (isDir) {
          item.insertText = e.name + "/";
          item.command = { command: "editor.action.triggerSuggest", title: "" };
          item.sortText = "1" + e.name;
        } else {
          item.sortText = "0" + e.name;
        }
        items.push(item);
      }
    }),
  );
  return items;
}

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
