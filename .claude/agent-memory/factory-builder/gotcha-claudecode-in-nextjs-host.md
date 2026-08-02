---
name: gotcha-claudecode-in-nextjs-host
description: Putting harness claudeCode() in a Next.js host (demo-bank) needs an uncommittable rig patch — Turbopack refuses dynamic loads and the SDK can't resolve from @vendoai/apps
metadata:
  type: project
---

`harness: claudeCode()` cannot currently be added to a Next.js host such as
`apps/demo-bank` in a committable way. Both escape routes are closed:

- **Dynamic load** — `createRequire(import.meta.url)(specifier)` with any
  computed specifier fails Turbopack at boot with `Cannot find module as
  expression is too dynamic`, and `/* turbopackIgnore: true */` is NOT honored
  on `require` (only on `import()`).
- **Static import** — `import { claudeCode } from "@vendoai/harnesses/claude-code"`
  pulls `@anthropic-ai/claude-agent-sdk` into the host's build graph, where it
  cannot resolve: `packages/apps/src/claude-turn.ts` imports that SDK
  (`SDK_PACKAGE`, lines 37 and 328) but `packages/apps/package.json` declares it
  neither as a dependency nor as an optional peer. Only `@vendoai/harnesses`
  (optional peer) and `@vendoai/engine` (dependency) declare it.

**How to apply:** to drive `claudeCode()` through a Next host locally, symlink
`@vendoai/harnesses` into the host's `node_modules/@vendoai/` and the SDK's real
`.pnpm` directory into BOTH the host's and `packages/apps/node_modules/@anthropic-ai/`
(a symlink-to-a-symlink is not enough — Turbopack needs the direct path), use a
static import, and revert the host source before committing. Until
`packages/apps` declares the SDK, any committed static import breaks the
deployed demo's build.
