/** Build contract §4 — the four model seats. A seat is a JOB, not a model: the
 *  same model may fill several, and swapping one never renames the others. */
export type Seat = "default" | "reviewer" | "judge" | "fill";

/** Iteration order for the seats, so callers never hand-roll the list. */
export const SEATS: readonly Seat[] = ["default", "reviewer", "judge", "fill"];

/**
 * Build contract §4's `ResolvedModels`: every seat filled.
 *
 * Generic over the model type instead of importing the ai-SDK's `LanguageModel`,
 * for the same reason `threadMessageStore` is generic — `@vendoai/core` carries
 * no `ai` dependency, and `scripts/dependency-guard.mjs` rejects adding one.
 * The umbrella instantiates it as `ResolvedModels<LanguageModel>`, so the shape
 * callers see is the contracted one.
 */
export type ResolvedModels<Model = unknown> = Readonly<Record<Seat, Model>>;

/** What a host may set: any subset, each either a model or a name to resolve. */
export type SeatConfig<Model = unknown> = Partial<Record<Seat, Model | string>>;

/** Today's slot vocabulary, as `packages/vendo/src/models-config.ts` writes it. */
export interface LegacyModelsConfig<Model = unknown> {
  agent?: Model | string;
  paint?: Model | string;
  judge?: Model | string;
  knowledgeVerifier?: Model | string;
}

/**
 * Build contract §4's migration: `agent → default`, `paint → fill`, `judge`
 * unchanged, `knowledgeVerifier` folded into `default`.
 *
 * `agent` wins over `knowledgeVerifier` when both are set, because both land on
 * `default` and `agent` is the model the host actually chose for the main job —
 * folding must never quietly demote it. Seats already written in the new
 * vocabulary pass straight through, so a half-migrated config still works.
 */
export function migrateModelSeats<Model = unknown>(
  config: LegacyModelsConfig<Model> & SeatConfig<Model>,
): SeatConfig<Model> {
  const seats: SeatConfig<Model> = {};
  const fallbackDefault = config.knowledgeVerifier ?? config.agent;
  const chosenDefault = config.default ?? config.agent ?? fallbackDefault;
  if (chosenDefault !== undefined) seats.default = chosenDefault;
  const fill = config.fill ?? config.paint;
  if (fill !== undefined) seats.fill = fill;
  const judge = config.judge;
  if (judge !== undefined) seats.judge = judge;
  const reviewer = config.reviewer;
  if (reviewer !== undefined) seats.reviewer = reviewer;
  return seats;
}

/**
 * Build contract §4: **boot error** if a harness option sets a model AND
 * `models.default` is set for the same seat.
 *
 * Returns the message rather than throwing, so the caller decides whether this
 * is a boot failure or a config warning. Silence means no conflict.
 *
 * Why only `default`: a harness's `model` option names the model it thinks with,
 * which is the `default` seat. A judge or reviewer seat is a different job, so
 * setting one alongside a harness option is not ambiguous and must not error.
 */
export function seatConflict<Model = unknown>(input: {
  harnessOptionModel?: Model | string;
  seats: SeatConfig<Model>;
}): string | undefined {
  if (input.harnessOptionModel === undefined) return undefined;
  if (input.seats.default === undefined) return undefined;
  return "A harness option and `models.default` both set a model for the default seat. "
    + "Remove one — either the harness's `model` option or `models.default`.";
}
