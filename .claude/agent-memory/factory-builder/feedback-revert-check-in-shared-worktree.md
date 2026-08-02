---
name: feedback-revert-check-in-shared-worktree
description: Never do a revert-check by copying a whole file to /tmp and restoring it when another agent shares the worktree — edit and un-edit the exact lines instead
metadata:
  type: feedback
---

To prove a regression test has teeth, change ONLY the target lines (a scripted
`str.replace` both ways), never `cp file /tmp/bak` → run → `cp back`.

**Why:** wave-3 ran two fix agents in one worktree (`rebase/wave3-stage`). A
whole-file restore silently reverts any edit the sibling agent landed in that
file between the copy and the restore — an invisible loss of their work, with no
conflict and nothing in `git status` to show what went missing. I did four
revert-checks on `packages/vendo/src/server.ts` this way and only got away with
it because the other agent happened not to be in that file.

**How to apply:** in a shared worktree, revert-check with a targeted edit +
targeted undo, and `git diff <file>` afterwards to confirm the working tree holds
exactly your own hunks and nothing else. Same rule as
[[feedback-git-stash-is-repo-wide]] — anything repo- or file-wide is not yours to
roll back.

**And assert the revert actually happened, positively.** 2026-08-02: a
`perl -0pi -e 's/, ctx\.principal\)\)/))/'` never matched (the real text ended
`) });`), and the check I used to confirm it — `grep -c 'ctx.principal))'` → `0` —
was reading a pattern that had never existed in the file. The test then "passed"
and I nearly recorded a red-green that never ran. Verify the substitution by
grepping for the string that must now be ABSENT *and* seeing the count fall from
a known non-zero, or diff against the pre-edit copy. A revert-check whose revert
silently no-ops is worse than none: it manufactures false evidence.
