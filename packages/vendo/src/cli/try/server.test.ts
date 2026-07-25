import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { runDeterministicPass } from "./extract.js";
import { VENDO_FIXTURES_FORMAT, VENDO_USECASES_FORMAT, type TryProfile } from "./profile.js";
import {
  composeTryVendo,
  createTryEventBus,
  startTryServer,
  type TryEvent,
  type TryServer,
} from "./server.js";

const cleanupDirs: string[] = [];
const cleanupServers: TryServer[] = [];

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanupDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

/** Same minimal Next-ish host as extract.test.ts: one shadcn-token stylesheet,
 *  one app-router API route (`host_invoices_list`, GET /api/invoices). */
async function nextFixture(): Promise<string> {
  const root = await tempDir("vendo-try-server-fixture-");
  await write(root, "package.json", `${JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.4.0" },
  }, null, 2)}\n`);
  await write(root, "app/layout.tsx", [
    'import "./globals.css";',
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    "",
  ].join("\n"));
  await write(root, "app/globals.css", [
    ":root {",
    "  --background: #fffdf8;",
    "  --foreground: #1c1917;",
    "  --primary: #7c3aed;",
    "  --radius: 10px;",
    "}",
    "",
  ].join("\n"));
  await write(root, "app/api/invoices/route.ts",
    "export async function GET() { return Response.json([]); }\n");
  return root;
}

/** Full recursive inventory of a tree (extract.test.ts's zero-commit unit). */
async function inventory(root: string, at = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      entries[`${relative}/`] = "dir";
      Object.assign(entries, await inventory(root, path));
    } else {
      entries[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return entries;
}

async function extractedProfile(): Promise<{ repoRoot: string; profileRoot: string }> {
  const repoRoot = await nextFixture();
  const profileRoot = await tempDir("vendo-try-server-profile-");
  await runDeterministicPass({ repoRoot, profileRoot });
  return { repoRoot, profileRoot };
}

async function serve(options: Parameters<typeof startTryServer>[0]): Promise<TryServer> {
  const server = await startTryServer(options);
  cleanupServers.push(server);
  return server;
}

async function fetchProfile(server: TryServer): Promise<TryProfile> {
  const response = await fetch(`${server.url}/profile.json`);
  expect(response.status).toBe(200);
  return await response.json() as TryProfile;
}

/** A model the tests never invoke: liveChat is a capability FLAG, not a call. */
function stubModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "stub",
    modelId: "stub",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("the try server must never call the model on its own"); },
    doStream: async () => { throw new Error("the try server must never call the model on its own"); },
  } as unknown as LanguageModel;
}

/** Read SSE frames off a fetch body until `count` data frames (and
 *  `minComments` comment frames) arrived. */
async function readDataFrames(
  body: ReadableStream<Uint8Array>,
  count: number,
  minComments = 0,
): Promise<{ data: TryEvent[]; comments: string[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const data: TryEvent[] = [];
  const comments: string[] = [];
  try {
    while (data.length < count || comments.length < minComments) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (frame.startsWith("data: ")) data.push(JSON.parse(frame.slice("data: ".length)) as TryEvent);
        else if (frame.startsWith(":")) comments.push(frame);
        boundary = buffered.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { data, comments };
}

describe("startTryServer profile endpoint", () => {
  it("serves the profile from CURRENT disk state and re-reflects artifacts landing between requests", async () => {
    const { repoRoot, profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, repoRoot, env: {} });

    const first = await fetchProfile(server);
    expect(first.venue).toBe("local");
    expect(first.tools.list.map((tool) => tool.name)).toContain("host_invoices_list");
    expect(first.usecases).toEqual([]);
    // env {} → the model ladder resolves unavailable → liveChat honestly false;
    // refine defaults false until Task 11 turns it on.
    expect(first.capabilities).toEqual({ liveChat: false, refine: false });

    // Deepening lands usecases.json between requests — no restart, no cache.
    await write(profileRoot, ".vendo/data/extract/usecases.json", JSON.stringify({
      format: VENDO_USECASES_FORMAT,
      usecases: [{ label: "Overdue invoices", prompt: "Show my overdue invoices" }],
    }));
    const second = await fetchProfile(server);
    expect(second.usecases).toEqual([{ label: "Overdue invoices", prompt: "Show my overdue invoices" }]);
    expect(second.depth.stages["usecases"]).toBe("done");
  });

  it("reports liveChat true when the caller supplies a model, and threads venue/brand options", async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({
      profileRoot,
      model: stubModel(),
      brand: { name: "Maple" },
      env: {},
    });

    const profile = await fetchProfile(server);
    expect(profile.capabilities.liveChat).toBe(true);
    expect(profile.brand.name).toBe("Maple");
  });
});

describe("startTryServer shell", () => {
  it("injects window.__VENDO_TRY__ into / and serves the playground bundle", async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {} });

    const home = await fetch(server.url);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(
      'window.__VENDO_TRY__ = {"profileUrl":"/profile.json","eventsUrl":"/events","apiBase":"/api/vendo"}',
    );
    expect(html).toContain('src="/playground.js');

    const bundle = await fetch(`${server.url}/playground.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");

    expect((await fetch(`${server.url}/favicon.ico`)).status).toBe(204);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
});

describe("startTryServer events (SSE)", () => {
  it("streams bus emissions to a connected client, with heartbeats, and closes cleanly", async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 20 });

    const stream = await fetch(`${server.url}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    server.events.emit({ type: "stage", stage: "usecases", status: "done" });
    // The injectable heartbeat interval is tiny here, so keep reading until a
    // heartbeat comment frame arrives alongside the data frame.
    const { data, comments } = await readDataFrames(stream.body!, 1, 1);
    expect(data[0]).toEqual({ type: "stage", stage: "usecases", status: "done" });
    expect(comments[0]).toBe(": heartbeat");

    await server.close();
  });

  it("replays latest-known state to a late subscriber and overrides profile stage statuses", async () => {
    const { profileRoot } = await extractedProfile();
    const bus = createTryEventBus();
    const server = await serve({ profileRoot, env: {}, events: bus });

    // Emitted BEFORE any client connects — and superseded once for the same stage.
    bus.emit({ type: "stage", stage: "usecases", status: "pending" });
    bus.emit({ type: "stage", stage: "usecases", status: "failed" });
    bus.emit({ type: "stage", stage: "fixtures", status: "skipped" });

    const late = await fetch(`${server.url}/events`);
    const { data } = await readDataFrames(late.body!, 2);
    expect(data).toEqual([
      { type: "stage", stage: "usecases", status: "failed" },
      { type: "stage", stage: "fixtures", status: "skipped" },
    ]);

    // The bus's latest-known statuses win over the disk-derived defaults.
    const profile = await fetchProfile(server);
    expect(profile.depth.stages["usecases"]).toBe("failed");
    expect(profile.depth.stages["fixtures"]).toBe("skipped");
    expect(profile.depth.stages["tools"]).toBe("done");

    await server.close();
  });
});

describe("startTryServer /api/vendo mount", () => {
  it("answers the wire's cheapest endpoint (GET /status) through a real composition", { timeout: 60_000 }, async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {} });

    const response = await fetch(`${server.url}/api/vendo/status`);
    expect(response.status).toBe(200);
    const body = await response.json() as { posture: string; blocks: Record<string, unknown> };
    expect(body.blocks["store"]).toBe(true);
    expect(body.blocks["agent"]).toBe(true);
  });

  it("executes host route tools through the synthetic fetch (composition-level: the wire's only no-inference tool paths are bearer/model-gated)", { timeout: 60_000 }, async () => {
    const { profileRoot } = await extractedProfile();
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_1", total: 4200 }] },
    }));

    const vendo = await composeTryVendo({ profileRoot });
    try {
      // A validated wire request teaches the same-origin baseUrl default the
      // route-binding executor joins paths against (server.ts onRequestOrigin).
      const status = await vendo.handler(new Request("http://127.0.0.1/api/vendo/status"));
      expect(status.status).toBe(200);

      const outcome = await vendo.actions.execute(
        { id: "call_try_synthetic", tool: "host_invoices_list", args: {} },
        { principal: { kind: "user", subject: "try_user" }, venue: "chat", presence: "present", sessionId: "session_try" },
      );
      expect(outcome.status).toBe("ok");
      // The fixture rows came back: the host request was answered by the
      // synthetic fetch, not the (not-running) host API.
      expect(outcome.output).toEqual([{ id: "inv_1", total: 4200 }]);
    } finally {
      await vendo.store.close();
    }
  });

  it("rebuilds the mount when compose-time artifacts change: the next turn sees NEW fixture rows and the landed brief", { timeout: 60_000 }, async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    // Each POST /threads turn is two model calls: a host tool call, then the
    // closing text — scripted, so the server never needs a real key.
    let calls = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        calls += 1;
        prompts.push(structuredClone(prompt));
        const chunks = calls % 2 === 1
          ? [
              { type: "tool-call" as const, toolCallId: `call_${calls}`, toolName: "host_invoices_list", input: "{}" },
              { type: "finish" as const, usage, finishReason: { unified: "tool-calls" as const, raw: undefined } },
            ]
          : [
              { type: "text-start" as const, id: `t${calls}` },
              { type: "text-delta" as const, id: `t${calls}`, delta: "Done." },
              { type: "text-end" as const, id: `t${calls}` },
              { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: undefined } },
            ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });

    const { profileRoot } = await extractedProfile();
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_first" }] },
    }));
    const server = await serve({ profileRoot, env: {}, model: model as unknown as LanguageModel });
    const turn = async (threadId: string): Promise<string> => {
      const response = await fetch(`${server.url}/api/vendo/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          message: { id: `msg_${threadId}`, role: "user", parts: [{ type: "text", text: "List invoices" }] },
        }),
      });
      expect(response.status).toBe(200);
      return await response.text();
    };

    // First composition: the tool result streamed back carries the v1 rows.
    expect(await turn("thr_rebuild_1")).toContain("inv_first");

    // Deepening lands NEW fixtures and the brief between requests.
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_second" }] },
    }));
    await write(profileRoot, ".vendo/brief.md", "Maple is a neobank for freelancers.\n");

    const second = await turn("thr_rebuild_2");
    expect(second).toContain("inv_second");
    expect(second).not.toContain("inv_first");
    // The rebuilt composition also re-read brief.md into the system prompt —
    // the whole compose-time read set refreshes, not just fixtures.
    expect(JSON.stringify(prompts[2])).toContain("Maple is a neobank for freelancers.");
  });

  it("recovers /api/vendo after the profile is repaired: a failed composition is retried, never terminal", { timeout: 60_000 }, async () => {
    const profileRoot = await tempDir("vendo-try-server-repair-");
    await write(profileRoot, ".vendo/try-store", "not a directory\n");
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 20 });

    expect((await fetch(`${server.url}/api/vendo/status`)).status).toBe(503);

    // Repair: the blocking file goes away (state OUTSIDE the keyed artifact
    // set — recovery must not depend on a keyed file ever changing).
    await rm(join(profileRoot, ".vendo", "try-store"));
    expect((await fetch(`${server.url}/api/vendo/status`)).status).toBe(200);
  });

  it("degrades to 503 JSON naming the composition error while /, /profile.json, /events still paint", { timeout: 60_000 }, async () => {
    const profileRoot = await tempDir("vendo-try-server-corrupt-");
    // A FILE where the try store's PGlite data directory must go: composing
    // the vendo instance over this profile root fails, nothing else does.
    await write(profileRoot, ".vendo/try-store", "not a directory\n");
    // A short heartbeat so cancelling the /events probe below doesn't sit out
    // a full default heartbeat interval (undici resolves cancel on the next
    // server write).
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 20 });

    const api = await fetch(`${server.url}/api/vendo/status`);
    expect(api.status).toBe(503);
    const body = await api.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("composition-failed");
    expect(body.error.message).toMatch(/try-store/);

    expect((await fetch(server.url)).status).toBe(200);
    expect((await fetchProfile(server)).depth.level).toBe("shallow");
    const events = await fetch(`${server.url}/events`);
    expect(events.status).toBe(200);
    await events.body?.cancel();
  });
});

describe("startTryServer zero-commit contract", () => {
  it("never writes a byte under repoRoot across serving, SSE, and the vendo mount", { timeout: 60_000 }, async () => {
    const repoRoot = await nextFixture();
    const profileRoot = await tempDir("vendo-try-server-profile-");
    await runDeterministicPass({ repoRoot, profileRoot });
    const before = await inventory(repoRoot);

    const server = await serve({ profileRoot, repoRoot, env: {} });
    await fetch(server.url);
    await fetchProfile(server);
    server.events.emit({ type: "stage", stage: "brief", status: "pending" });
    const events = await fetch(`${server.url}/events`);
    await readDataFrames(events.body!, 1);
    // The mount composes a real store — its PGlite data dir must land under
    // profileRoot, never the repo (and never the cwd).
    expect((await fetch(`${server.url}/api/vendo/status`)).status).toBe(200);
    await server.close();

    expect(await inventory(repoRoot)).toEqual(before);
  });
});
