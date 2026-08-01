import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_APP_FORMAT, type AppDocument, type Membership, type Principal, type ToolRegistry } from "@vendoai/core";
import { appAccess, createStore, workspaceStore, type VendoStore } from "@vendoai/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

/**
 * E8 — the wave-3 proof bar, over the REAL composition: `createVendo` fills
 * `appAccess`, `multiParty`, `promoteApp` and the memberships seam itself, and
 * every assertion below goes through the actual wire routes a browser calls.
 *
 * Two real people in one org: Dana (org admin) and Kim (ordinary member).
 * Seeded apps only — new-app GENERATION against a host catalog is a known
 * engine failure (#631) and E8 deliberately does not depend on it.
 */

const ORG = "maple";
const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Maple Bank", teams: ["support"], admin: true }],
  kim: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no host tools" } }; },
};

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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-orgs-e8-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Whose request this is — set per call, the way a real session would. */
let acting: Principal = dana;

async function boot(store: VendoStore, opts: { key?: boolean } = {}): Promise<Vendo> {
  // §9.6 — multiParty is filled from the SAME cloud-key read every other Cloud
  // default uses, so this env stub is the whole difference between keyed and
  // keyless. Nothing else in the composition changes.
  if (opts.key !== false) vi.stubEnv("VENDO_API_KEY", "vnd_e8_key");
  const vendo = createVendo({
    store,
    tools,
    auth: {
      principal: async () => acting,
      memberships: async (principal) => memberships[principal.subject] ?? [],
    },
  });
  await store.ensureSchema();
  return vendo;
}

const BASE = "https://maple.test/api/vendo";

async function call(
  vendo: Vendo,
  who: Principal,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  acting = who;
  const response = await vendo.handler(new Request(`${BASE}${path}`, {
    method,
    // The wire's CSRF floor requires application/json on every mutation (a
    // simple credentialed form POST must not reach a route), body or not.
    headers: {
      origin: "https://maple.test",
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const seedApp = async (store: VendoStore, app: AppDocument, subject: string): Promise<void> => {
  await store.records("vendo_apps").put({
    id: app.id,
    data: { subject, enabled: false, doc: app },
    refs: { subject },
  });
};

describe("E8 — two principals, one org, over the real composition", () => {
  let store: VendoStore;
  let vendo: Vendo;

  beforeEach(async () => {
    store = await tempStore();
    vendo = await boot(store);
  });

  it("promote → both see ONE living app", async () => {
    await seedApp(store, seeded("app_dash", "Team dashboard"), "dana");

    // Kim cannot see Dana's personal app at all.
    expect((await call(vendo, kim, "GET", "/apps")).body).toEqual([]);

    expect((await call(vendo, dana, "POST", "/apps/app_dash/promote", { orgId: ORG })).status).toBe(200);
    // The row now belongs to the org, verbatim.
    expect((await store.records("vendo_apps").get("app_dash"))?.refs?.["subject"]).toBe(ORG);

    // Dana still reaches it (the owner grant promote minted), and Kim reaches it
    // as an ordinary member once she is granted — one app, two people.
    expect((await call(vendo, dana, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_dash"]);
    await call(vendo, dana, "POST", "/apps/app_dash/grants", { principal: "user:kim", level: "viewer" });
    expect((await call(vendo, kim, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_dash"]);
    // The SAME app id — not a copy.
    expect((await call(vendo, kim, "GET", "/apps/app_dash")).body.name).toBe("Team dashboard");
  });

  it("a viewer denied an edit gets forbidden (403) and can fork", async () => {
    await seedApp(store, seeded("app_view", "Shared view"), ORG);
    await call(vendo, dana, "POST", "/apps/app_view/grants", { principal: "user:kim", level: "viewer" });

    const denied = await call(vendo, kim, "POST", "/apps/app_view/edit", { instruction: "make it blue" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");

    // ...and the offer behind that code works: her own copy, in her workspace.
    const forked = await call(vendo, kim, "POST", "/apps/app_view/fork");
    expect(forked.status).toBe(200);
    expect(forked.body.forkedFrom).toBe("app_view");
    expect((await store.records("vendo_apps").get(forked.body.id))?.refs?.["subject"]).toBe("kim");
    // Grants never travel: nothing points at the copy.
    expect((await store.records("vendo_app_grants").list({ refs: { app_id: forked.body.id } })).records)
      .toEqual([]);

    // A caller with NO access at all stays masked — never 403.
    acting = { kind: "user", subject: "stranger" };
    const masked = await call(vendo, { kind: "user", subject: "stranger" }, "POST", "/apps/app_view/edit", {
      instruction: "make it blue",
    });
    expect(masked.status).toBe(404);
  });

  it("revoke → reads age, the next write fails against LIVE rows", async () => {
    await seedApp(store, seeded("app_rev", "Revocable"), ORG);
    await call(vendo, dana, "POST", "/apps/app_rev/grants", { principal: "user:kim", level: "editor" });
    expect((await call(vendo, kim, "GET", "/apps/app_rev")).status).toBe(200);

    const revoked = await call(vendo, dana, "DELETE", "/apps/app_rev/grants?principal=user%3Akim");
    expect(revoked.status).toBe(200);

    // The app is masked again, and a write is refused against live rows.
    expect((await call(vendo, kim, "GET", "/apps/app_rev")).status).toBe(404);
    // A workspace commit is the other live-rows door (§9.7): a session that
    // already checked out keeps what it read, but cannot land a write.
    const workspace = workspaceStore(store);
    const path = `/orgs/${ORG}/apps/app_rev/app.vendo`;
    expect(await workspace.canCommit({ principal: kim, memberships: memberships["kim"] }, path)).toBe(false);
    expect(await workspace.canCommit({ principal: dana, memberships: memberships["dana"] }, path)).toBe(true);
  });

  it("per-user app data inside a promoted app stays subject-partitioned", async () => {
    await seedApp(store, seeded("app_data", "Shared with private state"), ORG);
    await call(vendo, dana, "POST", "/apps/app_data/grants", { principal: "user:kim", level: "editor" });

    // App storage is keyed (appId, subject) — promotion changes nothing about
    // that, which is exactly why per-user data needs no new machinery.
    const state = store.records("vendo_state");
    await state.put({ id: "app_data:dana", data: { draft: "dana's numbers" } });
    await state.put({ id: "app_data:kim", data: { draft: "kim's numbers" } });

    expect((await state.get("app_data:dana"))?.data).toEqual({ draft: "dana's numbers" });
    expect((await state.get("app_data:kim"))?.data).toEqual({ draft: "kim's numbers" });
    const rows = await state.list({ refs: { app_id: "app_data" } });
    expect(rows.records.map((row) => row.id).sort()).toEqual(["app_data:dana", "app_data:kim"]);
  });

  it("two concurrent /orgs commits to one file: one ok, one conflict (E3's org slice)", async () => {
    const workspace = workspaceStore(store);
    const path = `/orgs/${ORG}/files/handbook.md`;
    const seed = await workspace.open(dana, { memberships: memberships["dana"] });
    await seed.writeFile(path, "v1");
    await seed.commit();

    const mine = await workspace.open(dana, { memberships: memberships["dana"] });
    const theirs = await workspace.open(kim, { memberships: memberships["kim"] });
    await mine.writeFile(path, "dana's v2");
    await theirs.writeFile(path, "kim's v2");

    expect(await mine.commit()).toEqual({ status: "ok", changed: [path] });
    expect(await theirs.commit()).toEqual({ status: "conflict", paths: [path] });
  });

  it("the memberships seam is asserted per request and never stored", async () => {
    await seedApp(store, seeded("app_asserted", "Asserted"), ORG);
    await call(vendo, dana, "POST", "/apps/app_asserted/grants", { principal: `org:${ORG}`, level: "viewer" });
    // The org-wide grant reaches Kim because the host asserts her membership.
    expect((await call(vendo, kim, "GET", "/apps/app_asserted")).status).toBe(200);

    // Stop asserting it — nothing was persisted, so access simply stops.
    const restore = memberships["kim"]!;
    memberships["kim"] = [];
    try {
      expect((await call(vendo, kim, "GET", "/apps/app_asserted")).status).toBe(404);
    } finally {
      memberships["kim"] = restore;
    }
    // ...and no Vendo table anywhere holds a membership row: the org tables the
    // pre-wave-3 design once had are gone and were deliberately not re-added
    // (§9.1 — the host's identity system IS the org).
    const tables = await (store.raw() as { query(sql: string): Promise<{ rows: Array<{ table_name: string }> }> })
      .query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const names = tables.rows.map((row) => row.table_name);
    expect(names).not.toContain("vendo_orgs");
    expect(names).not.toContain("vendo_org_members");
    // The ONLY multi-party rows are the grants (§9.2).
    expect(names.filter((name) => name.includes("grant")).sort())
      .toEqual(["vendo_app_grants", "vendo_grants", "vendo_mcp_grants"]);
  });
});

describe("E8 — §9.6: the key gates the WRITES, never the enforcement", () => {
  it("refuses grant and promote with no key, while can() answers identically", async () => {
    const store = await tempStore();
    const vendo = await boot(store, { key: false });
    await seedApp(store, seeded("app_keyless", "Keyless"), ORG);
    // A grant row written directly (as a keyed deployment would have) so the
    // comparison is "same rows, different key", which is the actual claim.
    await store.records("vendo_app_grants").put({
      id: "ag_keyless",
      data: { appId: "app_keyless", orgId: ORG, principal: "user:kim", level: "viewer", createdBy: "dana" },
      refs: { app_id: "app_keyless", principal: "user:kim", level: "viewer" },
    });

    const share = await call(vendo, dana, "POST", "/apps/app_keyless/grants", {
      principal: "user:sam",
      level: "viewer",
    });
    expect(share.status).toBe(402);
    expect(share.body.error.code).toBe("cloud-required");

    await seedApp(store, seeded("app_keyless_own", "Mine"), "dana");
    const promote = await call(vendo, dana, "POST", "/apps/app_keyless_own/promote", { orgId: ORG });
    expect(promote.status).toBe(402);

    // ...and `can()` is untouched by the key: the existing row still grants.
    const access = appAccess(store);
    const ctx = {
      principal: kim,
      venue: "app" as const,
      presence: "present" as const,
      sessionId: "s",
      memberships: memberships["kim"]!,
    };
    expect(await access.levelFor(ctx, "app_keyless")).toBe("viewer");
    expect((await call(vendo, kim, "GET", "/apps/app_keyless")).status).toBe(200);
    // Reading the grant list stays OSS too.
    expect((await call(vendo, kim, "GET", "/apps/app_keyless/grants")).body.grants).toHaveLength(1);
  });
});
