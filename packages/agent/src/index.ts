export { createAgent } from "./agent.js";
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
export type { Thread, ThreadSummary } from "./threads.js";
