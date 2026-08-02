---
name: gotcha-warm-box-stale-clobber
description: A sandbox that is not re-materialized between turns must diff against what ITS disk holds, never a fresh store read — otherwise an out-of-band write is reverted
metadata:
  type: project
---

If a harness skips re-materializing a warm sandbox between turns (the thing that
makes turn 2 free), then the turn-end sync-back baseline **must be what that
machine's disk is known to hold**, persisted per conversation — not a fresh read of
the store.

**The failure**, measured 2026-08-02 in `packages/harnesses/src/materialize.ts`:
`checkoutWorkspace` derived its `hashes` map from the store at the start of every
turn. On a warm box the tree dated from conversation start, so a file someone else
changed in the store (another thread of the same user, an app tool, an automation, a
second harness) hash-mismatched the box's stale copy and was written BACK —
**reverting the newer state**. An out-of-band delete was **resurrected**, because the
absent path was not in the store-derived map.

**The shape of the fix:** a `TreeState { hashes, oversized }` living on the per-thread
box/local entry. `checkoutWorkspace(workspace, tree, reseed)` fills it when the
machine is about to be materialized and otherwise trusts it. Then "unchanged in the
box" means SKIP, and only what the box actually changed is written.

**How to apply:** any time you make a cache/sandbox skip a refresh for speed, ask what
the diff baseline now means. Pin it with THREE tests, not two — an out-of-band write,
an out-of-band delete, AND the machine's own edit still landing. A fix that simply
turned sync-back off would pass the first two.

Related: [[gotcha-agent-sdk-live-session-traps]].
