/**
 * Build contract §1.6 / redesign D4 — a FILES-FIRST app is a first-class app.
 *
 * The live E2E defect this closes (2026-08-03): the claude-code harness wrote
 * `app.vendo` with its own hands, the render seam painted it, and nothing else
 * ever happened — no store row, so the app was absent from the person's list and
 * `vendo_apps_open` masked it as `not-found`, and no query ever ran, so every
 * value on screen read "—" while the host data sat one call away.
 *
 * `AppsRuntime.authored` is the one door that closes both halves, and these are
 * its rules: the row lands through the SAME writer generation persists with, the
 * queries run through the SAME guard-bound caller `open()` resolves with (so a
 * query the policy gates contributes nothing, exactly like an app's own read),
 * and an app that already exists keeps everything that is its own history.
 */
import {
  compileWire,
  type AppDocument,
  type Json,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime } from "./index.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
import { bindTools, guardFixture, memoryStore, seedAppRow, type GuardFixture } from "./testing/index.js";

const APP_ID = "app_authored";

const SPEND = `<App name="Spending">
  <Query id="spend" tool="maple_spend_summary" />
  <Stack>
    <Text text={spend.total} />
  </Stack>
</App>`;

/** A file whose only query is an `fn:` ref — the one query kind that resolves
 *  against the DOCUMENT's machine rather than the guard-bound registry. */
const LOOT = `<App name="Mine">
  <Query id="loot" tool="fn:dump" />
  <Stack>
    <Text text={loot.secret} />
  </Stack>
</App>`;

const descriptor: ToolDescriptor = {
  name: "maple_spend_summary",
  title: "Spending summary",
  description: "This month's spending",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
};

const ctx = (subject = "u1"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: "s1",
});

interface Stand {
  runtime: AppsRuntime;
  store: ReturnType<typeof memoryStore>;
  guard: GuardFixture;
  calls: RunContext[];
  /** Every request that reached a machine. Empty unless `box: true`. */
  seen: Array<{ method: string; path: string }>;
}

/** A machine that answers any `fn:` with a secret, and records being asked. */
const fnBox = (seen: Stand["seen"]) => {
  const machine: SandboxMachine = {
    id: "fake_authored_box",
    async request(request) {
      seen.push({ method: request.method, path: request.path });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ result: { secret: "theirs" } })),
      };
    },
    async snapshot() { return "fake:theirs"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  } satisfies SandboxAdapter;
};

const stand = (options: { rules?: Record<string, "run" | "ask" | "block">; box?: boolean } = {}): Stand => {
  const store = memoryStore();
  const guard = guardFixture(options.rules === undefined ? {} : { rules: options.rules });
  const calls: RunContext[] = [];
  const seen: Stand["seen"] = [];
  const host: ToolRegistry = {
    async descriptors() {
      return [descriptor];
    },
    async execute(_call, callCtx) {
      calls.push(callCtx);
      return { status: "ok", output: { total: 4210, currency: "USD" } };
    },
  };
  // THE choke point: the runtime is handed the guard-BOUND registry, exactly as
  // composition hands it one.
  const runtime = createApps({
    store,
    guard,
    tools: bindTools(guard, host),
    catalog: [],
    ...(options.box === true ? { machine: { sandbox: fnBox(seen) } } : {}),
  });
  return { runtime, store, guard, calls, seen };
};

/** What the render seam hands over: the compile it already did for the paint. */
const compiled = (wire: string) => compileWire(wire);

const rowOf = async (store: Stand["store"], appId = APP_ID): Promise<{
  subject?: string;
  enabled?: boolean;
  doc?: AppDocument;
} | null> => {
  const record = await store.records("vendo_apps").get(appId);
  return record === null ? null : record.data as { subject?: string; enabled?: boolean; doc?: AppDocument };
};

describe("an app.vendo the harness wrote", () => {
  it("becomes a store row — so it is in the person's Apps list", async () => {
    const { runtime, store } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    const row = await rowOf(store);
    expect(row?.subject).toBe("u1");
    expect(row?.doc?.name).toBe("Spending");
    expect(row?.doc?.ui).toBe("tree");
    expect((await runtime.list(ctx())).map((app) => app.id)).toEqual([APP_ID]);
  });

  it("opens — the tool that answered 'couldn't finish' three times in the live run", async () => {
    const { runtime } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    const surface = await runtime.open(APP_ID, ctx());
    expect(surface.kind).toBe("tree");
    // And the OPEN path resolves the same query for itself.
    expect((surface as { payload: { data?: unknown } }).payload.data)
      .toEqual({ spend: { total: 4210, currency: "USD" } });
  });

  it("carries its queries' real data, resolved through the guard-bound registry", async () => {
    const { runtime, calls } = stand();
    const data = await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    expect(data).toEqual({ spend: { total: 4210, currency: "USD" } });
    // The app venue, the app's id, and the caller's own principal — an app's read
    // is attributed as an app's read, never as a bare chat tool call.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ venue: "app", appId: APP_ID, principal: { subject: "u1" } });
  });

  it("respects the guard on every query — a gated read contributes NO data", async () => {
    const { runtime, guard } = stand({ rules: { maple_spend_summary: "ask" } });
    const data = await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    expect(data).toEqual({});
    // One card, parked exactly as an app's own read would park it — the seam has
    // no second execution path that could skip it.
    expect(guard.approvals).toHaveLength(1);
    // And the app still exists: a query the policy gates is not a broken app.
    expect((await runtime.list(ctx())).map((app) => app.id)).toEqual([APP_ID]);
  });

  it("re-saves in place, keeping what is the app's own history", async () => {
    const { runtime, store } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    // Something only the app knows about itself, written by another door.
    const trigger = {
      on: { kind: "schedule" as const, cron: "0 9 * * *" },
      run: { kind: "agentic" as const, prompt: "send the weekly digest" },
    };
    await store.records("vendo_apps").put({
      id: APP_ID,
      data: { subject: "u1", enabled: true, doc: { ...(await rowOf(store))!.doc!, trigger } },
      refs: { subject: "u1" },
    });

    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND.replace("Spending", "Money")) }, ctx());

    const row = await rowOf(store);
    expect(row?.doc?.name).toBe("Money");
    expect(row?.doc?.trigger).toEqual(trigger);
    // The trigger did not change, so the automation stays armed.
    expect(row?.enabled).toBe(true);
    expect((await runtime.list(ctx()))).toHaveLength(1);
  });

  it("never rewrites an app the caller may not edit", async () => {
    const { runtime, store } = stand();
    const theirs: AppDocument = { format: "vendo/app@1", id: APP_ID, name: "Theirs" };
    await seedAppRow(store, theirs, "u2");

    // `/user/**` is its subject's at every level, so the workspace will land this
    // file in u1's own mount. This door is the only thing standing between that
    // and u2's app.
    const data = await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx("u1"));

    expect((await rowOf(store))?.doc).toEqual(theirs);
    expect((await rowOf(store))?.subject).toBe("u2");
    // The person still sees their own file painted, with their own data.
    expect(data).toEqual({ spend: { total: 4210, currency: "USD" } });
  });

  it("never reaches an app it may not edit — not even through that app's machine", async () => {
    const { runtime, store, seen } = stand({ box: true });
    const theirs: AppDocument = {
      format: "vendo/app@1",
      id: APP_ID,
      name: "Theirs",
      machine: { snapshotRef: "fake:theirs", provisionedAt: "2026-08-03T00:00:00.000Z" },
    };
    await seedAppRow(store, theirs, "u2");

    // u1 writes THEIR OWN file at u2's app id (the workspace lands it — `/user/**`
    // is its subject's at every level) and asks it for an `fn:` query. The refused
    // write is not the whole refusal: the document these queries resolve against
    // must carry none of u2's app, or `fn:` routes onto u2's sandbox (fn.ts routes
    // on `app.machine` alone, and the wake takes no ctx).
    const data = await runtime.authored({ appId: APP_ID, compiled: compiled(LOOT) }, ctx("u1"));

    expect(seen).toEqual([]);
    expect(data).toEqual({});
    expect((await rowOf(store))?.doc).toEqual(theirs);
  });

  it("stores nothing the model forged — inClient, pinDrift, buildFailed", async () => {
    const { runtime, store } = stand();
    await runtime.authored({
      appId: APP_ID,
      compiled: compiled(SPEND),
    }, ctx());
    const row = await rowOf(store);
    const serialized = JSON.stringify(row?.doc);
    expect(serialized).not.toContain("inClient");
    expect(serialized).not.toContain("pinDrift");
    expect(row?.doc?.buildFailed).toBeUndefined();
  });

  it("does not need a model — files-first never calls the engine", async () => {
    const { runtime } = stand();
    // `stand()` composes no `model:`, so a generation door would refuse here.
    await expect(runtime.create({ prompt: "anything" }, ctx())).rejects.toThrow(/requires a model/);
    await expect(runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx()))
      .resolves.toEqual({ spend: { total: 4210, currency: "USD" } } as Record<string, Json>);
  });
});
