/**
 * The pack boot merge (build contract §5): four slots, names global as authored,
 * and a collision that fails at boot naming both packs — boot-collision IS the
 * namespacing, so nothing is ever renamed.
 */
import {
  VendoError,
  type Check,
  type Json,
  type Pack,
  type RunContext,
  type ToolDefinition,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { definePack } from "./define.js";
import { mergePacks, type PackContext } from "./merge.js";

const context = {} as PackContext;

const runContext = {} as RunContext;

const tool = (name: string, execute?: ToolDefinition["execute"]): ToolDefinition => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  execute: execute ?? (async () => ({ ran: name })),
});

const merge = (packs: readonly Pack[]) => mergePacks(packs, context);

describe("definePack", () => {
  it("returns the pack unchanged — it is a typing handle, not a wrapper", () => {
    const pack = definePack({ name: "compliance-reports", tools: [tool("check_report")] });
    expect(pack.name).toBe("compliance-reports");
    expect(pack.tools?.[0]?.name).toBe("check_report");
  });
});

describe("the four slots", () => {
  it("merges tools, skills, checks and components from every pack", async () => {
    const merged = merge([
      definePack({
        name: "one",
        tools: [tool("a_tool")],
        skills: [{ name: "a-skill", description: "A.", body: "a\n" }],
        checks: [{ name: "a-check", kind: "judgment", rule: "Rule A." }],
        components: { Alpha: { component: "AlphaImpl", description: "Alpha." } },
      }),
      definePack({
        name: "two",
        tools: [tool("b_tool")],
        skills: [{ name: "b-skill", description: "B.", body: "b\n" }],
        checks: [{ name: "b-check", kind: "judgment", rule: "Rule B." }],
        components: { Beta: { component: "BetaImpl", description: "Beta." } },
      }),
    ]);

    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["a_tool", "b_tool"]);
    expect(merged.skills.map(({ name }) => name)).toEqual(["a-skill", "b-skill"]);
    expect(merged.checks.map(({ name }) => name)).toEqual(["a-check", "b-check"]);
    expect(Object.keys(merged.components)).toEqual(["Alpha", "Beta"]);
    expect(merged.names).toEqual(["one", "two"]);
  });

  it("merges an empty pack list into empty slots", async () => {
    const merged = merge([]);
    expect(await merged.tools.descriptors()).toEqual([]);
    expect(merged.skills).toEqual([]);
    expect(merged.checks).toEqual([]);
    expect(merged.components).toEqual({});
  });

  it("lets a pack fill only the slots it cares about", async () => {
    const merged = merge([definePack({ name: "skill-only", skills: [{ name: "s", description: "S.", body: "s\n" }] })]);
    expect(await merged.tools.descriptors()).toEqual([]);
    expect(merged.skills).toHaveLength(1);
  });
});

describe("names are global as authored — no renaming, ever", () => {
  it("registers a pack tool under exactly the name it declared", async () => {
    const merged = merge([definePack({ name: "compliance-reports", tools: [tool("check_report")] })]);
    // Not "compliance_reports_check_report": a skill body says `check_report`,
    // and projection is a copy, so a prefix would point at a tool that is not there.
    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["check_report"]);
  });

  it("fails at boot naming BOTH packs when two claim one tool name", () => {
    const attempt = (): unknown => merge([
      definePack({ name: "alpha", tools: [tool("check_report")] }),
      definePack({ name: "beta", tools: [tool("check_report")] }),
    ]);

    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/check_report/);
    expect(attempt).toThrow(/alpha/);
    expect(attempt).toThrow(/beta/);
  });

  it("fails at boot when two packs claim one skill name", () => {
    expect(() => merge([
      definePack({ name: "alpha", skills: [{ name: "building-apps", description: "A.", body: "a" }] }),
      definePack({ name: "beta", skills: [{ name: "building-apps", description: "B.", body: "b" }] }),
    ])).toThrow(/building-apps[\s\S]*alpha[\s\S]*beta|alpha[\s\S]*beta/);
  });

  it("fails at boot when two packs claim one check name", () => {
    const clash = (name: string): Check => ({ name: "totals-cite", kind: "judgment", rule: name });
    expect(() => merge([
      definePack({ name: "alpha", checks: [clash("a")] }),
      definePack({ name: "beta", checks: [clash("b")] }),
    ])).toThrow(/totals-cite/);
  });

  it("fails at boot when two packs claim one component name", () => {
    expect(() => merge([
      definePack({ name: "alpha", components: { RetentionBadge: { component: 1, description: "A." } } }),
      definePack({ name: "beta", components: { RetentionBadge: { component: 2, description: "B." } } }),
    ])).toThrow(/RetentionBadge/);
  });

  it("lets one pack reuse a name across DIFFERENT slots — the namespaces are separate", () => {
    expect(() => merge([
      definePack({
        name: "one",
        tools: [tool("reports")],
        skills: [{ name: "reports", description: "R.", body: "r" }],
      }),
    ])).not.toThrow();
  });

  it("fails at boot when one pack declares the same tool name twice", () => {
    expect(() => merge([
      definePack({ name: "sloppy", tools: [tool("check_report"), tool("check_report")] }),
    ])).toThrow(/check_report/);
  });

  it("fails at boot when two packs share a pack name", () => {
    expect(() => merge([definePack({ name: "same" }), definePack({ name: "same" })])).toThrow(/same/);
  });

  it("rejects a tool name the tool contract does not allow", () => {
    expect(() => merge([definePack({ name: "bad", tools: [tool("not a tool name")] })])).toThrow(VendoError);
  });
});

describe("pack tools reach the one registry, guarded like every other tool", () => {
  it("executes the declared tool and returns its output as an ok outcome", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool", async (input) => ({ echoed: input }))] })]);

    const outcome = await merged.tools.execute({ id: "call_1", tool: "a_tool", args: { x: 1 } }, runContext);

    expect(outcome).toEqual({ status: "ok", output: { echoed: { x: 1 } } });
  });

  it("hands the pack tool the run context, so it acts as the signed-in user", async () => {
    let seen: RunContext | undefined;
    const merged = merge([definePack({
      name: "one",
      tools: [tool("a_tool", async (_input, ctx) => { seen = ctx; return null as unknown as Json; })],
    })]);

    await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext);

    expect(seen).toBe(runContext);
  });

  it("turns a throwing pack tool into an error outcome, never a crash", async () => {
    const merged = merge([definePack({
      name: "one",
      tools: [tool("a_tool", async () => { throw new VendoError("validation", "needs a report id"); })],
    })]);

    expect(await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext)).toEqual({
      status: "error",
      error: { code: "validation", message: "needs a report id" },
    });
  });

  it("reports an unexpected throw as an internal error carrying its message", async () => {
    const merged = merge([definePack({
      name: "one",
      tools: [tool("a_tool", async () => { throw new Error("socket hang up"); })],
    })]);

    expect(await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext)).toEqual({
      status: "error",
      error: { code: "internal", message: "socket hang up" },
    });
  });

  it("answers not-found for a tool no pack declared", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool")] })]);

    const outcome = await merged.tools.execute({ id: "call_1", tool: "other_tool", args: {} }, runContext);

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("never leaks the execute function into a descriptor", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool")] })]);
    const [descriptor] = await merged.tools.descriptors();
    expect(descriptor).toEqual({
      name: "a_tool",
      description: "does a_tool",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
    });
  });
});

describe("a pack that needs a platform handle is a plain function of the context", () => {
  it("calls the provider with the boot context and merges what it returns", async () => {
    let seen: PackContext | undefined;
    const merged = mergePacks([(ctx) => { seen = ctx; return { name: "lazy", tools: [tool("a_tool")] }; }], context);

    expect(seen).toBe(context);
    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["a_tool"]);
  });

  it("collides a provider-built pack with a plain one exactly the same way", () => {
    expect(() => mergePacks(
      [(_ctx) => ({ name: "lazy", tools: [tool("check_report")] }), definePack({ name: "plain", tools: [tool("check_report")] })],
      context,
    )).toThrow(/check_report/);
  });
});
