---
name: feedback-test-doubles-must-match-runtime-shape
description: A turn double that hands one message per turn hides truncation logic — check whether a green test is green for a nameable reason before trusting it
metadata:
  type: feedback
---

When a test passes, be able to NAME why. If you cannot, it is not evidence.

**Why:** 2026-08-02, two live proofs in `packages/harnesses/src/claude-code/*.live.test.ts`
were green for the wrong reason. Their `harnessed()` double built
`messages: [userMessage(thread, say)]` — ONE message per turn. Production
`Turn.messages` is the accumulated transcript (`thread.messages` read back from
`vendo_thread_messages` with the new message upserted, `packages/vendo/src/harness-turn.ts`).
So "turn 2" looked like a history that had not grown.

The box-session proof had been passing only because the live SDK session persisted
regardless of the resume plumbing being wired at all. When new truncation logic
(`truncated()`) started reading a non-growing transcript as a regenerate, the test
failed — and the LAW was right while the DOUBLE was wrong. The sibling local proof
was still green, for a reason I could not name (possibly SDK project-dir
auto-continue, possibly a memory file the agent had written). That is the same
failure wearing a passing badge.

**How to apply:**
- Before "fixing" a law because a test failed, check whether the double models the
  runtime's real shape. Grep the production assembly point.
- After any test goes green, ask "what exactly made this pass?" A green you cannot
  explain is a red you have not found. Especially suspicious: multi-turn tests, tests
  that pass without the mechanism under test being reachable, and tests that keep
  passing when you delete the thing they name.

Related: [[gotcha-piped-test-exit-code-lies]], [[gotcha-shared-spy-reads-earlier-phase]].
