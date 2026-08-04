import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunContext } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { composioConnector } from "./composio.js";

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const ctx = (subject = "user_alice"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
});

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Composio's real shapes, verified against their API reference 2026-08-03:
 * search answers with SLUG LISTS plus a separate connection-status array, and
 * carries no schemas and no tags of its own — those come from the batch read. */
interface StubOptions {
  primary?: string[];
  related?: string[];
  connected?: boolean;
  tools?: Record<string, { toolkit: string; description?: string; tags?: string[]; input?: unknown }>;
  execute?: (slug: string, body: Record<string, unknown>) => { status: number; payload: unknown };
}

function composioStub(options: StubOptions = {}) {
  const counts = { session: 0, search: 0, batch: 0, single: 0, execute: 0 };
  const seenSessionUsers: string[] = [];
  const tools = options.tools ?? {
    GMAIL_SEND_EMAIL: {
      toolkit: "gmail",
      description: "Send an email with Gmail",
      tags: ["destructiveHint"],
      input: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    },
  };

  const item = (slug: string) => {
    const tool = tools[slug]!;
    return {
      slug,
      toolkit_slug: tool.toolkit,
      description: tool.description,
      ...(tool.tags === undefined ? {} : { tags: tool.tags }),
      ...(tool.input === undefined ? {} : { input_parameters: tool.input }),
    };
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://stub");
    res.setHeader("content-type", "application/json");

    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      counts.session += 1;
      const body = await readBody(req);
      seenSessionUsers.push(String(body["user_id"]));
      res.end(JSON.stringify({ session_id: `trs_${seenSessionUsers.length}` }));
      return;
    }

    if (req.method === "POST" && /^\/api\/v3\.1\/tool_router\/session\/[^/]+\/search$/.test(url.pathname)) {
      counts.search += 1;
      const toolkits = [...new Set(Object.values(tools).map((tool) => tool.toolkit))];
      res.end(JSON.stringify({
        results: [{
          primary_tool_slugs: options.primary ?? Object.keys(tools),
          related_tool_slugs: options.related ?? [],
        }],
        toolkit_connection_statuses: toolkits.map((toolkit) => ({
          toolkit,
          has_active_connection: options.connected ?? false,
          status_message: `Connect ${toolkit} to continue.`,
        })),
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v3.1/tools") {
      counts.batch += 1;
      const slugs = (url.searchParams.get("tool_slugs") ?? "").split(",").filter(Boolean);
      res.end(JSON.stringify({ items: slugs.filter((slug) => tools[slug] !== undefined).map(item) }));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/v3.1/tools/")) {
      counts.single += 1;
      const slug = decodeURIComponent(url.pathname.slice("/api/v3.1/tools/".length));
      if (tools[slug] === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "Tool not found", code: 404 } }));
        return;
      }
      res.end(JSON.stringify(item(slug)));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/v3/tools/execute/")) {
      counts.execute += 1;
      const slug = decodeURIComponent(url.pathname.slice("/api/v3/tools/execute/".length));
      const body = await readBody(req);
      const answer = options.execute?.(slug, body) ?? { status: 200, payload: { successful: true, data: { id: "m_1" } } };
      res.statusCode = answer.status;
      res.end(JSON.stringify(answer.payload));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `unstubbed ${req.method} ${url.pathname}` } }));
  };

  return { handler, counts, seenSessionUsers };
}

async function connectorOn(stub: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
  const server = await startServer(stub.handler);
  closers.push(server.close);
  return composioConnector({ apiKey: "key_test", baseUrl: server.url });
}

describe("find_service_tools rides Composio's own search", () => {
  it("returns one complete row per match — slug, toolkit, schema and connect status inline", async () => {
    const stub = composioStub();
    const connector = await connectorOn(stub);

    await expect(connector.searchTools!("send an email", ctx())).resolves.toEqual([{
      slug: "GMAIL_SEND_EMAIL",
      toolkit: "gmail",
      description: "Send an email with Gmail",
      inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      connected: false,
      statusMessage: "Connect gmail to continue.",
    }]);
  });

  it("reports the caller's own connection, not the deployment's", async () => {
    const stub = composioStub({ connected: true });
    const connector = await connectorOn(stub);

    const [match] = await connector.searchTools!("send an email", ctx());
    expect(match?.connected).toBe(true);
  });

  it("opens ONE tool-router session per subject and reuses it", async () => {
    const stub = composioStub();
    const connector = await connectorOn(stub);

    await connector.searchTools!("send an email", ctx("user_alice"));
    await connector.searchTools!("send another", ctx("user_alice"));
    await connector.searchTools!("send an email", ctx("user_bob"));

    // A session is bound to one user_id: sharing one would search and connect
    // as the wrong person.
    expect(stub.counts.session).toBe(2);
    expect(stub.seenSessionUsers).toEqual(["user_alice", "user_bob"]);
    expect(stub.counts.search).toBe(3);
  });

  it("leaves inputSchema absent when Composio has no schema, rather than inventing one", async () => {
    const stub = composioStub({
      tools: { SLACK_POST: { toolkit: "slack", description: "Post a message" } },
    });
    const connector = await connectorOn(stub);

    const [match] = await connector.searchTools!("post to slack", ctx());
    expect(match?.slug).toBe("SLACK_POST");
    expect(match).not.toHaveProperty("inputSchema");
  });

  it("caps the answer and takes primary matches before related ones", async () => {
    const tools: StubOptions["tools"] = {};
    for (let i = 0; i < 12; i += 1) tools[`PRIMARY_${i}`] = { toolkit: "gmail", description: `p${i}` };
    tools["RELATED_0"] = { toolkit: "gmail", description: "r0" };
    const stub = composioStub({
      tools,
      primary: Object.keys(tools).filter((slug) => slug.startsWith("PRIMARY_")),
      related: ["RELATED_0"],
    });
    const connector = await connectorOn(stub);

    // Composio's search takes no limit parameter, so the cap is ours.
    const matches = await connector.searchTools!("email", ctx());
    expect(matches).toHaveLength(10);
    expect(matches.every((match) => match.slug.startsWith("PRIMARY_"))).toBe(true);
  });
});

describe("use_service_tool grades and runs one slug", () => {
  it("maps Composio's own tags to our risk labels", async () => {
    const stub = composioStub({
      tools: {
        GMAIL_SEND_EMAIL: { toolkit: "gmail", tags: ["destructiveHint"] },
        GMAIL_LIST_MESSAGES: { toolkit: "gmail", tags: ["readOnlyHint"] },
        GMAIL_MYSTERY: { toolkit: "gmail" },
      },
    });
    const connector = await connectorOn(stub);

    await expect(connector.toolRisk!("GMAIL_SEND_EMAIL")).resolves.toBe("destructive");
    await expect(connector.toolRisk!("GMAIL_LIST_MESSAGES")).resolves.toBe("read");
    // Untagged is `ungraded`, never guessed from the name: #747 deleted the
    // word lists on purpose, and `ungraded` is ask-by-default.
    await expect(connector.toolRisk!("GMAIL_MYSTERY")).resolves.toBe("ungraded");
  });

  it("answers `undefined` for a slug Composio does not have, so unknown never reads as ungraded", async () => {
    const stub = composioStub();
    const connector = await connectorOn(stub);

    await expect(connector.toolRisk!("GMAIL_SEND_MESSAGE")).resolves.toBeUndefined();
  });

  it("runs the slug as the caller and names the toolkit on the outcome", async () => {
    const stub = composioStub();
    const connector = await connectorOn(stub);

    const outcome = await connector.executeSlug!("GMAIL_SEND_EMAIL", { to: "a@b.c" }, ctx());
    expect(outcome).toMatchObject({
      status: "ok",
      output: { id: "m_1" },
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: "user_alice" },
    });
  });

  it("returns a clean error for an unknown slug instead of throwing", async () => {
    const stub = composioStub();
    const connector = await connectorOn(stub);

    const outcome = await connector.executeSlug!("GMAIL_SEND_MESSAGE", {}, ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    // The dispatch never reached Composio's executor: an unknown slug is
    // refused, not attempted.
    expect(stub.counts.execute).toBe(0);
  });

  it("turns a missing per-user connection into the typed connect-required outcome", async () => {
    const stub = composioStub({
      execute: () => ({
        status: 400,
        payload: { error: { message: "no account", slug: "ActionExecute_ConnectedAccountNotFound" } },
      }),
    });
    const connector = await connectorOn(stub);

    const outcome = await connector.executeSlug!("GMAIL_SEND_EMAIL", { to: "a@b.c" }, ctx());
    expect(outcome).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
    });
  });

  it("spends no second lookup on a slug the search already returned", async () => {
    const stub = composioStub();
    const connector = await connectorOn(stub);

    await connector.searchTools!("send an email", ctx());
    const batchAfterSearch = stub.counts.batch;
    await connector.toolRisk!("GMAIL_SEND_EMAIL");
    await connector.executeSlug!("GMAIL_SEND_EMAIL", { to: "a@b.c" }, ctx());

    expect(stub.counts.batch).toBe(batchAfterSearch);
    expect(stub.counts.single).toBe(0);
  });
});
