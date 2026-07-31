/**
 * What composition says out loud about the configured packs.
 *
 * Both of these are pure functions of what boot already knows, so the messages
 * are testable on their own rather than only observable as console noise from a
 * booted server.
 */
import { VendoError } from "@vendoai/core";
import { APPS_PACK_NAME } from "./apps.js";

/**
 * A pack claiming a tool name the HOST's own tools already own.
 *
 * The registry refuses this collision on its own — it throws `conflict` — but
 * only when it first loads, on some later request, and its message names just
 * the second arrival ("from added registry"): nothing says which pack, or what
 * it hit. This is the boot-time half, and it throws, so the deployment never
 * starts in a state where every tool call is going to fail.
 *
 * It compares against the host tool names composition already has WITHOUT doing
 * any I/O. Connector tools are not here on purpose: knowing them means a network
 * round trip, and making `createVendo` reach the network to compose would be a
 * far worse trade than leaving that rarer collision to the registry.
 */
export const hostPackToolCollision = (
  toolOwners: ReadonlyMap<string, string>,
  hostToolNames: readonly string[],
): VendoError | undefined => {
  for (const name of hostToolNames) {
    const pack = toolOwners.get(name);
    if (pack !== undefined) {
      return new VendoError(
        "conflict",
        `the pack "${pack}" declares the tool "${name}", but this deployment's own host tools already claim that name. Tool names are global as authored — nothing is auto-prefixed, because a skill body naming a tool is copied verbatim — so rename it in the pack, or rename or disable the host tool in .vendo/overrides.json.`,
      );
    }
  }
  return undefined;
};

/**
 * An explicit `packs:` list with no apps pack in it.
 *
 * App generation is what the agent is FOR, and dropping it is silent otherwise:
 * the agent simply answers that it cannot build apps, with nothing anywhere
 * saying why. A warning rather than an error, because running without it is a
 * legitimate (if unusual) choice — a host embedding only its own pack.
 */
export const missingAppsPackWarning = (configured: readonly string[] | undefined): string | undefined => {
  if (configured === undefined || configured.includes(APPS_PACK_NAME)) return undefined;
  const listed = configured.length === 0 ? "(none)" : configured.join(", ");
  return `[vendo] createVendo({ packs }) is set to [${listed}] and does not include apps(), so this agent cannot build apps at all — the app tools, the building-apps skill, and the app checks are all absent. Add apps() to the list if that was not deliberate: packs: [apps(), ...].`;
};
