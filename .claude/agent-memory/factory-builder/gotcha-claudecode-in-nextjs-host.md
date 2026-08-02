---
name: gotcha-claudecode-in-nextjs-host
description: RESOLVED 2026-08-01 — claudeCode() is now committable in a Next.js host; the old "Turbopack refuses every dynamic form" diagnosis was wrong
metadata:
  type: project
---

**Status: FIXED.** `harness: claudeCode()` is committable in a Next.js host as of
2026-08-01 (`apps/demo-bank/src/vendo/proof-harness.ts`, `namedHarness()`, gated
on `MAPLE_HARNESS`). `pnpm --filter demo-bank build` is green with
`@anthropic-ai/claude-agent-sdk` absent from the app's `node_modules`.

**The old diagnosis recorded here was wrong** and is kept because it cost a
proof run. It claimed Turbopack "refuses every dynamic form" with `Cannot find
module as expression is too dynamic`. Turbopack in fact CONSTANT-FOLDS
`await import(SOME_CONST)`, resolves the specifier, and fails with a plain
`Module not found: Can't resolve '@anthropic-ai/claude-agent-sdk'` plus a full
import trace naming the chain. The trace is the useful artifact — read it rather
than guessing which form the bundler dislikes.

The real cause was reachability, not import syntax: `@vendoai/apps/internal`
re-exported the SDK-touching turn runner, and the harnesses render seam imports
`./internal` on every composed host's server path.

**How to apply:** the node_modules-symlink workaround described in the old
version of this note is obsolete — do not do it. Just set `MAPLE_HARNESS` to
`instant`, `claude-code`, or `claude-code-local`. For the underlying rule, see
[[gotcha-subpath-graph-drags-optional-peer]].
