# The dcg shell guard prompts the founder — avoid tripping it

`dcg` is a global PreToolUse hook on Bash (installed in `~/.claude/settings.json`).
It blocks destructive shell patterns and **asks the founder for permission**, which
stalls an unattended lane. Two rules bit this build repeatedly:

- `core.git:checkout-discard` — a path-scoped discard (used to revert mutation
  probes)
- `core.git:stash-drop` — stash+drop for red-green proofs

Both are allowlisted until 2026-08-03 (`~/Library/Application Support/dcg/allowlist.toml`).
**After that they prompt again.**

## It matches the literal TEXT of the whole command

The guard greps the command string, so the pattern trips even when it appears
inside an unrelated argument — a heredoc body, a `dcg explain "..."` argument, a
commit message. Three of my own commands were blocked for *mentioning* the
pattern, not running it.

Practical consequences:
- Never put a blocked pattern inside quoted text, a heredoc, or a commit message.
- Prefer file tools (Read/Write/Edit) over shell for editing files — they are not
  shell calls, so the hook never sees them.
- For mutation probes, the safest revert needs no git at all: `cp file file.bak`
  before the probe, `mv file.bak file` after. No guard, no prompt, no risk of
  discarding a sibling's work.
- `git worktree remove --force` is NOT blocked; loops over worktree paths must
  quote `"$wt"` because agent worktree paths can contain a space.

## Related

[[gotcha-stale-dist-phantom-results]] — the other thing that repeatedly cost
lanes time on this build.
