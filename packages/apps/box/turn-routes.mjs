/**
 * Wave 2 lane E — the box's `claudeCode()` turn door.
 *
 * The existing control port serves the layer-3 app builder (`/agent/*`). This
 * module adds the CONVERSATIONAL door beside it: materialize a workspace copy,
 * run one Claude Agent SDK turn over it, stream events out, and hand every
 * projected tool call back to the HOST — which is the only place a tool ever
 * executes.
 *
 * **The bridge is inverted.** `SandboxMachine.request()` is the only data path
 * into a box, so the host drives: it polls, the box parks an ask and hands it out
 * on the next poll, the host answers. The box therefore holds no outbound
 * credential at all — a workspace copy, the inference key (the recorded v0
 * exception), and the machine token the host asserts on every call. Nothing else.
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
/** Finished turns stay pollable for a little while (a host retrying its last
 *  poll), then go. A session machine lives for many turns, and every turn's
 *  event buffer kept forever is a slow leak in a long-lived box. */
const TURNS_RETAINED = 4;

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
 * @param {object} options
 * @param {string} [options.root]     workspace root (default /workspace)
 * @param {string} [options.token]    the machine token the host must present
 * @param {Function} [options.runTurn] injectable SDK loop (tests)
 * @param {NodeJS.ProcessEnv} [options.env] env handed to the SDK
 */
export const createTurnRoutes = (options = {}) => {
  const root = options.root ?? process.env.VENDO_WORKSPACE_ROOT ?? "/workspace";
  let token = options.token ?? process.env.VENDO_BOX_TOKEN ?? "";
  // What the SDK subprocess gets. Seeded from the machine's own env and
  // REPLACED by every /turn/hello: the provider does not hand create-time envs
  // to the template's start command (measured 2026-08-01 — the in-box SDK
  // answered "Not logged in"), and a turn-scoped handoff is the better shape
  // anyway: the credential arrives with the turn that needs it.
  let sdkEnv = { ...(options.env ?? process.env) };
  const turns = new Map();
  let active;

  const loadRunner = async () => options.runTurn ?? (await import(RUNNER)).runClaudeTurn;

  const startTurn = async (payload) => {
    const turnId = `turn_${randomUUID()}`;
    const state = {
      events: [],
      /**
       * Every projected call waiting on the host, by id — a QUEUE, not a slot.
       * The model emits parallel tool_use blocks (and a Task subagent's calls
       * land concurrently too), so a single slot starved the second call until
       * the turn budget expired. Each entry is handed out exactly ONCE, so the
       * host can never execute one intent twice.
       */
      asks: new Map(),
      waiters: [],
      done: false,
      abort: new AbortController(),
    };
    turns.set(turnId, state);
    for (const stale of [...turns.keys()].slice(0, -TURNS_RETAINED)) turns.delete(stale);
    active = turnId;

    const wake = () => {
      for (const resolve of state.waiters.splice(0)) resolve();
    };
    const emit = (event) => {
      state.events.push(event);
      wake();
    };
    /** Park the call for the host and wait for its answer. */
    const callTool = (name, args) => new Promise((resolve) => {
      const id = `ask_${randomUUID()}`;
      state.asks.set(id, { id, name, args, resolve, handedOut: false });
      wake();
    });

    const runClaudeTurn = await loadRunner();
    state.promise = (async () => {
      try {
        await runClaudeTurn({
          prompt: payload.prompt,
          systemPrompt: payload.systemPrompt,
          tools: Array.isArray(payload.tools) ? payload.tools : [],
          model: payload.model,
          effort: payload.effort,
          maxTurns: payload.maxTurns,
          resume: payload.resume,
          resumeAt: payload.resumeAt,
          cwd: root,
          env: { ...sdkEnv },
          callTool,
          emit,
          signal: state.abort.signal,
        });
      } catch (error) {
        // The host renders one plain sentence; the detail stays in the box's log.
        console.error("[vendo-box] turn failed", error);
        emit({ type: "error", message: "Something went wrong while I was working on that." });
      } finally {
        state.done = true;
        // A turn that ended with asks outstanding would hang the host's poll.
        for (const ask of state.asks.values()) {
          ask.resolve({ status: "error", message: "the turn ended" });
        }
        state.asks.clear();
        if (active === turnId) active = undefined;
        wake();
      }
    })();
    return turnId;
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
    owns: (pathname) => pathname.startsWith("/turn"),

    /**
     * @returns {Promise<{status:number, body:object}>}
     */
    async handle(method, pathname, headers, payload) {
      if (method !== "POST") return { status: 405, body: { error: "POST only" } };
      const presented = headers["x-vendo-box-token"];
      if (pathname === "/turn/hello") {
        // Trust on FIRST use while the box is unclaimed; after that ONLY the
        // holder of the current token may ROTATE it. Rotation is what makes a
        // woken machine usable: a snapshot restores this module's memory, so the
        // box comes back still demanding the token it slept with, while the host
        // mints a fresh one per acquire. An attacker can still never claim a box
        // that is in use — they hold neither token.
        if (token !== "" && presented !== token) {
          return { status: 401, body: { error: "bad or missing box token" } };
        }
        if (typeof payload?.token !== "string" || payload.token === "") {
          return { status: 400, body: { error: "token must be a non-empty string" } };
        }
        token = payload.token;
        // The turn-scoped credential handoff (design §9): a workspace copy, the
        // inference key, and this token — nothing else ever enters the machine.
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

      if (pathname === "/turn/workspace") {
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

      if (pathname === "/turn/collect") {
        const wanted = Array.isArray(payload?.paths) ? payload.paths : undefined;
        const files = [];
        if (wanted !== undefined) {
          // A wanted entry naming a `*` segment is how a file that did NOT exist
          // when the turn started reaches the mid-turn sync: the host cannot
          // pre-name `/user/apps/<a brand-new id>/plan.vendo`, so it asks by
          // shape. Filtered HERE, so the wire carries the hot files and not the
          // tree they were found in.
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
              // Above any file the workspace itself can hold (FILES_STORE_MAX_BYTES
              // is 5 MiB), so a CHECKED-OUT file can never be skipped here — which
              // matters because an absent path reads as a deletion at turn end.
              // Only something the box invented can be this big, and that is not a
              // document the store was ever asked to keep.
              if (statSync(diskPath).size > 8 * 1024 * 1024) continue;
              files.push({ path: workspacePath, base64: readFileSync(diskPath).toString("base64") });
            } catch {
              // A file that vanished mid-walk simply is not in the diff.
            }
          }
        }
        return { status: 200, body: { files } };
      }

      if (pathname === "/turn/start") {
        if (active !== undefined) {
          return { status: 409, body: { error: "a turn is already running", turnId: active } };
        }
        if (typeof payload?.prompt !== "string" || payload.prompt.trim() === "") {
          return { status: 400, body: { error: "prompt must be a non-empty string" } };
        }
        return { status: 202, body: { turnId: await startTurn(payload) } };
      }

      const match = /^\/turn\/([^/]+)\/(poll|answer|abort)$/.exec(pathname);
      if (match === null) return { status: 404, body: { error: `unknown route: ${pathname}` } };
      const state = turns.get(match[1]);
      if (state === undefined) return { status: 404, body: { error: `unknown turn: ${match[1]}` } };

      if (match[2] === "poll") {
        const cursor = Number.isInteger(payload?.cursor) ? payload.cursor : 0;
        return { status: 200, body: await poll(state, cursor, payload?.waitMs) };
      }
      if (match[2] === "answer") {
        const ask = state.asks.get(payload?.id);
        if (ask === undefined) return { status: 404, body: { error: "no such ask" } };
        state.asks.delete(payload.id);
        // Everything the host sends is DATA: only the declared shape passes, and
        // an unrecognised status reads as an error the model narrates.
        const raw = payload?.result ?? {};
        const result = raw.status === "ok"
          ? { status: "ok", output: raw.output }
          : raw.status === "denied"
            ? { status: "denied", reason: String(raw.reason ?? "That isn't something I can do right now.") }
            : { status: "error", message: String(raw.message ?? "That didn't work.") };
        ask.resolve(result);
        return { status: 200, body: { ok: true } };
      }
      state.abort.abort();
      return { status: 200, body: { ok: true } };
    },

    /** Tests: await the turn's completion. */
    turnPromise: (turnId) => turns.get(turnId)?.promise,
  };
};
