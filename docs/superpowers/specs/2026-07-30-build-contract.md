# Build contract — exact shapes

**2026-07-30.** Companion to `2026-07-30-embedded-agent-architecture-design.md`
(the architecture; read it first). This file exists because four reviewers
independently found the spec unbuildable *as text*: it states laws, not shapes.
Everything here is a shape two lanes would otherwise invent differently.

Rule for builders: **if it is in this file, it is frozen — propose changes to
the orchestrator, never diverge locally.** If it is *not* here and not in the
architecture spec, decide it locally and note it in your lane report.

## 1. The harness contract

```ts
// @vendoai/core — types only, so every block may speak them
import type { UIMessage } from "ai";
import type { LanguageModel } from "ai";

export interface Harness<Options = unknown> {
  readonly name: string;                     // "vendo" | "instant" | "claude-code" | …
  readonly optionsSchema?: StandardSchemaV1;  // declares per-turn-overridable knobs
  readonly requires?: { sandbox?: boolean };  // boot-time composition check
  run(turn: Turn<Options>): AsyncGenerator<HarnessEvent, void, void>;
}

export interface Turn<Options = unknown> {
  /** Canonical transcript, oldest → newest. Ours; read-only. */
  readonly messages: readonly UIMessage[];
  readonly tools: TurnTools;
  readonly skills: TurnSkills;
  readonly workspace: WorkspaceFs;      // §3; the harness's file hands
  readonly models: ResolvedModels;      // §4
  readonly state: TurnState;            // §2.3
  readonly options: Options;            // parsed by optionsSchema, incl. per-turn overrides
  readonly signal: AbortSignal;
  /** Present iff the caller proved presence (a click/message/submit). */
  readonly interactive: boolean;
}
```

`defineHarness(def): Harness` returns the harness value itself. A harness that
needs host dependencies is authored as a plain factory returning that value
(`export const acmeHarness = (deps) => defineHarness({...})`) — there is no
separate factory concept in the contract.

### 1.1 Tools

```ts
export interface TurnTools {
  /** Never throws. Guarded, audited, and mirrored before it resolves. */
  call(name: string, args: Json): Promise<ToolResult>;
  // amendment 2026-07-30: the idempotencyKey opt was removed — the §7 effect
  // ledger keys on run/turn id + input hash internally; no caller read it.
  /** Currently-equipped tools (post-curation). */
  list(): Promise<ToolListing[]>;
}

export type ToolResult =
  | { status: "ok"; output: Json }
  | { status: "denied"; reason: string; needs?: DeniedNeeds }   // guard said no / needs a human
  | { status: "error"; error: { code: string; message: string } };

export type DeniedNeeds =
  | { kind: "approval"; approvalId: string }   // a card is waiting for the user
  | { kind: "connect"; toolkit: string }       // an account must be connected
  | { kind: "unattended-destructive" };        // §12 law: never available off-interaction

export interface ToolListing {
  name: string; title: string; description: string; risk: "read" | "write" | "destructive";
  /** Amendment 2026-07-30: JSON Schema for the tool's input — every in-process
   *  harness must hand schemas to its model; JSON Schema is the interchange. */
  inputSchema?: JsonSchema;
}
```

Mapping from the frozen core `ToolOutcome` (unchanged: `ok | error |
pending-approval | blocked | connect-required`) is the runtime's job, not the
harness author's: `pending-approval` → `denied{needs:approval}` (interactive
callers block first, §1.4), `blocked` → `denied`, `connect-required` →
`denied{needs:connect}`. Three statuses is the whole surface a harness sees.

### 1.2 Skills, workspace, models

```ts
export interface TurnSkills {
  list(): Promise<SkillListing[]>;               // ~30 tokens each; always cheap
  load(name: string): Promise<string>;            // full SKILL.md body, on demand
}
export interface SkillListing { name: string; description: string; }
```

`workspace` is the `WorkspaceFs` of §3. `models` is §4's `ResolvedModels`.

### 1.3 Harness state

```ts
export interface TurnState {
  get(): string | undefined;     // opaque to us
  set(value: string): void;      // persisted at turn end
  clear(): void;
}
```

Cleared by the runtime on arbitrary history edits or a harness swap; a prefix
truncation uses the harness's native rewind instead (adapter's business).

### 1.4 Approvals

`call()` resolves; it never suspends the process.

- `turn.interactive === true`: the runtime shows the card and **awaits the tap**
  inside `call()`, up to `APPROVAL_WAIT_MS = 90_000`, holding no sandbox lease.
  Tap → `{status:"ok"}` (or `denied` if refused). Timeout → `denied{needs:approval}`.
- `turn.interactive === false`: no wait. `denied{needs:approval}` immediately;
  the runtime raises the failure card (§3 of the architecture spec).

### 1.5 Events (closed vocabulary)

```ts
export type HarnessEvent =
  | { type: "text";   delta: string }
  | { type: "status"; label: string }             // consumer-voice; ephemeral, screen-only
  | { type: "error";  message: string; code?: string }   // consumer-voice; no internals
  | { type: "usage";  inputTokens: number; outputTokens: number;
      cacheReadTokens?: number; cacheWriteTokens?: number; model?: string };
```

Routing (frozen): `text` → screen + transcript · `status` → screen only ·
`error` → screen + audit (amendment 2026-07-30: the original "…+ transcript"
leg was aspirational — the ai-SDK error chunk is not persisted and today's
shipped agent does not persist errors either; parity with today wins, and
audit ⊇ transcript holds trivially) · `usage` → audit/metering only. Tool
calls are mirrored by the runtime, never yielded. Adding a member later is a
breaking change for host renderers — this list is closed for v1.

Amendment 2026-07-30: `status` rides a **transient** `data-vendo-status` wire
part owned by `@vendoai/harnesses` (never persisted, never in
`stream-parts.ts` — core stays untouched). `error`'s host-observable
affordance must match today's agent behavior exactly (whatever chunk/part the
shipped loop raises today, the runtime raises — no new failure UX in wave 1).

### 1.6 Who runs a harness

`@vendoai/harnesses` owns the **runtime**: it builds the `Turn`, converts
`HarnessEvent`s plus mirrored tool calls into the existing ai-SDK UIMessage
stream with today's `data-vendo-*` parts (`packages/core/src/stream-parts.ts` —
unchanged; no new wire format), persists the transcript, and enforces the
routing table. Harness adapters contain no persistence and no wire code.

**Hot-path render seam** (orchestrator addition, 2026-07-30, ratified with
Yousef — closes the gap between §3.5's mid-turn sync and "the skeleton renders
the moment the plan file exists"): on every store write to a hot-path file
(`app.vendo`, `plan.vendo`) — façade tool edit, in-process bash, or sandbox
mid-turn sync — the **runtime** parses the content and, iff it parses, emits
today's `data-vendo-view` part: same payload shape (assembled tree), same
stable per-app stream id, same server-authoritative field stripping, same
progressive query-resolver data fill (all existing code, relocated from the
engine). An unparseable write emits **nothing** — the last good view stays on
screen and the brokenness reaches the harness through `validate`, never the
user. Granularity is per file save (accepted trade: a harness that writes once
at the end shows nothing until it finishes — a bench-visible quality
difference, not a correctness one). Harnesses never yield view events;
`HarnessEvent` stays closed.

## 2. Layering (dependency-guard rows)

```
core                      ← Harness/Turn/Pack contract types live here
harnesses → core, agent, apps, guard      (second multi-block package, after vendo)
vendo     → everything                    (unchanged)
```

Add `harnesses` to `scripts/dependency-guard.mjs` LAYERS with exactly those
edges. `defineHarness`, `definePack`, `Turn`, `HarnessEvent`, `Pack`, `Check`,
`Finding` are **type-only** exports from core; implementations live in
`harnesses` / `apps` / `vendo`. Name collision to avoid: `@vendoai/agent`
already exports `buildVendoToolPack` / `VendoPackTool` (the BYO tool pack) —
the new `definePack` must not shadow or rename those.

## 3. Workspace

### 3.1 Path layout (frozen)

```
/user/apps/<appId>/app.vendo        the app document, printed wire text
/user/apps/<appId>/plan.vendo       the plan (renders as the skeleton)
/user/memory/<name>.md              agent notes
/user/files/<name>                  uploads + generated artifacts
/user/scratch/<name>                intra-turn junk; never synced back
/orgs/<orgId>/apps/<appId>/…        same shape, org-owned (wave 3)
/host/skills/<skillName>/SKILL.md   host + pack skills (read-only)
/host/knowledge/<name>              host-authored reference (read-only)
```

Rules: no other top-level mounts; no `misc`; `appId` is the store's app id
verbatim; a path's meaning never depends on who wrote it.

### 3.2 The filesystem interface

We implement **`just-bash`'s `IFileSystem`** (Apache-2.0, `vercel-labs/just-bash`)
over the store, and expose it as `WorkspaceFs = IFileSystem` plus:

```ts
export interface WorkspaceFs extends IFileSystem {
  /** Commit changed files. Per-mount rules: /orgs = CAS, /user = last write wins. */
  commit(opts?: { message?: string }): Promise<CommitResult>;
}
export type CommitResult =
  | { status: "ok"; changed: string[] }
  | { status: "conflict"; paths: string[] };   // stale base; the harness re-reads and re-applies
```

`IFileSystem.getAllPaths()` and `resolvePath()` are **synchronous** in just-bash.
Decision: the façade builds a **path index at turn start** and updates it on
every write; content is always read through the store. Mount read-only-ness is
enforced with `MountableFs`'s `readOnly`.

### 3.3 Tables

```sql
vendo_workspace_files (
  path          text  not null,        -- full path, e.g. /user/apps/app_1/app.vendo
  owner         text  not null,        -- subject, or org id for /orgs mounts
  content       text,                  -- inline iff <= WORKSPACE_INLINE_MAX_BYTES (65536)
  blob_ref      text,                  -- else the files-adapter key
  bytes         integer not null,
  revision      integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (path, owner)
);
create index on vendo_workspace_files (owner);

vendo_workspace_history (               -- undo + provenance; append-only
  id            text primary key,
  path          text not null,
  owner         text not null,
  revision      integer not null,
  content       text,                  -- prior content (or blob_ref)
  blob_ref      text,
  intent        text,                  -- consumer-voice, e.g. "made the chart blue"
  at            timestamptz not null default now()
);
create index on vendo_workspace_history (path, owner, revision desc);
```

Both join `ERASE_TABLES` (`packages/store/src/erase.ts`) and the
anon→signed-in adoption path (`helpers/subjects.ts`), keyed on `owner`.
History retention: `WORKSPACE_HISTORY_LIMIT = 50` per path (same as app history).

### 3.4 Files adapter

```ts
export interface FilesAdapter {                       // core, type-only
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | undefined>;
  delete(key: string): Promise<void>;
}
```

Unset → the store's `blobs()` backs it, capped at `FILES_STORE_MAX_BYTES`
(5 MiB, matching today's app-blob cap); the first over-cap write fails with
`VendoError("validation")` naming the fix ("wire `files:`"). `s3(bucket)` is the
one shipped implementation (S3-compatible covers S3/R2/Supabase/MinIO).

### 3.5 Materialization

Checkout writes the caller's visible files to the sandbox disk (`/orgs` at
viewer level → read-only bind). Sync-back is **diff-based, per file, never
wholesale**: only paths whose content hash changed are committed, each carrying
its checkout `revision` as the CAS base. `/user/scratch/**` is never synced.
Hot paths — `app.vendo` and `plan.vendo` — sync mid-turn (that is what puts the
skeleton on screen); everything else at turn end.

## 4. Model seats

```ts
export type Seat = "default" | "reviewer" | "judge" | "fill" | "verifier";
export type ResolvedModels = Readonly<Record<Seat, LanguageModel>>;
```

Config takes `models?: Partial<Record<Seat, LanguageModel | string>>`.
Resolution per seat: explicit seat → `default` → the env credential ladder →
Cloud gateway (if `VENDO_API_KEY`) → a first-use error naming the exact key.
Migration from today's `ModelsConfig`: `agent → default`, `paint → fill`,
`judge` unchanged, `knowledgeVerifier → verifier` (amendment 2026-07-30: the
fold into `default` was premised on it having no independent consumer — that
premise was FALSE, `server.ts` still reads it, and folding silently repointed
the agent model when a host set only `knowledgeVerifier`. It keeps its own
seat; the knowledge check's cheap/fast model must never be the agent's). Deprecated `model:` / `paint:` keys keep
their existing shims for one minor. **Boot error** if a harness option sets a
model *and* `models.default` is set for the same seat.

## 5. Packs

```ts
export interface Pack {
  name: string;
  tools?: ToolDefinition[];
  skills?: PackSkill[];
  checks?: Check[];
  components?: ComponentRegistry;      // the SHIPPED registry shape, see below
}
export interface PackSkill { name: string; description: string; body: string; }
```

- **`components` uses today's vocabulary**, unchanged from
  `packages/core/src/catalog.ts`: `{ component, description, props?, examples?,
  remixable? }` — the server ignores `component`, the client mounts it. (The
  architecture spec's `{schema, render}` sketch is superseded by this line.)
- **`checks` reconciles with the shipped `Check`** (`packages/apps/src/checking/types.ts`):

```ts
export type Check =
  | { name: string; kind?: "fact"; run(input: CheckInput): Promise<Finding[]> }
  | { name: string; kind: "judgment"; rule: string };   // joins the reviewer rubric
// amendment 2026-07-30: `kind` is optional on the fact variant and the floor
// runs anything NOT explicitly "judgment" — a safety floor never opts a check
// out by omission (a kind-less legacy host check must keep firing).

export interface CheckInput { document: AppDocument; request: string; plan?: AppPlan; }
export interface Finding { severity: "block" | "warn"; where?: string; message: string; }
```

`kind` is added to the shipped shape (defaulting to `"fact"` for existing
in-repo checks); judgment rules are appended to the reviewer's rubric list as
separate lines, never concatenated into one string. Findings are
order-independent; a check that throws yields one `warn` and never blocks a
build.
- Names are **global as authored** — no prefixing. Boot fails on collision,
  naming both packs.
- **Every boot gate ships a test that proves it can still FAIL** (lesson,
  2026-07-30): a gate reading the wrong source looks identical to a gate that
  finds nothing wrong — twice this wave a *fix* was the defect and only a
  red-green test caught it. A pass-only test is not evidence a gate works.
- A pack module is imported twice (server + client) and must be import-safe on
  the server.

## 6. Transcript storage (the accepted migration)

```sql
vendo_thread_messages (
  thread_id   text not null,
  id          text not null,            -- client-minted UIMessage.id
  seq         integer not null,         -- ordering; monotonic per thread
  message     jsonb not null,           -- one UIMessage
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (thread_id, id)
);
create index on vendo_thread_messages (thread_id, seq);
```

`vendo_threads` keeps `id, subject, title, revision, created_at, updated_at`
and **loses `messages`**. Reads reassemble by `seq`. Writes: one row per new or
edited message, per-row CAS on `revision`; the thread row's `revision` still
guards title/metadata. Ordering never derives from timestamps (approval flips
rewrite older messages). Backfill follows the existing versioned-migration
pattern in `packages/store/src/schema.ts` (`SCHEMA_VERSION` bump + one
`DATA_BACKFILL` step splitting existing arrays). Add the table to
`ERASE_TABLES`, the subject-adoption path, and `02-store.md`'s row map.

Helper surface (orchestrator addition, 2026-07-30 — lane D builds it, lane A's
runtime consumes it; style matches `helpers/threads.ts`):

```ts
export function threadMessageStore(store: VendoStore): {
  /** One row per message; per-row CAS on `revision` for edits. */
  upsert(principal: Principal, threadId: ThreadId, message: UIMessage, seq: number): Promise<void>;
  /** Reassembled by seq, oldest → newest. */
  list(principal: Principal, threadId: ThreadId): Promise<UIMessage[]>;
}
```

## 7. Consent shapes

```ts
export interface GrantSet {
  id: string;                    // gset_…
  appId: string;
  subject: string;               // per person, always
  intentHash: string;            // sha256 over the canonical intent, below
  tools: string[];
  createdAt: string;
}
```

`intentHash` preimage (RFC 8785 canonical JSON): `{ tools: string[] (sorted),
trigger, runBody, name }` — the app's declared toolset, its trigger, its run
body/prompt, and its user-visible name. Any change → the set is invalidated →
re-ask **the delta only**, reusing today's `invalidatedGrant` +
stale/current-hash audit path. `title` joins the `descriptorHash` preimage
(`packages/core/src/descriptor-hash.ts`) so a retitle invalidates like a rename.

Effect ledger (makes fail-and-re-run correct):

```sql
vendo_effects (
  key         text primary key,   -- sha256(runId|turnId + tool + exactInputHash
                                  --        + ordinal), where ordinal counts
                                  --        prior identical calls in the same
                                  --        (run, turn) — amendment 2026-07-30:
                                  --        without it, two legitimately
                                  --        intended identical mutations (pay
                                  --        $10 twice) silently collapse to one
  subject     text not null,      -- amendment 2026-07-30: outcome holds tool output,
                                  -- so the ledger must join the erase cascade
  outcome     jsonb not null,
  at          timestamptz not null default now()
);
create index on vendo_effects (subject);
```

Written inside the guard's execute path for mutating calls only; a call whose
key already exists returns the recorded outcome instead of executing. The
table joins `ERASE_TABLES` and the subject-adoption path, keyed on `subject`
(orchestrator amendment, 2026-07-30 — the frozen v1 shape had no subject
column and was therefore un-erasable).

## 8. Explicit wave-1 cuts (do not build)

`/orgs/**` mounts and `can()` beyond ownership (wave 3) · steering
(mid-turn user input) · the `vendo validate` in-box CLI shim · `vendo pack
export` · conditions on grants · any code-execution or app-serving tool ·
scope constraints on grants (the architecture's §12 law removes their v1
need).

Wave-1 `can()` is exactly today's rule: a path under `/user/` belongs to its
subject, `/host/` is read-only for everyone. Nothing more.

Amendments 2026-07-30 (lane D ratifications): the design's `records_*` verbs
ARE the shipped `vendo_apps_data_list/put/delete` — no rename; the names are
referenced inside stored app documents, and invalidating live apps for
cosmetics fails the migration law. `schedule` carries risk `write` (arming
future unattended behavior is a write). `validate` returns findings in its
output, never a tool error. The host product-slug RENAME (applying the
shipped prefix primitive across the extraction estate) is its own post-wave-1
lane — mixed prefixes are worse than none.
