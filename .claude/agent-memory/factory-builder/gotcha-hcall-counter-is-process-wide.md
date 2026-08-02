---
name: gotcha-hcall-counter-is-process-wide
description: hcall_N ids are a process-wide counter, not per-turn — never infer "N-1 hidden tool calls" from a high id
metadata:
  type: project
---

`hcall_<N>_<uuid>` ids come from a MODULE-scoped counter
(`packages/harnesses/src/turn-tools.ts:58`), so N counts every guarded call the
SERVER PROCESS has made across all turns and all threads.

**Why:** wave-2 finding D3 claimed that a surfaced call with id `hcall_13` meant
"roughly twelve box-internal tool calls preceded it and reached neither the wire
nor the audit plane" — presented as the mechanism that let a fabricated "Done"
hide. It was wrong: ids 1-12 were the four earlier, fully surfaced turns on the
same dev-server boot. A whole finding's mechanism rested on the misreading.

**How to apply:** to test a "hidden calls" hypothesis, count ids across ALL the
turns of that server boot, not within one:

```
for f in claude-code-*.sse; do echo "$f: $(grep -o 'hcall_[0-9]*' $f | sort -u | tr '\n' ' ')"; done
```

If the ids form a contiguous run across the recorded turns, nothing is hidden.
Separately: box-native tools (Bash/Read/Write/Edit/Glob/Grep/TodoWrite) never get
an hcall id at all — they are auto-allowed in `claude-turn.ts` with no event, by
design — so a high id can never be evidence about them either way.
