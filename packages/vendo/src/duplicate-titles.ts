import { duplicateToolTitles, VendoError, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { FIND_TOOLS_TOOL_NAME } from "@vendoai/agent";

/**
 * Design §12 — "two actions must never read identically on a card."
 *
 * A consent card shows a tool's `title`. If two tools share one, the card cannot
 * tell the person which action they are approving, and `title` is part of the
 * descriptorHash they consented to — so the ambiguity is not cosmetic, it is a
 * consent defect. The contract calls for a BOOT error.
 *
 * `createVendo` is synchronous while the descriptor set is resolved lazily and
 * asynchronously (the portability gate forbids I/O at module scope, so
 * `actions.descriptors()` cannot be awaited at compose). Composition therefore
 * INSTALLS this check, and it fires the instant the descriptor set first becomes
 * known — the earliest moment the fact is knowable at all. A bad deployment
 * fails every call that needs tools and never becomes healthy on retry.
 *
 * The check is memoized per registry: every turn enumerates descriptors, and a
 * whole-registry title scan on that hot path would be waste for a fact that
 * cannot change without a redeploy.
 */
export function withUniqueToolTitles(tools: ToolRegistry): ToolRegistry {
  let verdict: VendoError | undefined;
  let checked = false;

  const assertUnique = (descriptors: readonly ToolDescriptor[]): void => {
    if (!checked) {
      checked = true;
      // A host tool that takes a reserved internal name is a DEPLOYMENT fault, so
      // it belongs here with the title check rather than surfacing as a mid-turn
      // stream throw the user sees as a broken conversation. `find_tools` carries
      // no `vendo_` prefix, so nothing else would catch it.
      const reserved = descriptors.find((descriptor) => descriptor.name === FIND_TOOLS_TOOL_NAME);
      if (reserved !== undefined) {
        verdict = new VendoError(
          "conflict",
          `A host tool is named ${JSON.stringify(FIND_TOOLS_TOOL_NAME)}, which Vendo reserves for its own `
          + "tool-discovery meta-tool. Rename it in .vendo/overrides.json.",
        );
      }
      const collisions = duplicateToolTitles(descriptors);
      if (verdict === undefined && collisions.length > 0) {
        const detail = collisions
          .map(({ title, tools: names }) => `"${title}" (${names.join(", ")})`)
          .join("; ");
        verdict = new VendoError(
          "conflict",
          `Two or more tools share one title, so a consent card cannot tell them apart: ${detail}. `
          + "Retitle them in .vendo/overrides.json — a title is what the user approves.",
        );
      }
    }
    if (verdict !== undefined) throw verdict;
  };

  return {
    ...tools,
    async descriptors(ctx) {
      const descriptors = await tools.descriptors(ctx);
      assertUnique(descriptors);
      return descriptors;
    },
    // EXECUTION is gated too. Gating only enumeration was a hole, not a
    // simplification: a caller holding a tool name from anywhere else — a stored
    // app document, a replayed approval, a compound step — could still perform a
    // real mutating call on a deployment whose consent cards cannot tell two
    // actions apart. The card is the only thing standing between the user and an
    // irreversible action, so if it is ambiguous nothing may run.
    async execute(call, ctx) {
      assertUnique(await tools.descriptors());
      return tools.execute(call, ctx);
    },
  };
}
