/**
 * The checks floor, lifted from generation-internal to host-pluggable
 * (build contract §5): the two kinds of check, who runs which, and the
 * guarantees that hold no matter which harness built the app or whether it
 * bothered to review its own work.
 */
import {
  VENDO_APP_FORMAT,
  compileWire,
  type AppDocument,
  type Check,
  type CheckInput,
  type NormalizedCatalog,
  type ShapeType,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createCheckingLayer } from "./layer.js";
import type { GenerationDependencies, HostToolInfo } from "../generation/engine.js";
import { scriptedLanguageModel } from "../testing/scripted-model.js";

const tools: HostToolInfo[] = [{
  name: "host_listInvoices",
  description: "Open invoices",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
}];

const toolShapes: Record<string, ShapeType> = {
  host_listInvoices: {
    kind: "object",
    fields: {
      data: { kind: "array", items: { kind: "object", fields: { id: { kind: "string" } } } },
    },
  },
};

const catalog: NormalizedCatalog = [];

const deps = (): GenerationDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog,
  tools,
  toolShapes,
});

const documentFrom = (wire: string): AppDocument => {
  const compiled = compileWire(wire, { toolShapes });
  return {
    format: VENDO_APP_FORMAT,
    id: "app_floor_test",
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree as AppDocument["tree"],
  } as AppDocument;
};

const GOOD = '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack gap={12}><Text text="Invoices" variant="heading"/><Table rows={invoices.data}/></Stack></App>';

/** A deliberately bad app: it names a tool the host does not have. */
const BAD = '<App name="Invoices"><Query id="invoices" tool="host_wireMoney"/><Stack><Table rows={invoices.data}/></Stack></App>';

const inputFor = (wire: string, request = "show me my invoices"): CheckInput =>
  ({ document: documentFrom(wire), request });

const factCheck = (name: string, findings: () => Awaited<ReturnType<Extract<Check, { kind: "fact" }>["run"]>>): Check =>
  ({ name, kind: "fact", run: async () => findings() });

describe("CheckInput speaks the core document shape (build contract §5)", () => {
  it("takes a stored AppDocument, so a check over a committed app needs no unwrapping", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    let seen: AppDocument | undefined;
    const spy: Check = { name: "spy", kind: "fact", run: async ({ document }) => { seen = document; return []; } };

    await createCheckingLayer({ deps: deps(), checks: [spy] }).run(inputFor(GOOD));

    expect(seen?.id).toBe("app_floor_test");
    expect(await layer.run(inputFor(GOOD))).toEqual([]);
  });
});

describe("fact checks vs judgment rules", () => {
  it("runs fact checks and never runs a judgment rule as code", async () => {
    let ranFact = false;
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "host-fact", kind: "fact", run: async () => { ranFact = true; return []; } },
        { name: "cite-totals", kind: "judgment", rule: "Totals must cite their query." },
      ],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(ranFact).toBe(true);
    expect(findings).toEqual([]);
  });

  it("exposes judgment rules as separate rubric lines, never concatenated", () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "cite-totals", kind: "judgment", rule: "Totals must cite their query." },
        { name: "no-jargon", kind: "judgment", rule: "Never show a field name to a person." },
      ],
    });

    expect(layer.rubric).toEqual([
      "Totals must cite their query.",
      "Never show a field name to a person.",
    ]);
  });

  it("has an empty rubric when no pack contributed a judgment rule", () => {
    expect(createCheckingLayer({ deps: deps() }).rubric).toEqual([]);
  });

  it("registers both kinds under `checks` so a boot report can name them all", () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "host-fact", kind: "fact", run: async () => [] },
        { name: "cite-totals", kind: "judgment", rule: "Totals must cite their query." },
      ],
    });

    expect(layer.checks.map(({ name }) => name)).toEqual(expect.arrayContaining(["host-fact", "cite-totals"]));
  });
});

describe("the floor holds regardless of the builder", () => {
  it("catches a deliberately bad app with no host check and no reviewer wired", async () => {
    const layer = createCheckingLayer({ deps: deps() });

    const findings = await layer.run(inputFor(BAD));

    expect(findings).toContainEqual({
      severity: "block",
      where: 'query "invoices"',
      message: 'names unknown tool "host_wireMoney"; the host tools are: host_listInvoices',
    });
  });

  it("fires a host check even when the builder skipped self-review", async () => {
    // No reviewer check is registered at all — the plugged check is not
    // downstream of anyone's self-review, so it still reports.
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [factCheck("maple-house-style", () => [
        { severity: "block", where: 'node "n2"', message: "Maple never shows a bare table — wrap it in a Card" },
      ])],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(layer.checks.map(({ name }) => name)).not.toContain("reviewer");
    expect(findings).toContainEqual({
      severity: "block",
      where: 'node "n2"',
      message: "Maple never shows a bare table — wrap it in a Card",
    });
  });

  it("lets a check omit `where` when it cannot name a locus", async () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [factCheck("whole-app", () => [{ severity: "warn", message: "this app feels thin" }])],
    });

    expect(await layer.run(inputFor(GOOD))).toEqual([{ severity: "warn", message: "this app feels thin" }]);
  });
});

describe("a broken check costs its findings, never the build", () => {
  it("turns a throwing fact check into exactly one warn and blocks nothing", async () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [{ name: "flaky", kind: "fact", run: async () => { throw new Error("model call timed out"); } }],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(findings).toEqual([{
      severity: "warn",
      where: "flaky",
      message: 'the check "flaky" failed to run (model call timed out), so whatever it would have found is missing from this report',
    }]);
    expect(findings.filter(({ severity }) => severity === "block")).toEqual([]);
  });

  it("keeps every other check's findings when one throws", async () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "flaky", kind: "fact", run: async () => { throw new Error("boom"); } },
        factCheck("solid", () => [{ severity: "block", where: "document", message: "still reported" }]),
      ],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(findings).toContainEqual({ severity: "block", where: "document", message: "still reported" });
    expect(findings.some(({ where }) => where === "flaky")).toBe(true);
  });
});

describe("findings are order-independent", () => {
  const one = factCheck("one", () => [{ severity: "warn", where: "one", message: "one ran" }]);
  const two = factCheck("two", () => [{ severity: "block", where: "two", message: "two ran" }]);

  it("reports the same set however the checks were registered", async () => {
    const forward = await createCheckingLayer({ deps: deps(), checks: [one, two] }).run(inputFor(GOOD));
    const backward = await createCheckingLayer({ deps: deps(), checks: [two, one] }).run(inputFor(GOOD));

    const key = (findings: readonly { severity: string; where?: string; message: string }[]): string =>
      [...findings].map((finding) => JSON.stringify(finding)).sort().join("|");
    expect(key(forward)).toBe(key(backward));
  });

  it("shows no check another check's findings", async () => {
    const seen: CheckInput[] = [];
    const nosy = (name: string): Check =>
      ({ name, kind: "fact", run: async (input) => { seen.push(input); return [{ severity: "warn", where: name, message: name }]; } });

    await createCheckingLayer({ deps: deps(), checks: [nosy("a"), nosy("b")] }).run(inputFor(GOOD));

    expect(seen).toHaveLength(2);
    // The input a check receives carries the app and the ask — never findings.
    for (const input of seen) expect(Object.keys(input).sort()).toEqual(["document", "request"]);
  });
});
