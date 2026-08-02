import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgPolicyPath, orgPolicyResolver, workspacePolicySource } from "./org-policy.js";

/** Build contract §9.10, the composition half: which files get read for whom,
 *  and what a bad one does. The clamp itself is the guard's (org-policy.test.ts
 *  there); this is the seam that feeds it. */

const ctx = (memberships?: unknown): RunContext => ({
  principal: { kind: "user", subject: "user_dana" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...(memberships === undefined ? {} : { memberships }),
} as RunContext);

const policy = (rules: unknown[]): string =>
  JSON.stringify({ format: "vendo/org-policy@1", rules });

describe("org policy resolution at the composition seam", () => {
  it("reads nothing at all when the caller asserted no orgs", async () => {
    const source = vi.fn();
    expect(await orgPolicyResolver(source)(ctx())).toEqual([]);
    expect(source).not.toHaveBeenCalled();
  });

  it("unions the rules of every asserted org, once per org", async () => {
    const source = vi.fn(async (org: string) =>
      org === "maple"
        ? policy([{ match: { risk: "destructive" }, action: "block" }])
        : policy([{ match: { tool: "host_pay*" }, action: "ask" }]));

    const rules = await orgPolicyResolver(source)(ctx([
      { org: "maple", admin: true },
      { org: "cadence" },
      { org: "maple" },
    ]));

    expect(rules).toEqual([
      { match: { risk: "destructive" }, action: "block" },
      { match: { tool: "host_pay*" }, action: "ask" },
    ]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("treats an absent policy file as no rules", async () => {
    expect(await orgPolicyResolver(async () => undefined)(ctx([{ org: "maple" }]))).toEqual([]);
  });

  /** F7 — one org's broken file must not disarm every OTHER org's policy. The
   *  bad file is reported and skipped; the rest still bind. */
  it("keeps the parseable orgs' rules when one org's file is malformed, and reports the failure", async () => {
    const failures: Array<{ org: string; reason: string }> = [];
    const resolve = orgPolicyResolver(
      async (org) => org === "broken"
        ? "{not json"
        : policy([{ match: { risk: "destructive" }, action: "block" }]),
      (org, reason) => { failures.push({ org, reason }); },
    );

    const rules = await resolve(ctx([{ org: "broken" }, { org: "maple" }]));

    expect(rules).toEqual([{ match: { risk: "destructive" }, action: "block" }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.org).toBe("broken");
    expect(failures[0]?.reason).toMatch(/org broken/);
  });

  it("reports a file that tries to LOOSEN and applies none of its rules", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      async () => policy([{ match: {}, action: "run" }, { match: {}, action: "block" }]),
      (org) => { failures.push(org); },
    );

    // Not "drop the run rule and keep the block": a file this layer cannot
    // understand is not partially applied.
    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual(["maple"]);
  });

  /** F8 — an absent file and a FAILED READ are different facts. Absent is the
   *  normal case (most orgs set no policy); a read that blew up must be heard,
   *  because silently treating it as "no policy" is a silent loosening. */
  it("reports a source that fails to read, rather than treating it as no policy", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      async () => { throw new Error("workspace read failed"); },
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual(["maple: workspace read failed"]);
  });

  it("says nothing at all when the file is simply absent", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(async () => undefined, (org) => { failures.push(org); });

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("ignores a memberships field that is not a list of orgs", async () => {
    const source = vi.fn();
    expect(await orgPolicyResolver(source)(ctx("maple"))).toEqual([]);
    expect(await orgPolicyResolver(source)(ctx([{ team: "finance" }, null, 7]))).toEqual([]);
    expect(source).not.toHaveBeenCalled();
  });

  it("reads each org's file from the org's own subtree", () => {
    expect(orgPolicyPath("maple")).toBe("/orgs/maple/policy.json");
  });
});

/** N2 — the previous absent-vs-failed split was written against `error.code`,
 *  which the workspace never sets: its refusals are plain Errors carrying the
 *  code as a MESSAGE prefix (`ENOENT: no such file…`, store/workspace-fs.ts).
 *  So the ordinary case — an org with no policy.json — took the FAILURE path:
 *  a warning and an audit row on every guarded call, and the throw skipped the
 *  cache so the TTL never engaged. These tests go through the real workspace,
 *  not a stubbed source, because that is the blind spot that let it ship. */
describe("org policy over the REAL workspace", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const realStore = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-org-policy-store-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    });
    await store.ensureSchema();
    return store;
  };

  it("is SILENT for an org with no policy file — no rules, no failure reported", async () => {
    const store = await realStore();
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      workspacePolicySource(store),
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("caches the absent answer, so the TTL engages instead of reading per call", async () => {
    const store = await realStore();
    const source = workspacePolicySource(store);

    expect(await source("maple")).toBeUndefined();
    // A closed store cannot be read at all — so a second `undefined` here can
    // only have come from the cache.
    await store.close();
    expect(await source("maple")).toBeUndefined();
  });

  it("still REPORTS a read that genuinely fails", async () => {
    const store = await realStore();
    const source = workspacePolicySource(store);
    // Warm the workspace façade on one org, then break the store underneath it:
    // an UNCACHED org now hits a workspace that exists but cannot answer, which
    // is a real failure and not an absent file.
    expect(await source("maple")).toBeUndefined();
    await store.close();
    const failures: string[] = [];
    const resolve = orgPolicyResolver(source, (org, reason) => { failures.push(`${org}: ${reason}`); });

    expect(await resolve(ctx([{ org: "cadence" }]))).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("cadence");
  });
});
