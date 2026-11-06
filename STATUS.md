# FHiCL VS Code extension: status

Last updated: 2026-11-06. Version 0.0.1 (unreleased, not packaged).

Goal: VS Code support for FHiCL (`.fcl`) files: commenting, highlighting, syntax checking, and awareness of
`FHICL_FILE_PATH`, which UPS sets inside an Apptainer container (and mrb sets during development).
Reference grammar: `../fhicl-cpp` (`fhiclcpp/parse.cc`, `tokens.h`, `tools/`) and cetlib's `includer.cc` on `/cvmfs`.

## Summary

| Area | State |
|---|---|
| Language registration, `#` comment toggle, brackets | Done, not yet tried in the editor |
| TextMate syntax highlighting | Done, not yet tried in the editor |
| Built-in parser and live diagnostics (syntax only, current file only) | Done, tested |
| Include-following analysis (undefined-name warnings) | **Removed** 2026-11-06 at your request: too slow on real DUNE files, and the preview covers it |
| Container/setup environment capture (Apptainer, UPS, mrb) | Done, verified against the real container |
| `fhicl-dump` validation (on demand, optional on save) | Done, verified against the real tool |
| Host mode (capture once, run `fhicl-dump` without the container) | Done, verified against the real tool |
| Show resolved config / show expanded includes | Done, untested in the editor |
| Navigation: outline, `#include` links, go-to-definition, hover, completion (current file only) | Written, index unit-tested; providers untested in the editor |
| Packaging | `fcl-vscode-0.0.1.vsix` builds with `npm run package` (tests run first) and installs; Apache-2.0 license; no icon or repository field yet; publisher is the placeholder `local` |
| `fhicl-dump` preview panel (title-bar button, side panel, manual refresh) | Written, model unit-tested against real output; panel untested in the editor |

**Nothing has been exercised inside VS Code yet.** All checks so far are unit tests plus runs of the compiled
code against your container. First step next time: press F5 and try `samples/sample.fcl` and `samples/errors.fcl`.

## Decisions made

- **The editor checks syntax only, for the current file only.** It never follows `#include` and never runs external
  tools. Everything that needs includes or real FHiCL semantics comes from `fhicl-dump` in the preview panel.
- **Navigation is current-file only:** go-to-definition, hover and `@local::` completion cover names defined in the
  file you are editing. `#include` links are resolved asynchronously so they never block the editor.
- **`fhicl-dump` is optional.** With no configuration, only the built-in checks run. Validate-on-save is **off by
  default** (`fhicl.validateOnSave`). The palette commands always work on demand.
- **Environments are named profiles, chosen per window** (2026-11-06). `fhicl.environments` lists them in user
  settings (name, `setupCommand`, optional `commandPrefix`/`runMode`/`extraLibraryPath`/`fhiclFilePath` overrides;
  top-level `fhicl.*` values are defaults). Each window picks one from the status bar; the choice is stored per
  workspace, so two windows can use two UPS/mrb setups at once. No environment is used until one is picked; with no
  profiles defined, tools use VS Code's own environment. Captures are cached in global state by setup+container and
  shared across windows. `fhicl.setupCommand` was removed.
- **Host mode is opt-in** (`fhicl.runMode: "cachedHost"`). The default is `"container"`.
- **No re-capture on startup** when a valid cache exists. Use *Reload Environment* to refresh it.
- **Preview is manual only.** A title-bar button (and *Open Resolved Configuration Preview to the Side*) runs
  `fhicl-dump --prefix-annotate` once and shows the result beside the editor. It re-runs only when you click its
  Refresh button: never on save, never while typing.
- **Includes:** the built-in lookup is deliberately more lenient than the real tools (it also tries the including
  file's folder and the workspace folders) so it under-reports rather than raising false alarms.

## Your environment (what was verified on this machine)

- Container: `apptainer exec --fakeroot …` on `/cvmfs/singularity.opensciencegrid.org/fermilab/fnal-dev-sl7:latest`
  (SL7, glibc 2.17). Host: Ubuntu, glibc 2.39. VS Code is a snap, so it cannot run inside the container.
- Setup used for testing: `source /cvmfs/dune.opensciencegrid.org/products/dune/setup_dune.sh;
  setup dunesw v10_26_00d05 -q e26:prof`. This yields 37 `FHICL_FILE_PATH` entries and `fhicl-dump` from
  fhiclcpp v4_18_04.
- Container capture takes 4 to 15 s. The two `sudo sysctl` lines in your `cvmfs_container` function are host
  prerequisites. The extension never runs `sudo`.
- Host mode: `fhicl-dump` on the host needs one extra library, `libcrypto.so.10`. A symlink to the copy inside the
  unpacked image works (see README). With it, a passing run takes about 0.13 s, versus about 15 s in the container.
- Failing `fhicl-dump` runs take about 1.2 s even on the host. It aborts on every error and Ubuntu's `apport` crash
  handler runs. This is not avoidable from the extension.
- Perl "Setting locale failed" warnings from the container are harmless and ignored.

## How it is built

```
src/parser/{ast,parser}.ts   grammar-faithful parser (no vscode import)
src/command.ts               builds argv for container/setup/host runs; capture parsing
src/dumpErrors.ts            parses real fhicl-dump error output; start-failure detection
src/searchPath.ts            FHICL_FILE_PATH sources, include resolution, ${workspaceFolder}
src/diagnostics.ts           live syntax diagnostics (debounced 200 ms, current file only)
src/profiles.ts              named environments: validation, merge with defaults, cache key (pure)
src/env.ts                   per-window active environment, shared capture cache, runTool (container / cachedHost + fallback)
src/envStatus.ts             status-bar item and environment picker
src/validate.ts              fhicl-dump validation, show resolved/expanded
src/definitions.ts           single-file definition index (pure): go-to-definition, hover, name completion
src/navigation.ts            outline, #include links, definition, hover, completion providers
src/dumpView.ts              parses --prefix-annotate output into a tree; HTML rendering (pure, escaped)
src/preview.ts               the side panel (webview): Refresh, Expand/Collapse all, Copy, click-to-source
src/extension.ts             activation and commands
src/test/*.test.ts           38 tests (parser, corpus, command builder, e2e with real bash, index, preview model)
syntaxes/, language-configuration.json, samples/, README.md
```

Commands: *Open Resolved Configuration Preview to the Side* (also a title-bar button), *Validate with fhicl-dump*, *Reload Environment*, *Show Resolved Configuration*, *Show Expanded #includes*.
Commands also include *Select Environment for This Window* (and the status-bar item).
Settings: `fhicl.environments`, `fhicl.diagnostics.enable`, `fhicl.fhiclFilePath`, `fhicl.validateOnSave`,
`fhicl.commandPrefix`, `fhicl.dumpPath`, `fhicl.expandPath`, `fhicl.timeoutSeconds`, `fhicl.runMode`,
`fhicl.extraLibraryPath`.

## Verified against the real thing

- **Grammar:** every `.fcl` in `fhicl-cpp/fhiclcpp/test/testFiles/pass/` parses with no errors, and every syntactic
  `fail/` file reports an error. Two `fail/` cases (`adv_ref_fail`, `include4_fail`) are semantic or file-lookup
  failures, left to `fhicl-dump`.
- **Rules learned from the sources** (the first parser draft was too lenient):
  - Names cannot start with a digit.
  - Bare values must be a number, bool, or an identifier-like string. A bare `nil` is the *string* "nil"; only
    `@nil` is nil (confirmed with the real `fhicl-dump`). There is no catch-all outside snippet mode,
    so `a: foo-bar` and `a: http://x` must be quoted.
  - Dotted names are only legal at top level.
  - A `BEGIN_PROLOG` after any parameter is an error.
  - `#include` must start in column 0 and be exactly `#include "file"`, with nothing after the closing quote.
- **`fhicl-dump` output:** parse errors, lookup errors and failed includes were captured from the real tool and are
  used as test fixtures. Locations come as `line N, character C, of file "…"`. A failed include has no location,
  so the diagnostic is anchored on the `#include` line.
- **Preview input:** `fhicl-dump --prefix-annotate` prints `#KEY|a.b[1]|` and `#SRC|file:line|` before each
  parameter; synthesized values have `#SRC|""|`. Real output is a test fixture.
- **Wrapper:** end-to-end tests with real `bash` confirm that file names are passed as separate arguments (no shell
  interpolation) and that a setup script cannot see the wrapper's arguments.

## Known gaps and risks

- Not tried in the editor: highlighting, commenting, diagnostics rendering, the commands, progress and messages.
  Expect small UI bugs.
- The fallback from host mode to the container, and the warning message, are not unit-tested (they live in the
  VS Code-dependent `env.ts`). The start-failure detection they rely on is tested.
- `fhicl-dump` reads the file from disk, so unsaved edits are not validated.
- Only `fhicl-dump` was checked in host mode. Other tools (e.g. `art`) may need more system libraries.
- The `libcrypto.so.10` workaround depends on a path inside the current image tag on `/cvmfs`.
- **Performance (resolved by removal).** The include-following analysis was CPU-bound on real DUNE files (about 97 s
  of CPU on the 49 `dunesw/fcl/protodunehd` files, never finished). It was removed. The syntax check plus the
  single-file index now take 29 ms for all 49 files (slowest file 7 ms).
- **Real error found in your tree:** `protodunehd/reco/split_recos/standard_reco_stage2_calibration_protodunehd_keepup.fcl`,
  line 25: no comma after `opslicer` (the comma was on line 26, now commented out: `#crtreco, crttag`). Not
  confirmed with `fhicl-dump`, which stops first on an include not in dunesw v10_26_00d05
  (`standard_reco_protodunehd_keepup.fcl`).
- Windows and macOS paths (the `:` separator, `bash`) were not considered. Linux only for now.

## To do

1. Try it: F5 (the launch config is in `.vscode/`), open `samples/`, work through `errors.fcl`.
2. Navigation is written; try it in the editor: outline, Ctrl+click on `#include "…"`, F12 and hover on
   `@local::`/`@table::`/`@sequence::` names, completion after `#include "` and after `@local::`. It uses the same
3. Before publishing: a publisher ID and a repository URL; optional icon. For now the .vsix is shared by hand.
4. Try the preview panel in the editor: click the title-bar button on a `.fcl` file, check Refresh, Expand/Collapse,
   Copy, and click-to-source on the `file:line` links (these are resolved over the include path).
5. Optional: a `fhicl.captureOnStartup` toggle, unit tests for `env.ts` with the `vscode` module mocked,
   mrb dry run.

## Running things

```sh
npm install
npm test            # tsc + 38 tests (corpus tests need ../fhicl-cpp present; they skip otherwise)
npm run build       # compile to out/
# F5 in VS Code: launches the Extension Development Host on samples/
```

Settings that reproduce the tested setup are in README.md ("Examples" and "Fast mode").
