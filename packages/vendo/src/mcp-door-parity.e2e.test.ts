/**
 * The cc-native PARITY GATE — is the MCP door a drop-in replacement for the
 * in-process tool projection inside a `claudeCode()` turn?
 *
 * The cc-native lane wants to delete the ask/park/queue/cursor bridge and let the
 * box reach the host's tools over native remote MCP
 * (`mcpServers: { vendo: { type: "http", url: <the door>, headers: { Authorization } } }`).
 * That is only allowed if the door produces the SAME accountability as
 * `turn.tools.call()`. So this file runs the same two tool asks — one `read` the
 * `cautious` policy runs, one `write` it parks for a human — through BOTH doors of
 * ONE composed host (one store, one guard, one policy, one registry) and compares:
 *
 *   - the AUDIT ROW: (outcome, decidedBy, presence, venue, subject)
 *   - the APPROVAL BEHAVIOR: does the guard's ask reach the user the same way,
 *     and does a denial behave the same way?
 *
 * It is a MEASUREMENT pinned as a test: the assertions below record the answer we
 * measured, so a future change to either path that closes (or widens) the gap
 * fails here and gets read by a person. Read the recorded verdict in
 * `docs/superpowers/lanes/2026-08-02-cc-native-CLOSE.md`.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SUBJECT = "user_parity";
const principal: Principal = { kind: "user", subject: SUBJECT };
const READ_TOOL = "host_lookup";
const WRITE_TOOL = "host_pay";

const MOUNT = "https://host.test/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-parity-gate-1234567890";

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-parity-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One read the `cautious` policy runs silently, one write it parks for a human. */
function hostTools(): ToolRegistry {
  const descriptors: ToolDescriptor[] = [
    {
      name: READ_TOOL,
      title: "Look something up",
      description: "Look something up for the signed-in customer",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      risk: "read",
    },
    {
      name: WRITE_TOOL,
      title: "Send a payment",
      description: "Send a payment to a payee",
      inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      risk: "write",
    },
  ];
  return {
    async descriptors() {
      return descriptors;
    },
    async execute() {
      return { status: "ok", output: { ok: true } };
    },
  };
}

interface Row {
  id: string;
  kind: string;
  tool?: string;
  outcome?: string;
  decidedBy?: string;
  venue?: string;
  presence?: string;
  principal?: { subject?: string };
}

const toolRows = async (store: VendoStore, tool: string): Promise<Row[]> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: SUBJECT } });
  return records
    .map((record) => record.data as unknown as AuditEvent as unknown as Row)
    .filter((row) => row.kind === "tool-call" && row.tool === tool);
};

/**
 * The rows one leg of the gate added. Row ORDER out of the store is not the order
 * they were written, so the two legs are separated by identity, never by `at(-1)`.
 */
async function rowsAddedBy(
  store: VendoStore,
  tool: string,
  leg: () => Promise<void>,
): Promise<Row[]> {
  const before = new Set((await toolRows(store, tool)).map((row) => row.id));
  await leg();
  return (await toolRows(store, tool)).filter((row) => !before.has(row.id));
}

/** The five fields the contract names, as one comparable shape. */
const shapeOf = (row: Row | undefined): Record<string, unknown> => ({
  outcome: row?.outcome,
  decidedBy: row?.decidedBy,
  presence: row?.presence,
  venue: row?.venue,
  subject: row?.principal?.subject,
});

/**
 * ONE composed host serving BOTH doors: a `claudeCode()`-shaped harness turn on
 * the chat wire, and the MCP door at its canonical mount.
 */
async function composedHost(script: (call: (tool: string, args: unknown) => Promise<string>) => Promise<void>) {
  const store = await tempStore();
  const observed: string[] = [];
  const harness = defineHarness({
    name: "parity-probe",
    async *run(turn) {
      await script(async (tool, args) => {
        const result = await turn.tools.call(tool, args as never);
        observed.push(`${tool}:${result.status}`);
        return result.status;
      });
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    policy: "cautious",
    harness: harness as never,
    mcp: true,
    oauth: {
      async authorize() {
        return { subject: SUBJECT };
      },
      async principal(subject) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostTools());
  await store.ensureSchema();
  return { vendo, store, observed };
}

/** The chat wire's own turn — the in-process projection. */
async function runHarnessTurn(vendo: Vendo, threadId: string, text: string): Promise<void> {
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      message: { id: `m_${threadId}`, role: "user", parts: [{ type: "text", text }] },
    }),
  }));
  if (response.status !== 200) throw new Error(`turn failed ${response.status}: ${await response.text()}`);
  // Drain the stream: the turn only completes as the body is consumed.
  await response.text();
}

/** The user's tap over the public wire, polled because the turn blocks on it. */
async function tapWhenItAppears(vendo: Vendo, tool: string, approve: boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listed = await vendo.handler(new Request("https://host.test/api/vendo/approvals"));
    if (listed.ok) {
      const pending = (await listed.json()) as Array<{ id: string; call?: { tool?: string } }>;
      const mine = pending.find((request) => request.call?.tool === tool);
      if (mine !== undefined) {
        const decided = await vendo.handler(new Request("https://host.test/api/vendo/approvals/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [mine.id], decision: { approve } }),
        }));
        if (!decided.ok) throw new Error(`decide failed ${decided.status}`);
        return mine.id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no approval was ever parked for ${tool}`);
}

// ── the MCP door's client side ────────────────────────────────────────────────

const pkce = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** register → authorize → token. The ONLY way a bearer for this door exists. */
async function bearer(vendo: Vendo): Promise<string> {
  const registered = await vendo.handler(new Request(`${MOUNT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "parity gate", redirect_uris: [REDIRECT], scope: "read write" }),
  }));
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const authorized = await vendo.handler(new Request(`${MOUNT}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkce(VERIFIER),
    code_challenge_method: "S256",
    scope: "read write",
    resource: MOUNT,
  })}`));
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;

  const issued = await vendo.handler(new Request(`${MOUNT}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: MOUNT,
    }),
  }));
  if (issued.status !== 200) throw new Error(`token failed ${issued.status}: ${await issued.text()}`);
  return ((await issued.json()) as { access_token: string }).access_token;
}

interface DoorSession {
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
}

/** A minimal streamable-HTTP MCP client: initialize, then tools/call. */
async function openDoor(vendo: Vendo, token: string): Promise<DoorSession> {
  let id = 0;
  let sessionId: string | undefined;
  const rpc = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    id += 1;
    const response = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    }));
    const learned = response.headers.get("mcp-session-id");
    if (learned !== null) sessionId = learned;
    const body = await response.text();
    // The door answers JSON-RPC over SSE frames; take the last data line.
    const line = body.split("\n").filter((raw) => raw.startsWith("data:")).at(-1);
    const payload = JSON.parse(line === undefined ? body : line.slice(5).trim()) as
      { result?: Record<string, unknown>; error?: { message?: string } };
    if (payload.error !== undefined) throw new Error(`door ${method} failed: ${payload.error.message}`);
    return payload.result ?? {};
  };

  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "parity-gate", version: "1.0.0" },
  });
  await vendo.handler(new Request(MOUNT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }));

  return {
    async callTool(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      const content = (result["content"] as Array<{ text?: string }> | undefined) ?? [];
      return {
        ...(result["isError"] === true ? { isError: true } : {}),
        text: content.map((part) => part.text ?? "").join(""),
      };
    },
  };
}

// ── the gate ──────────────────────────────────────────────────────────────────

describe("cc-native parity gate — MCP door vs the in-process projection", () => {
  it("a READ the policy runs: the audit rows differ in venue, and the door's row alone is not attributable to the turn", async () => {
    const { vendo, store, observed } = await composedHost(async (call) => {
      await call(READ_TOOL, { query: "balance" });
    });

    const fromTurn = await rowsAddedBy(store, READ_TOOL, async () => {
      await runHarnessTurn(vendo, "thr_read", "look it up");
    });
    expect(observed).toEqual([`${READ_TOOL}:ok`]);
    expect(fromTurn).toHaveLength(1);
    const inProcess = shapeOf(fromTurn[0]);

    const door = await openDoor(vendo, await bearer(vendo));
    const fromDoor = await rowsAddedBy(store, READ_TOOL, async () => {
      const answered = await door.callTool(READ_TOOL, { query: "balance" });
      expect(answered.isError).toBeFalsy();
    });
    expect(fromDoor).toHaveLength(1);
    const throughDoor = shapeOf(fromDoor[0]);

    // THE MEASUREMENT, all five contract-named fields, verbatim. Four of five
    // agree; `venue` does not, and it does not because the door HARDCODES it
    // (`mcpContext`, packages/mcp/src/door.ts) while the in-process projection
    // carries the RUN's own venue. Routing a claudeCode() turn's tools through
    // the door relabels every tool call in every chat turn as MCP traffic — and
    // `venue` is a policy-matchable field (packages/guard/src/policy.ts) and a
    // grant-set predicate (core grant-sets.ts), so this is not cosmetic.
    expect(inProcess).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "chat",
      subject: SUBJECT,
    });
    expect(throughDoor).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
  });

  it("a WRITE the policy parks: the in-process path blocks for the tap and executes; the door refuses and tells the client to go elsewhere", async () => {
    const { vendo, store, observed } = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 1400 });
    });

    // In-process: the card reaches the user mid-turn, the turn WAITS, the tap
    // lands, the call executes. One ask, one human decision, one execution.
    const fromTurn = await rowsAddedBy(store, WRITE_TOOL, async () => {
      const tap = tapWhenItAppears(vendo, WRITE_TOOL, true);
      await runHarnessTurn(vendo, "thr_write", "pay them");
      await tap;
    });
    expect(observed).toEqual([`${WRITE_TOOL}:ok`]);
    const inProcess = shapeOf(fromTurn.at(-1));
    expect(inProcess.outcome).toBe("ok");

    // Through the door: no card on any turn's stream, no wait. The door answers
    // the CALLER with an in-band error naming a queue it cannot reach, and the
    // audit row says `pending-approval` — a different outcome for the same ask.
    const door = await openDoor(vendo, await bearer(vendo));
    const fromDoor = await rowsAddedBy(store, WRITE_TOOL, async () => {
      const answered = await door.callTool(WRITE_TOOL, { amount: 1400 });
      expect(answered.isError).toBe(true);
      expect(answered.text).toContain("needs approval");
    });
    const throughDoor = shapeOf(fromDoor.at(-1));

    // MEASURED DIVERGENCE 2 — approval behavior, on the SAME five fields. Same
    // ask, same guard, same policy: one path is a live approval a human answers
    // inside the turn, the other is a refusal plus a retry instruction. A boxed
    // agent cannot act on "resolve it in the product and retry", and the row it
    // leaves behind is a still-live ask rather than a completed write.
    expect(throughDoor).toEqual({
      outcome: "pending-approval",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
    expect(inProcess.outcome).not.toBe(throughDoor.outcome);
  }, 20_000);

  it("a DENIED write: in-process the model is handed the guard's reason; through the door the reason arrives too, but as the caller's own error", async () => {
    const { vendo, store, observed } = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 9 });
    });

    const tap = tapWhenItAppears(vendo, WRITE_TOOL, false);
    await runHarnessTurn(vendo, "thr_deny", "pay them");
    await tap;
    // The turn saw a plain denial it can narrate — never a throw (contract §1.1).
    expect(observed).toEqual([`${WRITE_TOOL}:denied`]);

    const rows = await toolRows(store, WRITE_TOOL);
    // In-process, a turned-down approval leaves NO executed tool-call row: the
    // call never ran. The door's `pending-approval` row (previous test) records
    // an ask that is still live. Both are honest; they are not the same fact.
    expect(rows.every((row) => row.outcome !== "ok")).toBe(true);
  }, 20_000);

  it("the door cannot be reached with a per-turn token a harness mints — a bearer only exists at the end of an OAuth authorization-code flow", async () => {
    const { vendo } = await composedHost(async () => undefined);

    // The cc-native design's `headers: { Authorization: Bearer <per-turn token> }`
    // has no issuer: the door authenticates ONLY grants minted through its own
    // /register → /authorize → /token flow (10-mcp §3), so a token the harness
    // invents is a 401 and there is no internal mint to call instead.
    const invented = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: "Bearer bxt_a-token-the-harness-minted",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    }));
    expect(invented.status).toBe(401);
  });
});
