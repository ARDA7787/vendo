---
name: gotcha-generated-vendo-artifacts
description: Editing apps/*/.vendo/tools.json never holds (vendo sync regenerates it on predev/prebuild) and docs/verification/**/*.png is gitignored
metadata:
  type: project
---

Two flowlet artifacts fight hand edits, and both cost a wasted commit if you
assume otherwise.

**`apps/<demo>/.vendo/tools.json` is generated, not authored.** demo-bank's
`predev` AND `prebuild` both run `vendo sync . --no-watermark`, so any tool you
delete by hand reappears on the next `pnpm dev` or root `pnpm build`. To keep a
tool out of the agent's reach, add `{"disabled": true, "description": "<why>"}`
under its name in the sibling `.vendo/overrides.json` — the treatment the two
Auth.js endpoints already get. The live filter is
`packages/actions/src/runtime/registry.ts:839` on the *effective* descriptor
(override merged at `:262`).

**Verification screenshots are gitignored.** `.gitignore` has
`docs/verification/**/*.png` (and `/PARKED.md`), so browser evidence lives on
disk only — cite absolute paths in the lane report, never assume a reviewer can
`git show` them.

**Why:** a `git add` of tools.json between an edit and a build silently captured
the regenerated copy, so a commit whose message claimed a removal did not make
one. Only reading the committed blob back (`git show HEAD:<path>`) caught it.

**How to apply:** never treat these files as source. Verify a claimed change with
`git show HEAD:<path>` rather than the working tree, and reach for
`overrides.json` when the goal is "this tool must not be live".

Related: [[gotcha-stale-dist-phantom-results]]
