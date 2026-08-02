---
name: gotcha-typecheck-excludes-tests
description: flowlet's pnpm typecheck excludes *.test.ts, so a renamed export shows a clean typecheck and only pnpm test catches the breakage
metadata:
  type: project
---

Every package's `tsconfig.json` in flowlet sets
`exclude: ["src/**/*.test.ts", "src/**/*.test-util.ts"]`, and `typecheck` is
`tsc -p tsconfig.json --noEmit`.

So **`pnpm typecheck` never sees test files.** Rename or delete an exported symbol and
typecheck stays 43/43 green while dozens of tests fail at runtime with
`X is not a function`. `pnpm test` is the only gate that catches it.

**Why it matters:** on a refactor that renames an entry point, "typecheck passes" is
worth nothing as evidence. Measured 2026-08-02: renaming `runClaudeTurn` →
`createClaudeSession` left typecheck fully green and broke 36 tests in one package.

**How to apply:** after any export rename, run the scoped `pnpm --filter <pkg> exec
vitest run` for every package that could reference it — don't infer safety from
typecheck. `.live.test.ts` files are ALSO only env-gated at runtime (`describe.skip`
when a key is absent), so they still get collected and imported: a dangling import
there breaks collection even with no keys set.
