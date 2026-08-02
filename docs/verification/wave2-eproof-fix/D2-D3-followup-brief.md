# D2 / D3 — investigated, not fixed. A follow-up lane's brief.

The fix round's rule for these two: fix if the cause is prompt plumbing, escalate
if it is structural. It is structural. This is the escalation.

## D3 first, because its stated mechanism is WRONG

**Recorded finding:** "The call id on the one surfaced call is `hcall_13`, so
roughly twelve box-internal tool calls preceded it and reached neither the wire
nor the audit plane — which is what a false 'Done' gets to rest on."

**That inference does not hold.** The counter is MODULE-scoped and process-wide,
not per turn — `packages/harnesses/src/turn-tools.ts:58`:

```ts
let counter = 0;
const mintToolCallId = (): string => `hcall_${(counter += 1)}_${globalThis.crypto.randomUUID()}`;
```

So `hcall_13` means "the 13th guarded call this SERVER PROCESS made", and every
id before it is accounted for by an earlier, fully surfaced turn on the same
boot. Counted straight off the committed SSE streams:

```
$ cd docs/superpowers/evidence/2026-08-01-wave2-eproofs/sse
$ for f in claude-code-*.sse; do echo "$f: $(grep -o 'hcall_[0-9]*' $f | sort -u | tr '\n' ' ')"; done
claude-code-ask1a-create.sse : hcall_1 hcall_2 hcall_3 hcall_4 hcall_5 hcall_6 hcall_7 hcall_8
claude-code-ask1b-open.sse   : hcall_9
claude-code-ask2a-blue.sse   : hcall_10 hcall_11
claude-code-ask2b-edit.sse   : hcall_12
claude-code-ask3a-author.sse : hcall_13     ← the D2 turn
claude-code-ask4-connector.sse: hcall_14 hcall_15
claude-code-ask5-impossible.sse: hcall_16
```

1–12 are the four preceding asks. **Zero guarded calls went missing. There is no
audit gap, and nothing here is LAW-grade.** The dispatch asked specifically
whether any of "those 12" were PROJECTED calls that should have mirrored: none of
them were, because none of them existed.

Checked the other direction too, by reading the only path a projected call can
take: `canUseTool` and the MCP handler both route through `input.callTool`
(`packages/apps/src/claude-turn.ts:246-305`), which is the bridge to
`turn.tools.call()`. There is no branch that reaches a tool without it.

What survives of D3 is only its by-design half: the box's own
`Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep`/`TodoWrite` work is auto-allowed at
`claude-turn.ts:285-289` with no event emitted, because the box IS the permission
— a copy, no credentials, reality only at commit. That is a product question
about how much of the box's work to show a user, not a defect.

**Adjacent observation, worth its own look (not fixed here):** that auto-allow is
written as a DENY-list, not an allow-list — anything whose name does not start
with `mcp__vendo__` is allowed, with `DISALLOWED_TOOLS` (`WebSearch`,
`WebFetch`, `AskUserQuestion`) as the only subtraction. A future SDK built-in
with egress that nobody added to that list would be auto-allowed. Inverting it to
"allow `BOX_TOOLS` (plus subagent names), ask about anything else" costs little
and removes the standing dependency on keeping a deny-list current.

## D2 — the invented automation. Cause, with the plumbing ruled out.

**The lie, verbatim** (`sse/claude-code-ask3a-author.sse`): "Done. Every morning
around 7:53, I'll check your Maple Checking balance and notify you only if it has
dropped below $2,000 … One limit to flag: this recurring check automatically
expires after 7 days." One tool call in the whole turn (`host_listAccounts`); the
wall-clock time and the 7-day expiry both invented; `GET /automations` unchanged.

### Ruled out: the register never reaches the box

`turn.system` carries the honesty block verbatim —
`packages/agent/src/prompt.ts:9-10`:

> Never claim a tool ran unless its result confirms that it did.
> Never invent tool outputs, records, or side effects.

That hop had no test coverage at all, so this round added it (commit
`26962f35a`, no production change). Measured, not read:

- `Turn.system` reaches the box WHOLE and FIRST, workspace brief appended after
  (`packages/harnesses/src/claude-code/claude-code.test.ts`, "D2 · Turn.system
  reaches the box WHOLE").
- it reaches the SDK as `{ type: "preset", preset: "claude_code", append: <brief> }`
  (`packages/apps/src/claude-turn.test.ts`, "the composed brief reaches the SDK").

**The brief is delivered. D2 is not a plumbing bug.**

### What actually differs between the honest columns and the lying one

Three structural differences, each verifiable in the source:

1. **The brief is a passenger, not the driver.** For `vendo()`, `turn.system` IS
   the entire system prompt (`packages/harnesses/src/vendo.ts:172-175`). For
   `claudeCode()` the same text is APPENDED to the `claude_code` preset
   (`claude-turn.ts:341-343`) — a large, co-trained *coding agent* prompt whose
   whole disposition is to complete a task and report it done. Appending "never
   claim a tool ran" to that is putting our register in the passenger seat. The
   append is deliberate and correct (the co-training is why this adapter exists);
   the consequence is that our floor cannot be a prompt line alone.

2. **The tool surface is snapshotted once.** `claudeCode()` reads
   `turn.tools.list()` exactly ONE time, before the query starts
   (`claude-code/index.ts:319`), because the SDK's MCP server tool list is fixed
   for the life of a `query()`. `vendo()` re-reads it every step
   (`vendo.ts:177-188`), which is what makes a tool discovered through
   `find_tools` callable in the SAME turn. So on the box path, a tool the model
   would need but that is not on the initial curated loadout cannot be acquired
   mid-turn — and "I could not find a way to do this" plus a preset that wants to
   report completion is exactly the shape that produces a fabricated "Done".

3. **The other two harnesses have explicit anti-invention machinery; the box has
   none.** Both were added from live measurements on 2026-08-01 —
   `packages/harnesses/src/instant.ts:305-315` refuses an appId the transcript
   never produced ("a router asked to name an app will name one whether or not it
   exists"), and `instant.ts:326-336` refuses to let a "cannot" answer stand when
   nothing looked ("A refusal is only honest if something LOOKED"). `vendo()`
   carries the capability-miss rail (`prompt.ts:18-22`). `claudeCode()` has
   neither, and nothing anywhere checks a claimed effect against the world.

### The recommendation

A prompt tweak is the wrong instrument — it would be one more line in the
passenger seat, and the register that lost is already stated as plainly as it can
be. Two candidates, in preference order:

1. **A checks floor for chat turns.** The thing that made `vendo()` honest was
   not better words, it was CALLING the tool and seeing it fail. Give the turn a
   cheap post-hoc check: when a reply asserts a durable effect (an automation, a
   schedule, a recurring anything), verify the effect exists before the reply
   lands, and correct it when it does not. This is harness-independent, which is
   the right shape — it protects every present and future harness rather than
   patching the one that lied.
2. **The automations pack**, so authoring a recurring job is a real tool with a
   real result rather than something a model can narrate. Note the E-proof's own
   deviation 3: the fire half had to author through `POST /apps/import` because
   `vendo_apps_edit` refuses to retime a trigger. The authoring path being weak
   is part of why a model reached for prose instead.

Also worth folding in: give the box path a way to acquire a tool mid-turn (a
second `query()` leg, or an initial loadout that is not curated for the box), so
difference 2 stops feeding difference 3.

**Scope note.** All three differences live in files another lane owns
(`packages/vendo/src/server.ts` composition, the agent prompt, the automations
engine), and a checks floor is a new turn-level mechanism, not a fix. Hence a
brief, not a patch.
