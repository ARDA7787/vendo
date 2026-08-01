import {
  VendoError,
  type AccessLevel,
  type AppAccess,
  type AppGrantRecord,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import type { memoryStore } from "./memory-store.js";

const RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };



/**
 * A stand-in for `appAccess(store)` over the same rows: the real function lives
 * in @vendoai/store and `apps → core` is the only edge layering allows the
 * runtime (or its tests). It reads the SAME `vendo_app_grants` records with the
 * SAME frozen principal encoding, so the runtime's own grant queries (the
 * `list()` union) are genuinely exercised; the real function is proven against
 * a real database in @vendoai/store's own suite.
 */
export function storeAccessFixture(store: ReturnType<typeof memoryStore>): AppAccess {
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
export const seedGrantRows = async (
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
