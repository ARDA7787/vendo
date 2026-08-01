/**
 * `machine: "local"` — build list item 7.
 *
 * The explicit opt-in that runs the Agent SDK on the host's own server: the
 * workspace materializes to a temp dir, the SAME sync-back seam lands the diff,
 * and `callTool` is a direct call instead of a bridge hop. Never the default — a
 * spawned-CLI harness without a sandbox is a boot error (design §9), and this is
 * the escape hatch a host chooses on purpose.
 *
 * The SDK arrives by DYNAMIC import (the `sdk-seam.ts` pattern): it is an
 * optional peer, so neither `tsc` nor a host who never opts in ever needs the
 * ~250MB platform binary on disk.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CheckoutFile, SyncFile } from "../materialize.js";
import { pathAccess } from "../materialize.js";
import type { TurnMachine, TurnRequest } from "./machine.js";

/** The turn runner is shared with the box — one implementation, two homes. */
const RUNNER = "@vendoai/apps/internal";
/** Resolved at RUNTIME and from HERE, because this package is the one that
 *  declares the optional peer. The shared runner must stay free of it. */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

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

async function walk(root: string, directory: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
}

export interface LocalMachineOptions {
  threadId: string;
  /** The recorded v0 inference exception (design §9): a harness must reach a
   *  model to think. Nothing else enters the SDK subprocess's environment. */
  env: Record<string, string>;
  /** Test seam — the real runner is loaded from `@vendoai/apps/internal`. */
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
        const found: SyncFile[] = [];
        for (const workspacePath of paths) {
          try {
            found.push({ path: workspacePath, bytes: await readFile(toDisk(root, workspacePath)) });
          } catch {
            // Not written yet. Absent is not a deletion on the hot path.
          }
        }
        return found;
      }
      const diskPaths: string[] = [];
      await walk(root, root, diskPaths);
      const files: SyncFile[] = [];
      for (const diskPath of diskPaths) {
        const workspacePath = toWorkspace(root, diskPath);
        if (pathAccess(workspacePath) !== "rw") continue;
        files.push({ path: workspacePath, bytes: await readFile(diskPath) });
      }
      return files;
    },

    async run(request: TurnRequest) {
      const runClaudeTurn = options.runner
        ?? (await import(RUNNER)).runClaudeTurn as (input: Record<string, unknown>) => Promise<void>;
      const sdk = options.runner === undefined ? await import(SDK_PACKAGE) : undefined;
      await runClaudeTurn({
        ...request,
        cwd: root,
        configDir,
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
