---
name: git-stash-is-repo-wide
description: Never use git stash in a parallel-lane worktree — the stash stack is shared across all worktrees of one repo, so pop can steal another lane's work
metadata:
  type: feedback
---

**Never use `git stash` (push/pop/apply) in a factory lane worktree.** The stash
stack is a property of the *repository*, not the worktree — every parallel lane
in `.claude/worktrees/*` shares one stack.

**Why:** during wave-1 lane D I used `git stash push` to test whether a failure
was pre-existing, and by the time I ran `git stash pop`, a sibling lane had
pushed its own stash. `stash@{0}` was then **lane A's** work, and my pop tried to
apply lane A's changes into my worktree. It conflicted on a generated file, so
git kept the entry and lane A's work survived — pure luck. A clean apply would
have silently merged another lane's uncommitted work into mine, and a successful
pop would have *dropped* their stash entirely.

**How to apply:** to test whether a test failure is pre-existing rather than
caused by your changes, use one of these instead:
- `git diff --stat <base> HEAD -- <path>` to prove your diff does not even touch
  the code under test (usually settles it immediately);
- `git show <base>:<path>` to read the old content without touching the tree;
- commit your work first, then reason from the diff — commits are per-branch and
  safe, stashes are not.

If a stash already went wrong: do NOT `git stash drop`. Resolve the conflict by
restoring the affected files from `git show HEAD:<path>`, then `git reset` to
clear the merge state, and leave every stash entry alone. Verify with
`git stash list` that the sibling's entry is still present.

Related: [[worktree-absolute-paths]]
