import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toolsFileSchema, type ExtractedTool } from "@vendoai/actions";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { createVendo, type Vendo } from "../../server.js";
import { PLAYGROUND_BUNDLE_SOURCE } from "../playground/bundle.gen.js";
import { resolveRefineModel } from "../refine.js";
import {
  assembleTryProfile,
  fixturesFileSchema,
  tryStageStatusSchema,
  VENDO_FIXTURES_FORMAT,
  type FixturesFile,
  type TryProfile,
  type TryStageStatus,
} from "./profile.js";
import { createSyntheticFetch } from "./synthetic-fetch.js";

/**
 * The local HTTP server behind `npx vendo try` (unified try surface, Task 5).
 *
 * The LATENCY LAW: the first paint never gates on AI. `/`, `/playground.js`,
 * `/profile.json`, and `/events` serve from disk state and in-process memory
 * alone — no model call, no network, no browser launch, no child process. The
 * model only ever matters on `/api/vendo` chat turns the USER starts, and the
 * `liveChat` capability the profile reports is resolved once at startup
 * without failing the server (a keyless machine still paints everything).
 *
 * The ZERO-COMMIT GUARANTEE (extends Task 2's): every byte this server writes
 * lands under `profileRoot` — the composed vendo store's PGlite data dir is
 * pinned there explicitly (never the process cwd `createStore` would default
 * to), and `profileDir: profileRoot` points every `.vendo/` read/capture at
 * the same root. The host repo stays read-only.
 */

/** One event on the try surface's deepening stream. Task 6 (the deepening
 *  orchestrator) emits `{ type: "stage", stage, status }` through this shape;
 *  the schema deliberately stays open for additive event kinds. */
export interface TryEvent {
  type: string;
  [key: string]: unknown;
}

/** The deepening event bus — the seam between the orchestrator (Task 6, the
 *  emitter) and this server (the SSE relay + profile stage overrides). */
export interface TryEventBus {
  emit(event: TryEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(subscriber: (event: TryEvent) => void): () => void;
  /** Latest-known state for late subscribers: the newest event per replay key
   *  (`type`, plus the stage for stage events), in emission order. */
  replay(): TryEvent[];
  /** The latest stage statuses seen on the stream — the live overrides
   *  `assembleTryProfile` applies over its disk-derived defaults. */
  stages(): Record<string, TryStageStatus>;
}

export function createTryEventBus(): TryEventBus {
  const latest = new Map<string, TryEvent>();
  const stageStatuses: Record<string, TryStageStatus> = {};
  const subscribers = new Set<(event: TryEvent) => void>();
  return {
    emit(event) {
      const key = typeof event["stage"] === "string" ? `${event.type}:${event["stage"]}` : event.type;
      // Delete-then-set so a superseding event moves to the tail: replay stays
      // in true emission order even when a stage's status changes.
      latest.delete(key);
      latest.set(key, event);
      if (event.type === "stage" && typeof event["stage"] === "string") {
        const status = tryStageStatusSchema.safeParse(event["status"]);
        if (status.success) stageStatuses[event["stage"]] = status.data;
      }
      for (const subscriber of [...subscribers]) subscriber(event);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    replay: () => [...latest.values()],
    stages: () => ({ ...stageStatuses }),
  };
}

/** The wire mount and the boot object the surface app reads off `window`. */
const API_BASE = "/api/vendo";
const TRY_BOOT = JSON.stringify({ profileUrl: "/profile.json", eventsUrl: "/events", apiBase: API_BASE });
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface StartTryServerOptions {
  /** The Task-2 profile root (`assembleTryProfile` boots from it) — also the
   *  ONE directory this server may write under. */
  profileRoot: string;
  /** The host repo the profile was extracted from; model detection resolves
   *  provider modules against it. Never written to. */
  repoRoot?: string;
  /** 0 (the default) asks the OS for a free port. */
  port?: number;
  venue?: "local";
  brand?: Partial<TryProfile["brand"]>;
  /** Explicit capability flags win over detection; `refine` defaults false
   *  until Task 11 turns it on. */
  capabilities?: { liveChat?: boolean; refine?: boolean };
  /** BYO model, threaded into the vendo composition; also flips liveChat on. */
  model?: LanguageModel;
  /** Share a bus with the deepening orchestrator (Task 6); default fresh. */
  events?: TryEventBus;
  /** Test seams. */
  env?: Record<string, string | undefined>;
  heartbeatIntervalMs?: number;
}

export interface TryServer {
  url: string;
  port: number;
  events: TryEventBus;
  close(): Promise<void>;
}

/** Fail-soft artifact read, mirroring assembleTryProfile's posture: a missing
 *  or malformed file degrades to `fallback`, never a throw. */
async function readProfileArtifact<Value>(
  path: string,
  parse: (raw: string) => Value,
  fallback: Value,
): Promise<Value> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Compose the real vendo instance the try server mounts under /api/vendo:
 * the profile root as `profileDir`, the synthetic fetch answering host route
 * calls from the profile's tools.json + fixtures.json, and an EXPLICIT store.
 *
 * The store is pinned to `<profileRoot>/.vendo/try-store` — never left to
 * `createStore`'s cwd-relative `.vendo/data` default (the zero-commit
 * guarantee), and deliberately NOT `<profileRoot>/.vendo/data` either: the
 * extraction artifacts (data/extract/*.json) already live there, and PGlite
 * initializes its data directory expecting to own it.
 *
 * Composition includes the store's schema probe so a corrupt profile root
 * fails HERE (the server's 503 lane) instead of surfacing as an opaque 500 on
 * the first wire request.
 */
export async function composeTryVendo(options: {
  profileRoot: string;
  model?: LanguageModel;
}): Promise<Vendo> {
  const vendoDir = join(options.profileRoot, ".vendo");
  const tools = await readProfileArtifact<ExtractedTool[]>(
    join(vendoDir, "tools.json"),
    (raw) => toolsFileSchema.parse(JSON.parse(raw)).tools,
    [],
  );
  const fixtures = await readProfileArtifact<FixturesFile>(
    join(vendoDir, "data", "extract", "fixtures.json"),
    (raw) => fixturesFileSchema.parse(JSON.parse(raw)),
    { format: VENDO_FIXTURES_FORMAT, fixtures: {} },
  );
  const store = createStore({
    dataDir: join(vendoDir, "try-store"),
    // The try store is a throwaway demo database inside a temp profile root;
    // dev-mode plaintext is the honest posture (02-store §4).
    allowUnencryptedSecrets: true,
  });
  const vendo = createVendo({
    profileDir: options.profileRoot,
    fetch: createSyntheticFetch({ tools, fixtures }),
    store,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  try {
    await vendo.store.ensureSchema();
  } catch (error) {
    await vendo.store.close().catch(() => undefined);
    throw error;
  }
  return vendo;
}

/** liveChat is an honest capability flag, resolved ONCE at startup: a passed
 *  model (or explicit flag) wins; otherwise the same dev-credential ladder
 *  `vendo refine` rides (resolveRefineModel → DevModelController) decides —
 *  and a resolution failure means `false`, never a failed server. */
async function detectLiveChat(options: StartTryServerOptions): Promise<boolean> {
  if (options.capabilities?.liveChat !== undefined) return options.capabilities.liveChat;
  if (options.model !== undefined) return true;
  try {
    await resolveRefineModel({
      root: options.repoRoot ?? options.profileRoot,
      env: options.env ?? process.env,
    });
    return true;
  } catch {
    return false;
  }
}

function pageHtml(): string {
  // The playground shell (playground.ts pageHtml) plus the try boot object:
  // one small serialized script the surface app (Tasks 8-10) reads to find the
  // profile, the deepening stream, and the wire mount.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vendo Try</title>
</head>
<body>
<div id="root"></div>
<script>window.__VENDO_TRY__ = ${TRY_BOOT};</script>
<script src="/playground.js?v=${PLAYGROUND_BUNDLE_SOURCE.length.toString(36)}"></script>
</body>
</html>
`;
}

/** Minimal node-http → fetch adapter for the mounted wire handler, modeled on
 *  the integrator-written one in corpus/hosts/express-host (stream the request
 *  body, preserve method/headers, write back status/headers/body — set-cookie
 *  via getSetCookie so multiple cookies survive). Local because the umbrella
 *  ships no Node server adapter of its own (hosts bring their framework's). */
async function serveWireRequest(
  vendo: Vendo,
  request: IncomingMessage,
  response: ServerResponse,
  fallbackHost: string,
): Promise<void> {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  }
  const url = new URL(request.url ?? "/", `http://${headers.get("host") ?? fallbackHost}`);
  const method = (request.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const wireResponse = await vendo.handler(new Request(url, init));
  response.statusCode = wireResponse.status;
  wireResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  });
  const cookies = wireResponse.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (wireResponse.body === null) {
    response.end();
    return;
  }
  // Pipeline preserves streaming backpressure; SSE/stream chunks never buffer.
  await pipeline(Readable.fromWeb(wireResponse.body as import("node:stream/web").ReadableStream), response);
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

type MountState = { vendo: Vendo } | { error: string };

export async function startTryServer(options: StartTryServerOptions): Promise<TryServer> {
  const bus = options.events ?? createTryEventBus();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const liveChat = await detectLiveChat(options);

  // The /api/vendo mount, composed LAZILY on first use and REBUILT whenever
  // any compose-time profile read changes on disk. Chosen over a per-call
  // lazy fixtures read inside the synthetic fetch because recomposition
  // refreshes EVERY compose-time read at once (brief.md into the system
  // prompt, theme/catalog/semantics, the tool surface, the fixture rows) —
  // one freshness mechanism instead of several. The trade (in-memory thread
  // state resets on rebuild) is bounded: deepening writes each artifact once
  // per run, and durable state lives in the store, which every composition
  // shares (the PGlite handle is per-dataDir refcounted in-process). A failed
  // composition answers 503 naming the error while every other route keeps
  // painting — and is NEVER cached terminally: the next /api request retries,
  // because the failure may stem from state outside the keyed set (the store
  // directory itself, permissions), not just a keyed artifact.
  //
  // The key is one stat sweep per request over the exact compose-time read
  // set: `.vendo/` tools.json + overrides.json + capabilities.json (the
  // actions registry), theme.json + brief.md + catalog.json + semantics.json
  // (createVendo's own dotVendo reads), and data/extract/fixtures.json (the
  // synthetic fetch). design-rules.md needs no recompose (createVendo re-reads
  // it per generation), and `.vendo/remixable/` pin baselines are left out
  // deliberately (deepening never writes them; sync does, before the server).
  const COMPOSE_READ_SET: readonly string[][] = [
    ["tools.json"],
    ["overrides.json"],
    ["capabilities.json"],
    ["theme.json"],
    ["brief.md"],
    ["catalog.json"],
    ["semantics.json"],
    ["data", "extract", "fixtures.json"],
  ];
  let mount: { key: string; ready: Promise<MountState>; failed: boolean } | undefined;
  const composedStores: Vendo["store"][] = [];
  const composeKey = async (): Promise<string> => {
    const stamps = await Promise.all(COMPOSE_READ_SET.map(async (segments) => {
      try {
        const stats = await stat(join(options.profileRoot, ".vendo", ...segments));
        return `${stats.mtimeMs}:${stats.size}`;
      } catch {
        return "absent";
      }
    }));
    return stamps.join("|");
  };
  const currentMount = async (): Promise<MountState> => {
    const key = await composeKey();
    if (mount === undefined || mount.key !== key || mount.failed) {
      const superseded = mount;
      const next: { key: string; ready: Promise<MountState>; failed: boolean } = {
        key,
        failed: false,
        ready: composeTryVendo({
          profileRoot: options.profileRoot,
          ...(options.model === undefined ? {} : { model: options.model }),
        }).then(
          (vendo): MountState => {
            composedStores.push(vendo.store);
            return { vendo };
          },
          (error): MountState => {
            next.failed = true;
            return { error: error instanceof Error ? error.message : String(error) };
          },
        ),
      };
      mount = next;
      // Release the superseded composition's store instead of stranding its
      // PGlite ref until close(). Best-effort: a request still streaming on
      // the old composition loses its store mid-flight, which is the accepted
      // rebuild trade above (rebuilds coincide with deepening writes).
      if (superseded !== undefined) {
        void superseded.ready
          .then(async (state) => {
            if ("vendo" in state) {
              const index = composedStores.indexOf(state.vendo.store);
              if (index >= 0) composedStores.splice(index, 1);
              await state.vendo.store.close();
            }
          })
          .catch(() => undefined);
      }
    }
    return mount.ready;
  };

  // Open SSE responses, tracked so close() can end them (an idle EventSource
  // would otherwise hold the server open forever).
  const sseClients = new Set<ServerResponse>();
  const serveEvents = (request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Node holds headers until the first body write; flush now so EventSource
    // fires `open` immediately instead of waiting on the first event or
    // heartbeat (an idle stream would otherwise sit head-less for 15s).
    response.flushHeaders();
    let unsubscribe: () => void = () => undefined;
    let closed = false;
    const teardown = (): void => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      sseClients.delete(response);
    };
    // A dead socket surfaces as a throw from write(): tear this client down
    // instead of letting the throw propagate into bus.emit (one bad client
    // must never break the emitter or its other subscribers).
    const send = (event: TryEvent): void => {
      try {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        teardown();
      }
    };
    const heartbeat = setInterval(() => {
      try {
        response.write(": heartbeat\n\n");
      } catch {
        teardown();
      }
    }, heartbeatIntervalMs);
    heartbeat.unref();
    // Latest-known state first: a late subscriber paints current progress
    // immediately instead of waiting for the next emission.
    for (const event of bus.replay()) send(event);
    // A socket that died DURING the replay burst already ran teardown();
    // subscribing/registering after it would re-add a dead client.
    if (closed) return;
    unsubscribe = bus.subscribe(send);
    sseClients.add(response);
    request.once("close", teardown);
  };

  let fallbackHost = "127.0.0.1";
  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === API_BASE || path.startsWith(`${API_BASE}/`)) {
      const state = await currentMount();
      if ("error" in state) {
        // The mount degrades alone: the surface still paints from /profile.json
        // and /events; only the wire names its composition failure.
        json(response, { error: { code: "composition-failed", message: state.error } }, 503);
        return;
      }
      await serveWireRequest(state.vendo, request, response, fallbackHost);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (path === "/playground.js") {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(PLAYGROUND_BUNDLE_SOURCE);
      return;
    }
    if (path === "/profile.json") {
      // Assembled from CURRENT disk state on every request (deepening lands
      // artifacts between requests), with the bus's live stage statuses on top.
      const profile = await assembleTryProfile(options.profileRoot, {
        venue: options.venue ?? "local",
        ...(options.brand === undefined ? {} : { brand: options.brand }),
        capabilities: { liveChat, refine: options.capabilities?.refine ?? false },
        stages: bus.stages(),
      });
      json(response, profile);
      return;
    }
    if (path === "/events") {
      serveEvents(request, response);
      return;
    }
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (path !== "/" && path !== "/index.html") {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(pageHtml());
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        json(response, { error: { code: "internal", message } }, 500);
        return;
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      // Detach the bind-failure handler so a later runtime error is not
      // swallowed by rejecting an already-settled promise (playground.ts).
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  fallbackHost = `127.0.0.1:${port}`;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    events: bus,
    close: async () => {
      for (const client of sseClients) client.end();
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // Every composition's store (rebuilds included): release the shared
      // PGlite handle and the composition's unref'd sweep timer.
      await Promise.all(composedStores.splice(0).map((store) => store.close().catch(() => undefined)));
    },
  };
}
