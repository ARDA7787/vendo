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

  it("animates exactly one element while a card builds — the boot hairline", () => {
    const building = [...CHROME_CSS.matchAll(/^[^\n{]*\[data-state="building"\][^{]*\{[^}]*\}/gm)]
      .map((match) => match[0])
      .filter((rule) => /animation\s*:/.test(rule));
    expect(building).toHaveLength(1);
    expect(building[0]).toContain(".fl-boot-hairline");
  });
});
