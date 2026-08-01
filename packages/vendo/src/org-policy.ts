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
    const workspaces = open();
    let body: string | undefined;
    if (workspaces !== null) {
      try {
        // The org owns its own subtree, so the file is read as the org (§9.5:
        // an org id is a workspace owner verbatim).
        const fs = await workspaces.open({ kind: "user", subject: orgId });
        body = await fs.readFile(orgPolicyPath(orgId));
      } catch {
        // No file, no `/orgs` mount yet, no workspace: no org rules.
        body = undefined;
      }
    }
    cache.set(orgId, { body, at: Date.now() });
    return body;
  };
}

/** Build contract §9.10's guard seam: the union of every asserted org's rules.
 *
 *  A MALFORMED file throws rather than degrading to `[]`. That is deliberate,
 *  and it is the same posture the actions registry takes: a layer that cannot
 *  be understood refuses to guess rather than silently dropping the tightening
 *  it was written to apply. The guard catches it, applies no org rules, and
 *  audits the gap so the admin can see their policy is not in force — nothing
 *  is ever LOOSENED by a bad file, because org rules can only tighten. */
export function orgPolicyResolver(
  source: (orgId: string) => Promise<string | undefined>,
): (ctx: RunContext) => Promise<PolicyRule[]> {
  return async (ctx) => {
    const rules: PolicyRule[] = [];
    for (const org of assertedOrgs(ctx)) {
      const body = await source(org);
      if (body === undefined) continue;
      rules.push(...parseOrgPolicyFile(body, `org ${org}`));
    }
    return rules;
  };
}
