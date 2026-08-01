---
name: gotcha-root-parked-md-gitignored
description: A lane's /PARKED.md at the repo root is gitignored, so park records written there vanish — put standing acceptance evidence under docs/verification/<lane>/
metadata:
  type: project
---

`.gitignore` root-anchors `/PARKED.md`, `/LANE-REPORT.md`, `/progress.md`,
`/log.md` and `/HANDOFF*.md`. A lane that parks a criterion by writing
`PARKED.md` in its worktree root produces evidence that exists on one machine
only, and any tracked file referencing it becomes a dangling pointer.

**Why:** four such scratch files had already leaked onto `main`, so the ignore
rules were added deliberately — the intent is that lane *scratch* is private,
not that a parked acceptance criterion is. The ignore is root-anchored on
purpose precisely so `docs/` may carry a file of the same name.

**How to apply:** when a park record is the standing evidence for a criterion
that a ruling ACCEPTS as missed (rather than throwaway working notes), write it
to `docs/verification/<lane>/PARKED.md` and confirm with
`git check-ignore -v <path>` (exit 1 = not ignored) before claiming it is
recorded. Working notes can stay at the root. Verified 2026-08-01 on wave-2
lane F, where an independent verifier raised it as a MAJOR finding.
