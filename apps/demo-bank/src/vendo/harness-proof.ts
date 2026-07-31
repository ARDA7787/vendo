/**
 * Wave-1 live-proof seam (docs/verification/wave1-live/).
 *
 * `POST /threads` is on the LEGACY `createAgent` path unless a host opts in
 * (wire/threads.ts: `deps.harness ?? deps.agent`), so a proof run against the
 * demo as-shipped would measure the old code. Two opt-ins exist and they are not
 * the same thing:
 *
 * - `MAPLE_HARNESS=named` puts `harness: vendo()` in `createVendo` (server.ts).
 *   That is the literal contract opt-in — and `resolveHarness` in
 *   harness-turn.ts only composes the assembled system prompt when
 *   `config.harness` is UNSET, so a host-named `vendo()` thinks with
 *   `system: ""`. Kept as a probe target, not as the evidence path.
 * - `MAPLE_HARNESS=1` leaves the slot unset (so composition builds `vendo()`
 *   WITH its ctx-shaped system prompt) and routes the wire's chat turn to the
 *   composed `vendo.harness` door here — the door harness-wire.test.ts calls the
 *   one "the host (and the live proofs) can drive a harness turn" through.
 *
 * Off by default: unset `MAPLE_HARNESS` and this file returns null on every
 * request, so the shipped demo is untouched.
 */
import type { Principal, RunContext } from "@vendoai/core";
import type { UIMessage } from "ai";
import { resolveMapleSession } from "@/vendo/auth";
import { vendo } from "@/vendo/server";

/** True when the wire's chat turn should be served by the composed harness. */
export function harnessProofEnabled(): boolean {
  return process.env.MAPLE_HARNESS === "1";
}

export async function harnessThreadsResponse(request: Request): Promise<Response | null> {
  if (!harnessProofEnabled()) return null;
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.endsWith("/api/vendo/threads")) return null;

  let body: { threadId?: string; message?: UIMessage };
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return null;
  }
  const message = body?.message;
  if (!message || message.role !== "user" || !Array.isArray(message.parts)) return null;

  const user = await resolveMapleSession(request);
  if (user === null) return null;

  const principal: Principal = { kind: "user", subject: user.subject };
  const ctx: RunContext = {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: request.headers.get("x-vendo-session-id") ?? "harness-proof",
    requestHeaders: Object.fromEntries(request.headers.entries()),
  };

  return vendo.harness.stream({
    ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
    message,
    ctx,
    signal: request.signal,
  });
}
