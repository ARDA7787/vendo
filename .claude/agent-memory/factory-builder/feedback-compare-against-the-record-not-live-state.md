---
name: feedback-compare-against-the-record-not-live-state
description: A guard that compares against "the previous live value" is vacuous whenever that value is cleared between uses — compare against the persisted record
metadata:
  type: feedback
---

A validity check written as "does the new value differ from the currently-live
one?" silently does nothing if the live slot is emptied between uses. Compare
against the **persisted record** instead.

**Why:** door-ctx's turn-credential registry burned a conversation's credentials
when its thread was seen carrying a different principal — by comparing the
incoming turn's subject against `live.get(threadId)`. But `live` is cleared at
every turn end, so an intruder's turn that came and went with no call arriving
found `previous === undefined`, burned nothing, and the credential came back to
life on the rightful subject's next turn. A privilege escalation that only a
negative test with **no intervening successful use** could see. Fixed by
comparing against what was MINTED (`minted.values()`), which outlives turns.

**How to apply:** when writing a "has this changed hands / been tampered with"
check, ask what clears the thing you are comparing against and whether an
attacker controls the gap. Then write the negative with the successful path
REMOVED — my first version of the test passed against the broken code because a
`resolve()` in the middle happened to catch it via a second, redundant check.
Related: [[feedback-test-doubles-must-match-runtime-shape]] (a green you cannot
name is a red you have not found).
