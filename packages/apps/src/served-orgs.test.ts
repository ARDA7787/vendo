import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime, type BoxRequest } from "./index.js";
import { fakeBoxSandbox } from "./testing/fake-box.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";
import { storeAccessFixture, seedGrantRows } from "./testing/app-access-fixture.js";

/**
 * Build contract §9.8 — served ORG apps are a wire door, not a snapshot with
 * viewers: `open()` hands back an authenticated proxy URL and `can(viewer)` is
 * checked against LIVE rows on every request through it. Personal served apps
 * keep today's behaviour byte for byte.
 */

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const ctx = (subject: string, orgs: string[] = []): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
  ...(orgs.length === 0 ? {} : { memberships: orgs.map((org) => ({ org })) }),
});

/** A layer-3 document: the machine serves the whole surface. `snapshotRef` has
    to name a snapshot the fake box actually holds, so setup() mints one. */
const servedApp = (id: string, snapshotRef: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Invoice kanban",
  ui: "http",
  machine: { snapshotRef, provisionedAt: "2026-08-01T00:00:00.000Z" },
});

const setup = async (over: Partial<AppsConfig> = {}): Promise<{
  runtime: AppsRuntime;
  store: ReturnType<typeof memoryStore>;
  /** A served app the fake box can actually resume, seeded under `subject`. */
  seed(id: string, subject: string): Promise<void>;
  sandbox: ReturnType<typeof fakeBoxSandbox>;
}> => {
  const store = memoryStore();
  const sandbox = fakeBoxSandbox();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    appAccess: storeAccessFixture(store),
    multiParty: true,
    experimentalMachines: true,
    experimentalServedApps: true,
    machine: { sandbox },
    // The wire fills this with its own base path; the runtime never invents it.
    servedProxyPath: (appId) => `/api/vendo/apps/${appId}/serve/`,
    ...over,
  });
  return {
    runtime,
    store,
    sandbox,
    async seed(id, subject) {
      const box = await sandbox.create({ env: {}, template: "node" });
      const snapshotRef = await box.snapshot();
      await seedAppRow(store, servedApp(id, snapshotRef), subject);
    },
  };
};

describe("§9.8 — open() routes ORG-owned served apps through the proxy", () => {
  it("hands an org app the authenticated proxy URL, never the provider's", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_org_served", "acme");
    await seedGrantRows(store, "app_org_served", { "user:kim": "viewer" });

    const opened = await runtime.open("app_org_served", ctx("kim", ["acme"]));
    expect(opened).toEqual({
      kind: "http",
      url: "/api/vendo/apps/app_org_served/serve/",
    });
  });

  it("leaves a PERSONAL served app on the provider URL, unchanged", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_own_served", "dana");

    const opened = await runtime.open("app_own_served", ctx("dana"));
    expect(opened).toMatchObject({ kind: "http" });
    // Today's behaviour: the machine's own ingress URL, not a host path.
    expect((opened as { url: string }).url).toMatch(/^https?:\/\//);
    expect((opened as { url: string }).url).not.toContain("/serve/");
  });
});

describe("§9.8 — serve() checks can(viewer) against live rows, every request", () => {
  const GET: BoxRequest = { method: "GET", path: "/" };

  it("serves a granted viewer and refuses a stranger", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_serve", "acme");
    await seedGrantRows(store, "app_serve", { "user:kim": "viewer" });

    expect((await runtime.serve("app_serve", GET, ctx("kim", ["acme"]))).status).toBe(200);
    await expect(runtime.serve("app_serve", GET, ctx("mal", ["acme"])))
      .rejects.toMatchObject({ code: "not-found" });
  });

  // The red half of the gate: a mid-session revoke bites the NEXT request.
  it("refuses the next request after the viewer's grant is revoked", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_revoke_serve", "acme");
    await seedGrantRows(store, "app_revoke_serve", { "user:kim": "viewer" });
    const kim = ctx("kim", ["acme"]);
    expect((await runtime.serve("app_revoke_serve", GET, kim)).status).toBe(200);

    // The owner takes the grant away; nothing about kim's session changes.
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };
    await runtime.access.revoke("app_revoke_serve", "user:kim", admin);

    await expect(runtime.serve("app_revoke_serve", GET, kim))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("forwards the PAYLOAD only — no cookie, authorization, or host header crosses", async () => {
    const { runtime, store, seed, sandbox } = await setup();
    await seed("app_payload", "acme");
    await seedGrantRows(store, "app_payload", { "user:kim": "viewer" });

    await runtime.serve("app_payload", {
      method: "POST",
      path: "/checkout",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"ok":true}'),
    }, ctx("kim", ["acme"]));

    // Read what actually crossed the skin, not what we hoped we sent.
    const crossed = sandbox.machines.flatMap((machine) => machine.received)
      .filter((entry) => entry.path === "/checkout");
    expect(crossed).toHaveLength(1);
    expect(Object.keys(crossed[0]!.headers).map((name) => name.toLowerCase()).sort())
      .toEqual(["content-type"]);
  });

  it("wakes the machine only AFTER the access check, never before", async () => {
    // A refused caller must not cost a machine: the check comes first, so a
    // stranger hammering the proxy cannot spin up someone else's box.
    const { runtime, seed, sandbox } = await setup();
    await seed("app_no_wake", "acme");
    const before = sandbox.machines.length;
    await expect(runtime.serve("app_no_wake", GET, ctx("mal", ["acme"])))
      .rejects.toMatchObject({ code: "not-found" });
    expect(sandbox.machines.length).toBe(before);
  });
});
