/**
 * The box's `claudeCode()` SESSION door.
 *
 * The existing control port serves the layer-3 app builder (`/agent/*`). This
 * module adds the CONVERSATIONAL door beside it: materialize a workspace copy
 * ONCE, hold ONE Claude Agent SDK session open for the whole conversation, and
 * push each user message into it. Chat in, stream out — exactly like a terminal.
 *
 * **The bridge is inverted, and stays that way.** `SandboxMachine.request()` is
 * the only data path into a box, so the host drives: it posts a message, then
 * polls; when the model reaches a projected tool the box parks the ask and hands
 * it out on the next poll; the host runs `turn.tools.call()` and posts the answer
 * back. The box therefore holds no outbound credential at all — a workspace copy,
 * the inference key (the recorded v0 exception), and the machine token the host
 * asserts on every call.
 *
 * The cc-native lane MEASURED whether our MCP door could replace this bridge
 * (`packages/vendo/src/mcp-door-parity.e2e.test.ts`). It cannot: the door
 * hardcodes `venue`/`presence`, cannot express a live approval, and has no
 * bearer a harness can mint. So the projection stays in-process and this bridge
 * stays with it — now keyed on the SESSION rather than on one turn.
 *
 * Everything interesting about the SDK loop lives in `claude-turn.mjs`, which is
 * the SAME module `machine: "local"` runs on the host — one implementation, two
 * homes.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUNNER = "/opt/vendo-box/claude-turn.mjs";
const MAX_POLL_WAIT_MS = 25_000;
/** Finished messages stay pollable for a little while (a host retrying its last
 *  poll), then go. A session box lives for many messages, and every message's
 *  event buffer kept forever is a slow leak in a long-lived box. */
const MESSAGES_RETAINED = 4;
/**
 * Too big for the wire — the proxy's body limit is what this protects. Under the
 * DEFAULT files store (5 MiB cap) no checked-out file reaches this size; a BYO
 * files adapter has no cap, so the host's sync-back seam exempts oversized
 * checked-out files from absent-means-deleted (`materialize.ts`,
 * `WALK_SKIP_BYTES` — the same 8 MiB) instead of reading this skip as an erasure.
 */
const WALK_SKIP_BYTES = 8 * 1024 * 1024;

/** Workspace path → disk path under the root. The frozen layout (§3.1) is kept
 *  verbatim one level down, so `/user/apps/a/app.vendo` reads the same on both
 *  sides of the wire. */
const toDisk = (root, workspacePath) => path.join(root, workspacePath.replace(/^\/+/, ""));
const toWorkspace = (root, diskPath) => `/${path.relative(root, diskPath).split(path.sep).join("/")}`;

/**
 * Does this workspace path match a wanted entry that names a `*` segment?
 *
 * `*` stands for exactly ONE segment, which is all the hot set needs
 * (`/user/apps/&#42;/plan.vendo`) and the only shape a caller may ask for. Segment
 * comparison rather than a built regex: a path is user-controlled text, and
 * there is no escaping to get wrong.
 */
const matchesPattern = (pattern, workspacePath) => {
  const wanted = pattern.split("/");
  const actual = workspacePath.split("/");
  if (wanted.length !== actual.length) return false;
  return wanted.every((segment, at) => segment === "*" || segment === actual[at]);
};

/**
 * Everything the host sends is DATA: only the declared shape passes, and an
 * unrecognised status reads as an error the model narrates.
 */
const guardedResult = (raw) => {
  if (raw?.status === "ok") return { status: "ok", output: raw.output };
  if (raw?.status === "denied") {
    return { status: "denied", reason: String(raw.reason ?? "That isn't something I can do right now.") };
  }
  return { status: "error", message: String(raw.message ?? "That didn't work.") };
};

const walk = (directory, out) => {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // The SDK's own session store lives beside the workspace and is machine
    // state, never the user's files.
    if (entry.name === ".claude") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

/**
 * The tool listing a session was opened with, as one comparable string.
 *
 * An in-process MCP server's tool set is fixed when the session opens, but OUR
 * equipped set can grow mid-conversation (`find_tools`). Rather than project
 * every tool up front — which would defeat curation and THE LAW's withholding —
 * the session is REOPENED (resuming its own id, so nothing is forgotten) on the
 * rare message where the listing actually changed.
 */
const fingerprint = (tools) =>
  (Array.isArray(tools) ? tools : []).map((tool) => tool?.name).sort().join(" ");

/**
 * @param {object} options
 * @param {string} [options.root]     workspace root (default /workspace)
 * @param {string} [options.token]    the machine token the host must present
 * @param {Function} [options.openSession] injectable session factory (tests)
 * @param {NodeJS.ProcessEnv} [options.env] env handed to the SDK
 */
export const createSessionRoutes = (options = {}) => {
  const root = options.root ?? process.env.VENDO_WORKSPACE_ROOT ?? "/workspace";
  let token = options.token ?? process.env.VENDO_BOX_TOKEN ?? "";
  // What the SDK subprocess gets. Seeded from the machine's own env and
  // REPLACED by /session/hello: the provider does not hand create-time envs to
  // the template's start command (measured 2026-08-01 — the in-box SDK answered
  // "Not logged in"), so the credential arrives with the first message.
  let sdkEnv = { ...(options.env ?? process.env) };

  /** The live session, its tool fingerprint, and the id to resume on reopen. */
  let session;
  let openedWith = "";
  let sessionId;
  /** Every message's buffers, by id. The in-flight one is `current`. */
  const messages = new Map();
  let current;

  const loadFactory = async () => options.openSession ?? (await import(RUNNER)).createClaudeSession;
  /**
   * The SDK, from the machine image (`build-template.mjs` npm-installs it into
   * /opt/vendo-box at BUILD time). It is loaded HERE and not by the runner
   * because the runner's other home is a HOST's server, where naming this
   * package would drag a ~250MB platform binary into the host's build graph.
   * `agent-sdk.mjs` reaches for it exactly the same way.
   */
  const loadSdk = async () => await import("@anthropic-ai/claude-agent-sdk");

  const wake = (state) => {
    for (const resolve of state.waiters.splice(0)) resolve();
  };

  /** Events and asks belong to whichever message is in flight. Between messages
   *  nothing is active, and anything arriving then is dropped rather than
   *  attributed to the next message. */
  const emit = (event) => {
    if (current === undefined) return;
    if (event?.type === "session" && typeof event.sessionId === "string") sessionId = event.sessionId;
    current.events.push(event);
    wake(current);
  };

  const callTool = (name, args) => new Promise((resolve) => {
    const state = current;
    if (state === undefined) {
      resolve({ status: "error", message: "That didn't work." });
      return;
    }
    const id = `ask_${randomUUID()}`;
    state.asks.set(id, { id, name, args, resolve, handedOut: false });
    wake(state);
  });

  /** The host asked for a mid-turn hot sync; it polls for this and syncs. */
  const onFileWritten = (written) => {
    if (current === undefined) return;
    current.events.push({ type: "wrote", ...(typeof written === "string" ? { path: written } : {}) });
    wake(current);
  };

  const openSession = async (payload) => {
    const createClaudeSession = await loadFactory();
    // An injected factory is a test double and brings its own SDK double.
    const sdk = options.openSession === undefined ? await loadSdk() : undefined;
    openedWith = fingerprint(payload.tools);
    session = createClaudeSession({
      ...(sdk === undefined ? {} : { sdk }),
      systemPrompt: payload.systemPrompt,
      tools: Array.isArray(payload.tools) ? payload.tools : [],
      model: payload.model,
      effort: payload.effort,
      maxTurns: payload.maxTurns,
      // Reopening mid-conversation resumes the session we already have, so a
      // changed tool listing costs a restart and never a memory.
      ...(sessionId === undefined ? {} : { resume: sessionId }),
      ...(payload.pluginPath === undefined ? {} : { pluginPath: payload.pluginPath }),
      ...(payload.skillNames === undefined ? {} : { skillNames: payload.skillNames }),
      cwd: root,
      env: { ...sdkEnv },
      callTool,
      emit,
      onFileWritten,
    });
  };

  const startMessage = async (payload) => {
    const messageId = `msg_${randomUUID()}`;
    const state = { events: [], asks: new Map(), waiters: [], done: false };
    messages.set(messageId, state);
    for (const stale of [...messages.keys()].slice(0, -MESSAGES_RETAINED)) messages.delete(stale);
    current = state;

    if (session === undefined) {
      await openSession(payload);
    } else if (payload.reopen === true || fingerprint(payload.tools) !== openedWith) {
      const closing = session;
      session = undefined;
      await closing.end().catch(() => undefined);
      // `reopen` is a TRUNCATION (§1.3): the host says this session remembers an
      // answer the user threw away, so it must NOT come back with its memory —
      // the fresh one resumes nothing and the host's prompt carries the re-seed.
      // A changed tool listing is the other reason to reopen, and that one keeps
      // its id so nothing is forgotten.
      if (payload.reopen === true) sessionId = undefined;
      await openSession(payload);
    }

    state.promise = (async () => {
      try {
        await session.send(payload.prompt);
      } catch (error) {
        // The host renders one plain sentence; the detail stays in the box's log.
        console.error("[vendo-box] message failed", error);
        state.events.push({ type: "error", message: "Something went wrong while I was working on that." });
      } finally {
        state.done = true;
        // A message that ended with asks outstanding would hang the host's poll.
        for (const ask of state.asks.values()) {
          ask.resolve({ status: "error", message: "the turn ended" });
        }
        state.asks.clear();
        if (current === state) current = undefined;
        wake(state);
      }
    })();
    return messageId;
  };

  /** Hold the poll open until there is something to say, or the wait expires. */
  const poll = async (state, cursor, waitMs) => {
    const deadline = Date.now() + Math.min(Math.max(waitMs ?? 0, 0), MAX_POLL_WAIT_MS);
    for (;;) {
      const fresh = state.events.slice(cursor);
      const offered = [...state.asks.values()].filter((ask) => !ask.handedOut);
      if (fresh.length > 0 || offered.length > 0 || state.done) {
        // Handed out ONCE: a poll that re-offered an unanswered ask would have
        // the host execute the same guarded call again.
        for (const ask of offered) ask.handedOut = true;
        return {
          events: fresh,
          cursor: cursor + fresh.length,
          asks: offered.map(({ id, name, args }) => ({ id, name, args })),
          // Only truly finished when nobody is still waiting on us.
          done: state.done && state.asks.size === 0,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { events: [], cursor, done: false };
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        state.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  };

  return {
    /** True for anything this module owns, so the supervisor can delegate. */
    owns: (pathname) => pathname.startsWith("/session"),

    /**
     * @returns {Promise<{status:number, body:object}>}
     */
    async handle(method, pathname, headers, payload) {
      if (method !== "POST") return { status: 405, body: { error: "POST only" } };
      const presented = headers["x-vendo-box-token"];
      if (pathname === "/session/hello") {
        // Trust on FIRST use while the box is unclaimed; after that only the
        // holder of the token may speak. There is no ROTATION any more: a box
        // lives for one conversation and is destroyed rather than snapshotted,
        // so there is no woken supervisor holding a stale token to reconcile.
        if (token !== "" && presented !== token) {
          return { status: 401, body: { error: "bad or missing box token" } };
        }
        if (typeof payload?.token !== "string" || payload.token === "") {
          return { status: 400, body: { error: "token must be a non-empty string" } };
        }
        token = payload.token;
        // The credential handoff (design §9): a workspace copy, the inference
        // key, and this token — nothing else ever enters the machine.
        if (typeof payload.env === "object" && payload.env !== null) {
          const next = {};
          for (const [name, value] of Object.entries(payload.env)) {
            if (typeof value === "string") next[name] = value;
          }
          sdkEnv = { ...sdkEnv, ...next };
        }
        return { status: 200, body: { ok: true } };
      }

      // Every other route needs the CURRENT token, always.
      if (token === "" || presented !== token) {
        return { status: 401, body: { error: "bad or missing box token" } };
      }

      if (pathname === "/session/workspace") {
        if (payload?.reset === true) {
          // Empty the root's CONTENTS, never the root itself: the sandbox runs
          // as a non-root user and cannot recreate a directory directly under
          // `/` (measured 2026-08-01 — every materialize answered 500).
          mkdirSync(root, { recursive: true });
          for (const entry of readdirSync(root)) {
            rmSync(path.join(root, entry), { recursive: true, force: true });
          }
        }
        for (const file of Array.isArray(payload?.files) ? payload.files : []) {
          if (typeof file?.path !== "string" || typeof file?.base64 !== "string") continue;
          const target = toDisk(root, file.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(file.base64, "base64"));
          // `/host` mounts read-only (§3.5). Advisory inside the box — the
          // sync-back seam on the host is what actually refuses the write.
          if (file.readOnly === true) chmodSync(target, 0o444);
        }
        return { status: 200, body: { ok: true } };
      }

      if (pathname === "/session/collect") {
        const wanted = Array.isArray(payload?.paths) ? payload.paths : undefined;
        const files = [];
        if (wanted !== undefined) {
          // A wanted entry naming a `*` segment is how a file that did NOT exist
          // when the conversation started reaches the mid-turn sync: the host
          // cannot pre-name `/user/apps/<a brand-new id>/plan.vendo`, so it asks
          // by shape. Filtered HERE, so the wire carries the hot files and not
          // the tree they were found in.
          const patterns = wanted.filter((entry) => typeof entry === "string" && entry.includes("*"));
          const literals = wanted.filter((entry) => typeof entry === "string" && !entry.includes("*"));
          const matched = patterns.length === 0
            ? []
            : walk(root, [])
              .map((diskPath) => toWorkspace(root, diskPath))
              // Same rule as the whole-tree branch below: a route that WALKS
              // answers about the user's own space and nothing else.
              .filter((workspacePath) => workspacePath.startsWith("/user/")
                && patterns.some((pattern) => matchesPattern(pattern, workspacePath)));
          for (const workspacePath of [...new Set([...literals, ...matched])]) {
            try {
              files.push({
                path: workspacePath,
                base64: readFileSync(toDisk(root, workspacePath)).toString("base64"),
              });
            } catch {
              // Not written yet — absent is not a deletion on the hot path.
            }
          }
        } else {
          for (const diskPath of walk(root, [])) {
            const workspacePath = toWorkspace(root, diskPath);
            if (!workspacePath.startsWith("/user/")) continue;
            try {
              if (statSync(diskPath).size > WALK_SKIP_BYTES) continue;
              files.push({ path: workspacePath, base64: readFileSync(diskPath).toString("base64") });
            } catch {
              // A file that vanished mid-walk simply is not in the diff.
            }
          }
        }
        return { status: 200, body: { files } };
      }

      if (pathname === "/session/message") {
        if (current !== undefined) {
          return { status: 409, body: { error: "a message is already running" } };
        }
        if (typeof payload?.prompt !== "string" || payload.prompt.trim() === "") {
          return { status: 400, body: { error: "prompt must be a non-empty string" } };
        }
        return { status: 202, body: { messageId: await startMessage(payload) } };
      }

      const match = /^\/session\/([^/]+)\/(poll|answer|interrupt)$/.exec(pathname);
      if (match === null) return { status: 404, body: { error: `unknown route: ${pathname}` } };
      const state = messages.get(match[1]);
      if (state === undefined) return { status: 404, body: { error: `unknown message: ${match[1]}` } };

      if (match[2] === "poll") {
        const cursor = Number.isInteger(payload?.cursor) ? payload.cursor : 0;
        return { status: 200, body: await poll(state, cursor, payload?.waitMs) };
      }
      if (match[2] === "interrupt") {
        // The user hit stop. The SESSION survives — only this turn is cut short,
        // which is the whole reason a live session interrupts instead of aborting.
        await session?.interrupt().catch(() => undefined);
        return { status: 200, body: { ok: true } };
      }
      const ask = state.asks.get(payload?.id);
      if (ask === undefined) return { status: 404, body: { error: "no such ask" } };
      state.asks.delete(payload.id);
      ask.resolve(guardedResult(payload?.result));
      return { status: 200, body: { ok: true } };
    },

    /** Tests: await one message's completion. */
    messagePromise: (messageId) => messages.get(messageId)?.promise,
  };
};
