---
name: gotcha-grep-binary-claude-turn
description: packages/apps/src/claude-turn.ts holds a raw NUL byte, so plain grep treats it as binary and silently reports zero matches
metadata:
  type: project
---

`packages/apps/src/claude-turn.ts` contains a literal NUL byte inside a template
literal (line ~244, the `slot()` cache key separator: `` `${name}\0${JSON…}` ``
written as a raw byte, not `\0`). `file` reports the file as `data`, and **plain
`grep` prints nothing for it** — no matches, no "binary file matches" note when
piped. Searching it for a type or symbol looks like the symbol does not exist.

**Why:** grep suppresses output for files it classifies as binary. One control
byte in a 403-line TypeScript file is enough.

**How to apply:** if a grep over `packages/apps/src` comes back empty for a
symbol you have other evidence exists (e.g. `internal.ts` re-exports it), re-run
with `grep -a` before concluding anything. `grep -a -n "Symbol" <file>` works
normally. `Read` also works fine — it renders the NUL as a space.

Related: [[gotcha-stale-dist-phantom-results]] — the sibling trap where `dist`
has the symbol and `src` appears not to. Both look like "this capability does not
exist"; neither is true.
