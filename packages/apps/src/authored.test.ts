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
import { describe, expect, it, vi } from "vitest";
import { createApps, pinComponentName, type AppsRuntime } from "./index.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
import { seedGrantRows, storeAccessFixture } from "./testing/app-access-fixture.js";
import { bindTools, guardFixture, memoryStore, seedAppRow, type GuardFixture } from "./testing/index.js";

const APP_ID = "app_authored";

const SPEND = `<App name="Spending">
  <Query id="spend" tool="maple_spend_summary" />
  <Stack>
    <Text text={spend.total} />
  </Stack>
</App>`;

/** The same app, one section further along: a different tree under the SAME name,
 *  which is what a rewrite of a sponsored app looks like to the intent hash. */
const SPEND_MORE = `<App name="Spending">
  <Query id="spend" tool="maple_spend_summary" />
  <Stack>
    <Text text={spend.total} />
    <Text text={spend.currency} />
  </Stack>
</App>`;

/** A save caught mid-write: `compileWire` is valid-while-partial, so the seam
 *  paints it and this door stores it. */
const PARTIAL = `<App name="Spending">
  <Query id="spend" tool="maple_spend_summary" />
  <Stack>
    <Text text={spend.total} /`;

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
  /** §9.9 — every announcement the runtime made through `onDocumentEdit`. */
  edits: Array<{ previous: AppDocument; next: AppDocument; editor: string }>;
  /**
   * Land something in the window a save brackets: `run` fires ONCE, right after
   * a save reads a row and before it writes. This is the only way to be inside
   * that window from outside, and it is exactly the race a concurrent `edit()`
   * is. `skipReads` lets that many reads pass first, which is how a test picks
   * WHICH part of the window it lands in — 0 is the baseline read, 1 is after
   * the first concurrency check (so inside the history append).
   */
  arm: (run: () => Promise<void>, skipReads?: number) => void;
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

const stand = (options: {
  rules?: Record<string, "run" | "ask" | "block">;
  box?: boolean;
  /** Wire the multi-party half, so a grant row can make a THIRD PARTY an editor. */
  shared?: boolean;
} = {}): Stand => {
  const store = memoryStore();
  const guard = guardFixture(options.rules === undefined ? {} : { rules: options.rules });
  const calls: RunContext[] = [];
  const seen: Stand["seen"] = [];
  const edits: Stand["edits"] = [];
  let armed: { skipReads: number; run: () => Promise<void> } | undefined;
  // The runtime captures its `vendo_apps` collection once; this wrapper hands it
  // an instrumented one so a test can land a write between a save's baseline read
  // and its put.
  const wrapped = {
    ...store,
    records: (collection: string) => {
      const records = store.records(collection);
      if (collection !== "vendo_apps") return records;
      return {
        ...records,
        async get(id: string) {
          const record = await records.get(id);
          if (armed !== undefined) {
            if (armed.skipReads > 0) {
              armed.skipReads -= 1;
            } else {
              const { run } = armed;
              armed = undefined;
              await run();
            }
          }
          return record;
        },
      };
    },
  };
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
    store: wrapped,
    guard,
    tools: bindTools(guard, host),
    catalog: [],
    // §9.9's listener, as composition wires it (server.ts → the automations
    // engine's `onDocumentEdit`, which invalidates or re-binds sponsorship).
    onDocumentEdit: async (previous, next, editor) => {
      edits.push({ previous, next, editor });
    },
    ...(options.shared === true ? { appAccess: storeAccessFixture(store), multiParty: true } : {}),
    ...(options.box === true ? { machine: { sandbox: fnBox(seen) } } : {}),
  });
  return {
    runtime,
    store,
    guard,
    calls,
    seen,
    edits,
    arm: (run, skipReads = 0) => {
      armed = { skipReads, run };
    },
  };
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
    const { runtime, store, edits } = stand();
    const theirs: AppDocument = { format: "vendo/app@1", id: APP_ID, name: "Theirs" };
    await seedAppRow(store, theirs, "u2");

    // `/user/**` is its subject's at every level, so the workspace will land this
    // file in u1's own mount. This door is the only thing standing between that
    // and u2's app.
    const data = await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx("u1"));

    expect((await rowOf(store))?.doc).toEqual(theirs);
    expect((await rowOf(store))?.subject).toBe("u2");
    // Nothing about the other person's app is read, written, versioned or
    // ANNOUNCED: an announcement over a foreign row would invalidate a
    // sponsorship u2 holds, on a file u1 wrote in their own mount.
    expect(edits).toEqual([]);
    expect((await store.records(`vendo:app-history:${APP_ID}`).list()).records).toEqual([]);
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

/**
 * Build contract §9.9 — a files-first rewrite is a change to what the app IS, so
 * it passes through the SAME announcement `persistEdit` and `undo` make. It has
 * to: `authoredDocument` keeps `trigger` verbatim, so the intent hash a
 * sponsorship was minted over does not move when a third party rewrites the file
 * — the fire-time hash check cannot see this change, and this hook is the only
 * thing that can.
 */
describe("§9.9 — the announcement a files-first save owes", () => {
  const trigger = {
    on: { kind: "schedule" as const, cron: "0 9 * * *" },
    run: { kind: "agentic" as const, prompt: "send the weekly digest" },
  };

  it("announces a third party's rewrite of a sponsored app, under THEIR subject", async () => {
    const { runtime, store, edits } = stand({ shared: true });
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx("u1"));
    await seedAppRow(store, { ...(await rowOf(store))!.doc!, trigger }, "u1", true);
    // u2 holds editor on u1's app (a shared automation) and rewrites the file.
    await seedGrantRows(store, APP_ID, { "user:u2": "editor" });

    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND_MORE) }, ctx("u2"));

    expect(edits).toHaveLength(1);
    // The invalidation keys on exactly this: the editor is not the sponsor.
    expect(edits[0]?.editor).toBe("u2");
    // And it could key on nothing else — every input to the intent hash (name,
    // trigger, declared tools) came through the rewrite unchanged.
    expect(edits[0]?.next.name).toBe(edits[0]?.previous.name);
    expect(edits[0]?.next.trigger).toEqual(trigger);
    // §9.5 — the row keeps its owner.
    expect((await rowOf(store))?.subject).toBe("u1");
  });

  it("announces the sponsor's OWN rename, so their automation is re-bound not killed", async () => {
    const { runtime, store, edits } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    await seedAppRow(store, { ...(await rowOf(store))!.doc!, trigger }, "u1", true);

    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND.replace("Spending", "Money")) }, ctx());

    // A rename DOES move the hash — without the announcement the automation would
    // stop at its next fire for an edit its own sponsor made.
    expect(edits).toHaveLength(1);
    expect(edits[0]?.editor).toBe("u1");
    expect(edits[0]?.next.name).toBe("Money");
  });

  it("announces a PARTIAL mid-turn save too — what the store holds is what fires", async () => {
    const { runtime, edits } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    // A truncated save, mid-build: the seam stores it because refusing to store
    // what the person can already see is the worse failure — and a stored
    // half-app is what an automation would fire on.
    await runtime.authored({ appId: APP_ID, compiled: compiled(PARTIAL) }, ctx());

    expect(edits).toHaveLength(1);
  });

  it("announces nothing for the FIRST save — that is a create, and it says so", async () => {
    const { runtime, edits, guard } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    expect(edits).toEqual([]);
    expect(guard.audit.filter((event) => event.kind === "app-lifecycle")).toHaveLength(1);
  });
});

describe("a save whose text left a pinned component out", () => {
  const slot = "dashboard.header";
  const name = pinComponentName(slot);

  it("keeps the pinned source — a pin whose source is gone is not a pin", async () => {
    const { runtime, store } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    // A remixed host component: `pins` names the slot, `components` holds the
    // captured host source. `Extra` is the model's own island, next to it.
    await seedAppRow(store, {
      ...(await rowOf(store))!.doc!,
      pins: [{ slot, base: "sha256:hostsource" }],
      components: { [name]: "export default () => null;", Extra: "export default () => 1;" },
    }, "u1");

    // The compile carries NO islands at all (a rewrite from scratch, or a save
    // that has not got to them yet).
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    const doc = (await rowOf(store))?.doc;
    expect(doc?.pins).toEqual([{ slot, base: "sha256:hostsource" }]);
    expect(doc?.components?.[name]).toBe("export default () => null;");
    // The model's island is the model's to drop; only the pinned source is the
    // app's own history.
    expect(doc?.components?.Extra).toBeUndefined();
  });

  it("still lets the file EDIT a pinned component, exactly as an engine edit may", async () => {
    const { runtime, store } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    await seedAppRow(store, {
      ...(await rowOf(store))!.doc!,
      pins: [{ slot, base: "sha256:hostsource" }],
      components: { [name]: "export default () => null;" },
    }, "u1");

    const island = `<App name="Spending">
  <${name} />
  <Island name="${name}">export default () =&gt; 2;</Island>
</App>`;
    await runtime.authored({ appId: APP_ID, compiled: compiled(island) }, ctx());

    expect((await rowOf(store))?.doc?.components?.[name]).toContain("2");
  });

  it("records the pin intent that edit does, so a rebase can replay this save", async () => {
    const { runtime, store } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    await seedAppRow(store, {
      ...(await rowOf(store))!.doc!,
      pins: [{ slot, base: "sha256:hostsource" }],
      components: { [name]: "export default () => null;" },
    }, "u1");

    const island = `<App name="Spending">
  <${name} />
  <Island name="${name}">export default () =&gt; 2;</Island>
</App>`;
    await runtime.authored({ appId: APP_ID, compiled: compiled(island) }, ctx());

    // The trail is what `pins.rebase` replays onto a new host baseline. Without the
    // slot on this save's version, an edit the FILE made to a pinned component is
    // silently dropped the next time the host ships that component — the same
    // record `persistEdit` writes for a model edit (touchedPinSlots).
    const trail = await store.records(`vendo:app-pin-intents:${APP_ID}`).list();
    expect(trail.records.map((record) => (record.data as { slot: string; intent: string })))
      .toEqual([expect.objectContaining({ slot, intent: "Saved app.vendo" })]);
  });
});

describe("the undo point a files-first save leaves", () => {
  it("records the state a rewrite replaced, and restores it", async () => {
    const { runtime } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    // The first save is a create: there is no earlier state to keep.
    expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);

    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND.replace("Spending", "Money")) }, ctx());

    const versions = await runtime.history(APP_ID, ctx()).list();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.intent).toBe("Saved app.vendo");
    // The point of the entry: a truncated or wrong save is recoverable.
    expect((await runtime.history(APP_ID, ctx()).undo()).name).toBe("Spending");
  });

  it("spends no version on a re-save that changed nothing", async () => {
    const { runtime, edits } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());

    // The history is capped at 50: an undo point to the state the app is already
    // in would push a real one out.
    expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);
    // And §9.9 says nothing either: the app is not different, invalidation is
    // terminal, so announcing an identical re-save would kill a live sponsorship
    // for a change that does not exist. The skill saves on a timer, so this is
    // the common case, not the corner.
    expect(edits).toEqual([]);
  });
});

describe("a save computed over a row that changed under it", () => {
  it("is refused rather than reverting the edit that landed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store, edits, arm } = stand();
      await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
      const stored = (await rowOf(store))!.doc!;
      // What a UI `edit()` lands in the window: this save's baseline is now stale,
      // and the document it computed carries the PRE-edit description forward.
      arm(async () => {
        await seedAppRow(store, { ...stored, description: "the person's own edit" }, "u1");
      });

      const data = await runtime.authored(
        { appId: APP_ID, compiled: compiled(SPEND.replace("Spending", "Money")) },
        ctx(),
      );

      const row = await rowOf(store);
      expect(row?.doc?.description).toBe("the person's own edit");
      expect(row?.doc?.name).toBe("Spending");
      // Nothing announced and no version minted for a write that never landed.
      expect(edits).toEqual([]);
      expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);
      // Never silent…
      expect(errors.mock.calls.map(String).join(" ")).toContain("app not saved");
      // …and never a reason to withhold the view the person is already looking at.
      expect(data).toEqual({ spend: { total: 4210, currency: "USD" } });
    } finally {
      errors.mockRestore();
    }
  });

  it("is refused when it lands DURING the version append, not only before it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store, edits, arm } = stand();
      await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
      const stored = (await rowOf(store))!.doc!;
      // One read later than the test above: the baseline read and the first
      // concurrency check both pass, and the edit lands while the history append
      // is in flight. A single check would have written the pre-edit document
      // straight over it — the append is a store round trip, so the whole of it
      // sits inside the window.
      arm(async () => {
        await seedAppRow(store, { ...stored, description: "the person's own edit" }, "u1");
      }, 1);

      await runtime.authored(
        { appId: APP_ID, compiled: compiled(SPEND.replace("Spending", "Money")) },
        ctx(),
      );

      const row = await rowOf(store);
      expect(row?.doc?.description).toBe("the person's own edit");
      expect(row?.doc?.name).toBe("Spending");
      expect(edits).toEqual([]);
      // The append already ran, so its version stands — a spent slot whose undo
      // target is the state before both writes. persistEdit has the same residual
      // for the same reason (no compare-and-swap on the store seam); what the
      // second check buys is that the CONCURRENT EDIT survives.
      expect(await runtime.history(APP_ID, ctx()).list()).toHaveLength(1);
      expect(errors.mock.calls.map(String).join(" ")).toContain("app not saved");
    } finally {
      errors.mockRestore();
    }
  });

  it("does not conflict with a run of saves in the same turn", async () => {
    const { runtime, store, edits } = stand();
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND) }, ctx());
    // The skill saves once per group: each save re-reads its own baseline, so a
    // rapid sequence never conflicts with itself.
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND_MORE) }, ctx());
    await runtime.authored({ appId: APP_ID, compiled: compiled(PARTIAL) }, ctx());
    await runtime.authored({ appId: APP_ID, compiled: compiled(SPEND.replace("Spending", "Money")) }, ctx());

    expect((await rowOf(store))?.doc?.name).toBe("Money");
    expect(edits).toHaveLength(3);
    expect(await runtime.history(APP_ID, ctx()).list()).toHaveLength(3);
  });
});
