/**
 * The LIVE leg: two real people, one org, a shared app — and a real e2b box.
 *
 * The offline sibling (`orgs-materialize.test.ts`) proves the two gates with a
 * scripted SDK loop, which means it proves OUR seams and not the model's hands.
 * This one removes the last stand-in: a real machine, the real box image (the
 * one `packages/apps/box/build-template.mjs` bakes, which carries the walk rule
 * this lane changed), a real Claude Agent SDK session, and a real model deciding
 * for itself which file to open. What is asserted is only what the user would
 * see: Kim asks for a change to the TEAM's app, and Dana sees it.
 *
 * Gated on `E2B_API_KEY` + `ANTHROPIC_API_KEY` + `VENDO_BOX_TEMPLATE`, like every
 * `.live.test.ts`. No MCP door is composed on purpose: the subject here is the
 * workspace, and a box reaching a door needs a public origin this test has no
 * business minting. The harness warns once and runs with its own hands, which
 * is exactly the deployment shape a workspace-only host has.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { UIMessage } from "ai";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { e2bSandbox } from "@vendoai/apps/e2b";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { appAccess, createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const ready = process.env["E2B_API_KEY"] !== undefined
  && process.env["ANTHROPIC_API_KEY"] !== undefined
  && process.env["VENDO_BOX_TEMPLATE"] !== undefined;
const live = ready ? describe : describe.skip;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

const ORG = "acme";
const APP = "app_quarterly";
const APP_PATH = `/orgs/${ORG}/apps/${APP}/app.vendo`;
const SEEDED = '<App name="Quarterly Report">\n  <Heading text="Q2 revenue" />\n</App>\n';

const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Acme", admin: true }],
  kim: [{ org: ORG, display: "Acme" }],
};

const ctxOf = (principal: Principal): RunContext => ({
  principal,
  memberships: memberships[principal.subject] ?? [],
  venue: "app",
  presence: "present",
  sessionId: `s_${principal.subject}`,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-orgs-live-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

const seeded = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** Whose request this is — set per call, the way a real session would. */
let acting: Principal = kim;

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

live("a real box reaches a real team's app", () => {
  it("Kim edits the TEAM's Quarterly Report, and Dana sees the change", async () => {
    const store = await tempStore();
    const vendo = createVendo({
      model: {} as LanguageModel,
      store,
      sandbox: e2bSandbox({ apiKey: process.env["E2B_API_KEY"]!, timeoutMs: 10 * 60_000 }),
      harness: claudeCode({ model: MODEL, maxTurns: 14 }),
      auth: {
        principal: async () => acting,
        memberships: async (principal: Principal) => memberships[principal.subject] ?? [],
      },
    } as Parameters<typeof createVendo>[0]);

    // Dana, the org admin, owns the team's app and shares it with Kim.
    await store.records("vendo_apps").put({
      id: APP,
      data: { subject: ORG, enabled: false, doc: seeded(APP, "Quarterly Report") },
      refs: { subject: ORG },
    });
    await appAccess(store).grant(ctxOf(dana), APP, `user:${kim.subject}`, "editor");
    acting = dana;
    const danas = await vendo.harness.workspace(dana);
    await danas.writeFile(APP_PATH, SEEDED);
    expect(await danas.commit()).toEqual({ status: "ok", changed: [APP_PATH] });

    // Kim — an ordinary member, not the owner — asks for the change in her own
    // words. Nothing tells the model which mount to look in.
    acting = kim;
    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_live_org",
        message: userMessage(
          "m1",
          "Our team's Quarterly Report app says 'Q2 revenue'. Change that heading to say"
          + " 'Q3 revenue' and save it. Edit the existing file — do not make a copy.",
        ),
      }),
    }));
    expect(response.status).toBe(200);
    const wire = await response.text();

    // Dana reads the SAME path. One app, two people (§9.7).
    acting = dana;
    const after = await (await vendo.harness.workspace(dana)).readFile(APP_PATH);
    console.log("[live org edit]", JSON.stringify({ wire: wire.slice(0, 1500), after }));
    expect(wire).not.toContain("missing its workspace machine");
    expect(after).toContain("Q3 revenue");

    // And it edited the team's file rather than inventing a personal duplicate,
    // which is the OTHER shape the old bug produced.
    acting = kim;
    const kims = await vendo.harness.workspace(kim);
    expect(kims.getAllPaths().filter((path) => path.startsWith("/user/apps/"))).toEqual([]);
  }, 600_000);
});
