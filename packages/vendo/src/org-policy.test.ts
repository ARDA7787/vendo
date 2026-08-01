import type { RunContext } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { orgPolicyPath, orgPolicyResolver } from "./org-policy.js";

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
