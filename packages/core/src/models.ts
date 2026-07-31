/**
 * Model seats — build contract 2026-07-30 §4, copied verbatim.
 *
 * LANE OWNERSHIP: wave-1 lane D owns seat RESOLUTION (the config surface, the
 * credential ladder, the `agent → default` / `paint → fill` migration off
 * `packages/vendo/src/models-config.ts`). Lane A landed only the frozen §4 TYPE
 * BLOCK, because `Turn.models` (harness.ts) cannot typecheck without it and the
 * two lanes build in separate worktrees. If lane D's version differs, lane D's
 * wins.
 */
import type { LanguageModel } from "ai";

/** Build contract §4 — the seat map is closed and typed. */
export type Seat = "default" | "reviewer" | "judge" | "fill";

/** Build contract §4 */
export type ResolvedModels = Readonly<Record<Seat, LanguageModel>>;
