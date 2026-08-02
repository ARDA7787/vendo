import {
  VendoError,
  accessForPath,
  grantMatches,
  holdsLevel,
  parseGrantPrincipal,
  strongerLevel,
  type AccessLevel,
  type AppAccess,
  type AppGrantRecord,
  type AppId,
  type CanThing,
  type IsoDateTime,
  type Membership,
  type RunContext,
} from "@vendoai/core";
import type { VendoStore } from "../store.js";

/** Build contract §9.3 — the SHAPES and the PURE rules (the principal grammar,
 *  the level order, the path rules) live in core, so the apps runtime's test
 *  stand-in resolves access through the very same functions; only the ROW
 *  reading is here, because only the store can do it. */
export type { AccessLevel, AppAccess, AppGrantRecord, CanThing, GrantPrincipal } from "@vendoai/core";
export { appOfOrgPath, isGrantPrincipal, orgOfPath, parseGrantPrincipal } from "@vendoai/core";

const membershipIn = (ctx: RunContext, org: string): Membership | undefined =>
  (ctx.memberships ?? []).find((entry) => entry.org === org);

/**
 * Build contract §9.3 — `can()`, one function, three doors (the workspace
 * façade, the wire, and the MCP door all reach it through the apps runtime).
 *
 * It is OSS and NEVER key-conditional: with no Cloud key no grant row can be
 * written, so it simply degenerates to "is it yours?" (§9.6). Memberships come
 * from the ctx ONLY — the host asserted them this request and `can()` never
 * queries an org chart, because Vendo does not have one (§9.1).
 *
 * Everything goes through the ADAPTER interface (`store.records`), never raw
 * SQL: multi-party deployments are exactly the ones running on a hosted store,
 * which has no local db handle.
 */
export function appAccess(store: VendoStore): AppAccess {
  const grants = store.records("vendo_app_grants");
  const apps = store.records("vendo_apps");

  const rowSubject = async (appId: AppId): Promise<string | undefined> => {
    const record = await apps.get(appId);
    return record === null ? undefined : record.refs?.["subject"];
  };

  const recordOf = (record: {
    id: string;
    data: unknown;
    createdAt: IsoDateTime;
  }): AppGrantRecord => {
    const data = record.data as Omit<AppGrantRecord, "id" | "createdAt">;
    return { ...data, id: record.id, createdAt: record.createdAt };
  };

  const grantsFor = async (appId: AppId): Promise<AppGrantRecord[]> =>
    (await grants.list({ refs: { app_id: appId }, limit: 500 })).records.map(recordOf);

  const levelFor = async (ctx: RunContext, appId: AppId): Promise<AccessLevel | null> => {
    const subject = await rowSubject(appId);
    if (subject === undefined) return null;
    // Ownership, then org-admin: an admin of the org that HOLDS the row is an
    // implicit owner of every app in it (§9.3).
    if (subject === ctx.principal.subject) return "owner";
    let level: AccessLevel | null = membershipIn(ctx, subject)?.admin === true ? "owner" : null;
    for (const row of await grantsFor(appId)) {
      if (grantMatches(ctx, row.principal)) level = strongerLevel(level, row.level);
    }
    return level;
  };

  /** §9.4 posture in one place: a caller who cannot even view stays masked with
      `not-found`; a proven viewer denied a stronger action gets `forbidden`. */
  const require = async (ctx: RunContext, appId: AppId, level: AccessLevel): Promise<void> => {
    const held = await levelFor(ctx, appId);
    if (held === null) throw new VendoError("not-found", `app not found: ${appId}`);
    if (!holdsLevel(held, level)) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
  };

  const can = async (ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean> => {
    if ("path" in thing) {
      // core decides everything a path decides without rows; what is left is the
      // one case that needs them — an app's own subtree, governed by its grants.
      const resolved = accessForPath(ctx, level, thing.path);
      return "app" in resolved ? await can(ctx, level, { app: resolved.app }) : resolved.decision;
    }
    return holdsLevel(await levelFor(ctx, thing.app), level);
  };

  return {
    can,
    levelFor,

    async grant(ctx, appId, principal, level) {
      await require(ctx, appId, "owner");
      const orgId = await rowSubject(appId);
      // §9.2 — `org_id` is "the org whose workspace holds the app", so a
      // team:/org: principal from anywhere else can never be satisfied: the
      // matcher keys on the org that HOLDS the row. Storing it anyway would
      // show a share in the list that grants nothing.
      const named = parseGrantPrincipal(principal);
      if (named !== undefined && named.kind !== "user" && named.org !== orgId) {
        throw new VendoError(
          "validation",
          `this app is not in ${named.org}'s workspace, so ${named.org} cannot be given access to it`
          + ` — move the app into ${named.org} first (sharing offers to), then share it`,
        );
      }
      await grants.put({
        id: `ag_${globalThis.crypto.randomUUID()}`,
        data: { appId, orgId, principal, level, createdBy: ctx.principal.subject },
      });
    },

    async revoke(ctx, appId, principal) {
      await require(ctx, appId, "owner");
      const existing = (await grantsFor(appId)).find((row) => row.principal === principal);
      if (existing !== undefined) await grants.delete(existing.id);
    },

    async list(ctx, appId) {
      await require(ctx, appId, "viewer");
      return await grantsFor(appId);
    },
  };
}
