/**
 * Interpret fhicl-dump / fhicl-expand failure output. Real output (fhiclcpp v4, via abort()):
 *
 *   terminate called after throwing an instance of 'cet::coded_exception<...>'
 *     what():  ---- Parse error BEGIN
 *     detected at or near line 3, character 1, of file "/path/x.fcl"
 *
 *     c: 3
 *     ^
 *   ---- Parse error END
 *
 * Other categories have different bodies (e.g. `search_path` with `Can't find file "x.fcl"`),
 * and some errors carry no location at all.
 */
export interface DumpError {
  location?: { line: number; character: number; file: string };
  /** File named by a "Can't find file" error (a failed #include), if any. */
  missingFile?: string;
  /** Error category from the "---- X BEGIN" fence, e.g. "Parse error", "search_path". */
  category?: string;
  /** Human-readable text with the abort()/what() wrapper and setup chatter removed. */
  message: string;
}

const LOC_RE = /line (\d+), character (\d+), of file "([^"]*)"/;
const FENCE_RE = /^.*?---- (.+?) BEGIN[ \t]*$/m; // outermost fence; may follow "what():"

export function parseDumpError(output: string): DumpError {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  let category: string | undefined;
  let body = clean;
  const begin = FENCE_RE.exec(clean);
  if (begin) {
    category = begin[1];
    const after = clean.slice(begin.index + begin[0].length);
    const end = after.lastIndexOf(`---- ${category} END`);
    body = end >= 0 ? after.slice(0, end) : after;
    // Nested fences ("---- Can't find key BEGIN") add nothing once we show their contents.
    body = body.replace(/^[ \t]*---- .+? (?:BEGIN|END)[ \t]*$\n?/gm, "");
  } else {
    // No fence: drop the usual noise lines and keep whatever is left.
    body = clean
      .split("\n")
      .filter((l) => !/^perl: |^\s*(LANGUAGE|LC_ALL|LANG) =|are supported and installed|^terminate called/.test(l))
      .join("\n");
  }
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, i, a) => l.trim() !== "" || (i > 0 && a[i - 1].trim() !== "")); // collapse blank runs
  let message = lines.join("\n").replace(/^\s*\n+/, "").replace(/^[ \t]{2}/gm, "").trim();
  if (category) message = `${category}: ${message}`;
  if (message.length > 1200) message = message.slice(0, 1200) + "…";
  const loc = LOC_RE.exec(clean);
  const missing = /Can't find file "([^"]+)"/.exec(clean);
  return {
    message: message || "fhicl-dump failed with no output",
    category,
    missingFile: missing?.[1],
    location: loc ? { line: Number(loc[1]), character: Number(loc[2]), file: loc[3] } : undefined,
  };
}

/** True if the failure means the tool itself could not be run (not a problem with the .fcl). */
export function looksLikeMissingTool(exitCode: number | string | undefined, output: string): boolean {
  return (
    exitCode === "ENOENT" ||
    exitCode === 127 ||
    /command not found|fhicl-(dump|expand): not found/i.test(output)
  );
}

/** Name of a shared library the dynamic loader could not find, e.g. "libcrypto.so.10". */
export function missingLibrary(output: string): string | undefined {
  return /error while loading shared libraries: ([^:\s]+)/.exec(output)?.[1];
}

/**
 * True if a host-side run failed *to start* (missing library or executable) rather than the tool
 * running and reporting a problem; the caller can then fall back to the container.
 */
export function looksLikeStartFailure(exitCode: number | string | undefined, output: string): boolean {
  return exitCode === "ENOENT" || exitCode === 127 || missingLibrary(output) !== undefined;
}
