export { createAgent, validateUpsert } from "./agent.js";
export type { VendoAgent } from "./agent.js";
export type { CapabilityMissConfig } from "./capability-miss.js";
export {
  buildVendoToolPack,
  type VendoPackExecuteOptions,
  type VendoPackTool,
  type VendoToolPackCoreOptions,
} from "./pack.js";
export {
  VENDO_CREATE_APP_TOOL,
  VENDO_DELEGATE_TOOL,
  VENDO_TOOL_PACK_PREFIX,
  type VendoDelegateResult,
  type VendoToolPackFilter,
  type VendoToolPackOptions,
} from "./tool-pack.js";
export type { ToolSearchConfig, ToolSearchFn, ToolSearchMatch } from "./tool-search.js";
// The one operating prompt, additively exported for the harness lift (build
// contract §1). A `Turn` deliberately carries no RunContext — harnesses are
// permission-blind — so the guard-and-venue-dependent half of the prompt cannot
// be assembled inside a harness. Composition assembles it here and hands the
// STRING to `vendo({ system })`, which keeps one prompt in the repo instead of
// two drifting copies.
export { assembleSystemPrompt } from "./prompt.js";
// The lifted turn loop and the guarded-call path, shared with @vendoai/harnesses
// so `vendo()` runs the shipped loop instead of a second one. `guardedCall`
// carries the view channel, the VENDO_VIEW_STREAM bridge, the connect card and
// its per-turn dedupe, the build-failed banner, the citations part and
// `toolOutputCap`; `previewApproval` is the previewCheck seam that stops an
// approved call from being charged to the guard twice.
export { startTurn, type TurnLoop, type TurnLoopOptions } from "./loop.js";
export { wireErrorMessage } from "./wire-error.js";
export {
  addAgentTool,
  buildAgentTools,
  guardedCall,
  previewApproval,
  type ToolBridgeOptions,
} from "./tools.js";
export { createToolSearchSession, type ToolSearchSession } from "./tool-search.js";
export type { Thread, ThreadSummary } from "./threads.js";
