import type { RunContext } from "@vendoai/core";
import { parseOrgPolicyFile, type PolicyRule } from "@vendoai/guard";
import { workspaceStore, type VendoStore } from "@vendoai/store";

/** Build contract §9.10 — where an org's policy lives. Owner derivation is a
 *  pure function of the path (§9.7): `/orgs/<orgId>/**` is owned by the org
 *  itself, which is why the file is read as the org rather than as any member.
 *  The admin-only WRITE rule on this path is the workspace's, not this seam's:
 *  nothing here can write. */
export const orgPolicyPath = (orgId: string): string => `/orgs/${orgId}/policy.json`;

/** How long a policy body is reused before it is read again. The contract asks
 *  for per-check memoization at minimum; a short TTL is strictly more than that
 *  and keeps a busy deployment from reading one small file on every tool call.
 *  The cost is bounded and stated: an admin's policy edit takes up to this long
 *  to bind, the same trade the connected-toolkit cache already makes. */
const POLICY_TTL_MS = 30_000;

/** The orgs the caller asserted for this request or fire (§9.1). Memberships
 *  ride the ctx and are never stored, so this is the only place to read them;
 *  a ctx without them (today's default, and every unkeyed deployment) simply
 *  has no orgs. */
const assertedOrgs = (ctx: RunContext): string[] => {
  const memberships = (ctx as RunContext & { memberships?: unknown }).memberships;
  if (!Array.isArray(memberships)) return [];
  return [...new Set(memberships
    .map((entry) => (entry as { org?: unknown } | null)?.org)
    .filter((org): org is string => typeof org === "string" && org.length > 0))];
};

/** The workspace-backed source of policy bodies, TTL-cached per org.
 *
 *  Resolved LAZILY and tolerantly: `workspaceStore` wants a SQL handle, which a
 *  hosted store has not got (harness-turn makes the same allowance). A
 *  deployment with no workspace has no org policy files, which is `undefined`,
 *  not an error — and never a loosening, because org rules can only tighten. */
export function workspacePolicySource(store: VendoStore): (orgId: string) => Promise<string | undefined> {
  const cache = new Map<string, { body: string | undefined; at: number }>();
  let workspace: ReturnType<typeof workspaceStore> | null | undefined;
  const open = (): ReturnType<typeof workspaceStore> | null => {
    if (workspace === undefined) {
      try {
        workspace = workspaceStore(store);
      } catch {
        workspace = null;
      }
    }
    return workspace;
  };
  return async (orgId) => {
    const cached = cache.get(orgId);
    if (cached !== undefined && Date.now() - cached.at < POLICY_TTL_MS) return cached.body;
    // No SQL handle at all (a hosted store) — no workspace, so no policy files
    // anywhere in this deployment. That is an absence, not a failure.
    const workspaces = open();
    let body: string | undefined;
    if (workspaces !== null) {
      try {
        // The org owns its own subtree, so the file is read as the org (§9.5:
        // an org id is a workspace owner verbatim).
        const fs = await workspaces.open({ kind: "user", subject: orgId });
        body = await fs.readFile(orgPolicyPath(orgId));
      } catch (error) {
        // ABSENT is the ordinary case: no policy.json, or no `/orgs` mount in
        // this deployment yet. Anything else is a real read failure and must be
        // heard — treating a broken read as "no policy" is a silent loosening of
        // whatever the admin actually wrote, and it caches for the TTL.
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== "ENOENT" && code !== "EACCES" && code !== "EISDIR") throw error;
        body = undefined;
      }
    }
    cache.set(orgId, { body, at: Date.now() });
    return body;
  };
}

/** Build contract §9.10's guard seam: the union of every asserted org's rules.
 *
 *  Failures are PER ORG. A file that cannot be read or cannot be understood
 *  applies none of ITS rules — never partially, because a policy this layer only
 *  half-understands is not the policy the admin wrote — while every other org's
 *  rules still bind. One broken file used to disarm the whole layer for everyone
 *  in the request, which is the opposite of a tightening layer's job.
 *
 *  Every failure goes to `onFailure`, which the composition seam wires to the
 *  audit trail: the admin whose file is broken can see that their policy is not
 *  in force. Nothing is ever LOOSENED by a bad file — org rules only tighten, so
 *  their absence is the pipeline's own verdict, unchanged. */
export function orgPolicyResolver(
  source: (orgId: string) => Promise<string | undefined>,
  onFailure?: (orgId: string, reason: string) => void | Promise<void>,
): (ctx: RunContext) => Promise<PolicyRule[]> {
  return async (ctx) => {
    const rules: PolicyRule[] = [];
    for (const org of assertedOrgs(ctx)) {
      try {
        const body = await source(org);
        // Absent is the ordinary case — most orgs set no policy — and is not a
        // failure. A read that BLEW UP is (the source throws for that).
        if (body === undefined) continue;
        rules.push(...parseOrgPolicyFile(body, `org ${org}`));
      } catch (error) {
        await onFailure?.(org, error instanceof Error ? error.message : String(error));
      }
    }
    return rules;
  };
}
