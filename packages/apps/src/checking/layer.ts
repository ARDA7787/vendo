/**
 * The checking floor: built-in fact checks plus whatever the host plugged in
 * through a pack, run in parallel over one app and flat-merged into a single
 * finding list.
 *
 * The floor is harness-independent on purpose — swap the harness and it does not
 * move. It also does not care whether whoever built the app reviewed its own
 * work: a plugged check fires either way.
 *
 * A check is untrusted code (the host's, a pack's, or a model call): one that
 * throws degrades to a `warn` naming it, so a broken check never takes the app
 * down with it.
 */
import { factChecks } from "./facts.js";
import type { Check, CheckInput, CheckingLayer, Finding } from "./types.js";
import type { GenerationDependencies } from "../generation/engine.js";

export interface CheckingLayerOptions {
  /** The host surface the fact checks measure against (catalog, tools, tool
   *  shapes). */
  deps: GenerationDependencies;
  /** Checks plugged in by packs (`Pack.checks`, build contract §5). APPENDED —
   *  they can add findings, never remove or replace a built-in. */
  checks?: readonly Check[];
}

type FactCheck = Extract<Check, { kind: "fact" }>;

const crashFinding = (check: Check, error: unknown): Finding => ({
  severity: "warn",
  where: check.name,
  message: `the check "${check.name}" failed to run (${error instanceof Error ? error.message : String(error)}), so whatever it would have found is missing from this report`,
});

export const createCheckingLayer = ({ deps, checks = [] }: CheckingLayerOptions): CheckingLayer => {
  const all: Check[] = [...factChecks(deps), ...checks];
  const facts = all.filter((check): check is FactCheck => check.kind === "fact");
  return {
    checks: all,
    rubric: all.flatMap((check) => (check.kind === "judgment" ? [check.rule] : [])),
    run: async (input: CheckInput): Promise<Finding[]> => {
      const results = await Promise.all(facts.map(async (check) => {
        try {
          return await check.run(input);
        } catch (error) {
          return [crashFinding(check, error)];
        }
      }));
      return results.flat();
    },
  };
};
