/**
 * The pack boot merge (build contract §5): resolve every configured pack and
 * fold its four slots into the registries that already exist — tools into the
 * one tool registry, skills into the workspace mount, checks onto the floor,
 * components into the catalog.
 *
 * Two laws live here and nowhere else:
 *
 * - **No renaming, ever.** A name is global as authored. A pack's skill body
 *   says `check_report`, and projecting a skill is a copy rather than a
 *   translation, so a prefixed tool name would point the model at a tool that
 *   does not exist.
 * - **Boot-collision IS the namespacing.** Two packs claiming one name is an
 *   error at boot that names both of them, so the conflict is fixed by whoever
 *   configured them rather than papered over at runtime.
 */
import {
  TOOL_NAME_PATTERN,
  VendoError,
  type Check,
  type ComponentRegistry,
  type Pack,
  type PackProvider,
  type PackSkill,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";

/**
 * What a pack receives when its tools need a platform handle.
 *
 * Deliberately small: one member, the only handle a wave-1 pack actually needs,
 * and it grows by demand rather than by anticipation. Triggers and scheduling
 * are NOT here — they are platform lifecycle, not pack content (architecture
 * §5), so a pack contributes *over* that lifecycle and never arms it.
 */
export interface PackContext {
  /**
   * The apps runtime the app-generation tools act through.
   *
   * A thunk, not a value: the merge runs early in composition (its components
   * feed the catalog and its checks feed the floor, both of which the apps
   * runtime is built with), so the runtime does not exist yet. It always does by
   * the time a tool runs, because a tool only runs inside a request. This is the
   * same closure the arming seam uses for the automations engine.
   */
  apps: () => AppsRuntime;
}

export interface MergedPacks {
  /** Every pack tool as one registry, ready for `actions.add(...)` — so pack
   *  tools are guarded, audited, and projected identically to host tools. */
  tools: ToolRegistry;
  skills: PackSkill[];
  checks: Check[];
  components: ComponentRegistry;
  /** The configured pack names, in order — what a boot diagnostic reports. */
  names: string[];
}

/** The one collision message shape, so every slot reads the same. */
const collide = (slot: string, name: string, first: string, second: string): never => {
  throw new VendoError(
    "validation",
    `two packs claim the ${slot} name "${name}": "${first}" and "${second}". Names are global as authored — nothing is auto-prefixed — so rename it in one of them, or configure only one of the packs.`,
  );
};

/** Claim a name in one slot's namespace. The slots are separate namespaces: one
 *  pack may call a tool and a skill the same thing. */
const claimer = (slot: string): ((name: string, pack: string) => void) => {
  const owners = new Map<string, string>();
  return (name: string, pack: string): void => {
    const owner = owners.get(name);
    if (owner !== undefined) collide(slot, name, owner, pack);
    owners.set(name, pack);
  };
};

const descriptorOf = ({ execute: _execute, ...descriptor }: ToolDefinition): ToolDescriptor => descriptor;

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error: error instanceof VendoError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : "unknown pack tool error" },
});

/**
 * The pack tools as one registry.
 *
 * A pack tool returns its output or throws; the denial outcomes
 * (`pending-approval`, `blocked`, `connect-required`) belong to the guard that
 * wraps this registry, so a pack author cannot author one and cannot forget the
 * safety story.
 */
const registryOf = (definitions: ReadonlyMap<string, ToolDefinition>): ToolRegistry => ({
  async descriptors() {
    return [...definitions.values()].map(descriptorOf);
  },
  async execute(call, ctx): Promise<ToolOutcome> {
    const definition = definitions.get(call.tool);
    if (definition === undefined) {
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    }
    try {
      return { status: "ok", output: await definition.execute(call.args, ctx, call) };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});

const resolve = <Context>(provider: PackProvider<Context>, context: Context): Pack =>
  (typeof provider === "function" ? provider(context) : provider);

export const mergePacks = (
  providers: readonly PackProvider<PackContext>[],
  context: PackContext,
): MergedPacks => {
  const packNames = new Set<string>();
  const claimTool = claimer("tool");
  const claimSkill = claimer("skill");
  const claimCheck = claimer("check");
  const claimComponent = claimer("component");

  const tools = new Map<string, ToolDefinition>();
  const skills: PackSkill[] = [];
  const checks: Check[] = [];
  const components: ComponentRegistry = {};
  const names: string[] = [];

  for (const provider of providers) {
    const pack = resolve(provider, context);
    if (packNames.has(pack.name)) {
      throw new VendoError("validation", `two configured packs are both named "${pack.name}"; configure one of them.`);
    }
    packNames.add(pack.name);
    names.push(pack.name);

    for (const tool of pack.tools ?? []) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new VendoError(
          "validation",
          `pack "${pack.name}" declares the tool name "${tool.name}", which is not a legal tool name (letters, digits, "_" and "-", up to 64 characters).`,
        );
      }
      claimTool(tool.name, pack.name);
      tools.set(tool.name, tool);
    }
    for (const skill of pack.skills ?? []) {
      claimSkill(skill.name, pack.name);
      skills.push(skill);
    }
    for (const check of pack.checks ?? []) {
      claimCheck(check.name, pack.name);
      checks.push(check);
    }
    for (const [name, entry] of Object.entries(pack.components ?? {})) {
      claimComponent(name, pack.name);
      components[name] = entry;
    }
  }

  return { tools: registryOf(tools), skills, checks, components, names };
};
