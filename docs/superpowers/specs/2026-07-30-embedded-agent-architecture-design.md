# Vendo — the embedded agent layer

**2026-07-30.** The final architecture, designed with Yousef; brainstorm ongoing —
guard details, the automations pack, and the run_code↔guard bridge are still open
(§12). Nothing builds before his go.

## 1. The mission

Vendo is the embedded agent layer: if a company wants an agent inside its product,
Vendo is the stop for it. We own the in-product surface, the host's tools
(extraction), per-end-user authority (guard), verification (checks), and
persistence. Who thinks is a swappable adapter, like the store and the sandbox.

## 2. The dividing line

> **We own state, tools, checks, guard, and skills. The harness owns thinking —
> and orchestration is thinking.**

Subagents, parallelism, delegation, context management, when-to-go-deep: all the
harness's business. We never build orchestration; we build the façades the harness
thinks with, and the gates that hold regardless of who thinks.

Two kinds of moving part, nothing else:

- **Agents** — everything that exercises judgment, at whatever weight the hiring
  context chooses. All through one contract (§3).
- **Functions and gates** — everything that doesn't: validate, guard policy,
  audit, and *when checks fire*. Plain code.

Single model calls survive only as private internals: `instant()`'s guts,
the guard judge (hot path), and mechanical utilities (compaction summaries,
titles).

## 3. The harness

The harness is the embeddable agent — lean, app-ignorant, one thinker per
conversation. It discovers capabilities (packs) at runtime and hires its own
staff to execute them. The user always sees one assistant; harnesses, subagents,
and checks have no face.

One central home: `@vendoai/harnesses` — built-ins at the root, external
drivers as subpaths with their SDKs as optional peers
(`@vendoai/harnesses/claude-code`).

- **v1:** `vendo()` (default, in-process, key-free — today's `@vendoai/agent`
  reshaped onto the contract, gaining workspace+skills, subagent hiring, and
  steering) · `instant()` (the non-agentic ≤5s specialist — today's engine;
  authored in apps, re-exported here) · `claudeCode()` (new; Agent SDK;
  proves session sandbox, `turn.state`, MCP projection, native permission
  hook).
- **Fast-follow, in order:** `codex()` (reuses the spawned-CLI path) ·
  `pi()` (premium in-process alternative; the contract's honesty check and
  vendo()'s bench rival) · `managedAgents()` (proves the callback dialect) ·
  `opencode()` demand-driven · hosts' own via `defineHarness` from day one.
- vendo() is built on our existing runner + AI SDK — never on Pi (transcript/
  schema friction at the core, 0.x foundation risk); Pi's steering queues,
  event granularity, and non-destructive compaction are borrowed as design.
- **claudeCode() specifics (settled):** its own permission system is
  repurposed, not trusted — auto-allow inside the box (the box is the
  permission: copies only, no credentials; reality happens at commit), and
  our guard's asks are delivered through its native permission hook so the
  co-trained pause-and-explain behavior serves our cards. The ~250MB Agent
  SDK ships inside the sandbox image, never in the host's node_modules —
  `@vendoai/harnesses/claude-code` is a thin spawner. v1 options: `model`,
  `effort`, `maxTurns`, `machine: "local"`; nothing else until asked.

### The contract

```ts
export const acmeHarness = defineHarness({
  name: "acme-loop",
  options: z.object({ model: z.string().default("claude-fable-5") }),
  async *run(turn) {
    // turn.messages  conversation so far — ours, canonical, read-only
    // turn.tools     everything projected; call() is guarded + audited
    //                + mirrored automatically
    // turn.skills    pack skills — listed cheap, load(name) for full text
    // turn.state     the harness's own persisted state — opaque to us
    // turn.options   resolved knobs, incl. per-turn overrides
    // turn.signal    abort
    yield { type: "text", delta: "…" };   // yields are narrative only
  },
});
```

- **Tool calls are safe by construction.** Calls through `turn.tools` pass the
  guard, land in the audit trail, and mirror into the transcript — a harness
  author cannot forget the safety story.
- **Approvals wait or fail — they never suspend a run.** User present: the
  guarded call simply blocks until the card is tapped (seconds; the harness
  never knows). User away or timeout: the call returns `denied-needs-approval`,
  the run **fails loudly** with an actionable card ("needs approval for X —
  Grant & re-run"); the grant persists, re-run starts clean. Park/suspend is
  never extended to new surfaces (the automations engine's internal
  step-resume stays as shipped implementation detail). Consent is collected
  upfront (§11.4), so a mid-run missing grant is the rare exception, not the
  flow.
- **Options are declared, then overridable per turn.** Adapters declare their
  knobs (typed schema); hosts forward what they choose to end users (model
  picker etc.); the wire forwards nothing by default. Host-side dependencies
  (loggers, flags) arrive by factory closure — `acmeHarness({ logger })` — no
  context slot.
- **Two doors into the guard, one guard.** In-process harnesses call
  `turn.tools`; spawned harnesses get their native dialect and every call
  still lands in the same choke point. Projections per harness: plain
  functions (ours, Pi, custom) · in-process MCP + native permission hook
  (Claude Code SDK — guard asks surface as its own permission flow) · MCP
  config (spawned CLIs) · callback events (Managed Agents).

### Harness state

Three-part state, three owners:

| State | What | Owner |
|---|---|---|
| Conversation | the transcript | Vendo store — canonical for render, audit, review, resume |
| Workspace | files, skills, memory, app source | Vendo store — survives across turns and harness swaps |
| Harness state | `turn.state` — e.g. a session id | the harness; opaque, persisted by us, disposable |

Session-owning harnesses (Claude Code, Codex) keep their native session via
`turn.state` and get their co-trained compaction/caching. The native session
file is treated as one more workspace file: synced out at turn end, re-
materialized on acquire — an idle-TTL'd sandbox never costs a re-seed. Prefix
truncations (retry an edited message) use the harness's native rewind; only
arbitrary history edits or a harness swap clear `turn.state`, and a re-seed
feeds a compact summary + recent turns, never the raw transcript. Correctness
never depends on the harness's copy; the truth is ours.

**Mirroring — what goes where.** Yield vocabulary is closed: `text · status ·
error · usage`. Routing: text → screen + transcript; status → screen only
(ephemeral); in-box bash/file ops → nowhere but the commit diff (audit);
subagents → one transcript receipt line, never the screen (one-assistant law);
guarded calls → transcript + audit rows; usage → audit/metering only.
Invariant: **audit ⊇ transcript** — billing and reconciliation never depend
on the story layer. The write law's "~15 rows/turn" holds because in-box ops
don't mirror.

**The consumer voice law.** The agent never talks about code, tools, or files
to an end user. Three anchors: surfaces render tool *titles and verbs*
("Checked your invoices"), never names — rendering-layer law; every skill and
prompt carries the register (plain language, no paths, no jargon); the
reviewer rubric makes user-visible technical jargon a finding. Errors follow
it too: plain-language, no internals.

## 4. Tools

Defined once, neutral (`name / description / zod input / risk / execute`),
projected everywhere — every harness, the MCP door, `search_tools`. Execution is
always on our side; the guard wraps every harness identically.

Five families: **host** (extracted API, as the signed-in user) · **workspace**
(read/write/edit/ls/grep) · **vendo verbs** (`records_list/put/delete`,
`schedule`, `find_tools`, `search_components`, `validate`) · **capability**
(run_code, serve) · **ask_user** (questions + approvals, one door, any seat,
park-and-resume).

Naming and projection law for the families:

- **Host tools carry the host's product slug as prefix** (`maple_invoices_list`),
  derived at init, configurable — never the word "host"; the model should read
  them as native product actions. Renames invalidate descriptorHash-bound
  grants, so this lands pre-GA or never. **Compound tools** (host-authored
  macros in overrides.json: a named sequence of enabled primitive steps,
  declared risk = riskiest step, every step re-enters the guard individually)
  are host-family members, documented as convenience-never-bypass.
- **`find_tools`** (renamed from vendo_tools_search): searches every
  descriptor including the curated-out long tail AND equips matches into the
  live toolset mid-turn. No separate search_connectors — results include
  unconnected connector tools annotated connect-required, feeding the
  existing connect-card flow.
- **`run_code` is projected only to machine-less harnesses** — bash-native
  harnesses just run code; the hands table is the router. **`serve` projects
  to everyone**: serving is platform lifecycle (registered URL, wake/sleep,
  keepalive, egress approvals), not "a server in my box".
- **`validate` is also projected into the sandbox as a CLI shim**
  (`vendo validate <file>` on the box PATH, calling back through the bridge)
  so bash-native harnesses use it in their natural edit-check-fix rhythm.
  Generic box-side linters (tsc/eslint on island TSX) are free extra signal,
  never a substitute — validate checks against our catalog and the host's
  schemas, which live on our side.

**Hands vary; the cabinet, the guard, and the checks never vary.** Every
harness can do file work — what differs is the hands it reaches the workspace
with:

| Harness | Hands | File work | Arbitrary code |
|---|---|---|---|
| bash-native (Claude Code, Codex) | a real shell; workspace materialized in the session sandbox | grep/sed/editor/python — the whole CLI long tail, co-training intact | native |
| in-process (vendo(), Pi-based, custom) | workspace tools against the store façade | `edit(file, old, new)` — the v2 verb | rented: `run_code`, if a sandbox is wired |
| hosted (Managed Agents) | callbacks — tools execute our side | same, over a longer wire | rented, same |

Bash beats workspace tools wherever a machine exists — wrapping a bash-native
harness in `workspace_*` tools would confiscate the hands we chose it for.
Bash edits sync back to the store (the diff is the audit entry); tool edits
hit the store directly — next turn, a different harness sees the identical
workspace. A machine-less harness with no sandbox and no computed-value fit
takes the honest cannot-path. **Authority is always tools, every harness**:
host calls, records, ask_user need the user's identity and the guard, and
the sandbox holds no credentials — there is no file to bash. Hand-quality
changes what a harness can do to files, never what it can do to the world.

Curation: a small top-level list; the long tail reachable via `search_tools`
and callable from inside `run_code`.

**Documents are files; records are tables.** App source, memory, skills,
uploads, generated reports — file-shaped, in the workspace. Data rows —
table-shaped, subject-partitioned, reached through tools, never `cat`.

## 5. Packs

Capability arrives as a pack: a plain value contributing to slots that already
exist. Nothing else extends Vendo; the architecture's own joints are the plugin
system.

```ts
export const complianceReports = definePack({
  name: "compliance-reports",
  tools: [checkReportTool],
  skills: [{ name: "building-compliance-reports", body: skillMd }],
  checks: [{ kind: "fact", run: findUnmaskedAccounts },
           { kind: "judgment", rule: "Totals must cite their query." }],
  components: { RetentionBadge: { schema, render } },
});
```

- Four slots, no more: tools → the one registry (guarded, projected); skills →
  workspace mounts, projected per harness layout (on-disk format =
  agentskills.io SKILL.md — Pi and Claude Code read it natively, so projection
  is a copy, not a translation); checks → the floor; components → the catalog.
  (A records/storage slot was considered and cut — packs that need rows use
  the existing records machinery; the slot returns if a real pack demands it.)
- Packs contribute to existing slots **only** — no config surface, no guard
  wrapping, no reaching into other packs.
- `apps()` and `automations()` are built on this exact interface — no
  privileged internal API — with one honest carve-out: **triggers and
  scheduling are platform lifecycle** (core runtime, like `serve`), not pack
  content; the automations pack contributes tools/skills/checks/components
  *over* that lifecycle. Third-party packs wanting recurring behavior create
  automations through the normal guarded path.
- **Packs are isomorphic modules passed twice** — the same import to
  `createVendo({packs})` (server reads tools/checks/skills, ignores render)
  and to the client root (mounts render). Pack modules must be import-safe
  on the server. Harness/pack contract types live in core (the established
  layering fix).
- **No renaming, ever.** Tool names are global as authored — a skill body
  says `check_report` and projection is a copy, so a prefixed name would
  point the model at a tool that doesn't exist. Collisions fail at boot
  naming both packs; boot-collision IS the namespacing. Pack tool renames
  invalidate grants same as host renames.
- **Packs export downward**: the portable subset (tools + skills) compiles to
  the industry formats — an MCP server, an agentskills.io skill folder, a
  Claude Code plugin (`vendo pack export`). Author once in the rich format
  (checks have no downstream equivalent anywhere; components get at most a
  degraded export via MCP Apps' declared UI — the guarded/checked half stays
  export-less and is the differentiation), project to the poor ones.
- **Skills teach, checks enforce.** A skill is a job description; the harness
  hires its own staff to execute it; if the harness ignores it, the checks floor
  holds anyway.

## 6. App generation (the apps pack)

Not a subsystem — the first pack: generation tools (`validate`,
`search_components`), the v2 pattern as a skill, the checks, the renderer.

Delegation is the *skill's advice, per skill* — a sentence in its body ("run
me in a fresh subagent"), never a pack property or our machinery. Reference
and small-procedure skills are simply read inline; only big loud jobs carry
the advice, and the harness maps it to its native staff (or ignores it — the
checks floor holds either way).

The flow, with any harness: the resident carries a ~30-token skill listing;
on an app ask it dispatches **its own native subagent**; the builder loads the
full skill, writes the plan file (**the plan format is the render format** —
skeleton on screen as soon as the file exists), fans out cheap fill workers
(one per plan group; each sees only its group, its components' docs, and real
sample rows — the blinkers are the coherence and safety design), runs
`validate`, fixes, asks the user through the one door if genuinely ambiguous,
and dies. The resident keeps a ~80-token receipt. The app file is the only
truth; next week any harness opens it and edits. Worker weight (bare call vs
looped subagent) is the harness's business; scope and the checks floor are ours.

`instant()` is this pattern compiled into a specialist harness — one plan
call, parallel bare fill calls, ≤5s skeleton — for hosts that want speed as
the resident. Default-harness choice is a bench question, not architecture.

## 7. Checks

The harness-independent floor. Swap any harness; the floor doesn't move.

- **validate** — code, instant, compiler-shaped: parse, referenced tools/
  components/fields/schedules exist, types fit.
- **review** — a skill + a fresh subagent, nothing more. On app-commit (the
  same hook where fact checks and `can()` already run), the runtime spawns
  one subagent on the wired harness with the review skill: the rubric, the
  original ask verbatim, read-only hands (workspace ro, read-risk queries,
  test-drive; guard-clipped — no writes, no ask_user). **No shared context
  with the builder** — independence is free, not machinery. The builder's
  skill may also advise self-review mid-build (its business); the hook is
  the guarantee — host judgment rules fire regardless, and the D5-gate
  deletion condition (reviewer always runs) holds. `instant()` keeps its
  internal reviewer. `models.reviewer` overrides the seat; depth
  (rubric-only single call vs full test-drive) is a host dial, defaulting by
  blast radius: org-shared/automation apps get the full test-drive, personal
  quick edits rubric-only. **Failure protocol:** FAIL → the commit lands as a
  flagged version (the previous version keeps serving), one bounded fix
  round, then surface honestly. Reviewer traffic runs under its own breaker
  context, never the user's budget.
- **host checks** — plugged in via packs, same guarantee: they fire whether or
  not the builder feels like it.

## 8. Workspace

The agent's filesystem — a façade over the store, materialized onto a real
disk only when a sandbox needs one. Backed by `store` (small files) + `files`
(blobs, size-threshold cutover). The fs interface is **`just-bash`'s
`IFileSystem`** (Vercel, Apache-2.0): we implement it over the store and get
an in-process bash surface (grep/sed/awk/jq, read-only mounts) for
machine-less harnesses — no sandbox needed for file work. Versioning is a
revision column + history rows (per-file CAS at commit), not git.

Mounts — one per membership, permissions derived from role:

```
/user/                    the signed-in user — always rw
/orgs/<org>/              one mount PER org membership (Cloud; apps + shared
                          fields; org memory deliberately cut from v1)
/orgs/<org>/teams/<team>/ teams are principals too — same machinery
/host/                    host-authored skills + knowledge — always ro
```

`ls` on a mount is a query, not a directory read — it returns the caller's
visible subset.

**Per-app access is the Google Docs model.** Every org app carries grants of
*principal → level*; a grant can name any principal — a person, a team, the
whole org, any mix per app:

```
finance-dashboard:  org:acme → viewer · team:finance → editor · dana → owner
```

- The level vocabulary is closed and ships with us: `viewer` (see + use) ·
  `editor` (edit) · `owner` (edit + share + delete). Assignments are fully
  flexible; *defining new level types* is not a surface (`operator` for
  automations is deferred to the guard brainstorm). Effective access = max of
  your grants; org admins are implicit owners.
- **Live sharing implies the org workspace.** A personal app has one member;
  the share dialog promotes silently and sets grants ("Share → finance as
  editors" = promote + grant). To hand someone a copy instead, fork. Personal
  workspaces stay single-player; the org owns what outlives people.
- Enforcement is the same one point as everything else: the façade and the
  wire check the grant; no second permission system.

### How permissioning enforces

- **One function, three doors.** `can(principal, level, thing)` — resolved
  from ownership + memberships + grants, all rows — is the only permission
  logic; the workspace façade, the wire, and the MCP door all call it. Harnesses,
  packs, and tools are permission-blind: they just perceive a smaller world.
- **Rows live behind the `store` adapter** — the host's own Postgres
  (Supabase, RDS, whatever they wired) or Cloud's hosted store, as `vendo_*`
  tables, host-SQL-queryable. Cloud provides *management* (console, SSO →
  memberships, share dialog → grant rows), never the only copy of
  enforcement. No key → org tables empty → `can()` degenerates to "is it
  yours?"; share/promote throw `cloud-required`. No hidden branches.
- **For sandboxed harnesses, `can()` runs at exactly two moments** — there are
  no checks inside the box, so the box is born filtered:
  *checkout* — materialization is a query ("all files viewer+ reaches"),
  editor-level mounts rw, viewer-level ro, invisible apps simply absent;
  *commit* — sync-back checks `can(editor)` per changed file against live
  rows before the store accepts it (the diff is the audit). In-process harnesses
  have no box: same `can()`, every façade call.
- **The box is a snapshot.** Mid-session revokes don't un-materialize what a
  session already saw (reads age gracefully, like a Docs revoke); they bite
  at next checkout — and writes never sneak through, because commit always
  checks live rows.
- **Served org apps are a wire door, not a snapshot with viewers.** The
  registered URL checks `can(viewer, app)` per request against live rows;
  served processes get a read-only workspace and reach per-user data through
  tools; file writes from a served app are a job with a commit; the reviewer
  rubric checks nothing private is baked into the served snapshot.

Sharing is two verbs: **fork** (copy into your workspace, fresh ids,
`forkedFrom` provenance — take-and-adapt, registry import) and **promote**
(move the canonical into `org/` — team apps, org fields; survives departures).
The registry is a shelf of dead snapshots — publish = snapshot out, import =
fork in; no live links across org boundaries. Per-user data inside a promoted
app needs nothing new: app storage is already subject-partitioned.

Store write law: **O(messages + tool calls + files changed), never O(tokens).**
Deltas buffer in memory; the UI streams from the wire, not the DB. A turn
lands as ~15 rows.

## 9. Sandboxes

There is no placement layer. `run_code` and `serve` are tools; the harness
decides when (that judgment is thinking), the guard governs the calls, the
adapter supplies machines:

- **One machine concept.** `sandbox.acquire(workspace)` — a session that
  needs a machine (first run_code, a served app, a spawned-CLI harness's cwd)
  lazily acquires one sandbox, reuses it for the session, idle-TTL disposes
  it. No job/session split; warm pools and per-call ephemerality are adapter
  internals, adopted if a bench ever says so.
- Materialize workspace mounts in (ro mounts as read-only binds), sync
  changed files out at turn/job end — **except designated hot paths (the app
  and plan files), which sync mid-turn** so the skeleton renders the moment
  the plan file exists, whoever wrote it (the in-box `vendo validate` shim
  doubles as a sync point); O(files changed) preserved. Commit is per-file
  compare-and-swap for `/orgs/` (stale base → a conflict outcome the harness
  resolves — resolving is thinking); last-write-wins may stand for `/user/`.
  The store never stops being the truth.
  The box holds a workspace copy and a turn-scoped token, nothing else —
  credentials never enter; authority calls bridge back out through the guard.
- **Spawned-CLI harnesses run in the session sandbox by default** — `claudeCode()`
  without a sandbox adapter is a boot error; running the CLI on the host's own
  server is the explicit opt-in `machine: "local"`.
- **The run_code ↔ guard bridge: authority before execution** (the automations
  pattern applied to code). `run_code({ code, tools: [...] })` declares its
  toolset up front; the guard resolves the human ask *before any machine
  spins* — reads auto-grant per policy, mutating declarations become one
  approval card; approved grants are run-scoped and die with the run.
  **Mutating declarations carry scopes** — pinned/constrained args (payee,
  max amount, max calls), rendered on the card, enforced per call by the
  bridge; approving a bare name for code written after the approval is not a
  thing. The bridge enforces the declaration as an allowlist (undeclared
  call → denied, fail closed → script errors → harness re-declares honestly)
  and the mechanical arg gates (capability-substitution class) still inspect
  every actual argument at runtime. **Box egress is bridge-only by default**;
  anything else is a declared domain allowlist through the existing
  egress-approval machinery — the sandbox adapter must expose egress policy.
  `ask_user` does not exist inside code — questions precede the script. No
  mid-run parking, no idle machines, ever. (Today's box injects real secret
  values + the inference key — a deliberate v0 exception to §9's credential
  law; the reconciliation [handles vs scoped values, gating the inference
  key] is parked to the secrets-model brainstorm, recorded here so the
  contradiction is decided, not silent.)
- No adapter wired → capability tools aren't projected → the honest
  cannot-path. The adapter slot is the switch; no capability booleans.
- Escalation doctrine (prefer files and tools over code; job over session)
  lives in tool descriptions and the reviewer's rubric — prompts and checks,
  not machinery.
- Durable Objects and friends appear **behind** seams (a Cloud adapter),
  never **in** them.

## 10. Config — the whole surface

```ts
createVendo({
  auth: fromSession(getUser),
  tools: hostTools,                                  // vendo init / sync
  harness: claudeCode({ model: "claude-fable-5" }),    // default: vendo()
  packs: [apps(), automations(), complianceReports], // default: apps()
  models: { default: anthropic("claude-fable-5"),    // optional; resolution:
            reviewer: openai("gpt-5.6") },           // seat → default → borrow
                                        // the loop's → Cloud gateway →
                                        // first-use error naming the key
  store: postgres(env.DATABASE_URL),
  files: s3(bucket),                                 // optional
  sandbox: e2b({ warmPool: 2 }),                     // optional
});
```

Six slots + `packs`, `defineHarness`, `definePack`, per-turn options. Day one
is one key: `vendo init` writes `.vendo/`, `createVendo({auth})` reads it —
`tools:` is the explicit override, not the quickstart. Everything else
defaults or degrades honestly. Composition rules are boot-time errors
("Claude Code needs a sandbox adapter"), never runtime surprises.

- **One model-resolution order, one place:** a harness reads its seat
  (`models.default` resolved: seat → env ladder → Cloud gateway → first-use
  error); setting both `harness: claudeCode({model})` and `models.default`
  for the same seat is a boot error, not a precedence puzzle. The seat map is
  closed and typed (default / reviewer / judge / fill).
- **`files` unset is a documented default, not a gap**: blobs live in the
  store up to a size cap; the first over-cap write fails naming the fix.
- The build produces a **29→6 migration table** — every current
  `createVendoConfig` key gets a stated destination (folded into a slot, a
  pack option, a harness option, or deleted); no key vanishes silently.
- Roadmap: `vendo sync` emits typed host-tool declarations
  (`.vendo/tools.d.ts`) so host code gets typed names and args.

## 11. The Cloud line

Unchanged laws, applied: personal workspace, BYO everything = OSS
single-player. Org workspaces, sharing, registry, hosted automations, hosted
placement, the model gateway = Cloud — same code, another principal, another
adapter, lit by key + meter. DO-backed store/sandbox/automations adapters are
Cloud implementation details behind OSS seams.

## 11.4 Consent: permissions upfront, popups only for the irreversible

- **Apps and automations get their permissions beforehand, in one honest
  card** generated from their declared tools (the plan declares them; the
  automations enable flow already works this way — grant sets, one decision).
  Approved once → the app runs silently.
- **Destructive/external actions (money, messages to humans, deletes) are
  excluded from upfront bundles by law** — they always pop a live Vendo
  approval card in the moment, real arguments shown. What the human saw is
  what runs.
- **Reads are silent, always.** Ad-hoc chat asks (no app, no bundle) keep
  ask-once-with-remember.
- **Conditions: the third answer on any grant card** — free text ("only if
  below $1,000"), stored on the grant, human-authored. At fire time the judge
  answers one narrow question — do these actual arguments satisfy the
  sentence? — with schema and args in view; satisfied → run (condition +
  rationale in the audit row); unmet or ambiguous → the run fails with the
  card ("$1,400 exceeds your limit — approve this one / raise the limit").
  The human writes policy; the model only interprets it. No predicate DSL.

## 11.5 Automation authority: sponsorship

An automation always runs as a named person — its **sponsor** (creator by
default). The sponsor's grants-as-approval are the 2am authority: the guard
answers "do I hold this exact permission slip?", parks otherwise. When the
sponsor leaves or their grants invalidate, the automation parks loudly and
asks the app's editors+ to **adopt** — re-approving its grants as themselves
through the normal approval flow. The automation's card labels its window
("runs with Dana's access"); honesty, not hidden authority. No non-human
principal ever acts; org service authority stays off the table unless the
market forces it — addable later as an explicit admin-created thing without
touching this model.

## 11.6 Guard policy — carried forward, plus the org layer

Existing machinery survives untouched: host policy config + the judgment
channel (`tools.json < judgments.json < overrides.json`), the judge, approvals
— gaining two designed callers (run_code declarations, sponsorship adoption).
New: **org-admin policy** (Cloud) — a policy layer org admins set over their
members' agents ("finance may not approve host_transferMoney above $10k"),
living as a policy file in the org workspace, managed via the console,
evaluated by the same guard between host policy and user approvals. Host
policy always wins over org policy; org policy tightens, never loosens.

## 12. Open — next brainstorms
- **Secrets reconciliation** (parked from the review): handles vs scoped real
  values in the box; gating the inference key. Owns the §9-vs-box-env
  contradiction.
- **Transcript storage migration**: the O(messages) write law implies
  message-level rows (today: one thread row rewritten per turn — O(thread)
  bytes); recommended accept, awaiting Yousef's word (touches the frozen
  store contract + erase cascade).
- **The automations pack**: grants-as-approval + the logbook reshaped over
  the platform trigger lifecycle (§5 carve-out).
- **Display & remix**: the launcher (ordering, admin-featured), pins as the
  second render mode (feature bundles grafted into host screens), what a
  member sees when a pinned remix targets their screen. Design-skill work,
  with mockups.
- **Benches**: default resident harness (vendo() vs Claude Code + skill on the
  simple-ask corpus) · reviewer depth dial · fill worker weight/tier/
  concurrency · time-to-skeleton gates (≤5s typical stands until re-measured).

## 13. What this supersedes

The 2026-07-28 generation-pipeline-v2 spec's *mechanics* survive inside the
apps pack (plan text, groups, workers' blinkers, edit-like-a-file, computed
values, honest cannot-path); its pipeline framing is absorbed by §2/§3 — the
harness owns the loop, v2's harness seat is the resident harness, the fast path is
`instant()`. The v0 contracts' seams (store, guard.bind, LanguageModel,
subject partitioning) carry forward unchanged.
