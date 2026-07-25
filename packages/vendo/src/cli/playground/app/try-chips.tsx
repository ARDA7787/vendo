/**
 * The use-case chips row (unified try surface, Task 9): small pill buttons
 * above the surface slot, one per suggestion chip. Purely presentational —
 * try-app derives the chip set (usecaseChips in try-boot.ts) and owns the
 * press → surface-remount wiring; this row just renders pills and reports
 * presses. The active chip stays a live, focusable button (disabling it would
 * drop keyboard focus to the body) — it's marked via aria-pressed + styling,
 * and re-presses are no-ops because pressChip below is idempotent for it.
 *
 * Styling: the row carries its own themeCssVariables scope, the same way the
 * chrome roots in @vendoai/ui do, so the pills re-theme with the profile theme
 * through the var(--vendo-color-*) custom properties. Deliberately quiet — the
 * surface below is the hero.
 */
import type { VendoTheme } from "@vendoai/core";
import { themeCssVariables } from "@vendoai/ui";
import type { CSSProperties } from "react";
import type { UsecaseChip } from "./try-boot.js";

/** The pressed-chip state try-app keeps: which chip fired, plus a sequence
 *  that keys the surface remount. */
export interface PressedChip {
  chip: UsecaseChip;
  seq: number;
}

/** The press updater — THE double-send guard: pressing the already-active
 *  chip returns the SAME state (no seq bump → no remount → no re-send); any
 *  other chip bumps the sequence so the surface remounts and fires once. */
export function pressChip(current: PressedChip | null, chip: UsecaseChip): PressedChip {
  return current?.chip.prompt === chip.prompt ? current : { chip, seq: (current?.seq ?? 0) + 1 };
}

export function TryChips({ chips, activePrompt, onPick, theme }: {
  chips: UsecaseChip[];
  /** The pressed chip's prompt, or null when nothing has been fired yet. */
  activePrompt: string | null;
  onPick: (chip: UsecaseChip) => void;
  theme: VendoTheme;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Suggestions"
      style={{
        ...themeCssVariables(theme),
        display: "flex",
        gap: 8,
        overflowX: "auto",
        padding: "2px 2px 14px",
        scrollbarWidth: "none",
      } as CSSProperties}
    >
      {chips.map((chip, index) => {
        const active = chip.prompt === activePrompt;
        return (
          <button
            key={`${index}:${chip.label}`}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(chip)}
            style={{
              flex: "0 0 auto",
              font: "inherit",
              fontSize: 12.5,
              lineHeight: 1,
              padding: "7px 12px",
              borderRadius: 999,
              whiteSpace: "nowrap",
              cursor: active ? "default" : "pointer",
              border: `1px solid var(--vendo-color-${active ? "accent" : "border"}, #e3e3e8)`,
              background: active ? "var(--vendo-color-accent, #111111)" : "var(--vendo-color-surface, #f7f7f8)",
              color: active ? "var(--vendo-color-accent-text, #ffffff)" : "var(--vendo-color-text, #1a1a1e)",
            }}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
