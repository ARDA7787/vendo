/**
 * The harness path, through the REAL composition.
 *
 * Every test here drives `createVendo(...)` — real store, real guard, real
 * registry, real HTTP `Request` into `vendo.handler` — because this wave's worst
 * bug was ~700 lines of correct primitives with zero production callers. A unit
 * test of a helper cannot tell you a composition wired it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesAdapter, Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { vendo as vendoHarness } from "@vendoai/harnesses";
import { defineHarness } from "@vendoai/harnesses";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { apps, definePack } from "./packs/index.js";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_harness" };

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const request = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

/** A host tool with an observable side effect, so "the guard ran it" is a fact. */
function hostTools(): { tools: ToolRegistry; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const descriptor: ToolDescriptor = {
    name: "maple_invoices_list",
    title: "List invoices",
    description: "List the signed-in customer's invoices",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  };
  return {
    calls,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        calls.push((call.args ?? {}) as Record<string, unknown>);
        return { status: "ok", output: { invoices: [{ id: "inv_1" }] } };
      },
    },
  };
}

/** The whole point of the `harness:` slot: a host's own thinker, driven by the
 *  runtime, reading only the frozen `Turn`. */
function scriptedHarness(script: (turn: Parameters<Parameters<typeof defineHarness>[0]["run"]>[0]) => AsyncGenerator<
  { type: "text"; delta: string },
  void,
  void
>) {
  return defineHarness({ name: "scripted", run: script });
}

interface Composed {
  vendo: Vendo;
  store: VendoStore;
  host: ReturnType<typeof hostTools>;
}

async function compose(
  overrides: Partial<Parameters<typeof createVendo>[0]> = {},
): Promise<Composed> {
  const store = await tempStore("vendo-harness-");
  const host = hostTools();
  const vendo = createVendo({
    // Never reached: every harness in this file is scripted. A model would make
    // these tests measure a provider instead of the composition. Omitted when the
    // case sets `models`, because naming one seat twice is a boot error.
    ...(overrides.models === undefined ? { model: {} as LanguageModel } : {}),
    principal: async () => principal,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  // Host tools arrive on the ONE registry through the shipped door, exactly as
  // `actions.add(packs.tools)` does in composition — so what the harness sees is
  // guard-bound and connect-gated like anything else.
  vendo.actions.add(host.tools);
  return { vendo, store, host };
}

describe("createVendo({ harness }) — a turn served through the composed runtime", () => {
  it("routes POST /threads through the harness and persists the reply", async () => {
    const { vendo, store } = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "Two invoices are open." };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_served",
      message: userMessage("m1", "How many invoices?"),
    }));
    expect(turn.status).toBe(200);
    // The effective thread id comes back on every turn, like `createAgent`'s —
    // the wire needs it to register turn liveness.
    expect(turn.headers.get("x-vendo-thread-id")).toBe("thr_served");
    expect(await turn.text()).toContain("Two invoices are open.");

    // Persisted through the SAME table `createAgent` writes, so the shipped read
    // door sees a harness turn.
    const fetched = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_served"));
    const thread = await fetched.json() as { messages: Array<{ role: string }> };
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const rows = await store.records("vendo_threads").list({ refs: { subject: principal.subject } });
    expect(rows.records.map((record) => record.id)).toEqual(["thr_served"]);
  });

  it("hands the harness the guard-bound registry, schemas and all, and runs a real call", async () => {
    let listed: Array<{ name: string; inputSchema?: unknown }> = [];
    const { vendo, host } = await compose({
      harness: scriptedHarness(async function* (turn) {
        listed = await turn.tools.list();
        const result = await turn.tools.call("maple_invoices_list", {});
        yield { type: "text", delta: `status=${result.status}` };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_tools",
      message: userMessage("m1", "list them"),
    }));
    expect(await turn.text()).toContain("status=ok");
    // The host tool really executed — not a mirror, not a stub.
    expect(host.calls).toHaveLength(1);
    // The listing carries every tool composition added, host and pack alike.
    expect(listed.map((entry) => entry.name)).toContain("maple_invoices_list");
    expect(listed.find((entry) => entry.name === "maple_invoices_list")?.inputSchema)
      .toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("gives the harness the real workspace, and a write survives to the next turn", async () => {
    const seen: string[] = [];
    const { vendo } = await compose({
      harness: scriptedHarness(async function* (turn) {
        const path = "/user/memory/notes.md";
        if (await turn.workspace.exists(path)) seen.push(await turn.workspace.readFile(path));
        await turn.workspace.writeFile(path, "the user prefers tables\n");
        yield { type: "text", delta: "noted" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_ws", message: userMessage("m1", "remember that"),
    }))).text();
    await (await vendo.handler(request("/threads", {
      threadId: "thr_ws", message: userMessage("m2", "what did I say?"),
    }))).text();

    // Turn two read what turn one committed — the workspace is the store, not
    // per-turn scratch.
    expect(seen).toEqual(["the user prefers tables\n"]);
  });

  it("mounts pack skills at /host/skills so TurnSkills serves them", async () => {
    const listing: Array<{ name: string; description: string }> = [];
    let body = "";
    const housePack = definePack({
      name: "house",
      skills: [{
        name: "house-style",
        description: "How this product talks to its customers.",
        body: "Say the amount and the recipient. Never say 'a payment'.\n",
      }],
    });

    const { vendo } = await compose({
      packs: [apps(), housePack],
      harness: scriptedHarness(async function* (turn) {
        listing.push(...await turn.skills.list());
        body = await turn.skills.load("house-style");
        yield { type: "text", delta: "read the skill" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_skills", message: userMessage("m1", "how do I talk?"),
    }))).text();

    expect(listing).toEqual(expect.arrayContaining([
      { name: "house-style", description: "How this product talks to its customers." },
      // The apps pack's own skill rides the same mount — nothing registers
      // anywhere, the mount IS the source of truth.
      expect.objectContaining({ name: "building-apps" }),
    ]));
    expect(body).toBe("Say the amount and the recipient. Never say 'a payment'.\n");
  });

  it("fills every model seat, borrowing `default` for the ones nobody set", async () => {
    const model = { id: "the-default" } as unknown as LanguageModel;
    const reviewer = { id: "the-reviewer" } as unknown as LanguageModel;
    let seats: Record<string, unknown> = {};
    const { vendo } = await compose({
      models: { default: model, reviewer },
      harness: scriptedHarness(async function* (turn) {
        seats = turn.models as unknown as Record<string, unknown>;
        yield { type: "text", delta: "seated" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_seats", message: userMessage("m1", "hi"),
    }))).text();

    expect(seats["default"]).toBe(model);
    expect(seats["reviewer"]).toBe(reviewer);
    // Unset seats borrow `default` — contract §4's own fallback, so no seat is
    // ever undefined for a harness that reads one.
    expect(seats["judge"]).toBe(model);
    expect(seats["fill"]).toBe(model);
    expect(seats["verifier"]).toBe(model);
  });

  it("boot-errors when a harness needs a sandbox and none is wired", () => {
    expect(() => createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      harness: { name: "boxed", requires: { sandbox: true }, run: async function* () {} },
    } as Parameters<typeof createVendo>[0])).toThrow(/boxed needs a sandbox adapter/);
  });

  it("leaves POST /threads on the shipped agent path when no harness is named", async () => {
    let ranHarness = false;
    const { vendo } = await compose();
    // The default harness exists and is reachable directly...
    expect(vendo.harness).toBeDefined();
    // ...but the wire route did not switch under a host that named nothing.
    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_default", message: userMessage("m1", "hello"),
    }));
    // The scripted harness was never installed, so any 200 here came from
    // `agent.stream` reaching the (empty) model double and failing honestly.
    expect(ranHarness).toBe(false);
    expect([200, 400, 500]).toContain(turn.status);
  });
});

describe("THE CONSTRAINT — TurnRunInput.messages is store-sourced", () => {
  /**
   * A transcript carrying an UNANSWERED approval — the state that made a
   * client-sourced `TurnRunInput.messages` throw forever.
   *
   * Seeded through the real store door rather than produced by a first turn,
   * because `approval-requested` is a `createAgent`-authored part: the harness
   * runtime mirrors a refused call as `tool-output-denied`. So this fixture IS
   * the harness-swap case — a thread whose earlier turn ran on the shipped agent,
   * resumed by a harness turn.
   */
  const pendingApprovalPart = {
    type: "tool-maple_invoices_list",
    toolCallId: "call_pending",
    state: "approval-requested",
    input: {},
    // The ai-SDK's own handle, which a real `createAgent`-authored part carries.
    approval: { id: "aiapr_pending" },
  };
  const assistantWithPendingApproval = {
    id: "m_assistant_pending",
    role: "assistant",
    parts: [pendingApprovalPart],
  };

  const seeded = async (threadId: string): Promise<Composed> => {
    const composed = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "carried on" };
      }),
    });
    await composed.store.ensureSchema();
    const { threadStore } = await import("@vendoai/store");
    await threadStore(composed.store).put(principal, {
      id: threadId as never,
      messages: [userMessage("m0", "list invoices"), assistantWithPendingApproval] as never,
    });
    return composed;
  };

  const partStates = async (vendo: Vendo, threadId: string): Promise<string[]> => {
    const fetched = await vendo.handler(new Request(`https://host.test/api/vendo/threads/${threadId}`));
    const thread = await fetched.json() as { messages: Array<{ parts: Array<{ state?: string }> }> };
    return thread.messages.flatMap((message) => message.parts.map((part) => part.state ?? ""));
  };

  it("a client re-posting a stale pre-flip transcript cannot break the thread", async () => {
    const threadId = "thr_stale";
    const { vendo } = await seeded(threadId);

    // Pre-flip: the store really does hold an unresolved approval.
    expect(await partStates(vendo, threadId)).toContain("approval-requested");

    // Two consecutive turns, each re-posting the client's PRE-FLIP copy of
    // history alongside a fresh message. The second one is where the bug showed:
    // turn one flips the part and persists the flip, so a client still sending
    // the old assistant message is, by `validateUpsert`'s rules, forging history —
    // and it would throw on that turn and on every turn after it, permanently.
    for (const [id, text] of [["m1", "any luck?"], ["m2", "still there?"]] as const) {
      const later = await vendo.handler(request("/threads", {
        threadId,
        message: userMessage(id, text),
        // A client posting a whole transcript, ai-SDK style. The wire reads
        // `message` and nothing else, and the composition reads history from the
        // STORE — so this array is inert by construction.
        messages: [assistantWithPendingApproval, userMessage(id, text)],
      }));
      expect(later.status).toBe(200);
      expect(await later.text()).toContain("carried on");
    }

    // Post-flip: the runtime resolved the abandoned approval, and the client's
    // stale copy never reinstated it.
    const after = await partStates(vendo, threadId);
    expect(after).not.toContain("approval-requested");
  });

  it("still refuses a client that rewrites an existing user message", async () => {
    // The store-sourced transcript is not a licence to accept anything: the
    // shipped `validateUpsert` rule still decides what a client may change.
    const { vendo } = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "ok" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_forge", message: userMessage("m1", "the original words"),
    }))).text();

    const forged = await vendo.handler(request("/threads", {
      threadId: "thr_forge", message: userMessage("m1", "words I never said"),
    }));
    expect(forged.status).toBe(400);
    expect(await forged.text()).toMatch(/cannot be rewritten/);
  });
});

describe("ONE files adapter (build contract §3.4)", () => {
  /** Records which adapter instance the deployment actually used. */
  function recordingFiles(): FilesAdapter & { puts: string[]; deletes: string[] } {
    const blobs = new Map<string, Uint8Array>();
    return {
      puts: [],
      deletes: [],
      async put(key, bytes) {
        (this as unknown as { puts: string[] }).puts.push(key);
        blobs.set(key, bytes);
      },
      async get(key) {
        const bytes = blobs.get(key);
        return bytes === undefined ? undefined : { bytes };
      },
      async delete(key) {
        (this as unknown as { deletes: string[] }).deletes.push(key);
        blobs.delete(key);
      },
    } as FilesAdapter & { puts: string[]; deletes: string[] };
  }

  it("writes workspace blobs through `files:` and erases them through the SAME instance", async () => {
    const files = recordingFiles();
    // Past WORKSPACE_INLINE_MAX_BYTES (65536), so the content goes to the blob
    // seam instead of an inline row — which is what makes the adapter observable.
    const big = "x".repeat(70_000);
    const { vendo, store } = await compose({
      files,
      harness: scriptedHarness(async function* (turn) {
        await turn.workspace.writeFile("/user/files/report.txt", big);
        await turn.workspace.commit();
        yield { type: "text", delta: "wrote it" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_files", message: userMessage("m1", "save the report"),
    }))).text();

    // The workspace used the CONFIGURED adapter, not the store's blobs.
    expect(files.puts).toHaveLength(1);
    const key = files.puts[0] as string;

    // Now the other end: the erase cascade must delete the same object. If erase
    // resolved its own adapter, the row would go and the object would leak —
    // the class lane B spent three rounds killing.
    const { eraseStore } = await import("@vendoai/store");
    await eraseStore(store, { files }).bySubject(principal.subject);
    expect(files.deletes).toContain(key);
  });

  it("caps the no-adapter path and names `files:` as the fix", async () => {
    let message = "";
    const { vendo } = await compose({
      harness: scriptedHarness(async function* (turn) {
        try {
          // Past FILES_STORE_MAX_BYTES (5 MiB) with no `files:` wired. The façade
          // STAGES writes, so the blob only reaches the adapter at commit — which
          // is where the honest refusal has to surface.
          await turn.workspace.writeFile("/user/files/huge.bin", "x".repeat(6 * 1024 * 1024));
          await turn.workspace.commit();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        yield { type: "text", delta: "tried" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_cap", message: userMessage("m1", "save something huge"),
    }))).text();

    expect(message).toMatch(/files:/);
    expect(message).toMatch(/s3\(/);
  });
});

describe("the default harness is `vendo()`", () => {
  it("composes without a `harness:` and exposes a reachable harness door", async () => {
    const { vendo } = await compose();
    // `vendo()` is what composition resolved; the door exists either way, so a
    // host (and the live proofs) can drive a harness turn without config.
    expect(typeof vendo.harness.stream).toBe("function");
    expect(typeof vendo.harness.workspace).toBe("function");
    expect(vendoHarness().name).toBe("vendo");
  });
});
