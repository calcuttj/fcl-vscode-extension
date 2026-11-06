/**
 * Builds the argv used to run FHiCL tools, optionally inside a container and/or after a
 * user-supplied environment setup command. Pure (no vscode import) so it can be unit-tested.
 *
 * Nothing user-controlled is ever interpolated into a shell string except `setupCommand`
 * itself, which is the user's own shell snippet. Tool names, file paths and extra search
 * path entries are passed as separate positional arguments.
 */
export interface EnvConfig {
  /** Shell snippet run first, e.g. "source /cvmfs/.../setup; setup dunesw v10_00_00 -q e26:prof". */
  setupCommand: string;
  /** Command that wraps everything, e.g. ["apptainer","exec","-B","/cvmfs","img.sif"]. */
  commandPrefix: string[];
}

export interface Invocation {
  file: string;
  args: string[];
  /** Environment to run with; only set for direct (unwrapped) invocations. */
  env?: NodeJS.ProcessEnv;
}

export function isWrapped(cfg: EnvConfig): boolean {
  return cfg.setupCommand.trim() !== "" || cfg.commandPrefix.length > 0;
}

function wrapper(cfg: EnvConfig, tail: string, operands: string[]): Invocation {
  const script = [
    // Save our operands, then clear $@ so a sourced UPS/mrb setup script cannot see them.
    '__fhicl_extra="$1"; shift',
    '__fhicl_args=("$@"); set --',
    cfg.setupCommand,
    'if [ -n "$__fhicl_extra" ]; then export FHICL_FILE_PATH="${FHICL_FILE_PATH:+$FHICL_FILE_PATH:}$__fhicl_extra"; fi',
    tail,
  ].join("\n");
  const [prefixHead, ...prefixRest] = cfg.commandPrefix;
  const bashArgs = ["-lc", script, "bash", ...operands];
  return prefixHead
    ? { file: prefixHead, args: [...prefixRest, "bash", ...bashArgs] }
    : { file: "bash", args: bashArgs };
}

/** Run `program args...` in the configured environment, with `extraPath` appended to FHICL_FILE_PATH. */
export function buildInvocation(
  cfg: EnvConfig,
  program: string,
  args: string[],
  extraPath: string[],
  baseEnv: NodeJS.ProcessEnv,
): Invocation {
  if (!isWrapped(cfg)) {
    const env = { ...baseEnv };
    if (extraPath.length > 0) {
      env.FHICL_FILE_PATH = [baseEnv.FHICL_FILE_PATH, ...extraPath].filter(Boolean).join(":");
    }
    return { file: program, args, env };
  }
  return wrapper(cfg, 'exec "${__fhicl_args[@]}"', [extraPath.join(":"), program, ...args]);
}

/** What we record from the configured environment so tools can later run without it. */
export interface CapturedEnv {
  fhiclFilePath: string[];
  path: string[];
  ldLibraryPath: string[];
}

/** Run the setup and print selected variables between markers (immune to setup chatter). */
export function buildCaptureInvocation(cfg: EnvConfig): Invocation {
  return wrapper(
    cfg,
    `printf '\\n<<FHICL_FILE_PATH:%s>>\\n<<PATH:%s>>\\n<<LD_LIBRARY_PATH:%s>>\\n' "\${FHICL_FILE_PATH}" "\${PATH}" "\${LD_LIBRARY_PATH}"`,
    [""],
  );
}

function marker(stdout: string, name: string): string[] | undefined {
  const m = new RegExp(`<<${name}:([^\\n]*?)>>`).exec(stdout);
  return m ? m[1].split(":").filter((d) => d.length > 0) : undefined;
}

/** FHICL_FILE_PATH entries only (what the built-in checker needs). */
export function parseCapture(stdout: string): string[] | undefined {
  return marker(stdout, "FHICL_FILE_PATH");
}

export function parseCapturedEnv(stdout: string): CapturedEnv | undefined {
  const fhiclFilePath = marker(stdout, "FHICL_FILE_PATH");
  if (!fhiclFilePath) return undefined;
  return {
    fhiclFilePath,
    path: marker(stdout, "PATH") ?? [],
    ldLibraryPath: marker(stdout, "LD_LIBRARY_PATH") ?? [],
  };
}

// Directories that only make sense inside the container (or would shadow the host's own
// system libraries/tools if we put the container's versions in front of them).
const CONTAINER_ONLY = /^\/(usr|bin|sbin|lib|lib32|lib64|etc|opt\/rh|\.singularity\.d|\.apptainer)(\/|$)/;

/** Keep entries that refer to shared storage (/cvmfs, home, ...), drop the container's own system dirs. */
export function filterHostEntries(entries: string[]): string[] {
  return entries.filter((d) => d.startsWith("/") && !CONTAINER_ONLY.test(d));
}

/**
 * Run a tool directly on the host using a previously captured environment (no container, no setup).
 * Goes through `bash exec` so the program is found via the captured PATH.
 * Note: fhicl-dump reports errors via abort(), so a *failing* run is slowed by the OS crash handler
 * (~1s with Ubuntu's apport, regardless of ulimit); a passing run takes milliseconds.
 */
export function buildHostInvocation(
  cap: CapturedEnv,
  extraLibraryPath: string[],
  extraPath: string[],
  program: string,
  args: string[],
  baseEnv: NodeJS.ProcessEnv,
): Invocation {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.FHICL_FILE_PATH = [...cap.fhiclFilePath, ...extraPath].join(":");
  env.PATH = [...filterHostEntries(cap.path), baseEnv.PATH].filter(Boolean).join(":");
  // Deliberately not inheriting the host's LD_LIBRARY_PATH (e.g. snap runtimes) into SL7-era binaries.
  env.LD_LIBRARY_PATH = [...filterHostEntries(cap.ldLibraryPath), ...extraLibraryPath].join(":");
  return {
    file: "bash",
    args: ["-c", 'exec "$@"', "bash", program, ...args],
    env,
  };
}
