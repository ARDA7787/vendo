# Memory Index

## Standing rules
- [git stash is repo-wide](feedback-git-stash-is-repo-wide.md) — never stash in a lane worktree; the stack is shared and pop can steal a sibling lane's work

## Project context & gotchas
- [Worktree path with a space fails 7 tests](env-worktree-path-space-red.md) — pre-existing red in store/core/vendo from undecoded `%20`; never a lane's bug
- [THE LAW catches pre-existing tests](project-the-law-catches-pre-existing-tests.md) — §12 turns old green tests red; fix the expectation, never the law
- [Stale dist = phantom test results](gotcha-stale-dist-phantom-results.md) — always `pnpm build` before a scoped test in flowlet
- [grep goes silent on claude-turn.ts](gotcha-grep-binary-claude-turn.md) — a raw NUL byte makes it "binary"; use `grep -a` before concluding a symbol is absent
- [UI chrome exports are a pinned registry](gotcha-ui-chrome-export-registry.md) — a new chrome export reds export-surface.test.ts until it is listed there
- [Root PARKED.md is gitignored](gotcha-root-parked-md-gitignored.md) — park records that are standing evidence go in docs/verification/&lt;lane&gt;/, never the repo root
- [Generated .vendo artifacts fight hand edits](gotcha-generated-vendo-artifacts.md) — `vendo sync` rewrites tools.json on predev/prebuild; verification PNGs are gitignored
- [Maple §12 gaps (open)](project-maple-law-gaps.md) — `host_createOrder` money tool labelled `write`, narration promises unattended emails, chip seed claims `presence: present`
- [Architecture claims vs code](project-architecture-claims-unimplemented.md) — §7 FAIL half now refuses the write; flagged version + override + card still ABSENT; grep before trusting the spec
- [What the reviewer blocks](project-reviewer-block-severity.md) — 4 block categories; "quietly dropped work" is judgment-shaped and now costs the person their app (open product call)
- [store/index.ts exports must mirror postgres.ts](gotcha-store-postgres-export-mirror.md) — a surface test fails far from the file you changed
- [e2b template + env gotchas](gotcha-e2b-template-and-env.md) — copy() resolves from the script dir; create({envs}) never reaches the start command
- [nohup dev servers get reaped](gotcha-nohup-dev-server-reaped.md) — start long-lived servers with run_in_background:true, or they die mid-proof with no crash log
- [claudeCode() in demo-bank needs a rig patch](gotcha-claudecode-in-nextjs-host.md) — Turbopack refuses every dynamic form and the static import can't resolve the SDK from @vendoai/apps
