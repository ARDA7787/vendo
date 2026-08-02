---
name: gotcha-piped-test-exit-code-lies
description: pnpm test piped into grep/tail reports tail's exit code (always 0) — an aborted 40-of-53 run looked green
metadata:
  type: project
---

`pnpm test --force --concurrency=1 | grep -E "..." | tail -40` returns the exit code
of **`tail`**, which is always 0. A run that failed — or that you killed halfway —
reports success.

Measured 2026-08-02: a background run got `pkill`ed mid-suite, finished at
`Tasks: 40 successful, 53 total`, and its task notification said **"completed (exit
code 0)"**. It would have been cited as one of the two required green full-suite runs.

Two further traps in the same shape:
- A piped run buffers, so the output file stays EMPTY until the very end. You cannot
  watch progress, and "0 lines" does not mean "nothing happened".
- `set -o pipefail` is not on by default in these shells.

**How to apply:** redirect to a file instead of piping —
`pnpm test --force --concurrency=1 > /tmp/run.txt 2>&1` — then read
`grep -E "^ Tasks:" /tmp/run.txt`. Confirm the tally says `N successful, N total` with
N equal on both sides. This is the concrete form of the contract's standing rule:
**read the TALLY, never the exit line.** Related:
[[gotcha-concurrent-vitest-breaks-e2e-fixtures]].
