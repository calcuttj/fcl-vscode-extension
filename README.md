# FHiCL for VS Code

Language support for FHiCL (`.fcl`) files: highlighting, `#` comment toggling, live syntax checks, outline and
navigation within the file, and a side-panel preview of the resolved configuration from the real `fhicl-dump`.

The editor only ever checks the file you are editing (syntax), so it stays fast. Anything that needs `#include`s,
`FHICL_FILE_PATH` or the real FHiCL semantics is done by `fhicl-dump`, only when you click the preview button.

## Nothing is required

| Mode | Configure | You get |
|---|---|---|
| Built-in only (default) | nothing | live syntax errors, outline, go-to-definition/hover/completion for names in the current file, clickable `#include` links (over `fhicl.fhiclFilePath`) |
| Environments | `fhicl.environments` (+ `fhicl.commandPrefix`), then pick one per window | the above, with `#include` links resolved over that window's real UPS/mrb `FHICL_FILE_PATH` |
| Preview | the above, with `fhicl-dump` reachable | the title-bar preview button: the resolved configuration in a side panel, with every value linked to where it was set |

Validation on save is **off** by default (`fhicl.validateOnSave`). The commands in the palette always work on demand:
*Validate with fhicl-dump*, *Show Resolved Configuration* (`fhicl-dump -a`), *Show Expanded #includes*
(`fhicl-expand`), *Reload Environment*.

## Environments: one per window

Define your UPS/mrb setups once, by name, in your **user** settings. Each VS Code window then picks one from the
status bar (**$(beaker) FHiCL: …**, shown while a `.fcl` file is active) or with *FHiCL: Select Environment for This
Window*. The choice is remembered per workspace, so two windows can use two different environments at the same time.
A window with no environment picked still has full syntax checking; the preview asks you to pick one.

```json
"fhicl.commandPrefix": ["apptainer", "exec", "-B", "/cvmfs", "/path/to/image.sif"],   // shared default
"fhicl.environments": [
  { "name": "dunesw v10_26 prof",
    "setupCommand": "source /cvmfs/dune.opensciencegrid.org/products/dune/setup_dune.sh; setup dunesw v10_26_00d05 -q e26:prof" },
  { "name": "my mrb dev",
    "setupCommand": "source ~/dev/localProducts_*/setup; mrbslp",
    "fhiclFilePath": ["${workspaceFolder}"],        // your source .fcl files are not on FHICL_FILE_PATH until installed
    "runMode": "cachedHost" }
]
```

Each environment may override `commandPrefix` (`[]` = no container), `runMode`, `extraLibraryPath` and add
`fhiclFilePath` entries; anything it leaves out uses the top-level `fhicl.*` setting. If `fhicl.environments` is empty,
tools simply run with VS Code's own environment. Captures are cached by setup command + container and shared between
windows, so picking an environment another window already uses is instant.

(`fhicl.setupCommand` from earlier versions was replaced by `fhicl.environments`.)

No environment at all, just point at some directories:

```json
"fhicl.fhiclFilePath": ["/path/to/fcl/dir", "${workspaceFolder}"]
```

## Fast mode: capture once, run on the host (`fhicl.runMode: "cachedHost"`)

By default every `fhicl-dump` call starts your container and re-runs the setup (seconds each time). In
`cachedHost` mode the environment (`FHICL_FILE_PATH`, `PATH`, `LD_LIBRARY_PATH`) is captured **once** from the
container, and `fhicl-dump`/`fhicl-expand` then run directly on the host (milliseconds), which makes
`fhicl.validateOnSave` practical. The container is only used for the capture, *Reload Environment*, and as an automatic
fallback if the tool cannot start on the host.

This works when the tool's libraries live on shared storage the host also mounts (e.g. `/cvmfs`). SL7-era binaries
usually need one or two system libraries the host lacks. With the FNAL SL7 image, `fhicl-dump` needs only OpenSSL 1.0:

```sh
mkdir -p ~/.fhicl-shim
ln -s "/cvmfs/singularity.opensciencegrid.org/fermilab/fnal-dev-sl7:latest/usr/lib64/libcrypto.so.1.0.2k" \
      ~/.fhicl-shim/libcrypto.so.10
```
```json
"fhicl.runMode": "cachedHost",
"fhicl.extraLibraryPath": ["/home/you/.fhicl-shim"]
```

If a library is missing the extension tells you which one (and uses the container for that run). Only expose the
specific libraries you need; adding a container's whole `lib64` to the path would shadow the host's glibc.

The captured environment is reused across VS Code restarts; run **FHiCL: Reload Environment** after the setup
changes underneath (for example a "latest" version moves). Changing the environment's `setupCommand` or `commandPrefix` re-captures automatically.

`fhicl-dump` reports every error by aborting, so a *failing* run is slowed by the OS crash handler (about a second
with Ubuntu's apport); a passing run is near-instant.

## Notes

- The captured `FHICL_FILE_PATH` is cached per configuration, so VS Code does not wait for the container at start-up; it
  refreshes in the background. Run *Reload Environment* after changing your setup.
- The built-in include lookup is deliberately more lenient than `fhicl-dump` (it also tries the including file's folder
  and your workspace folders), so it under-reports rather than raising false alarms. `fhicl-dump` finds includes
  only on `FHICL_FILE_PATH` (plus `fhicl.fhiclFilePath` entries we append).
- `fhicl-dump` reads the file from disk, so unsaved edits are not validated.
