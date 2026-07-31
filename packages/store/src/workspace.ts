import type { FilesAdapter, Principal, WorkspaceFs } from "@vendoai/core";
import { storeFiles } from "./files-store.js";
import { dbFor, type VendoStore } from "./store.js";
import { HOST_MOUNT, normalizePath, WorkspaceStoreFs } from "./workspace-fs.js";
import { workspaceRows, type UndoOutcome, type WorkspaceHistoryEntry } from "./workspace-rows.js";

/** What the caller projects into the read-only `/host` mount for one turn:
    path → contents. Paths outside `/host/` are refused, because the layout is
    product (contract §3.1) and this is the only door into it. */
export type HostProjection = Record<string, string | Uint8Array>;

const encoder = new TextEncoder();

function hostFiles(projection: HostProjection | undefined): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(projection ?? {})) {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${HOST_MOUNT}/`)) {
      throw new Error(`Host projection paths live under ${HOST_MOUNT}/ — got '${path}'`);
    }
    files.set(normalized, typeof content === "string" ? encoder.encode(content) : content);
  }
  return files;
}

/**
 * Build contract §3 — the workspace: the agent's filesystem as a façade over
 * the store. `open` is called once per turn (it builds the path index just-bash
 * needs synchronously); `undo` and `history` read the same rows the façade
 * writes, so what the user undoes is exactly what the agent did.
 */
export function workspaceStore(store: VendoStore, options: { files?: FilesAdapter } = {}): {
  /** One workspace, one turn. Writes stage until `commit()`. `host` projects
      the read-only mount (pack skills, host knowledge) for this turn. */
  open(principal: Principal, opts?: { host?: HostProjection }): Promise<WorkspaceFs>;
  /** Walks one step back through a path's history — including back to a file
      that was deleted. `empty` means there is nothing left to undo;
      `content-missing` is a revision whose blob is gone (consumed, so the walk
      continues into older revisions instead of stopping there forever). */
  undo(principal: Principal, path: string): Promise<UndoOutcome>;
  /** Newest superseded revision first. */
  history(principal: Principal, path: string): Promise<WorkspaceHistoryEntry[]>;
} {
  const rows = workspaceRows(dbFor(store), options.files ?? storeFiles(store));
  return {
    async open(principal, opts) {
      const index = await rows.index([principal.subject]);
      return new WorkspaceStoreFs(rows, principal.subject, index, hostFiles(opts?.host));
    },
    async undo(principal, path) {
      return await rows.undo(principal.subject, normalizePath(path));
    },
    async history(principal, path) {
      return await rows.history(principal.subject, normalizePath(path));
    },
  };
}

export { HOST_MOUNT, USER_MOUNT } from "./workspace-fs.js";
export {
  WORKSPACE_HISTORY_LIMIT,
  WORKSPACE_INLINE_MAX_BYTES,
  type UndoOutcome,
  type WorkspaceFileMeta,
  type WorkspaceHistoryEntry,
} from "./workspace-rows.js";
