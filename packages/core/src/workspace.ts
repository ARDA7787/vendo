/**
 * The workspace filesystem seam — build contract 2026-07-30 §3.2, copied verbatim.
 *
 * LANE OWNERSHIP: wave-1 lane B owns this file and the implementation behind it.
 * Lane A landed only the frozen §3.2 TYPE BLOCK, because `Turn.workspace`
 * (harness.ts) cannot typecheck without it and the two lanes build in separate
 * worktrees. Nothing here is a lane-A design choice: if lane B's version differs
 * in any way, lane B's wins.
 */
import type { IFileSystem } from "just-bash";

/**
 * Build contract §3.2 — just-bash's `IFileSystem` (Apache-2.0,
 * vercel-labs/just-bash) implemented over the store, plus commit.
 */
export interface WorkspaceFs extends IFileSystem {
  /** Commit changed files. Per-mount rules: /orgs = CAS, /user = last write wins. */
  commit(opts?: { message?: string }): Promise<CommitResult>;
}

/** Build contract §3.2 */
export type CommitResult =
  | { status: "ok"; changed: string[] }
  /** Stale base; the harness re-reads and re-applies. */
  | { status: "conflict"; paths: string[] };
