import {
  VendoError,
  type AppId,
  type IsoDateTime,
  type Membership,
  type RunContext,
} from "@vendoai/core";
import type { VendoStore } from "../store.js";

/** Build contract §9.3 — the closed, ORDERED level vocabulary. Defining new
 *  level types is not a surface; assignments are fully flexible. */
export type AccessLevel = "viewer" | "editor" | "owner";

const RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };

/** Build contract §9.3 — what `can()` is asked about. */
export type CanThing = { app: AppId } | { path: string };

/** One stored grant row (build contract §9.2). */
export interface AppGrantRecord {
  id: string;
  appId: AppId;
  orgId: string;
  /** `user:<subject>` · `team:<orgId>/<teamId>` · `org:<orgId>` */
  principal: string;
  level: AccessLevel;
  /** The granting subject, for audit. */
  createdBy: string;
  createdAt: IsoDateTime;
}

/** Build contract §9.3 */
export interface AppAccess {
  can(ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean>;
  levelFor(ctx: RunContext, appId: AppId): Promise<AccessLevel | null>;
  grant(ctx: RunContext, appId: AppId, principal: string, level: AccessLevel): Promise<void>;
  revoke(ctx: RunContext, appId: AppId, principal: string): Promise<void>;
  list(ctx: RunContext, appId: AppId): Promise<AppGrantRecord[]>;
}

/** The grant-principal encoding (§9.2): one string, ref-queryable. Parsed here
 *  and nowhere else — the store door validates writes through this same
 *  function, so a row can never name a shape the matcher below cannot read. */
export type GrantPrincipal =
  | { kind: "user"; subject: string }
  | { kind: "team"; org: string; team: string }
  | { kind: "org"; org: string };

export function parseGrantPrincipal(encoded: string): GrantPrincipal | undefined {
  const separator = encoded.indexOf(":");
  if (separator === -1) return undefined;
  const kind = encoded.slice(0, separator);
  const rest = encoded.slice(separator + 1);
  if (rest === "") return undefined;
  if (kind === "user") return { kind: "user", subject: rest };
  if (kind === "org") return rest.includes("/") ? undefined : { kind: "org", org: rest };
  if (kind === "team") {
    const slash = rest.indexOf("/");
    const org = rest.slice(0, slash);
    const team = rest.slice(slash + 1);
    if (slash === -1 || org === "" || team === "" || team.includes("/")) return undefined;
    return { kind: "team", org, team };
  }
  return undefined;
}

export function isGrantPrincipal(encoded: string): boolean {
  return parseGrantPrincipal(encoded) !== undefined;
}

/** Build contract §3.1 / §9.7 — owner derivation is a pure function of the
 *  path: `/user/**` is the bound subject's, `/orgs/<orgId>/**` is the org's. */
export function orgOfPath(path: string): string | undefined {
  const match = /^\/orgs\/([^/]+)(?:\/|$)/.exec(path);
  return match?.[1];
}

/** `/orgs/<orgId>/apps/<appId>/…` — the app grant governs this subtree. */
export function appOfOrgPath(path: string): AppId | undefined {
  const match = /^\/orgs\/[^/]+\/apps\/([^/]+)\//.exec(path);
  return match?.[1] as AppId | undefined;
}

const memberships = (ctx: RunContext): readonly Membership[] => ctx.memberships ?? [];

const membershipIn = (ctx: RunContext, org: string): Membership | undefined =>
  memberships(ctx).find((entry) => entry.org === org);

/** Does an asserted membership satisfy this grant row's principal? */
function matches(ctx: RunContext, encoded: string): boolean {
  const principal = parseGrantPrincipal(encoded);
  if (principal === undefined) return false;
  if (principal.kind === "user") return principal.subject === ctx.principal.subject;
  const membership = membershipIn(ctx, principal.org);
  if (membership === undefined) return false;
  return principal.kind === "org" || (membership.teams ?? []).includes(principal.team);
}

const higher = (left: AccessLevel | null, right: AccessLevel | null): AccessLevel | null => {
  if (left === null) return right;
  if (right === null) return left;
  return RANK[left] >= RANK[right] ? left : right;
};

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
      if (matches(ctx, row.principal)) level = higher(level, row.level);
    }
    return level;
  };

  /** §9.4 posture in one place: a caller who cannot even view stays masked with
      `not-found`; a proven viewer denied a stronger action gets `forbidden`. */
  const require = async (ctx: RunContext, appId: AppId, level: AccessLevel): Promise<void> => {
    const held = await levelFor(ctx, appId);
    if (held === null) throw new VendoError("not-found", `app not found: ${appId}`);
    if (RANK[held] < RANK[level]) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
  };

  const canPath = (ctx: RunContext, level: AccessLevel, path: string): Promise<boolean> | boolean => {
    if (path === "/user" || path.startsWith("/user/")) return true;
    const org = orgOfPath(path);
    if (org === undefined) return false;
    const membership = membershipIn(ctx, org);
    if (membership === undefined) return false;
    // The org's policy file is the org admins' (§9.10 is lane H's; the mount
    // rule is ours): everyone in the org reads it, only an admin rewrites it.
    if (path === `/orgs/${org}/policy.json`) {
      return RANK[level] <= RANK["viewer"] || membership.admin === true;
    }
    const appId = appOfOrgPath(path);
    // An app's subtree is governed by the app's own grants; the rest of the org
    // mount is the membership's.
    return appId === undefined ? true : can(ctx, level, { app: appId });
  };

  const can = async (ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean> => {
    if ("path" in thing) return await canPath(ctx, level, thing.path);
    const held = await levelFor(ctx, thing.app);
    return held !== null && RANK[held] >= RANK[level];
  };

  return {
    can,
    levelFor,

    async grant(ctx, appId, principal, level) {
      await require(ctx, appId, "owner");
      const orgId = await rowSubject(appId);
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
