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

**You can also CREATE this trap yourself.** 2026-08-02: writing `"ma ple"` in an
Edit `new_string` landed a raw NUL in `packages/vendo/src/org-policy.test.ts`.
Every later `Edit` on that region failed with "String to replace not found" (the
NUL never round-trips through the tool's matcher), and `grep` went silent on the
whole file. The tell is `file <path>` printing `data` instead of
`… text`. Fix it out of band:

```
python3 -c "b=open(P,'rb').read(); open(P,'wb').write(b.replace(b'\x00', b'…'))"
```

Write control bytes as escapes (the two characters backslash-zero), never as literal bytes, and run
`file` on any source file whose Edit mysteriously stops matching.

Related: [[gotcha-stale-dist-phantom-results]] — the sibling trap where `dist`
has the symbol and `src` appears not to. Both look like "this capability does not
exist"; neither is true.
