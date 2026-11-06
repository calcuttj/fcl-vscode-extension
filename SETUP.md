# Setting up the FHiCL extension for VS Code

This guide takes you from the `.vsix` file to a working preview of the resolved configuration. It assumes Linux
with `/cvmfs` mounted. Steps 1 and 2 take a minute. Steps 3 to 5 are only needed for the preview and `fhicl-dump`
checks.

| What you want | Steps |
|---|---|
| Highlighting, `#` comments, live syntax errors, outline, go-to-definition within a file | 1 |
| The same, plus clickable `#include` links into your own directories | 1, 2 |
| The resolved-configuration preview (`fhicl-dump`) in a UPS/mrb environment | 1, 3, 4 |
| A faster preview (milliseconds instead of seconds per run) | 1, 3, 4, 5 |

## 1. Install

```sh
code --install-extension fcl-vscode-0.0.1.vsix
```

Or, in VS Code: Extensions view → **…** menu → **Install from VSIX…**, then pick the file.

Open any `.fcl` file. It should be highlighted, and **Ctrl+/** should toggle `#` comments. Syntax errors are
underlined as you type. They cover the current file only; `#include`d files are not checked in the editor.

To update, install the new `.vsix` the same way. To remove the extension, run
`code --uninstall-extension local.fcl-vscode`.

## 2. Optional: directories for `#include` links

To make `#include "..."` lines clickable without setting up an environment, list the directories to search in your
settings (**Ctrl+,**, then the `{}` icon at the top right to edit `settings.json`):

```json
"fhicl.fhiclFilePath": ["/path/to/some/fcl/dir", "${workspaceFolder}"]
```

## 3. Check your container works from a terminal

The preview runs the real `fhicl-dump`, which needs a UPS or mrb setup. On machines where UPS only works inside
an Apptainer container, the extension starts the container itself, using a command you give it. Before configuring
anything, check that this command works from a normal terminal (outside any container):

```sh
/cvmfs/oasis.opensciencegrid.org/mis/apptainer/current/bin/apptainer exec --fakeroot \
  -B /cvmfs,$HOME,/run/user,/etc/hostname,/etc/hosts,/etc/krb5.conf --ipc --pid \
  /cvmfs/singularity.opensciencegrid.org/fermilab/fnal-dev-sl7:latest \
  bash -lc 'source /cvmfs/dune.opensciencegrid.org/products/dune/setup_dune.sh; setup dunesw v10_26_00d05 -q e26:prof; which fhicl-dump'
```

It should print a path ending in `bin/fhicl-dump`. Replace the `setup dunesw ...` part with the version you use.

If it fails with a user-namespace or permission error, recent Ubuntu releases block unprivileged containers by
default. Allow them with:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_unconfined=0
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

These settings reset at every reboot, so run them again after rebooting (or before opening the preview for the
first time that day). The extension never runs `sudo` itself.

**Your files must be visible inside the container at the same path.** The `-B $HOME` bind does that for anything
under your home directory. If your code lives elsewhere (for example `/exp/dune/app/...`), add that directory to the
`-B` list.

## 4. Define your environments

Open `settings.json` (step 2) and add the container command and one entry per software setup you use.
Write your home directory out in full (`/home/you`), because `$HOME` and `~` are not expanded here.

```json
"fhicl.commandPrefix": [
  "/cvmfs/oasis.opensciencegrid.org/mis/apptainer/current/bin/apptainer", "exec", "--fakeroot",
  "-B", "/cvmfs,/home/you,/run/user,/etc/hostname,/etc/hosts,/etc/krb5.conf",
  "--ipc", "--pid",
  "/cvmfs/singularity.opensciencegrid.org/fermilab/fnal-dev-sl7:latest"
],
"fhicl.environments": [
  {
    "name": "dunesw v10_26_00d05 prof",
    "setupCommand": "source /cvmfs/dune.opensciencegrid.org/products/dune/setup_dune.sh; setup dunesw v10_26_00d05 -q e26:prof"
  },
  {
    "name": "my mrb dev area",
    "setupCommand": "source /home/you/dev/localProducts_larsoft_v10_26_00_e26_prof/setup; mrbslp",
    "fhiclFilePath": ["${workspaceFolder}"]
  }
]
```

- `fhicl.commandPrefix` is everything before `bash -lc ...` in the step 3 command, one argument per string. All
  environments share it, and an environment can override it with its own `commandPrefix` (use `[]` for no
  container).
- `setupCommand` is what you would type after entering the container.
- For an mrb area, `fhiclFilePath` adds your source checkout, since your edited `.fcl` files are not on
  `FHICL_FILE_PATH` until they are installed. The mrb example has not been tested yet; tell the author if it
  misbehaves.
- If you already work in a shell where `fhicl-dump` is on your `PATH` (no container), leave
  `fhicl.environments` empty. The tools then run with VS Code's own environment.

Then pick an environment for the window:

1. Open a `.fcl` file. The status bar (bottom right) shows **FHiCL: no environment**.
2. Click it, and choose one of your environments. The first time, it runs the setup in the container to record
   `FHICL_FILE_PATH`, which takes 5 to 15 seconds. A message says when it is ready. The result is cached, so later
   windows and restarts are instant.
3. Click the preview button at the top right of the editor (or run **FHiCL: Open Resolved Configuration Preview to
   the Side** from the command palette, **Ctrl+Shift+P**).

The panel shows the fully resolved configuration. Every value links to the file and line that set it. Use
**Ctrl+F** inside the panel to search, and **Refresh** to re-run after saving changes. The preview reads the saved
file, not unsaved edits.

Each window remembers its own environment, so two windows can use two different releases at the same time. After the
underlying setup changes (for example, a new build of your mrb area), run **FHiCL: Reload Environment**.

## 5. Optional: fast mode

By default every preview starts the container, which takes several seconds each time. In fast mode the extension
records the environment once and then runs `fhicl-dump` directly on your machine. A passing run then takes about a
tenth of a second.

`fhicl-dump` from the SL7 releases needs one old library that Ubuntu lacks. Point to the copy inside the container
image:

```sh
mkdir -p ~/.fhicl-shim
ln -sf "/cvmfs/singularity.opensciencegrid.org/fermilab/fnal-dev-sl7:latest/usr/lib64/libcrypto.so.1.0.2k" \
       ~/.fhicl-shim/libcrypto.so.10
```

Then add to `settings.json` (with your own home directory):

```json
"fhicl.runMode": "cachedHost",
"fhicl.extraLibraryPath": ["/home/you/.fhicl-shim"]
```

If a run cannot start on your machine, the extension says which library is missing and uses the container for that
run instead, so nothing breaks. A run that finds an error still takes about a second, because `fhicl-dump` reports
errors by crashing and Ubuntu's crash reporter runs.

## Troubleshooting

All tool output goes to **View → Output → FHiCL**. Check there first.

| Symptom | What to check |
|---|---|
| Status bar shows a warning icon after picking an environment | The setup failed. Open the FHiCL output and rerun the step 3 command with the same setup. |
| Preview says it could not run `fhicl-dump` | Run step 3 again. A missing `-B` bind or an expired `sysctl` setting (after a reboot) are the usual causes. |
| Preview reports "Can't find file" for an include | That file is not on this environment's `FHICL_FILE_PATH`. Pick the right release, or add the directory to `fhiclFilePath`. |
| Preview times out | The container was slow to start. Raise `fhicl.timeoutSeconds` (default 120). |
| No status-bar item | It only appears while a `.fcl` file is the active editor. |
| Errors underlined that `fhicl-dump` accepts, or the reverse | Please report it with the file. The built-in checker follows fhicl-cpp's grammar, but only for the current file. |

Other settings: `fhicl.validateOnSave` (off by default) runs `fhicl-dump` on every save and shows its errors as
underlines. `fhicl.diagnostics.enable` turns the built-in syntax checking off.

## Building from source

With Node.js 20 or later, in the source directory:

```sh
npm install
npm run package     # runs the tests, then writes fcl-vscode-<version>.vsix
```
