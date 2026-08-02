# Lane CLOSE — `claudeCode()` → live-session rewrite (cc-native)

**Worktree:** `/Users/yousefh/orca/workspaces/flowlet/cc-native` · branch `rebuild/cc-native` · base `59ccb2389`
**Date:** 2026-08-02 · **Never pushed, no PR, no merge.** Landing is the orchestrator's job.

---

## 1. The parity verdict — NOT IDENTICAL. Tools stay in-process.

This was run FIRST, before any deletion, because it decides how much gets deleted.
The gate is executable and committed: `packages/vendo/src/mcp-door-parity.e2e.test.ts`
(4/4 pass). Full write-up: `docs/verification/cc-native/parity-gate.md`; raw output:
`docs/verification/cc-native/parity-gate-output.txt`.

It drives the same two tool asks — one `read` the `cautious` policy runs, one
`write` it parks — through BOTH doors of ONE composed host (one store, one real
guard, one policy, one registry, one subject) and compares the five contract-named
audit fields plus approval behavior.

| | in-process | through the door |
|---|---|---|
| read | `ok · rule · present · **chat** · user_parity` | `ok · rule · present · **mcp** · user_parity` |
| write (policy parks) | card on the turn's stream → 90s wait → executes → `ok` | in-band "resolve it there, then retry" → `pending-approval` |
| harness-minted bearer | n/a | **401** |

Six divergences. Three measured, three read from code:

1. **`venue` is hardcoded** (measured). `mcpContext` (`packages/mcp/src/door.ts:1020`)
   always says `"mcp"`. `venue` is a policy-match field (`guard/src/policy.ts:175`)
   and a grant-set predicate (`core/src/grant-sets.ts:292`), so this changes
   decisions, not labels.
2. **Approval is a different mechanism** (measured). The door has no stream to put a
   card on. A boxed agent cannot act on "resolve it in the product and retry", and
   the row left behind is a live ask rather than a completed write.
3. **There is no bearer to mint** (measured). The door only accepts grants from its
   own `/register` → `/authorize` → `/token` PKCE flow and refuses ephemeral
   principals (`door.ts:328`). The design's `Bearer <per-turn token>` has no issuer.
4. **`presence` cannot be expressed** (read). Hardcoded `"present"`, with no
   parameter to pass. An unattended run would be audited AND JUDGED as attended.
   The most severe of the six, and structural.
5. **`descriptors()` is asked without ctx** (read, `door.ts:450`/`:493`) — so the door
   skips `projectableForRun`, where THE LAW (§12) withholds destructive and external
   tools from an unattended run.
6. **No mirror, no commit** (read). No transcript tool part; no `workspace.commit()`
   after each call, which is what puts the skeleton on screen mid-turn.

**Consequence taken, per the contract's own branch:** tools stay in-process
(`createSdkMcpServer`, unchanged) — and therefore **the ask/park/queue/cursor bridge
STAYS**, contrary to the Delete list. Everything else in the lane shipped.

---

## 2. What shipped

**The live session.** `runClaudeTurn()` → `createClaudeSession()`. ONE `query()` per
conversation with a streaming input; `send()` pushes a message and settles on that
message's own `result`. `interrupt()` stops a turn without killing the conversation
(the user hit stop, they did not close the tab). One box per conversation, one
session held open, chat in / stream out.

**Skills, natively — and `Turn.skills` reaches this harness for the first time.**
Before this lane the pack skills were materialized onto the box's disk and *nothing
told the model they existed*; they were files it might stumble on. `hostSkillFiles`
already writes `/host/skills/<name>/SKILL.md`, which is EXACTLY the layout the SDK's
local-plugin loader reads — so the `/host` mount IS the plugin. No copy, no
translation, no second mechanism, no new mount.

**Prompt.** The ~14-line workspace wall → a few lines about the *embedding*. Claude
Code already knows how to work in a directory; what it cannot know is that it is
inside someone's product talking to their customer.

**Components back.** The 1.2s file-watch interval → a sync driven by the SDK's native
`PostToolUse` hook. Sync on write, not sync on tick. Still by SHAPE
(`/user/apps/*/app.vendo`), because the app whose plan lands first may have an id the
turn only just invented.

**Deleted:** machine pool · idle sweep · snapshot/resume-ref (`SessionRef`) ·
token-rotation handshake · file-watch polling · the prompt wall · `state.resume`.
**Kept:** materialization + diff sync-back · guard · audit · transcript · tenant
isolation (`settingSources: []`, per-tenant `CLAUDE_CONFIG_DIR` + `cwd`) · sandbox
default · `machine: "local"` · the in-process projection and its bridge.

---

## 3. Line count — it went UP. Report this to Yousef.

The contract's mission says the adapter "is 3,403 lines because it treats every user
message as a cold start". Removing the cold start did **not** shrink it.

| file | before | after | delta |
|---|---|---|---|
| `box.ts` | 446 | 341 | **−105** |
| `claude-turn.ts` | 416 | 622 | **+206** |
| `local.ts` | 184 | 277 | +93 |
| `turn-routes.mjs` | 359 | 405 | +46 |
| `machine.ts` | 58 | 87 | +29 |
| `index.ts` | 444 | 457 | +13 |
| `materialize.ts` | 192 | 192 | 0 |
| **production total** | **2,099** | **2,381** | **+282** |
| tests | 1,304 | 1,802 | +498 |
| **contract's 3,403** | **3,403** | **4,183** | **+780** |

**Why.** The deletions landed exactly where predicted (`box.ts` −105: the pool,
sweep, snapshot, resume-ref and rotation). But holding a session OPEN costs more code
than starting one per turn: a push-driven input inbox, a turn-boundary settle, a
send-serializing queue, interrupt plumbing, reopen-on-tool-change, and — in both
drivers — an indirection so the session's sinks point at the turn currently in flight
instead of the one that opened it. "Call `query()` and return" needed none of that.

The honest reading: the 3,403 lines were never mostly cold-start cost. ~200 lines
were pool/snapshot/rotation (deleted). The rest is the bridge, the projection, the
sync-back and the tests — and the bridge survived because the parity gate failed. Had
the door been usable, deleting the bridge (~230 lines across three files) would have
made this roughly a wash rather than a saving.

**This is a product call for Yousef:** the live session is a better *experience*
(proven below) but not a smaller codebase. If the goal was fewer lines, the lever is
the door's `venue`/`presence`/bearer gaps, not the session shape.

---

## 4. Proofs

Evidence: `docs/verification/cc-native/` — `live-box-proofs.log` (7/7, real e2b box,
real model), `live-local-proofs.log` (5/5, `machine: "local"`),
`parity-gate-output.txt` (4/4). Box template re-baked:
`VENDO_BOX_TEMPLATE=azldli4bchjbn6gtq3tr`.

| # | proof | status | evidence |
|---|---|---|---|
| 1 | **Chat is real** — 2 turns, same box, same session, no re-materialize | **PASS (live)** | asked it to hold `7311`, second message recalled `7311`; `carriesSession` false→true; a unit test pins that only ONE `reset` materialize happens across two turns |
| 2 | **Skills** — native discovery | **PASS (live)** | a `refund-policy` SKILL.md whose code is only knowable by reading it → agent answered `ZEPHYR-9931`, with `settingSources: []` intact |
| 3 | **Tools + audit** | **PASS (live)** | `maple_invoices_list` executed host-side through `turn.tools.call`; box env carries `ANTHROPIC_API_KEY` and no other credential (no E2B key, no canary). Parity evidence in §1 |
| 4 | **Components** | **PARTIAL** | live: the agent edited `app.vendo` and the diff committed. Mid-turn skeleton timing is pinned at unit level (hook-driven `syncHot`, incl. the brand-new-appId shape case) but I did **not** measure a live mid-turn latency number, so the 52.8s-vs-5.0s regression is guarded by construction, not re-measured |
| 5 | **Recovery** | **PASS (live)** | box destroyed mid-conversation → fresh box, files re-materialized, agent read back `4417` |
| 6 | **Isolation** | **PASS (live)** | two tenants, one host process: Alice saw `APPLE-111` only, Bob `BANANA-222` only, neither the other's |
| 7 | **Local mode** | **PASS (live)** | 5/5 including a guard denial narrated through the native permission hook and an honest refusal with no invented tool |
| 8 | **Line count** | **DONE** | §3 — it went up |

### Two real bugs the live proofs caught that no unit test would have

1. **Every sentence doubled.** `includePartialMessages: true` makes the SDK emit both
   token deltas and the finished assistant block. The user saw *"I'll find and update
   that heading for you.I'll find and update that heading for you."* Whichever
   arrives first now wins; the block is still the only source when an SDK build
   streams nothing.
2. **An EMPTY second turn in `machine: "local"`.** The session outlives the turn that
   opened it, so capturing that turn's `emit`/`callTool` closures delivered every
   later turn's text to a queue nobody was draining. The user's second message came
   back blank. Local now routes through whichever turn is in flight — which is what
   the box path already did by design.

Both are pinned by tests that fail without the fix.

### One isolation gap found and closed while proving #2

`skills: "all"` enables every skill the engine *discovered*. On a host running
`machine: "local"` that included the operator's own `~/.claude/skills` — a probe saw
`deep-research`, `dataviz`, `claude-api` alongside ours. That is the operator's
private tooling joining a customer's agent. The enabled set is now OURS by name,
taken from `turn.skills.list()`. Verified empirically: with the named filter, our
skill works and invoking an unlisted operator skill returns **FAILED**.

---

## 5. Gates

`pnpm build` ✅ · `pnpm typecheck` ✅ 43/43 · `pnpm lint` ✅ 6/6 (dependency-guard +
portability) · `pnpm test --force --concurrency=1` from the repo root, twice, both on
the FINAL commit (the earlier green pair predated the skills wiring and the
NUL-separator fix, so it was re-run rather than cited).

Per-package on the clean run: apps 642 · harnesses 234 · vendo 1753 · ui 683 ·
bench 525 · corpus-harness 390 · demo-accounting 152 · genui-bench 122 ·
demo-bank 96 · demo-template 82 · integration 52 · automations 47.

**One load-flake, classified not assumed.** On the first full run
`@vendoai-fixtures/integration` failed 15 tests with `fetch failed` /
`ECONNREFUSED` / "Server is not running" — its fixture HTTP server starved under
`--concurrency=1` contention. Run scoped on a quiet machine it is **52 passed, 1
skipped**, and `grep -rl "claudeCode\|claude-code\|claude-turn" fixtures/integration/src/`
returns nothing, so the fixture never touches this lane's code. This is the class the
contract names as not-mine.

---

## 6. Contracted and dropped / deviations

- **The ask/park/queue/cursor bridge was NOT deleted.** The contract's Delete list
  assumed the MCP door could carry tools. The gate says it cannot, and the contract's
  own fallback branch says the projection stays in-process — which means its
  transport stays too. `/turn/*` became `/session/*` and is keyed on the session
  rather than one turn.
- **`snapshot` left `SandboxAdapterLike`.** Nothing snapshots a conversation box, so
  the structural subset no longer names it. The `SandboxAdapter` interface in
  `@vendoai/apps` is untouched; only this subpath's view narrowed.
- **A warm box is not re-materialized.** Contract proof 1 asks for exactly this. The
  consequence: an out-of-band store write (another harness, an app tool) is not seen
  by a live conversation until its box recycles. Previously every turn re-materialized
  and so always saw it. Accepted because the contract names it; worth Yousef knowing.
- **The projected tool set is fixed for the life of a session.** An SDK MCP server's
  tools are set at open. If `find_tools` equips something new, the session is
  REOPENED on its own id (fingerprint compare) — a restart, never a lost memory. The
  alternative, projecting everything up front, would defeat curation and §12.
- **`turn.state.resume` is gone**, so a conversation whose box died pays a re-seed
  from our transcript instead of a snapshot resume. Slower on that rare message,
  never wrong.
- **Recovery is not `SessionStore`-backed.** The contract floated a `SessionStore`-style
  adapter over `vendo_state`. The SDK does ship `sessionStore`, but recovery is the
  RARE path and the contract says not to let it complicate the main one — re-seeding
  from the transcript we already own needs no new adapter, no new table and no new
  concept. Flagging it as a deliberate narrowing, not an oversight.

## 7. Unrelated issues noticed, not fixed

- `packages/apps/src/claude-turn.ts` still greps as **binary** (a raw NUL byte) — use
  `grep -a`. Pre-existing.
- The SDK now warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`: bare `allowedTools` entries
  auto-approve `Bash/Read/Write/Edit/Glob/Grep/TodoWrite` **before** `canUseTool` is
  consulted. That is our intended box-is-the-permission design, so behavior is
  correct — but the SDK is telling us a `PreToolUse` hook is now the supported way to
  express it, and the hook allow-list in `guardedProjection` is therefore partly
  vestigial on that path. Worth a follow-up; not this lane's contract.
- `createVendo({ mcp: true })` warns "zero live host tools" when tools are added via
  `vendo.actions.add()` after construction. Cosmetic, pre-existing.
