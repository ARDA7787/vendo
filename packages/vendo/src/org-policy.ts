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

/** What "this org has no policy file" looks like coming out of the workspace.
 *
 *  Its refusals are PLAIN Errors carrying the POSIX code as a message PREFIX
 *  (`ENOENT: no such file or directory, open '/orgs/maple/policy.json'` —
 *  store/workspace-fs.ts); `error.code` is never set. Classifying on `.code`
 *  therefore never matched, and the ordinary case — an org that simply set no
 *  policy — took the FAILURE path: a warning and an audit row on every guarded
 *  call, with the throw skipping the cache so the TTL never engaged. Matching the
 *  prefix is exactly what `workspaceBash`'s REFUSAL regex does with these same
 *  errors. ENOENT: no file · EACCES: no `/orgs` mount in this deployment yet ·
 *  EISDIR: something other than a file at that path. */
const ABSENT_POLICY = /^(ENOENT|EACCES|EISDIR):/;

/** The workspace-backed source of policy bodies, TTL-cached per org.
 *
 *  Resolved LAZILY: `workspaceStore` wants a SQL handle, which a hosted store
 *  has not got (harness-turn makes the same allowance).
 *
 *  A deployment with no workspace is NOT the same thing as an org with no
 *  policy file, and it used to be treated as one — memoized as a permanent
 *  silent `null`. That is the deployment org policy is SOLD for: org policy is
 *  a Cloud feature, and a keyed deployment with no explicit store selects the
 *  hosted store. Every org resolved to no rules, forever, with nothing anywhere
 *  to tell an admin their policy was never in force. So it is reported — once
 *  per deployment, through the same `onFailure` channel a broken read uses
 *  (warning + audit row at the composition seam), and then it goes quiet: an
 *  operator must not be drowned in one unfixable fact on every guarded call.
 *
 *  Reporting it never LOOSENS anything: org rules only tighten, so their
 *  absence leaves the pipeline's own verdict standing. */
export function workspacePolicySource(store: VendoStore): (orgId: string) => Promise<string | undefined> {
  const cache = new Map<string, { body: string | undefined; at: number }>();
  let workspace: ReturnType<typeof workspaceStore> | null | undefined;
  let why = "";
  const open = (): ReturnType<typeof workspaceStore> | null => {
    if (workspace === undefined) {
      try {
        workspace = workspaceStore(store);
      } catch (error) {
        workspace = null;
        why = error instanceof Error ? error.message : String(error);
      }
    }
    return workspace;
  };
  let announced = false;
  return async (orgId) => {
    const cached = cache.get(orgId);
    if (cached !== undefined && Date.now() - cached.at < POLICY_TTL_MS) return cached.body;
    const workspaces = open();
    if (workspaces === null) {
      if (!announced) {
        announced = true;
        throw new Error(
          `this deployment has no workspace, so NO org's policy.json can be read and no org policy is in force anywhere (${why}). `
          + "Org policy files live in the workspace, which needs a store this runtime can open directly — "
          + "a Vendo Cloud hosted store has no local handle. Wire an explicit store (createVendo({ store })) to enforce org policy here.",
        );
      }
      cache.set(orgId, { body: undefined, at: Date.now() });
      return undefined;
    }
    let body: string | undefined;
    try {
      // The org owns its own subtree, so the file is read as the org (§9.5:
      // an org id is a workspace owner verbatim).
      const fs = await workspaces.open({ kind: "user", subject: orgId });
      body = await fs.readFile(orgPolicyPath(orgId));
    } catch (error) {
      // ABSENT is the ordinary case and is CACHED like any other answer, so the
      // TTL engages for it too. Anything else is a real read failure and must
      // be heard — treating a broken read as "no policy" is a silent loosening
      // of whatever the admin actually wrote. A failure is deliberately NOT
      // cached: a transient one must not disable an org's policy for the whole
      // TTL, so it is re-read (and re-reported) until it answers.
      if (!ABSENT_POLICY.test(error instanceof Error ? error.message : String(error))) throw error;
      body = undefined;
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
