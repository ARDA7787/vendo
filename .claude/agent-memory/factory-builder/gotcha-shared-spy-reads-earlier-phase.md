---
name: gotcha-shared-spy-reads-earlier-phase
description: A console/log spy installed once for a multi-phase test case passes on the earlier phase's calls — clear it before each phase or the assertion proves nothing
metadata:
  type: feedback
---

In a test case with lettered phases (a)/(b)/(c) sharing one `vi.spyOn(console, …)`,
an assertion in a later phase reads calls ACCUMULATED from the earlier ones. Add
`vi.mocked(console.warn).mockClear()` immediately before the phase under test.

**Why:** found twice in this repo (2026-08-02 in `packages/vendo/src/server.test.ts`
phase (c), and earlier elsewhere in the same wave). Both phases hit the SAME
`console.warn` call site, so the assertion passed even when the later phase could
not reach it at all. Demonstrated by pointing (c) at an id that logs nothing: the
case still PASSED without the clear and FAILED with it.

**How to apply:** whenever a test spies on a logger/emitter and asserts on it more
than once, or asserts once after other work has already run through the spy, clear
between phases. To red-check the fix, do not silence the shared call site (that
kills every phase equally) — instead make only the phase under test stop reaching
it. Same family as the vacuous-assertion sweep this wave ran; see
[[project-the-law-catches-pre-existing-tests]] for the other shape of "green test,
no evidence".
