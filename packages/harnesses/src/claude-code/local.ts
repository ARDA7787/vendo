/**
 * `machine: "local"` — build list item 7.
 *
 * The explicit opt-in that runs the Agent SDK on the host's own server: the
 * workspace materializes to a temp dir, the SAME sync-back seam lands the diff,
 * and `callTool` is a direct call instead of a bridge hop. Never the default — a
 * spawned-CLI harness without a sandbox is a boot error (design §9), and this is
 * the escape hatch a host chooses on purpose.
 *
 * The SDK arrives by DYNAMIC import, bundler-ignored: it is an optional peer, so
 * neither `tsc`, nor a host's BUILD, nor a host who never opts in ever needs the
 * ~250MB platform binary on disk. This file is the only place on any host path
 * that names it.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VendoError } from "@vendoai/core";
import type { CheckoutFile, SyncFile } from "../materialize.js";
import { pathAccess } from "../materialize.js";
import type { TurnMachine, TurnRequest } from "./machine.js";

/** The turn runner is shared with the box — one implementation, two homes. Its
 *  OWN subpath, so importing it never drags the render seam's `./internal` in,
 *  and `./internal` never drags this in. */
const RUNNER = "@vendoai/apps/claude-turn";

/**
 * The SDK, from HERE, because this package declares the optional peer
 * (`@vendoai/apps` declares it too, for the box door) — and this function is
 * the ONLY place in the shipped packages that names it on a host path.
 *
 * `turbopackIgnore`/`webpackIgnore` keep it out of a host's BUILD: a bundler
 * that resolves this specifier refuses to build a Next.js host that has not
 * installed a ~250MB platform binary it may never run, which is precisely the
 * cost the optional peer exists to avoid. The import still happens at runtime,
 * against the deployment's own node_modules.
 */
async function loadAgentSdk(): Promise<unknown> {
  try {
    return await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@anthropic-ai/claude-agent-sdk");
  } catch (cause) {
    // The operator, not the user: this is a deployment choice that was not
    // followed through, and it can only be fixed by installing something.
    throw new VendoError(
      "validation",
      "claudeCode({ machine: \"local\" }) needs the Claude Agent SDK on this server. "
      + "Install @anthropic-ai/claude-agent-sdk, or drop `machine: \"local\"` and give the "
      + "harness a sandbox instead, which keeps the SDK off your server entirely.",
      { cause },
    );
  }
}

/** A stable home per thread, so the SDK's own session file survives between
 *  turns on the same host exactly as it survives inside a warm box. */
const homeFor = (threadId: string): string =>
  path.join(tmpdir(), "vendo-claude-code", threadId.replace(/[^A-Za-z0-9_-]/g, "_"));

/** Workspace path → disk path, and back. `/user/apps/a/app.vendo` lives at
 *  `<root>/user/apps/a/app.vendo`: one root, the frozen layout underneath. */
const toDisk = (root: string, workspacePath: string): string =>
  path.join(root, workspacePath.replace(/^\//, ""));
const toWorkspace = (root: string, diskPath: string): string =>
  `/${path.relative(root, diskPath).split(path.sep).join("/")}`;

/** `*` stands for exactly ONE segment — the box door's rule, kept identical so
 *  both machines answer the same question the same way. */
const matchesPattern = (pattern: string, workspacePath: string): boolean => {
  const wanted = pattern.split("/");
  const actual = workspacePath.split("/");
  if (wanted.length !== actual.length) return false;
  return wanted.every((segment, at) => segment === "*" || segment === actual[at]);
};

/** Every file under `directory`, in DISK paths. A directory we cannot read is
 *  simply not there — same shape as the box door's own walk. */
async function walk(directory: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export interface LocalMachineOptions {
  threadId: string;
  /** The recorded v0 inference exception (design §9): a harness must reach a
   *  model to think. Nothing else enters the SDK subprocess's environment. */
  env: Record<string, string>;
  /** Test seam — the real runner is loaded from {@link RUNNER}, with the SDK. */
  runner?: (input: Record<string, unknown>) => Promise<void>;
}

export async function localMachine(options: LocalMachineOptions): Promise<TurnMachine> {
  const home = homeFor(options.threadId);
  // STABLE per thread, not a fresh mkdtemp per turn. The SDK files its session
  // under `CLAUDE_CONFIG_DIR/projects/<slug of cwd>`, so a moving working
  // directory means `resume` looks in a project folder that has never existed —
  // measured: turn 2 of a live thread failed outright instead of remembering.
  const root = path.join(home, "workspace");
  const configDir = path.join(home, "claude");
  // Emptied, not appended to: the STORE is the truth, and re-materializing from
  // it is what makes "a different harness sees the identical workspace next
  // turn" true.
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(root, { recursive: true });
  await mkdir(configDir, { recursive: true });

  return {
    // The config dir is per thread and outlives the turn, so a session written
    // last turn is still on this disk.
    carriesSession: true,

    async materialize(files) {
      for (const file of files) {
        const target = toDisk(root, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.bytes);
        // Advisory only — the sync-back seam is the real enforcement, because a
        // process running as the file's owner can always chmod it back.
        if (file.readOnly) chmodSync(target, 0o444);
      }
    },

    async collect(paths) {
      if (paths !== undefined) {
        // An entry naming a `*` segment asks by SHAPE, which is how a file that
        // did not exist at turn start reaches the mid-turn sync.
        const patterns = paths.filter((entry) => entry.includes("*"));
        let matched: string[] = [];
        if (patterns.length > 0) {
          matched = (await walk(root))
            .map((diskPath) => toWorkspace(root, diskPath))
            .filter((workspacePath) =>
              patterns.some((pattern) => matchesPattern(pattern, workspacePath)));
        }
        const found: SyncFile[] = [];
        for (const workspacePath of new Set([...paths.filter((entry) => !entry.includes("*")), ...matched])) {
          try {
            found.push({ path: workspacePath, bytes: await readFile(toDisk(root, workspacePath)) });
          } catch {
            // Not written yet. Absent is not a deletion on the hot path.
          }
        }
        return found;
      }
      const files: SyncFile[] = [];
      for (const diskPath of await walk(root)) {
        const workspacePath = toWorkspace(root, diskPath);
        if (pathAccess(workspacePath) !== "rw") continue;
        files.push({ path: workspacePath, bytes: await readFile(diskPath) });
      }
      return files;
    },

    async run(request: TurnRequest) {
      const runClaudeTurn = options.runner
        ?? (await import(RUNNER)).runClaudeTurn as (input: Record<string, unknown>) => Promise<void>;
      const sdk = options.runner === undefined ? await loadAgentSdk() : undefined;
      await runClaudeTurn({
        ...request,
        cwd: root,
        // CLAUDE_CONFIG_DIR is the whole handoff: the SDK reads it from the
        // environment, so the runner is told nothing about where the session lands.
        env: { ...options.env, CLAUDE_CONFIG_DIR: configDir },
        ...(sdk === undefined ? {} : { sdk }),
      });
    },

    async release() {
      // Nothing to tear down: the next turn empties and re-materializes the tree,
      // and the config dir (with it, the native session) deliberately stays.
    },
  };
}
