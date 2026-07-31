# Lane B — workspace (wave 1)

**Read first, in order:**
1. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md` — §8 (workspace), §15 (layout-is-product law)
2. `docs/superpowers/specs/2026-07-30-build-contract.md` — §3 (FROZEN — paths, interface, tables, files adapter, materialization rules), §8 (wave-1 cuts)
3. This file.

**The one rule:** we own state, tools, checks, guard, skills; the harness owns
thinking. The workspace is a façade over the store — dumb, predictable,
permission-blind above `can()`. If a shape in the build contract seems wrong,
ask the orchestrator; never diverge locally.

## Mission

Give every harness the same filesystem: a façade over the store (documents are
files; records stay tables), with an in-process bash surface for machine-less
harnesses, per-path history/undo, and a blob seam — so that next turn, a
different harness sees the identical workspace.

## Build list

1. **Core types** — new file `packages/core/src/workspace.ts`, type-only:
   `WorkspaceFs` (= just-bash `IFileSystem` + `commit`), `CommitResult`,
   `FilesAdapter` — exactly as contract §3.2/§3.4.
2. **The two tables** — contract §3.3 verbatim (`vendo_workspace_files`,
   `vendo_workspace_history`) appended to `packages/store/src/schema.ts`
   (versioned-migration pattern; coordinate the single `SCHEMA_VERSION` bump
   with the orchestrator — lane D also migrates). Inline content up to
   `WORKSPACE_INLINE_MAX_BYTES = 65536`, else `blob_ref`. History append-only,
   `WORKSPACE_HISTORY_LIMIT = 50` per path.
3. **The `IFileSystem` implementation over the store** — dependency:
   `just-bash` (Vercel, Apache-2.0, on npm). `getAllPaths()`/`resolvePath()`
   are synchronous: build a **path index at turn start**, update it on every
   write; content always reads through the store. This is what gives
   machine-less harnesses in-process bash (grep/sed/awk/jq) with no sandbox.
4. **Mounts** — `/user` (rw) and `/host` (ro, via `MountableFs` `readOnly`).
   Path layout frozen (§3.1): `/user/apps/<appId>/{app,plan}.vendo`,
   `/user/memory/`, `/user/files/`, `/user/scratch/` (never synced/committed),
   `/host/skills/<name>/SKILL.md`, `/host/knowledge/`. No other top-level
   mounts, no `misc`; `appId` is the store's app id verbatim.
5. **`commit()`** — `/user` last-write-wins; write history rows (prior content
   + consumer-voice `intent`); undo walks history. (`/orgs` CAS is wave 3; the
   `revision` column ships now so the table never migrates for it.)
6. **`FilesAdapter` seam + `s3()`** — one shipped implementation
   (S3-compatible: S3/R2/Supabase/MinIO). Unset → the store's `blobs()` backs
   it, capped at `FILES_STORE_MAX_BYTES` (5 MiB); the first over-cap write
   fails `VendoError("validation")` naming the fix ("wire `files:`").
7. **Erase + adoption** — both tables join `ERASE_TABLES`
   (`packages/store/src/erase.ts`) and the anon→signed-in adoption path
   (`packages/store/src/helpers/subjects.ts`), keyed on `owner`.
8. **Wave-1 `can()`** — exactly today's rule and nothing more: a path under
   `/user/` belongs to its subject; `/host/` is read-only for everyone.

## Frozen shapes you consume

- Contract §3 whole (paths, `WorkspaceFs`, tables, `FilesAdapter`,
  materialization rules — you implement the store side; sandbox
  materialization itself is lane E, wave 2).
- Store write law (design §8): O(messages + tool calls + files changed), never
  O(tokens).
- The store block's existing conventions: helpers style
  (`packages/store/src/helpers/`), conformance tests, `StoreAdapter` seam.

## Acceptance (plan §6)

- **E3, wave-1 slice**: app edited through the façade tools → stored result
  correct; undo walks history; over-cap file with no `files:` adapter → the
  error names the fix. (The `claudeCode()` bash column, sandbox-kill recovery,
  and `/orgs` CAS conflict arrive with waves 2–3.)
- In-process bash over the façade works: grep/sed a workspace file through
  just-bash with zero sandbox.
- Erase conformance + adoption tests green for both new tables.
- **E6**: monorepo green (`pnpm build && test && typecheck && lint`); façade
  writes are O(files changed), measured.

## Out of scope

`/orgs/**` mounts and `can()` beyond ownership (wave 3) · sandbox
materialization/sync-back and the in-box `vendo validate` shim (lane E,
wave 2) · skills content and projection (lane C — it consumes your mounts) ·
git-style versioning (revision column + history rows only) · everything in
contract §8.

## Files you own

- `packages/core/src/workspace.ts` (new)
- `packages/store/src/workspace*.ts` (new), `packages/store/src/files-s3.ts`
  (or equivalent — note the dependency choice in your lane report)
- **Shared, append-only, orchestrator merges at land:**
  `packages/core/src/index.ts`, `packages/store/src/schema.ts`,
  `packages/store/src/erase.ts`, `packages/store/src/helpers/subjects.ts`,
  `packages/store/src/index.ts`.

## Discipline

One worktree, this lane only. Seam questions → orchestrator. Report the moment
you finish. Local decisions not covered above: make them, note every one in
your lane report. Never claim done without the acceptance evidence.
