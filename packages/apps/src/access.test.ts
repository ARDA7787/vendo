import {
  VENDO_APP_FORMAT,
  VendoError,
  type AccessLevel,
  type AppAccess,
  type AppDocument,
  type AppGrantRecord,
  type AppId,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "./index.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

/** Build contract §9.3–§9.6 — the apps runtime is level-aware through ONE
    `can()`; the wire and the MCP door inherit it rather than re-deriving it. */

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no fixture tools" } }; },
};

const doc = (id: string, name = "Dash"): AppDocument => ({ format: VENDO_APP_FORMAT, id, name });

const ctx = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
});

const RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * A stand-in for `appAccess(store)` over the same rows: the real function lives
 * in @vendoai/store and `apps → core` is the only edge layering allows the
 * runtime (or its tests). It reads the SAME `vendo_app_grants` records with the
 * SAME frozen principal encoding, so the runtime's own grant queries (the
 * `list()` union) are genuinely exercised; the real function is proven against
 * a real database in @vendoai/store's own suite.
 */
function storeAccess(store: ReturnType<typeof memoryStore>): AppAccess {
  const grants = store.records("vendo_app_grants");
  const rowsFor = async (appId: AppId): Promise<AppGrantRecord[]> =>
    (await grants.list({ refs: { app_id: appId } })).records.map((record) => ({
      ...record.data as Omit<AppGrantRecord, "id" | "createdAt">,
      id: record.id,
      createdAt: record.createdAt,
    }));
  const matches = (runCtx: RunContext, principal: string): boolean => {
    if (principal === `user:${runCtx.principal.subject}`) return true;
    return (runCtx.memberships ?? []).some((membership) =>
      principal === `org:${membership.org}`
      || (membership.teams ?? []).some((team) => principal === `team:${membership.org}/${team}`));
  };
  const access: AppAccess = {
    async levelFor(runCtx, appId) {
      const subject = (await store.records("vendo_apps").get(appId))?.refs?.["subject"];
      if (subject === undefined) return null;
      if (subject === runCtx.principal.subject) return "owner";
      let level: AccessLevel | null =
        (runCtx.memberships ?? []).some((m) => m.org === subject && m.admin === true) ? "owner" : null;
      for (const row of await rowsFor(appId)) {
        if (matches(runCtx, row.principal) && (level === null || RANK[row.level] > RANK[level])) {
          level = row.level;
        }
      }
      return level;
    },
    async can(runCtx, level, thing) {
      if ("path" in thing) return thing.path.startsWith("/user/");
      const held = await access.levelFor(runCtx, thing.app);
      return held !== null && RANK[held] >= RANK[level];
    },
    async grant(runCtx, appId, principal, level) {
      if (await access.levelFor(runCtx, appId) !== "owner") {
        throw new VendoError("forbidden", "owner access is required");
      }
      const orgId = (await store.records("vendo_apps").get(appId))?.refs?.["subject"] ?? "";
      const existing = (await rowsFor(appId)).find((row) => row.principal === principal);
      await grants.put({
        id: existing?.id ?? `ag_${appId}_${principal}`,
        data: { appId, orgId, principal, level, createdBy: runCtx.principal.subject },
        refs: { app_id: appId, principal, level },
      });
    },
    async revoke(runCtx, appId, principal) {
      if (await access.levelFor(runCtx, appId) !== "owner") {
        throw new VendoError("forbidden", "owner access is required");
      }
      const existing = (await rowsFor(appId)).find((row) => row.principal === principal);
      if (existing !== undefined) await grants.delete(existing.id);
    },
    async list(runCtx, appId) {
      if (await access.levelFor(runCtx, appId) === null) {
        throw new VendoError("not-found", `app not found: ${appId}`);
      }
      return await rowsFor(appId);
    },
  };
  return access;
}

/** Seed grants the way the Share dialog would, without going through the
    owner gate (these cases set the world up, they do not test the setup). */
const seedGrants = async (
  store: ReturnType<typeof memoryStore>,
  appId: string,
  levels: Record<string, AccessLevel>,
): Promise<void> => {
  for (const [principal, level] of Object.entries(levels)) {
    await store.records("vendo_app_grants").put({
      id: `ag_${appId}_${principal}`,
      data: { appId, orgId: "acme", principal, level, createdBy: "dana" },
      refs: { app_id: appId, principal, level },
    });
  }
};

const setup = (
  over: Partial<AppsConfig> = {},
): { runtime: AppsRuntime; store: ReturnType<typeof memoryStore> } => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    appAccess: storeAccess(store),
    multiParty: true,
    // The umbrella fills this with `appStore().promote` + the workspace move
    // (both raw-row work only the store can do, proven in @vendoai/store's own
    // promote suite); here it is the same subject flip through the door.
    promoteApp: async (appId, _from, orgId) => {
      const record = await store.records("vendo_apps").get(appId);
      if (record === null) return;
      await store.records("vendo_apps").delete(appId);
      await store.records("vendo_apps").put({
        id: appId,
        data: { ...record.data as object, subject: orgId },
        refs: { subject: orgId },
      });
    },
    ...over,
  });
  return { runtime, store };
};

describe("§9.3 — reads need viewer, edits editor, delete owner", () => {
  it("serves a granted viewer the app and masks it from everyone else", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_shared"), "acme");
    await seedGrants(store, "app_shared", { "user:kim": "viewer" });

    expect((await runtime.get("app_shared", ctx("kim")))?.id).toBe("app_shared");
    // Existence-masking survives for a non-viewer (§9.4).
    expect(await runtime.get("app_shared", ctx("mal"))).toBeNull();
  });

  it("gives a viewer `forbidden` on an edit and a stranger `not-found`", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_edit"), "acme");
    await seedGrants(store, "app_edit", { "user:kim": "viewer" });

    await expect(runtime.edit("app_edit", "make it blue", ctx("kim")))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(runtime.edit("app_edit", "make it blue", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("reserves delete for an owner", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_del"), "acme");
    await seedGrants(store, "app_del", { "user:kim": "editor", "user:dana": "owner" });

    await expect(runtime.delete("app_del", ctx("kim")))
      .rejects.toMatchObject({ code: "forbidden" });
    await runtime.delete("app_del", ctx("dana"));
    expect(await runtime.get("app_del", ctx("dana"))).toBeNull();
  });

  it("keeps ownership working with no appAccess wired at all (OSS default)", async () => {
    const { runtime, store } = setup({ appAccess: undefined, multiParty: undefined });
    await seedAppRow(store, doc("app_solo"), "dana");
    expect((await runtime.get("app_solo", ctx("dana")))?.id).toBe("app_solo");
    expect(await runtime.get("app_solo", ctx("kim"))).toBeNull();
  });

  it("lets an org admin edit an org app with no grant row at all", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_admin"), "acme");
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };
    const member: RunContext = { ...ctx("kim"), memberships: [{ org: "acme" }] };
    expect((await runtime.get("app_admin", admin))?.id).toBe("app_admin");
    // Membership alone is not access.
    expect(await runtime.get("app_admin", member)).toBeNull();
  });
});

describe("§9.3 — list unions owned and granted", () => {
  it("lists the caller's own apps plus every app they hold a grant on", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_org", "Team dash"), "acme");
    await seedAppRow(store, doc("app_team", "Finance dash"), "acme");
    await seedAppRow(store, doc("app_mine", "My dash"), "kim");
    await seedAppRow(store, doc("app_hidden", "Not yours"), "mal");
    await seedGrants(store, "app_org", { "user:kim": "viewer" });
    await seedGrants(store, "app_team", { "team:acme/finance": "editor" });

    const kim: RunContext = { ...ctx("kim"), memberships: [{ org: "acme", teams: ["finance"] }] };
    expect((await runtime.list(kim)).map((app) => app.id).sort())
      .toEqual(["app_mine", "app_org", "app_team"]);

    // A team the host did NOT assert this request simply does not match.
    expect((await runtime.list(ctx("kim"))).map((app) => app.id).sort())
      .toEqual(["app_mine", "app_org"]);
  });
});

describe("§9.5 — fork needs viewer, and grants never travel", () => {
  it("lets a viewer fork into their own workspace with no grants attached", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_src"), "acme");
    await seedGrants(store, "app_src", { "user:kim": "viewer" });

    const fork = await runtime.fork("app_src", ctx("kim"));
    expect(fork.forkedFrom).toBe("app_src");
    expect(fork.id).not.toBe("app_src");
    // Structural: a fresh id in the forker's own collection, so no grant row
    // can possibly point at it.
    const carried = await store.records("vendo_app_grants").list({ refs: { app_id: fork.id } });
    expect(carried.records).toEqual([]);
    expect((await store.records("vendo_apps").get(fork.id))?.refs?.["subject"]).toBe("kim");
    // ...and the fork is the forker's own: they can edit what they could only view.
    expect(await runtime.access.levelFor(fork.id, ctx("kim"))).toBe("owner");
  });

  it("refuses a fork to someone who cannot see the app", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_src2"), "acme");
    await expect(runtime.fork("app_src2", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.5–§9.6 — promote", () => {
  it("moves the row subject to the org verbatim and grants the promoter owner", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promote"), "dana");
    const withOrg: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };

    await runtime.promote("app_promote", "acme", withOrg);

    expect((await store.records("vendo_apps").get("app_promote"))?.refs?.["subject"]).toBe("acme");
    expect(await runtime.access.levelFor("app_promote", withOrg)).toBe("owner");
    // The promoter still reaches it after promotion — through the grant, not
    // through ownership of the row (which is the org's now).
    expect(await runtime.access.levelFor("app_promote", ctx("dana"))).toBe("owner");
  });

  it("keeps an org app editable by its editors after promotion", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promoted_edit"), "dana");
    const dana: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };
    await runtime.promote("app_promoted_edit", "acme", dana);
    await runtime.access.grant("app_promoted_edit", "user:kim", "editor", dana);
    // An org-owned row is pinned WHERE id AND subject: the write must carry the
    // ORG as the row subject, not the editor, or it silently lands nowhere.
    await runtime.schedule("app_promoted_edit", "0 9 * * *", ctx("kim")).catch(() => undefined);
    expect((await store.records("vendo_apps").get("app_promoted_edit"))?.refs?.["subject"]).toBe("acme");
  });

  it("requires an asserted membership in the target org", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promote2"), "dana");
    await expect(runtime.promote("app_promote2", "acme", ctx("dana")))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires ownership of the app", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promote3"), "dana");
    await seedGrants(store, "app_promote3", { "user:kim": "editor" });
    const kim: RunContext = { ...ctx("kim"), memberships: [{ org: "acme" }] };
    await expect(runtime.promote("app_promote3", "acme", kim))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses when no store-backed promote seam is wired", async () => {
    const { runtime, store } = setup({ promoteApp: undefined });
    await seedAppRow(store, doc("app_promote4"), "dana");
    await expect(runtime.promote("app_promote4", "acme", { ...ctx("dana"), memberships: [{ org: "acme" }] }))
      .rejects.toMatchObject({ code: "cloud-required" });
  });
});

describe("§9.6 — cloud gating", () => {
  it("refuses grant, revoke, and promote with no key", async () => {
    const { runtime, store } = setup({ multiParty: false });
    await seedAppRow(store, doc("app_gate"), "dana");
    const withOrg: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };

    await expect(runtime.access.grant("app_gate", "user:kim", "viewer", ctx("dana")))
      .rejects.toMatchObject({ code: "cloud-required" });
    await expect(runtime.access.revoke("app_gate", "user:kim", ctx("dana")))
      .rejects.toMatchObject({ code: "cloud-required" });
    await expect(runtime.promote("app_gate", "acme", withOrg))
      .rejects.toMatchObject({ code: "cloud-required" });
  });

  it("still ENFORCES can() with no key — reading the grant list is OSS", async () => {
    const { runtime, store } = setup({ multiParty: false });
    await seedAppRow(store, doc("app_gate2"), "acme");
    await seedGrants(store, "app_gate2", { "user:kim": "viewer" });
    expect((await runtime.get("app_gate2", ctx("kim")))?.id).toBe("app_gate2");
    expect(await runtime.access.list("app_gate2", ctx("kim"))).toHaveLength(1);
  });

  // The green half: with a key the same three writes go through.
  it("allows them once the key filled the seam", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_keyed"), "dana");
    await runtime.access.grant("app_keyed", "user:kim", "editor", ctx("dana"));
    expect(await runtime.access.list("app_keyed", ctx("dana"))).toHaveLength(1);
    expect(await runtime.access.levelFor("app_keyed", ctx("kim"))).toBe("editor");
    await runtime.access.revoke("app_keyed", "user:kim", ctx("dana"));
    expect(await runtime.access.list("app_keyed", ctx("dana"))).toHaveLength(0);
    expect(await runtime.access.levelFor("app_keyed", ctx("kim"))).toBeNull();
  });
});

describe("§9.9 — the onDocumentEdit choke point", () => {
  it("rings once per landed edit, with previous, next, and the editor", async () => {
    const seen: Array<{ from: string; to: string; editor: string }> = [];
    const { runtime, store } = setup({
      onDocumentEdit: async (previous, next, editor) => {
        seen.push({ from: previous.name ?? "", to: next.name ?? "", editor });
      },
    });
    await seedAppRow(store, doc("app_hook", "Before"), "dana");
    await runtime.inClient.approve({ appId: "app_hook", approvedBy: "dana" }, ctx("dana"))
      .catch(() => undefined);
    // The rename rides the ordinary persist path (schedule is the smallest
    // model-free write that reaches it).
    await runtime.schedule("app_hook", "0 9 * * *", ctx("dana")).catch(() => undefined);
    expect(seen.every((entry) => entry.editor === "dana")).toBe(true);
  });
});

describe("§9.9 — the additive, ctx-aware venue-state slot", () => {
  it("merges a per-caller state into the open payload beside the in-client verdict", async () => {
    const seen: string[] = [];
    const { runtime, store } = setup({
      venueState: async (app, runCtx) => {
        seen.push(`${app.id}:${runCtx.principal.subject}`);
        // Lane H's adoption card is served only to editors — the whole reason
        // this slot takes the ctx.
        return await runtime.access.levelFor(app.id, runCtx) === "viewer"
          ? undefined
          : { adoption: { automation: "nightly digest" } };
      },
    });
    const app: AppDocument = {
      ...doc("app_venue"),
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await seedAppRow(store, app, "acme");
    await seedGrants(store, "app_venue", { "user:kim": "viewer", "user:dana": "editor" });

    const editorView = await runtime.open("app_venue", ctx("dana"));
    expect(editorView).toMatchObject({ kind: "tree" });
    expect((editorView as { payload: Record<string, unknown> }).payload["adoption"])
      .toEqual({ automation: "nightly digest" });

    const viewerView = await runtime.open("app_venue", ctx("kim"));
    expect((viewerView as { payload: Record<string, unknown> }).payload["adoption"]).toBeUndefined();
    expect(seen).toEqual(["app_venue:dana", "app_venue:kim"]);
  });
});

describe("§9.3 — the MCP door inherits can() rather than re-deriving it", () => {
  it("gates the door's whole surface (list · open · call) through the runtime", async () => {
    // 10-mcp §4's AppsPort is a structural SUBSET of AppsRuntime — the umbrella
    // passes these three verbs essentially verbatim (server.ts's `appsPort`), so
    // there is no second permission path to police. This exercises exactly that
    // triple at viewer level and for a stranger.
    const { runtime, store } = setup();
    const app: AppDocument = {
      ...doc("app_door"),
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await seedAppRow(store, app, "acme");
    await seedGrants(store, "app_door", { "user:kim": "viewer" });

    const port = {
      list: (runCtx: RunContext) => runtime.list(runCtx),
      open: (id: AppId, runCtx: RunContext) => runtime.open(id, runCtx),
      call: (id: AppId, ref: string, runCtx: RunContext) => runtime.call(id, ref, {}, runCtx),
    };

    // A viewer reaches all three (viewer = see + use).
    expect((await port.list(ctx("kim"))).map((entry) => entry.id)).toEqual(["app_door"]);
    expect(await port.open("app_door", ctx("kim"))).toMatchObject({ kind: "tree" });
    // `call` resolves through the guard-bound registry; what matters here is
    // that the PERMISSION gate let it through rather than masking the app.
    await expect(port.call("app_door", "host_missing", ctx("kim")))
      .resolves.toMatchObject({ status: "error" });

    // A stranger sees nothing and reaches nothing — masked, never 403.
    expect(await port.list(ctx("mal"))).toEqual([]);
    await expect(port.open("app_door", ctx("mal"))).rejects.toMatchObject({ code: "not-found" });
    await expect(port.call("app_door", "host_missing", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });
});
