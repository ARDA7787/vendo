/**
 * Materialization + diff sync-back — build contract §3.5, verbatim law.
 *
 * A sandboxed harness gets a real disk, so the workspace has to leave the store
 * and come back. Checkout writes the caller's visible files out; sync-back is
 * **diff-based, per file, never wholesale** — only paths whose content hash
 * changed are committed. `/user/scratch/**` never syncs. The hot paths
 * (`app.vendo`, `plan.vendo`) sync MID-TURN, which is what puts the skeleton on
 * screen; everything else lands at turn end.
 *
 * This file is deliberately harness-agnostic and transport-agnostic: it moves
 * bytes between a `WorkspaceFs` and a plain path→bytes list. `claudeCode()` is
 * its first caller; `codex()` is its second.
 *
 * Landing bytes and calling `commit()` is the WHOLE mid-turn render story — the
 * render seam (`render-seam.ts`) wraps `commit` and emits the view, so this file
 * never speaks about views.
 */
import { createHash } from "node:crypto";
import type { WorkspaceFs } from "@vendoai/core";
import { hotPathAppId } from "./render-seam.js";

/** §3.1, frozen: no other top-level mounts exist. */
const USER_MOUNT = "/user";
const HOST_MOUNT = "/host";
/** §3.1: intra-turn junk. Visible on the box's disk, never in the store. */
const SCRATCH_MOUNT = "/user/scratch";

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/**
 * Resolve `.`/`..` and collapse slashes, exactly as the store façade's own
 * `normalizePath` does. The box hands back path STRINGS from a real disk walk,
 * so `/user/../etc/passwd` is a shape that can arrive; judging it unresolved
 * would call it a `/user` path and let it out of the mount.
 */
function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * **The one seam function.** Wave-1 `can()` exactly as build contract §8 freezes
 * it: a path under `/user/` belongs to its subject, `/host/` is read-only for
 * everyone, and nothing else is a mount. Wave 3 repoints THIS function at the
 * real `can(principal, level, thing)` — that is the entire diff, which is why
 * checkout and commit both ask it and nothing else in the sandbox path decides a
 * permission.
 */
export type Access = "rw" | "ro" | "none";

export function pathAccess(path: string): Access {
  const resolved = normalize(path);
  if (under(resolved, HOST_MOUNT)) return "ro";
  if (under(resolved, USER_MOUNT)) return "rw";
  return "none";
}

/** SHA-256 of the bytes — the §3.5 diff key. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One file as the box receives it. `/host` lands as a read-only bind (§3.5). */
export interface CheckoutFile {
  path: string;
  bytes: Uint8Array;
  readOnly: boolean;
}

/** One file as the box hands it back. */
export interface SyncFile {
  path: string;
  bytes: Uint8Array;
}

export interface WorkspaceCheckout {
  /** Every file this caller may see, filtered at checkout — the box is born
   *  filtered, because there are no checks inside it (design §8). */
  readonly files: readonly CheckoutFile[];
  /**
   * Mid-turn sync of the hot paths only. Never deletes: a mid-turn view of the
   * box's disk is a snapshot of work in progress, not a statement about what the
   * user still owns.
   */
  syncHot(files: readonly SyncFile[]): Promise<string[]>;
  /**
   * Turn-end sync. Every changed writable path lands, and a file that was in the
   * checkout and is absent now is deleted — `rm` in the box is a real edit.
   */
  syncAll(files: readonly SyncFile[]): Promise<string[]>;
}

/** Never leaves the box: scratch, plus anything the seam does not call writable. */
const syncable = (path: string): boolean =>
  pathAccess(path) === "rw" && !under(path, SCRATCH_MOUNT);

export async function checkoutWorkspace(workspace: WorkspaceFs): Promise<WorkspaceCheckout> {
  const files: CheckoutFile[] = [];
  /** Path → hash of what the STORE holds, as far as this checkout knows. A
   *  mid-turn sync updates it, so turn end does not re-commit what already
   *  landed. */
  const hashes = new Map<string, string>();

  for (const path of workspace.getAllPaths()) {
    const access = pathAccess(path);
    if (access === "none") continue;
    let bytes: Uint8Array;
    try {
      bytes = await workspace.readFileBuffer(path);
    } catch {
      // `getAllPaths()` reports directories too, and a directory is not a file
      // to materialize. Nothing else can fail here that the box needs to hear
      // about — a file it cannot read simply is not on its disk.
      continue;
    }
    files.push({ path, bytes, readOnly: access === "ro" });
    if (syncable(path)) hashes.set(path, contentHash(bytes));
  }

  const apply = async (
    incoming: readonly SyncFile[],
    options: { hotOnly: boolean; deleteMissing: boolean },
  ): Promise<string[]> => {
    const seen = new Set<string>();
    const staged = new Map<string, string>();
    for (const entry of incoming) {
      // The seam judges the RESOLVED path, and the resolved path is what the
      // store is keyed by — one canonical name, whoever wrote it (§3.1).
      const path = normalize(entry.path);
      seen.add(path);
      if (!syncable(path)) continue;
      if (options.hotOnly && hotPathAppId(path) === undefined) continue;
      const hash = contentHash(entry.bytes);
      if (hashes.get(path) === hash) continue;
      await workspace.writeFile(path, entry.bytes);
      staged.set(path, hash);
    }

    const removed: string[] = [];
    if (options.deleteMissing) {
      for (const path of hashes.keys()) {
        if (seen.has(path)) continue;
        await workspace.rm(path, { force: true });
        removed.push(path);
      }
    }

    if (staged.size === 0 && removed.length === 0) return [];
    const result = await workspace.commit();
    // A conflict means nothing landed (§3.2): the checkout's view of the store is
    // unchanged, so the next sync retries the same diff.
    if (result.status !== "ok") return [];
    for (const [path, hash] of staged) hashes.set(path, hash);
    for (const path of removed) hashes.delete(path);
    // `removed` are paths that WERE in the checkout, so their rows existed and
    // the deletion landed; the union is deduped because a façade that reports
    // removals in `changed` (the shipped one does) would otherwise list twice.
    return [...new Set([...result.changed, ...removed])].sort();
  };

  return {
    files,
    syncHot: (incoming) => apply(incoming, { hotOnly: true, deleteMissing: false }),
    syncAll: (incoming) => apply(incoming, { hotOnly: false, deleteMissing: true }),
  };
}
