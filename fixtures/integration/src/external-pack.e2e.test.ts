/**
 * E5 — a pack authored OUTSIDE this repo's `packages/` tree installs with one
 * config line and works: its tool arrives in the one guarded registry under the
 * name it authored, its fact check fires on a generated app, its judgment rule
 * joins the reviewer's rubric instead of being run, its component is really in
 * the catalog, and its skill loads on demand from the host skills mount.
 *
 * Two packs claiming one tool name fail at boot naming both.
 *
 * The pack under test (`./external-pack/index.ts`) imports `@vendoai/vendo`
 * only — no `@vendoai/core`, no deep path — so if this suite passes, the public
 * interface really is enough to author a pack from outside.
 */
import {
  createTurnSkills,
  projectSkills,
  type PackSkill,
  type SkillsFs,
} from "@vendoai/core";
import { apps, mergePacks, type PackContext } from "@vendoai/vendo/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  generationTurn,
  resetFixture,
  type Stack,
} from "./harness.js";
import { RETENTION_RULE, UNMASKED_ACCOUNT, complianceReports } from "./external-pack/index.js";

/** just-bash's `IFileSystem` slice the skills store uses (build contract §3.2),
 *  in memory — lane B's `WorkspaceFs` is the real thing behind this same shape. */
const memoryFs = (): SkillsFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(["/"]);
  return {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async writeFile(path, content) { files.set(path, content); },
    async mkdir(path) { dirs.add(path); },
    async exists(path) { return files.has(path) || dirs.has(path); },
    getAllPaths() { return [...dirs, ...files.keys()]; },
  };
};

/** A tiny-ask create: the brain writes the whole app on the spot. The account
 *  number is the point — the pack's fact check is what must object to it. */
const CLEAN_APP = '<App name="Retention"><Text text="Report 2026 is clean"/><Disclaimer reason="Fixture app."/></App>';
/** The small-change answer: quote the app's own printed text, say what replaces
 *  it. The replacement carries an unmasked account number — the pack's check is
 *  what must object. */
const LEAK_EDIT = '<Edit><Old>Report 2026 is clean</Old><New>Account 4012888888881881 is clean</New></Edit>';
const APP_USING_PACK_COMPONENT = '<App name="Retention"><RetentionBadge years={7}/><Disclaimer reason="Fixture app."/></App>';
const REVIEW_SILENT = "Nothing to report.";

interface CreatedApp { id?: string; issues?: string[] }
interface EditedApp { app?: { id: string }; issues?: string[] }

let stack: Stack | undefined;
afterEach(async () => {
  const open = stack;
  stack = undefined;
  await open?.close();
});

const running = (): Stack => {
  if (stack === undefined) throw new Error("no stack for this test");
  return stack;
};

const create = async (prompt: string): Promise<CreatedApp> =>
  (await (await running().wireFetch("/apps", { method: "POST", body: JSON.stringify({ prompt }) }, ADA)).json()) as CreatedApp;

const edit = async (appId: string, instruction: string): Promise<EditedApp> =>
  (await (await running().wireFetch(`/apps/${appId}/edit`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  }, ADA)).json()) as EditedApp;

describe("E5: an external pack installs with one config line", () => {
  it("puts the pack's tool in the ONE guarded registry under the name it authored, and runs it", async () => {
    await resetFixture();
    stack = await createStack({ packs: [apps(), complianceReports] });

    const descriptors = await stack.vendo.actions.descriptors();
    const declared = descriptors.find(({ name }) => name === "check_report");

    // The authored name, not "compliance_reports_check_report": nothing is
    // auto-prefixed, because a skill body naming the tool is copied verbatim.
    expect(declared).toMatchObject({ name: "check_report", title: "Check a report", risk: "read" });
    // The app tools still arrived — apps() is a pack now, and adding one does
    // not displace another.
    expect(descriptors.map(({ name }) => name)).toContain("vendo_apps_create");

    // Executed through the SAME guard-bound registry chat and the MCP door use.
    const outcome = await stack.vendo.guard.bind(stack.vendo.actions).execute(
      { id: "call_pack_1", tool: "check_report", args: { reportId: "rep_9" } },
      { principal: ADA, venue: "chat", presence: "present", sessionId: "session_pack_1" },
    );

    expect(outcome).toMatchObject({ status: "ok", output: { reportId: "rep_9", status: "clean" } });
    // Guarded means audited: the call left the same trail every tool call does.
    expect(await stack.sql(
      "SELECT tool FROM vendo_audit WHERE subject = $1 AND kind = 'tool-call' AND tool = $2",
      [ADA.subject, "check_report"],
    )).toHaveLength(1);
  });

  it("fires the pack's fact check on a generated app and reports what it found", async () => {
    await resetFixture();
    stack = await createStack({
      packs: [apps(), complianceReports],
      turns: [
        // Create a clean app, then edit an account number into it: the edit path
        // is the one that hands blocking findings back to the caller.
        generationTurn(CLEAN_APP),
        generationTurn(REVIEW_SILENT, "review_1"),
        generationTurn(LEAK_EDIT, "gen_2"),
        // Two fix rounds: the brain declines to edit, so the finding survives.
        generationTurn(REVIEW_SILENT, "review_2"),
        generationTurn("No change.", "fix_1"),
        generationTurn(REVIEW_SILENT, "review_3"),
        generationTurn("No change.", "fix_2"),
        generationTurn(REVIEW_SILENT, "review_4"),
      ],
    });

    const created = await create("Show me the retention report");
    const leaky = await edit(created.id as string, "Put the full account number in the heading");

    // The host never wired a check; the PACK did, and the floor ran it anyway.
    expect(leaky.issues?.join(" ") ?? "").toContain(UNMASKED_ACCOUNT);
  });

  it("does not block an app the pack's check has nothing to say about", async () => {
    await resetFixture();
    stack = await createStack({
      packs: [apps(), complianceReports],
      turns: [generationTurn(CLEAN_APP), generationTurn(REVIEW_SILENT, "review_1")],
    });

    const clean = await create("Show me the retention report");

    expect(clean.id).toBeDefined();
    expect(clean.issues ?? []).toEqual([]);
  });

  it("registers the pack's component in the catalog the engine builds against", async () => {
    await resetFixture();
    stack = await createStack({
      packs: [apps(), complianceReports],
      turns: [generationTurn(APP_USING_PACK_COMPONENT), generationTurn(REVIEW_SILENT, "review_1")],
    });

    const built = await create("Show the retention badge");

    // An unregistered component is a blocking "absent from the catalog" finding,
    // so building with it and getting no such finding IS the registration proof.
    expect(built.issues?.join(" ") ?? "").not.toContain("absent from the catalog");
    expect(built.id).toBeDefined();
  });
});

describe("E5: the pack's skill loads on demand from the host mount", () => {
  it("projects every merged pack skill to /host/skills/<name>/SKILL.md and loads it back", async () => {
    const context = { apps: () => { throw new Error("no tool runs in this test"); } } as unknown as PackContext;
    const merged = mergePacks([apps(), complianceReports], context);
    const fs = memoryFs();

    await projectSkills(fs, merged.skills);
    const skills = createTurnSkills(fs);
    const listing = await skills.list();

    // Cheap listing: both skills, descriptions only.
    expect(listing.map(({ name }) => name)).toEqual(["building-apps", "building-compliance-reports"]);
    expect(JSON.stringify(listing)).not.toContain("fresh subagent");

    // The full body only when asked for, byte-identical to what the pack authored.
    const authored = merged.skills.find((skill: PackSkill) => skill.name === "building-compliance-reports");
    expect(await skills.load("building-compliance-reports")).toBe(authored?.body);
    expect(await skills.load("building-compliance-reports")).toContain("fresh subagent");
  });
});

describe("E5: judgment rules join the rubric; they are never run", () => {
  it("keeps the pack's judgment rule out of the fact runner and in the rubric as its own line", () => {
    const context = { apps: () => { throw new Error("no tool runs in this test"); } } as unknown as PackContext;
    const merged = mergePacks([complianceReports], context);

    const judgment = merged.checks.find(({ name }) => name === "totals-cite-their-report");
    expect(judgment).toEqual({ name: "totals-cite-their-report", kind: "judgment", rule: RETENTION_RULE });
    // One rule, one line — never folded into another rule's string.
    expect(merged.checks.filter(({ kind }) => kind === "judgment")).toHaveLength(1);
  });
});

describe("E5: two packs claiming one tool name fail at boot", () => {
  it("refuses to compose, naming both packs and the contested name", async () => {
    await resetFixture();
    const rival = { name: "rival-reports", tools: complianceReports.tools };

    await expect(createStack({ packs: [complianceReports, rival] })).rejects.toThrow(
      /check_report[\s\S]*compliance-reports[\s\S]*rival-reports/,
    );
  });
});
