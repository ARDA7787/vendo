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

  it("throws on a malformed file rather than silently dropping the tightening", async () => {
    const resolve = orgPolicyResolver(async () => "{not json");
    await expect(resolve(ctx([{ org: "maple" }]))).rejects.toThrow(/org maple/);
  });

  it("throws on a file that tries to LOOSEN", async () => {
    const resolve = orgPolicyResolver(async () => policy([{ match: {}, action: "run" }]));
    await expect(resolve(ctx([{ org: "maple" }]))).rejects.toThrow(/org maple/);
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
