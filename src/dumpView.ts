/**
 * Model + HTML for the "resolved configuration" preview. Pure (no vscode import).
 *
 * Input is `fhicl-dump --prefix-annotate` output, e.g.:
 *
 *   # Produced from '.../fhicl-dump' using:
 *   #   Input  : /w/x.fcl
 *
 *   #KEY|physics|
 *   #SRC|./x.fcl:5|
 *   physics: {
 *   #KEY|physics.t.a|
 *   #SRC|./x.fcl:6|
 *         a: 7
 *   }
 */
export interface DumpLine {
  text: string; // trimmed content line
  key?: string; // fully qualified key, e.g. "physics.t.seq[1]"
  src?: string; // "file:line" where the value was defined (omitted when synthesized)
}

export interface DumpBlock {
  open: DumpLine;
  children: Array<DumpBlock | DumpLine>;
  close?: DumpLine;
}

export interface DumpModel {
  header: string[];
  root: Array<DumpBlock | DumpLine>;
  /** The dump without the annotation lines: what plain `fhicl-dump` prints (minus its header). */
  plain: string;
}

export function isBlock(x: DumpBlock | DumpLine): x is DumpBlock {
  return (x as DumpBlock).open !== undefined;
}

export function parseAnnotatedDump(output: string): DumpModel {
  const header: string[] = [];
  const root: Array<DumpBlock | DumpLine> = [];
  const plainLines: string[] = [];
  const stack: DumpBlock[] = [];
  const sink = (): Array<DumpBlock | DumpLine> => (stack.length ? stack[stack.length - 1].children : root);
  let key: string | undefined;
  let src: string | undefined;
  let seenContent = false;

  for (const raw of output.replace(/\r/g, "").split("\n")) {
    if (raw.startsWith("#KEY|")) {
      key = raw.slice(5, raw.lastIndexOf("|"));
      continue;
    }
    if (raw.startsWith("#SRC|")) {
      const s = raw.slice(5, raw.lastIndexOf("|"));
      src = s && s !== '""' ? s : undefined;
      continue;
    }
    if (raw.trim() === "") continue;
    if (!seenContent && raw.startsWith("#")) {
      header.push(raw.replace(/^#\s?/, ""));
      continue;
    }
    seenContent = true;
    plainLines.push(raw);
    const t = raw.trim();
    const line: DumpLine = { text: t, key, src };
    key = undefined;
    src = undefined;
    if (t.startsWith("}") || t.startsWith("]")) {
      const b = stack.pop();
      if (b) b.close = line;
      else root.push(line);
    } else if (t.endsWith("{") || t.endsWith("[")) {
      const block: DumpBlock = { open: line, children: [] };
      sink().push(block);
      stack.push(block);
    } else {
      sink().push(line);
    }
  }
  return { header, root, plain: plainLines.join("\n") + (plainLines.length ? "\n" : "") };
}

// ----------------------------------------------------------------------------- HTML

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function valueHtml(v: string): string {
  const trail = v.endsWith(",") ? "," : "";
  const core = trail ? v.slice(0, -1) : v;
  let cls = "plain";
  if (core.startsWith('"')) cls = "str";
  else if (core === "true" || core === "false") cls = "bool";
  else if (/^[+-]?(\d|\.\d|infinity)/.test(core)) cls = "num";
  return `<span class="v-${cls}">${esc(core)}</span>${trail}`;
}

function contentHtml(text: string): string {
  // "name: value", "name: {", or a bare value (sequence element)
  const m = /^([A-Za-z0-9_]+):(?: (.*))?$/.exec(text);
  if (!m) return valueHtml(text);
  const rest = m[2] ?? "";
  const tail = rest === "{" || rest === "[" ? `<span class="br">${rest}</span>` : rest ? valueHtml(rest) : "";
  return `<span class="k">${esc(m[1])}</span>: ${tail}`;
}

function srcHtml(src: string | undefined): string {
  if (!src) return "";
  const short = src.replace(/^.*\//, "");
  return `<a class="src" href="#" data-src="${esc(src)}" title="${esc(src)}">${esc(short)}</a>`;
}

function lineHtml(l: DumpLine, extraClass = ""): string {
  return `<div class="line ${extraClass}" data-key="${esc(l.key ?? "")}">${contentHtml(l.text)}${srcHtml(l.src)}</div>`;
}

function nodeHtml(n: DumpBlock | DumpLine, depth: number): string {
  if (!isBlock(n)) return lineHtml(n);
  const open = depth < 1 ? " open" : ""; // top-level tables start expanded, deeper ones collapsed
  const kids = n.children.map((c) => nodeHtml(c, depth + 1)).join("");
  const count = n.children.length;
  const close = n.close ? `<div class="line close">${esc(n.close.text)}</div>` : "";
  return (
    `<details${open} class="blk"><summary>${lineHtml(n.open, "sum")}<span class="count">${count}</span></summary>` +
    `<div class="kids">${kids}</div>${close}</details>`
  );
}

export function renderBody(model: DumpModel): string {
  return model.root.map((n) => nodeHtml(n, 0)).join("");
}
