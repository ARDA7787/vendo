/**
 * Cross-block internals — NOT a host surface.
 *
 * The emitted-payload assembly and the field stripping that goes with it, so
 * @vendoai/harnesses' render seam emits the payload shape THIS emitter emits
 * rather than keeping a drifting copy. Behind a subpath because the only
 * supported consumer is another `@vendoai/*` block, so these stay free to change
 * without a major bump.
 */
export { assembleTree } from "./runtime.js";
export { stripServerAuthoritativeFields } from "./open.js";

/** Wave 2 lane E — ONE Claude Agent SDK turn, port-injected. Consumed by
 *  `@vendoai/harnesses/claude-code` for `machine: "local"`, and copied verbatim
 *  into the box template (`box/build-template.mjs`) for the sandbox path. */
export {
  runClaudeTurn,
  jsonSchemaToZodShape,
  BOX_TOOLS,
  VENDO_MCP_SERVER,
  type ClaudeTurnEvent,
  type ClaudeTurnInput,
  type ClaudeTurnTool,
  type GuardedCall,
  type GuardedResult,
} from "./claude-turn.js";
