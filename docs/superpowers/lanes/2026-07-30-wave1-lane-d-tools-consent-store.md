# Lane D — tools, consent, store migration (wave 1)

**Read first, in order:**
1. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md` — §4 (tools + naming law), §7 (review — the reviewer half), §12 (consent — THE LAW), §13 (sponsorship context only), §3 (voice law: cards carry real arguments)
2. `docs/superpowers/specs/2026-07-30-build-contract.md` — §4 (seats), §6 (message migration + helper surface), §7 (consent shapes), §8 (cuts)
3. This file.

**The one rule:** we own state, tools, checks, guard, skills; the harness owns
thinking. Everything you build is a gate or a function — no orchestration, no
free-text policy language, no judge at decision time. If a shape seems wrong,
ask the orchestrator; never diverge locally.

**THE LAW (design §12, non-negotiable):** destructive and external actions are
never unattended. Automations may read and write; tools that move money,
message humans, or delete are **not projected into an automation run at all** —
not with a limit, not with a condition, not with an admin override. Eligibility
never rests on the AI risk label alone: a second mechanical vote (HTTP method +
verb shape) must agree; disagreement treats the tool as destructive. The honest
pattern is prepare-then-human-sends.

## Build list

1. **`ask_user`** — questions as a tool, one door, any seat. Extend the
   guarded client-upsert gate (`packages/store/src/helpers/threads.ts`)
   **deliberately** and get the extension security-reviewed inside the lane
   (the gate is subject-scoped today; the question card's answer path must not
   open cross-subject writes).
2. **Vendo verbs as projected tools** — `validate`, `search_components`,
   `records_list/put/delete`, `schedule` on the one registry, guarded like
   everything else.
3. **`find_tools`** — rename from `vendo_tools_search`
   (`packages/agent/src/tool-search.ts`, `tools.ts`, `prompt.ts`,
   `packages/vendo/src/server.ts`): searches every descriptor including the
   curated-out long tail AND equips matches into the live toolset mid-turn;
   results include unconnected connector tools annotated connect-required,
   feeding the existing connect-card flow. No separate search_connectors.
4. **Host product-slug prefixes** — host tools carry the host's product slug
   (`maple_invoices_list`), derived at init, configurable; never the word
   "host". Renames invalidate descriptorHash-bound grants — that is the point;
   it lands pre-GA or never.
5. **The seat map** — contract §4: core `Seat`/`ResolvedModels` types (new
   file `packages/core/src/model-seats.ts`); migrate
   `packages/vendo/src/models-config.ts`: `agent → default`, `paint → fill`,
   `judge` unchanged, `knowledgeVerifier` folded into `default`; deprecated
   `model:`/`paint:` shims kept one minor; resolution seat → `default` → env
   ladder → Cloud gateway → first-use error naming the exact key; **boot
   error** if a harness option sets a model AND `models.default` for the same
   seat. (Vendo's internal `ResolvedModels` interface is absorbed/renamed —
   core's seat record is the one true name.)
6. **Review-on-commit** — the hook is NEW (today checks run inside the
   conductor): on app-commit, the runtime spawns one fresh subagent on the
   wired harness (code against core's `Harness`/`Turn` types, lane A) with the
   review skill — rubric + the original ask verbatim + read-only hands
   (workspace ro, read-risk queries; guard-clipped: no writes, no ask_user),
   **no shared context with the builder**. `models.reviewer` overrides the
   seat. Reviewer traffic under its own breaker context. **Failure protocol:**
   FAIL → commit lands as a flagged version (previous keeps serving) → one
   bounded fix round → plain-language card ("Your change didn't pass a safety
   check: <reason>. Fix it / keep the current version"). An `owner` may accept
   a flagged version (override recorded in audit) — except host-check
   failures, waivable only by the host's own policy config. Route the write
   paths that exist today through the hook; note any bypass path you find
   (fork/import/undo/pins) in your lane report rather than silently covering
   or skipping it.
7. **Grant sets + intentHash** — contract §7 verbatim: `GrantSet` per person;
   `intentHash` = sha256 over RFC 8785 canonical `{tools (sorted), trigger,
   runBody, name}`; any change invalidates and re-asks **the delta only**,
   reusing the shipped `invalidatedGrant` + stale/current-hash audit path
   (`packages/guard/src/guard.ts`). Enable is atomic with its grant set;
   re-declaration may only add; bundles pre-filled, never blank;
   whole-registry declarations rejected. Cards say what will happen,
   completely: one line per mutating step, a mechanically-derived risk line
   the model cannot author, exact tool name + args one tap away.
8. **Effect ledger** — contract §7 `vendo_effects`, written inside the guard's
   execute path for mutating calls only; key = sha256(runId|turnId + tool +
   exact input hash); a key that already succeeded returns the recorded
   outcome instead of executing. This is what makes fail-and-re-run correct.
9. **`title` into `descriptorHash`** — `packages/core/src/descriptor-hash.ts`
   preimage gains `title`; a retitle invalidates grants like a rename. Boot
   error on duplicate tool titles per deployment (two actions must never read
   identically on a card).
10. **The one-row-per-message migration** — contract §6 verbatim:
    `vendo_thread_messages`; `vendo_threads` loses `messages`; reads
    reassemble by `seq`; per-row CAS on `revision`; ordering never derives
    from timestamps. Versioned migration (`SCHEMA_VERSION` bump — coordinate
    the single bump with the orchestrator, lane B also adds tables — + one
    `DATA_BACKFILL` step splitting existing arrays). Join `ERASE_TABLES`, the
    adoption path, and `02-store.md`'s row map. Ship the frozen helper
    surface (`threadMessageStore.upsert/list`, contract §6) — lane A's runtime
    consumes it.
11. **hosted-anon-sessions 404 fix** — tracked in
    `docs/verification/existing-agents/polish/hosted-sessions-404.md`; fix per
    that doc.

## Frozen shapes you consume

Contract §1.1 `ToolResult`/`DeniedNeeds` (incl. `unattended-destructive`) ·
§4 · §6 · §7 — all verbatim. Core `ToolOutcome` unchanged. Lane C's `Check`/
`Finding` core types (judgment rules feed your reviewer rubric). Lane A's
`Harness`/`Turn` core types (your reviewer spawns through them).

## Acceptance (plan §6)

- **E2 (screenshots, real browser, Yousef's Cloud account)**: (a) read-only
  app → zero cards, skeleton renders · (b) writing app → one pre-filled card,
  one tap, then silence · (c) interactive destructive → popup with real amount
  + recipient; approve executes, refuse gets an honest message · (d)
  automation enable → one card · (e) **automation attempting a destructive
  tool → refused, prepare-then-send offered** · (f) missing grant unattended →
  failure card on the app surface with badge; grant → re-run succeeds · (g)
  edit declared tools → re-ask covers only the delta.
- **E4, reviewer slice**: bad app → review catches it, flagged-version
  protocol runs, owner-override works.
- **E7**: re-run never repeats a completed mutation · retitled tool
  invalidates grants · edited app invalidates its grant set · audit ⊇
  transcript for every run.
- Migration: backfill proven on a real database with existing threads; erase +
  adoption conformance green; transcript writes O(messages), measured.
- Monorepo green.

## Out of scope

Conditions on grants · scope constraints · org-admin policy (wave 3) ·
sponsorship mechanics (wave 3) · the checks-floor extraction (lane C) · the
runtime/mirroring (lane A) · workspace tables (lane B) · everything in
contract §8.

## Files you own

- `packages/guard/src/**` (grant sets, intentHash, effect ledger)
- `packages/core/src/descriptor-hash.ts`, `packages/core/src/model-seats.ts` (new)
- `packages/vendo/src/models-config.ts`
- `packages/agent/src/tools.ts`, `tool-search.ts`, `prompt.ts` (find_tools +
  verbs; coordinate with lane A's `agent.ts` lift — different files, same
  package)
- `packages/apps/src/checking/reviewer.ts` + the new review-on-commit hook
- `packages/store/src/helpers/threads.ts` + the new
  `helpers/thread-messages.ts`
- **Shared, append-only, orchestrator merges at land:**
  `packages/core/src/index.ts`, `packages/store/src/schema.ts`, `erase.ts`,
  `helpers/subjects.ts`, `packages/vendo/src/server.ts`.

## Discipline

One worktree, this lane only. Seam questions → orchestrator. Report the moment
you finish. Local decisions not covered above: make them, note every one in
your lane report. Never claim done without the acceptance evidence.
