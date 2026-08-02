---
name: gotcha-agent-sdk-live-session-traps
description: Three Agent SDK traps when holding one query() open per conversation — doubled text, sinks captured at open, and skills:"all" leaking the operator's own skills
metadata:
  type: project
---

Holding ONE `query()` open for a whole conversation (streaming-input `prompt`,
`send()` settling on each `result`) has three traps. All three were found by LIVE
proofs and were invisible to unit tests that drove a single turn.

**1. `includePartialMessages: true` doubles all text.** You then receive BOTH the
`stream_event` token deltas AND the finished `assistant` block for the same prose.
The user sees every sentence twice. Fix: track whether deltas arrived for the message
being assembled; if so, skip the block's text — but still take the block's `uuid` for
the rewind ledger, and still fall back to the block when nothing streamed.

**2. A session outlives the turn that opened it, so never capture that turn's
closures.** Passing turn 1's `emit`/`callTool` into `createClaudeSession` sent every
LATER turn's text to a queue nobody was draining — the user's second message came back
completely EMPTY. Route through a mutable "turn in flight" indirection instead, and
clear it in a `finally` so nothing between turns is misattributed.

**3. `skills: "all"` enables every DISCOVERED skill, including the machine's own.**
On a host running `machine: "local"` that pulled in the operator's `~/.claude/skills`
(observed: `deep-research`, `dataviz`, `claude-api`) alongside the product's. Pass the
skill names explicitly. Verified empirically: with a named list, the product's skill
works and an unlisted operator skill returns FAILED. Note `system/init`'s `skills`
field reports the DISCOVERED set either way — it is not evidence of what is enabled.

**Also true (verified against typings + a live run, contradicting the docs):**
`settingSources: []` disables FILESYSTEM settings discovery only. Programmatic
`plugins: [{ type: "local", path, skipMcpDiscovery: true }]` still loads, so native
skills and multi-tenant isolation coexist. A plugin root must contain
`skills/<name>/SKILL.md` — which is exactly what Vendo's `/host` mount already writes,
so the mount IS the plugin (no copy, no translation).

**How to apply:** when changing the claudeCode() session loop, drive at least TWO
turns in a live proof. A one-turn test passes through all three of these.
