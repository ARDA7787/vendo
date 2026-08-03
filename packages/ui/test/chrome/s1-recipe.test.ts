/** S1 recipe (spec §11) + build calm (spec §8) asserted on the emitted sheet
    string — the three laws that a later lane could silently undo. */
import { describe, expect, it } from "vitest";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";

describe("S1 recipe", () => {
  it("has retired frosted glass entirely", () => {
    expect(CHROME_CSS).not.toMatch(/backdrop-filter\s*:/);
    expect(CHROME_CSS).not.toMatch(/--vendo-glass/);
  });

  it("derives the hairline border from the host's text color", () => {
    expect(CHROME_CSS).toContain(
      "--vendo-border: color-mix(in srgb, var(--vendo-color-text, #14151a) 8%, transparent)",
    );
  });

  it("carries exactly one shadow token, named for floating elements only", () => {
    expect(CHROME_CSS).toContain("--vendo-shadow-float:");
    expect(CHROME_CSS).not.toMatch(/var\(--vendo-shadow\)/);
  });

  it("uses the M2 duration and easing", () => {
    expect(CHROME_CSS).toContain("--vendo-duration: 380ms");
    expect(CHROME_CSS).toContain("--vendo-ease: cubic-bezier(0.32, 0.72, 0, 1)");
  });

  it("every moving thing the center added respects prefers-reduced-motion (M29)", () => {
    const reduce = [...CHROME_CSS.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
      .map(match => match[1]!)
      .join("\n");
    // The sheet's full-width slide and its scrim, the tile hover-lift, and the
    // waiting strip's chevron rotation.
    expect(reduce).toContain(".fl-center-sheet");
    expect(reduce).toContain(".fl-center-scrim");
    expect(reduce).toMatch(/\.fl-tile:hover[^}]*transform: none/);
    expect(reduce).toMatch(/\.fl-tile--ghost:hover[^}]*transform: none/);
    expect(reduce).toMatch(/\.fl-waiting-strip > summary::after \{ transition: none; \}/);
  });

  it("animates exactly one element while a card builds — the boot hairline", () => {
    const building = [...CHROME_CSS.matchAll(/^[^\n{]*\[data-state="building"\][^{]*\{[^}]*\}/gm)]
      .map((match) => match[0])
      // `animation: none` is a rule that TAKES a loop away (M19) — it is not one
      // of the animations this law counts.
      .filter((rule) => /animation\s*:/.test(rule) && !/animation\s*:\s*none/.test(rule));
    expect(building).toHaveLength(1);
    expect(building[0]).toContain(".fl-boot-hairline");
  });

  it("a building card silences the streaming caret and any shimmer (M19)", () => {
    // The caret runs in TWO places (the lone caret, and the pseudo-element that
    // trails streamed prose) and the shimmer bar in a third — all three had to
    // stand down, or §8's one-animation law is false in the common frame.
    for (const target of [".fl-caret", ".fl-md--streaming > :last-child::after", ".fl-skeleton-bar"]) {
      expect(CHROME_CSS, `${target} stands down during a build`)
        .toContain(`.fl-thread:has(.fl-appcard-bar[data-state="building"]) ${target}`);
    }
    expect(CHROME_CSS).toMatch(/:has\(\.fl-appcard-bar\[data-state="building"\]\) \.fl-skeleton-bar \{ animation: none; \}/);
  });
});
