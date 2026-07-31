// Type-only: `import type` is erased at compile time, so core never carries
// just-bash's ~500 KB bash implementation into any consumer's bundle graph.
// The dependency is declared (not a devDependency) because `IFileSystem`
// leaks into core's published .d.ts — every consumer typechecks against it.
import type { IFileSystem } from "just-bash";

/** Build contract §3.2 — the agent's filesystem. just-bash's `IFileSystem`
    implemented over the store (`@vendoai/store`'s `openWorkspace`), so a
    machine-less harness gets in-process bash (grep/sed/awk/jq) over the same
    files a sandboxed harness sees on disk. Path layout is frozen (§3.1):

      /user/apps/<appId>/{app,plan}.vendo · /user/memory/ · /user/files/
      /user/scratch/ (intra-turn; never committed) · /host/** (read-only)

    Writes are staged in memory and land in the store on `commit()` — that is
    what keeps the store write law (O(files changed), never O(writes)). */
export interface WorkspaceFs extends IFileSystem {
  /** Commit changed files. Per-mount rules: /orgs = CAS, /user = last write wins. */
  commit(opts?: { message?: string }): Promise<CommitResult>;
}

/** Build contract §3.2. `conflict` is the /orgs compare-and-swap outcome
    (wave 3); /user is last-write-wins and always resolves `ok`. */
export type CommitResult =
  | { status: "ok"; changed: string[] }
  | { status: "conflict"; paths: string[] };

/** Build contract §3.4 — the blob seam under the workspace: files past the
    inline cap live here, keyed by the store's `blob_ref`. Unset, the store's
    own `blobs()` backs it (capped); `s3()` is the one shipped implementation. */
export interface FilesAdapter {
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | undefined>;
  delete(key: string): Promise<void>;
}
