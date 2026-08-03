import { describe, expect, it } from "vitest";
import type { RunContext } from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import { createActions } from "./registry.js";

/** A lazy connector shaped like the real Composio one: tools materialize per
 * toolkit on expand, every descriptor carries its `toolkit` (01-core §4), and
 * the per-toolkit fetch is counted so "cached process-wide, scoped per listing"
 * is asserted rather than assumed. */
function lazyConnector() {
  const expanded = new Set<string>();
  const fetches: string[] = [];
  const connector: Connector = {
    name: "composio",
    toolkitOf: (tool) => tool.split("_")[0],
    descriptors: async () => [...expanded].flatMap((toolkit) => {
      fetches.push(toolkit);
      return [{
        name: `${toolkit}_${toolkit.toUpperCase()}_SEND`,
        description: `send things via ${toolkit}`,
        inputSchema: {},
        risk: "write" as const,
        toolkit,
      }];
    }),
    execute: async (call) => ({ status: "ok", output: { ran: call.tool } }),
    discoveryIndex: async () => [
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
      { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels" },
    ],
    expandToolkits: async (toolkits) => {
      let changed = false;
      for (const toolkit of toolkits) {
        if (["gmail", "slack"].includes(toolkit) && !expanded.has(toolkit)) {
          expanded.add(toolkit);
          changed = true;
        }
      }
      return changed;
    },
  };
  return { connector, fetches: () => fetches };
}

const HOST_TOOL = {
  name: "host_listAccounts",
  description: "List the user's accounts",
  inputSchema: { type: "object" },
  risk: "read" as const,
  binding: { kind: "route" as const, method: "GET" as const, path: "/api/accounts", argsIn: "query" as const },
};

const context = (subject: string, sessionId: string): RunContext =>
  ({ principal: { kind: "user", subject }, venue: "chat", presence: "present", sessionId });

const ada = context("user_ada", "s_ada_1");
/** Ada's NEXT conversation — same subject, and deliberately the same
 * `sessionId`, because that is the live shape: the wire hands host-resolved
 * principals one process-wide session id, so a listing keyed on ctx FIELDS
 * would put this run and the one above in the same bucket. This is the run that
 * answered 301 tools in the boxed E2E. */
const adaLater = context("user_ada", "s_ada_1");
const bob = context("user_bob", "s_bob_1");

function registry() {
  const lazy = lazyConnector();
  return { actions: createActions({ dir: "", tools: [HOST_TOOL], connectors: [lazy.connector] }), fetches: lazy.fetches };
}

const names = (descriptors: Array<{ name: string }>): string[] => descriptors.map((descriptor) => descriptor.name);

/** The leak this pins, measured live 2026-08-03: lazy expansion was
 * process-wide and permanent, so one conversation's `search_connectors` put a
 * whole toolkit (301 tools instead of 35) on every later listing in the
 * process — for every user, until restart. */
describe("lazy expansion is scoped to the listing that asked for it", () => {
  it("one subject's expansion never reaches another subject's listing", async () => {
    const { actions } = registry();
    await actions.expandToolkits(["slack"], ada);

    expect(names(await actions.descriptors(ada))).toContain("slack_SLACK_SEND");
    expect(names(await actions.descriptors(bob))).toEqual(["host_listAccounts"]);
  });

  it("one conversation's expansion never reaches the same subject's NEXT conversation", async () => {
    const { actions } = registry();
    await actions.expandToolkits(["slack"], ada);

    expect(names(await actions.descriptors(adaLater))).toEqual(["host_listAccounts"]);
  });

  it("an expanded toolkit stays listed AND callable for the listing that expanded it", async () => {
    const { actions } = registry();
    await actions.expandToolkits(["slack"], ada);

    expect(names(await actions.descriptors(ada))).toContain("slack_SLACK_SEND");
    // Twice, because a listing that only survives one read is not a listing.
    expect(names(await actions.descriptors(ada))).toContain("slack_SLACK_SEND");
    await expect(actions.execute({ id: "c1", tool: "slack_SLACK_SEND", args: {} }, ada))
      .resolves.toMatchObject({ status: "ok" });
  });

  it("the toolkit FETCH is process-wide: a second listing expanding it costs no reload", async () => {
    const { actions, fetches } = registry();
    await actions.expandToolkits(["slack"], ada);
    await actions.descriptors(ada);
    const afterFirst = fetches().length;

    await actions.expandToolkits(["slack"], bob);
    expect(names(await actions.descriptors(bob))).toContain("slack_SLACK_SEND");
    expect(fetches().length).toBe(afterFirst);
  });

  it("search only ranks what the asking listing can see, and expands FOR it", async () => {
    const { actions } = registry();
    const found = await actions.search("post a message to slack", undefined, ada);
    expect(found.map((match) => match.name)).toContain("slack_SLACK_SEND");
    expect(names(await actions.descriptors(ada))).toContain("slack_SLACK_SEND");

    // Bob never searched: the hit ada's search materialized is not on his list…
    expect(names(await actions.descriptors(bob))).toEqual(["host_listAccounts"]);
    // …and when he does search, the memoized answer still leaves him a row he
    // can act on — a name his own next listing contains.
    const bobFound = await actions.search("post a message to slack", undefined, bob);
    expect(bobFound.map((match) => match.name)).toContain("slack_SLACK_SEND");
    expect(names(await actions.descriptors(bob))).toContain("slack_SLACK_SEND");
  });

  it("loadoutSeed expands for the turn that asked, and only for it", async () => {
    const { actions } = registry();
    const seed = await actions.loadoutSeed(["gmail"], ada);
    expect(seed).toContain("gmail_GMAIL_SEND");
    expect(names(await actions.descriptors(ada))).toContain("gmail_GMAIL_SEND");
    expect(names(await actions.descriptors(bob))).toEqual(["host_listAccounts"]);
  });

  it("a contextless read still sees the whole loaded surface (the guard's own lookup, conformance)", async () => {
    const { actions } = registry();
    await actions.expandToolkits(["slack"], ada);

    expect(names(await actions.descriptors())).toContain("slack_SLACK_SEND");
  });

  it("a rebuilt context is a fresh listing — it fails toward re-search, not toward ada's set", async () => {
    const { actions } = registry();
    await actions.expandToolkits(["slack"], ada);

    expect(names(await actions.descriptors({ ...ada }))).toEqual(["host_listAccounts"]);
  });
});
