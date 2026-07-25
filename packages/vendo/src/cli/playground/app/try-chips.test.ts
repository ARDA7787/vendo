import { describe, expect, it } from "vitest";
import { pressChip } from "./try-chips.js";

// The chips are live focusable buttons (never disabled — that would drop
// keyboard focus), so pressChip's idempotence IS the double-send guard.
describe("pressChip", () => {
  const dash = { label: "Dashboard", prompt: "Show me a dashboard of my recent activity" };
  const summary = { label: "Summary", prompt: "Give me a summary of my account" };

  it("first press activates the chip at seq 1", () => {
    expect(pressChip(null, dash)).toEqual({ chip: dash, seq: 1 });
  });

  it("re-pressing the active chip returns the SAME state — no seq bump, no remount, no re-send", () => {
    const current = pressChip(null, dash);
    expect(pressChip(current, dash)).toBe(current);
  });

  it("a different chip bumps the sequence, so A→B→A remounts (and re-sends) each time", () => {
    const a = pressChip(null, dash);
    const b = pressChip(a, summary);
    const back = pressChip(b, dash);
    expect(b).toEqual({ chip: summary, seq: 2 });
    expect(back).toEqual({ chip: dash, seq: 3 });
  });
});
