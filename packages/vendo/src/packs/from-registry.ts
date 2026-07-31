/**
 * Re-express a shipped `ToolRegistry` as pack tool definitions.
 *
 * This exists so a capability block that already owns a registry can arrive
 * through the public `Pack.tools` slot instead of being added to the tool
 * registry by a privileged path. The tools themselves are untouched: the whole
 * call — arguments and anything riding on it, like the app-create view-stream
 * bridge — is handed to the registry exactly as it arrived.
 *
 * The one translation is the return: a pack tool answers with output or throws,
 * because the denial statuses belong to the guard that wraps every tool. A
 * registry that produced one anyway would be a bug, so it surfaces as an error
 * naming what happened rather than as a silent success.
 */
import {
  VendoError,
  type Json,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

const unwrap = (name: string, outcome: ToolOutcome): Json => {
  switch (outcome.status) {
    case "ok":
      return outcome.output;
    case "error":
      throw new VendoError(
        outcome.error.code === "not-found" ? "not-found" : "validation",
        outcome.error.message,
      );
    case "blocked":
      throw new VendoError("blocked", outcome.reason);
    case "connect-required":
      throw new VendoError("validation", outcome.connect.message);
    case "pending-approval":
      throw new VendoError(
        "validation",
        `the tool "${name}" answered with a pending approval, which the guard owns rather than the tool`,
      );
  }
};

/** `registry` is a thunk because the block that owns it is usually composed
 *  after the pack merge; it is resolved when a tool actually runs. */
export const toolsFromRegistry = (
  registry: () => ToolRegistry,
  descriptors: readonly ToolDescriptor[],
): ToolDefinition[] => descriptors.map((descriptor) => ({
  ...descriptor,
  execute: async (_input, context, call) => unwrap(descriptor.name, await registry().execute(call, context)),
}));
