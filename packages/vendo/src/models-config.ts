import type { LanguageModel } from "ai";
import { migrateModelSeats, seatConflict, VendoError } from "@vendoai/core";
import { vendoModel, type VendoModelOptions } from "#dev-creds/model";

/**
 * The `models` block on createVendo (models spec 2026-07-22, DX surface 3):
 * one key per slot, valued by a model-name string (resolved through
 * vendoModel's credential ladder — VERBATIM passthrough, per-rung defaults)
 * or an explicit ai-SDK LanguageModel object (wins as-is). Supersedes the
 * deprecated top-level `model` and `paint.model` knobs; `paint.disabled`
 * survives as the single-lane switch. `judge` is consumed by
 * bindVendoModelSlots (see dev-creds/model.ts) — composition binds it, per
 * createVendo instance, onto the model of a judge the host wired from a
 * string, i.e. vendoAutoJudge({ model: vendoModel("vendo-judge") }).
 */
export interface ModelsConfig {
  /** Build contract §4's seat vocabulary. A seat is a JOB, not a model. These
   *  are additive: the legacy slot names below keep working for one minor, and
   *  `migrateModelSeats` (core) maps them on, so a half-migrated config still
   *  composes. Where both name one seat, the SEAT wins — a host mid-migration
   *  should get the new key they just wrote, not the old one they forgot to
   *  delete. */
  default?: string | LanguageModel;
  reviewer?: string | LanguageModel;
  fill?: string | LanguageModel;
  /** @deprecated superseded by `default` (still functional for one minor). */
  agent?: string | LanguageModel;
  /** @deprecated superseded by `fill` (still functional for one minor). */
  paint?: string | LanguageModel;
  judge?: string | LanguageModel;
  /** K15 — the knowledge tool's evidence check (a cheap/fast model reading the
      retrieved passages before the tool returns them). Its own slot beside
      `judge`: pinning the model that GRADES answers must not silently repoint
      the one that GATES them. Unset = the family fast pick on whatever rung
      the host's credentials resolve to; `VENDO_KNOWLEDGE_VERIFY=off` turns the
      check off entirely. */
  knowledgeVerifier?: string | LanguageModel;
}

export interface ResolveModelsInput {
  /** @deprecated superseded by models.agent (still functional). */
  model?: LanguageModel;
  /** @deprecated model half superseded by models.paint; `disabled` stays. */
  paint?: { model?: LanguageModel; disabled?: boolean };
  models?: ModelsConfig;
  /** A model named by a harness's own options. Build contract §4 makes it a BOOT
   *  ERROR for this and `models.default` to both be set: two places naming the
   *  model that thinks is ambiguous, and guessing would silently ignore one. */
  harnessOptionModel?: string | LanguageModel;
}

export interface ResolvedModels {
  /** The one model the agent and apps blocks consume, plus the /status venue:
   *  "custom" (host-passed object) or "ladder" (env-resolved, incl. strings). */
  agent: { model: LanguageModel; venue: "custom" | "ladder" };
  /** The apps-block paint knob, post-precedence. Undefined = engine falls
   *  back to the agent model (today's explicit-model behavior). */
  paint: { model?: LanguageModel; disabled?: boolean } | undefined;
}

type MakeModel = (name?: string, options?: VendoModelOptions) => LanguageModel;

function validateSlot(slot: string, value: string | LanguageModel | undefined): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (value.trim().length > 0) return;
    throw new VendoError("validation", `models.${slot} must be a non-blank model name string or an ai-SDK LanguageModel`);
  }
  if (typeof value === "object" && value !== null) return;
  throw new VendoError("validation", `models.${slot} must be a model-name string or an ai-SDK LanguageModel object`);
}

/** Resolve the models block + deprecated aliases into the composed slots.
 *  Precedence per slot: explicit model object → (env pins, inside the
 *  ladder) → models string → per-rung default. Paint invisibility: when the
 *  agent slot rides the ladder and no paint model was configured, the paint
 *  lane composes the family fast pick (vendo-paint on Cloud, the provider's
 *  fast model on BYO rungs); when the host passed an explicit agent model,
 *  paint falls back to that model exactly as before. */
export function resolveModels(config: ResolveModelsInput, makeModel: MakeModel = vendoModel): ResolvedModels {
  validateSlot("default", config.models?.default);
  validateSlot("reviewer", config.models?.reviewer);
  validateSlot("fill", config.models?.fill);
  validateSlot("agent", config.models?.agent);
  validateSlot("paint", config.models?.paint);
  validateSlot("judge", config.models?.judge);
  validateSlot("knowledgeVerifier", config.models?.knowledgeVerifier);

  // Collapse both vocabularies onto seats once, here, so the precedence below
  // never has to know which spelling a host used.
  const seats = migrateModelSeats<LanguageModel>(config.models ?? {});
  const conflict = seatConflict<LanguageModel>({
    ...(config.harnessOptionModel === undefined ? {} : { harnessOptionModel: config.harnessOptionModel }),
    seats,
  });
  if (conflict !== undefined) throw new VendoError("validation", conflict);

  const agentConfigured = seats.default ?? config.model;
  const agent: ResolvedModels["agent"] = agentConfigured === undefined
    ? { model: makeModel(undefined, { slot: "agent" }), venue: "ladder" }
    : typeof agentConfigured === "string"
      ? { model: makeModel(agentConfigured, { slot: "agent" }), venue: "ladder" }
      : { model: agentConfigured, venue: "custom" };

  const disabled = config.paint?.disabled;
  const paintConfigured = seats.fill ?? config.paint?.model;
  const paintModel = disabled === true
    ? undefined // no model behind a disabled lane
    : typeof paintConfigured === "string"
      ? makeModel(paintConfigured, { slot: "paint" })
      : paintConfigured
        ?? (agent.venue === "ladder" ? makeModel(undefined, { slot: "paint" }) : undefined);

  const paint = paintModel === undefined && disabled === undefined
    ? undefined
    : {
        ...(paintModel === undefined ? {} : { model: paintModel }),
        ...(disabled === undefined ? {} : { disabled }),
      };

  return { agent, paint };
}
