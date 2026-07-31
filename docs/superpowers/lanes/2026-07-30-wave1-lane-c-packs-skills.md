# Lane C — packs + skills (wave 1)

**Read first, in order:**
1. `docs/superpowers/specs/2026-07-30-embedded-agent-architecture-design.md` — §5 (packs), §6 (the apps pack), §7 (checks — the floor, NOT the reviewer), §3 (consumer voice law — every skill you author carries the register)
2. `docs/superpowers/specs/2026-07-30-build-contract.md` — §5 (FROZEN — Pack, Check, Finding), §2 (layering: contract types in core), §3.1 (skill paths)
3. This file.

**The one rule:** we own state, tools, checks, guard, skills; the harness owns
thinking. Skills teach, checks enforce: a skill is a job description the
harness executes with its own staff; if the harness ignores it, the checks
floor holds anyway. Delegation advice is a sentence in a skill body, never
pack machinery. If a shape seems wrong, ask the orchestrator; never diverge.

## Mission

Make packs the only way capability arrives: four slots (tools, skills, checks,
components) contributing to registries that already exist — and prove it by
re-expressing `apps()` and `automations()` on the same public interface a
third party would use.

## Build list

1. **Core types** — new file `packages/core/src/pack.ts`, type-only: `Pack`,
   `PackSkill`, `Check` (tagged `kind: "fact" | "judgment"`), `Finding`,
   `CheckInput` — exactly as contract §5. Note the deliberate re-typing from
   the shipped `packages/apps/src/checking/types.ts`: `app: GeneratedAppDocument`
   becomes `document: AppDocument` (core), `where` becomes optional, `kind` is
   added (existing in-repo checks default `"fact"`). Adapt the shipped checks;
   don't fork the type.
2. **`definePack` + boot merge** — tools → the one registry (guarded,
   projected — the registry itself is existing machinery); skills → the skills
   store; checks → the floor; components → today's catalog vocabulary
   unchanged (`packages/core/src/catalog.ts`: `{ component, description,
   props?, examples?, remixable? }` — server ignores `component`, client
   mounts it). **No renaming, ever**: names global as authored; collision =
   boot error naming both packs. Pack modules are imported twice (server +
   client) and must be import-safe on the server.
   Do not shadow `@vendoai/agent`'s existing `buildVendoToolPack` /
   `VendoPackTool` exports (the BYO tool pack — a different thing).
3. **Skills store + projection** — skills land at
   `/host/skills/<name>/SKILL.md` (lane B's ro mount; code against the core
   `WorkspaceFs` type, use just-bash's in-memory fs in tests). On-disk format =
   agentskills.io SKILL.md; projection per harness is a **copy, never a
   translation**. Implement `TurnSkills` (contract §1.2): `list()` ~30 tokens
   per skill, `load(name)` full body on demand.
4. **`apps()` and `automations()` as packs** — re-expressed on the public
   `definePack` interface, no privileged internal API, with the one carve-out:
   triggers and scheduling are platform lifecycle (core runtime), not pack
   content. This is a mechanical re-expression of what ships today — NOT the
   parked automations-pack redesign.
5. **The checks floor extracted** — lift the checking layer
   (`packages/apps/src/checking/`: `layer.ts`, `facts.ts`) from
   generation-internal to host-pluggable per contract §5: judgment rules join
   the reviewer rubric as separate lines (never concatenated); a check that
   throws yields one `warn` and never blocks a build; findings
   order-independent. (The reviewer itself, review-on-commit, and the failure
   protocol are lane D — you own the floor and the plug, not the reviewer.)
6. **The building-apps skill** — authored from today's prompt sections
   (`packages/agent/src/prompt.ts` + the generation prompts): the v2 pattern —
   plan file (plan format = render format), blinkered fill groups, validate →
   fix → the one ask_user door, edit-like-a-file — written in the consumer
   voice register, carrying the delegation advice ("run me in a fresh
   subagent") in its body. The skill explicitly teaches **write early, write
   per group**: the screen renders on every parsing save of the hot-path files
   (contract §1.6), so a builder that writes the plan file first and the app
   file per group gives the user the growing-app experience; one big write at
   the end is legal but worse.

## Frozen shapes you consume

- Contract §5 whole (Pack, Check, Finding, components vocabulary).
- Contract §3.1 skill paths; `WorkspaceFs` core type (lane B).
- Contract §1.2 `TurnSkills` (lane A owns the Turn; you provide the skills
  implementation behind it — agree the seam file with the orchestrator).
- Design §5 laws: four slots only, no config surface, no guard wrapping, no
  reaching into other packs, isomorphic passed-twice.

## Acceptance (plan §6)

- **E5**: a pack authored *outside* our repo (tools + skill + fact check +
  judgment rule + component) installs with one config line and works end to
  end — tool guarded, skill loads on demand, checks fire, component renders.
  Two packs claiming one tool name → boot error naming both. Proven live, not
  just in tests.
- **E4, floor slice**: a deliberately bad app → `validate` + the extracted
  floor catch it; a host check fires even when the builder skipped self-review.
  (The flagged-version protocol and owner-override are lane D's half.)
- Monorepo green.

## Out of scope

`vendo pack export` (downward compilation) · triggers-as-pack-content · the
reviewer, review-on-commit hook, failure protocol, `models.reviewer` (lane D) ·
the automations-pack redesign (parked brainstorm) · rendering/launcher work
(display design pass, separate session) · everything in contract §8.

## Files you own

- `packages/core/src/pack.ts` (new)
- `packages/apps/src/checking/layer.ts`, `facts.ts`, `types.ts` (the floor
  extraction — NOT `reviewer.ts`, lane D owns it)
- The pack-merge module (new — e.g. `packages/vendo/src/packs.ts`) + skills
  store module (placement per layering; ask if unsure)
- The building-apps SKILL.md content
- **Shared, append-only, orchestrator merges at land:**
  `packages/core/src/index.ts`, `packages/vendo/src/server.ts` (one composition
  call), `packages/apps/src/index.ts`.

## Discipline

One worktree, this lane only. Seam questions → orchestrator. Report the moment
you finish. Local decisions not covered above: make them, note every one in
your lane report. Never claim done without the acceptance evidence.
