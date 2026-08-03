# Gate logs — the convention

Checklist 12 (conductor ruling 7 + 17b). A wave that says "all four gates green"
and leaves no artifact is unanswerable afterwards: nobody can tell which targets
actually ran and which came back `FULL TURBO` from a cache another worktree
populated. So every gate run that a round reports lands here, verbatim, with the
command line that produced it.

**The rule: forced, serial, and the `Cached:` line stays in the log.** A turbo
summary reading `Cached: 0 cached, N total` is the proof the work ran; anything
else is a cache replay and does not count as a gate.

## This wave's run (post-check round C, `redesign/postcheck-c`)

Run from the repo root, in this order, one after another:

```
pnpm build --force
pnpm test --force --concurrency=1
pnpm typecheck --force
pnpm exec turbo run lint --force
```

`pnpm exec turbo` rather than bare `turbo` — turbo is not on PATH in a
non-interactive shell. `--concurrency=1` for the test target only, because that is
the one whose failures are otherwise indistinguishable from machine contention
(sibling rounds share this laptop).

| log | target | forced | result |
| --- | --- | --- | --- |
| `build.log` | `pnpm build --force` | yes | 24 successful / 24 · `Cached: 0 cached, 24 total` · 40.3s · `EXIT=0` |
| `test.log` | `pnpm test --force --concurrency=1` | yes | 56 successful / 56 · `Cached: 0 cached, 56 total` · 12m12s · `EXIT=0` |
| `typecheck.log` | `pnpm typecheck --force` | yes | 43 successful / 43 · `Cached: 0 cached, 43 total` · 31.4s · `EXIT=0` |
| `lint.log` | `pnpm exec turbo run lint --force` | yes | 6 successful / 6 · `Cached: 0 cached, 6 total` · 5.2s · `EXIT=0` |

All four forced, nothing replayed from cache. Inside `test.log`: `@vendoai/ui`
vitest 99 files / 867 tests passed, and the browser smoke pack
(`@vendoai/ui:test:ui`) 10 passed / 1 skipped in 15.6s — the skip being the
quarantined ruling-16 assertion.

Each log opens with the UTC timestamp and the exact argv, and ends with
`EXIT=<code>` — the shell's own answer, not a claim.
