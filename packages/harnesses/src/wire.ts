/**
 * The wire half of the runtime — build contract §1.6: "converts HarnessEvents
 * plus mirrored tool calls into the existing ai-SDK UIMessage stream with today's
 * `data-vendo-*` parts (packages/core/src/stream-parts.ts — UNCHANGED; no new
 * wire format)". Harness adapters contain no wire code; this is the only file
 * that knows what a chunk looks like.
 *
 * ONE addition, and it is deliberately NOT in core's stream-parts.ts: `status`
 * (§1.5) has no existing part, and it must be screen-only. The ai-SDK's own
 * `transient: true` data chunk is exactly "delivered to the client, never added
 * to message history", so a transient `data-vendo-status` is the native
 * mechanism rather than a persisted format. See VENDO_STATUS_PART.
 */
import {
  toVendoWirePart,
  vendoViewStreamId,
  type ApprovalId,
  type ConnectRequired,
  type Json,
  type RiskLabel,
  type ToolResult,
  type VendoViewPart,
} from "@vendoai/core";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import type { MirrorEvent } from "./turn-tools.js";

/**
 * The one wire name this lane adds. Transient, so it is screen-only by the
 * SDK's own rule and never lands in a persisted UIMessage — which is what §1.5
 * asks for. It lives here rather than in core because §1.6 freezes
 * stream-parts.ts as unchanged.
 */
export const VENDO_STATUS_PART = "data-vendo-status" as const;

type Writer = UIMessageStreamWriter<UIMessage>;

/** Accumulates one assistant text part per turn: many deltas, one row. */
export class TextChannel {
  private started = false;
  private readonly id = `txt_${globalThis.crypto.randomUUID()}`;

  constructor(private readonly writer: Writer) {}

  delta(delta: string): void {
    if (!this.started) {
      this.started = true;
      this.writer.write({ type: "text-start", id: this.id });
    }
    this.writer.write({ type: "text-delta", id: this.id, delta });
  }

  end(): void {
    if (!this.started) return;
    this.started = false;
    this.writer.write({ type: "text-end", id: this.id });
  }
}

/** §1.5 `status` → screen only. */
export function writeStatus(writer: Writer, label: string): void {
  writer.write({ type: VENDO_STATUS_PART, data: { label }, transient: true } as never);
}

/** §1.6 hot-path render seam — today's part, today's stable per-app stream id. */
export function writeView(writer: Writer, part: VendoViewPart): void {
  writer.write(toVendoWirePart(part, vendoViewStreamId(part.appId)) as never);
}

/**
 * Mirror one tool call onto the wire. Dynamic tools are the right shape: a
 * harness's tool set is resolved at runtime from the registry, exactly like the
 * agent bridge's `dynamicTool` calls today, so hosts render these with the
 * component they already have.
 */
export function writeMirror(writer: Writer, event: MirrorEvent): void {
  switch (event.kind) {
    case "call":
      writer.write({
        type: "tool-input-start",
        toolCallId: event.toolCallId,
        toolName: event.name,
        dynamic: true,
      });
      writer.write({
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.name,
        input: event.args as unknown,
        dynamic: true,
      });
      return;
    case "result":
      writeToolResult(writer, event.toolCallId, event.result);
      return;
    case "approval":
      // Today's flat §16 approval part, beside the tool part, keyed by toolCallId
      // — the same channel every consent surface already renders.
      writer.write(
        toVendoWirePart({
          type: "data-vendo-approval",
          toolCallId: event.toolCallId,
          risk: event.risk,
          approvalId: event.approvalId,
        }) as never,
      );
      return;
    case "connect":
      writer.write(
        toVendoWirePart({
          type: "data-vendo-connect",
          toolCallId: event.toolCallId,
          connector: event.connect.connector,
          toolkit: event.connect.toolkit,
          message: event.connect.message,
        }) as never,
      );
      return;
  }
}

function writeToolResult(writer: Writer, toolCallId: string, result: ToolResult): void {
  if (result.status === "ok") {
    writer.write({ type: "tool-output-available", toolCallId, output: result.output as unknown, dynamic: true });
    return;
  }
  if (result.status === "denied") {
    // `denied` is its own affordance on the wire: a refusal is not a failure, and
    // rendering it as one would tell the user something went wrong when nothing did.
    writer.write({ type: "tool-output-denied", toolCallId });
    return;
  }
  writer.write({ type: "tool-output-error", toolCallId, errorText: result.error.message, dynamic: true });
}

/** Re-exported for the runtime's convenience so it never imports `ai` itself. */
export type { ApprovalId, ConnectRequired, Json, RiskLabel, Writer };
