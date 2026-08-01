import type { AppId, IsoDateTime } from "./ids.js";
import type { RunContext } from "./run-context.js";

/**
 * Build contract §9.3 — the `can()` seam.
 *
 * The SHAPE lives here and the implementation lives in `@vendoai/store`
 * (`appAccess(store)`, re-exported from there): the apps runtime, the wire and
 * the MCP door all speak this interface, and `apps → core` is the only edge
 * layering allows them (dependency-guard). Same split as `Check`/`Finding`.
 */

/** The closed, ORDERED level vocabulary. Assignments are fully flexible;
    defining new level types is deliberately not a surface. */
export type AccessLevel = "viewer" | "editor" | "owner";

/** What `can()` is asked about: an app, or a workspace path. */
export type CanThing = { app: AppId } | { path: string };

/** One stored grant (build contract §9.2) — the only multi-party rows Vendo
    keeps. `principal` is one string: `user:<subject>` · `team:<orgId>/<teamId>`
    · `org:<orgId>`, matched against the memberships the host ASSERTS. */
export interface AppGrantRecord {
  id: string;
  appId: AppId;
  orgId: string;
  principal: string;
  level: AccessLevel;
  /** The granting subject, for audit. */
  createdBy: string;
  createdAt: IsoDateTime;
}

/** Build contract §9.3 — one function, three doors. */
export interface AppAccess {
  can(ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean>;
  levelFor(ctx: RunContext, appId: AppId): Promise<AccessLevel | null>;
  grant(ctx: RunContext, appId: AppId, principal: string, level: AccessLevel): Promise<void>;
  revoke(ctx: RunContext, appId: AppId, principal: string): Promise<void>;
  list(ctx: RunContext, appId: AppId): Promise<AppGrantRecord[]>;
}
