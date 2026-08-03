/** spec §16 law 2 — the descriptor travels with the approval.
 *
 *  THE BUG this file exists for: the in-thread approval built its own
 *  descriptor with `inputSchema: {}` (parts.tsx:506-525), so `declaredMoneyUnit`
 *  had nothing to read and a $47.50 transfer rendered as
 *  "4750 (unit not specified)" IN THE THREAD while the same ask formatted
 *  correctly in the queue. The description fell to `""` for the same reason, so
 *  the card's plain-words line disappeared. Anything the wire part carries —
 *  schema, authored title, description — now rides through to the card.
 *
 *  Drop-in for the synthesis at `parts.tsx:506-525` (Lane C owns that file; the
 *  conductor wires this in at integration):
 *
 *      const approval = buildApprovalRequest({
 *        approvalId: part.approval.id,
 *        toolCallId: part.toolCallId,
 *        tool: name,
 *        args: input,
 *        risk,
 *        ...(guardApproval?.invalidatedGrant === undefined
 *          ? {} : { invalidatedGrant: guardApproval.invalidatedGrant }),
 *        ...(guardApproval?.descriptor === undefined
 *          ? {} : { descriptor: guardApproval.descriptor }),
 *      }, tools);
 *
 *  `descriptor` is the `data-vendo-approval` part's passthrough descriptor
 *  (01-core §16 parts are `.passthrough()`, so a server that has the descriptor
 *  can ride it without a contract change and an older server simply omits it).
 */
import type { ApprovalRequest, Json, JsonSchema, RiskLabel } from "@vendoai/core";
import { preview, SYNTHESIZED_CREATED_AT } from "./message-data.js";

/** Only the field this builder reads off the host's `tools` map (a `ToolMetaMap`
    at every call site). Structural, because the thread directory ships as an
    eject template and may only import the PUBLIC package surface. */
type ToolDescriptions = Record<string, { description?: string } | undefined>;

export interface ApprovalWirePart {
  /** `part.approval.id` — the guard record this card decides. */
  approvalId: string;
  /** `part.toolCallId`. */
  toolCallId: string;
  /** The raw wire tool id (the card humanizes it). */
  tool: string;
  /** The REAL inputs the model passed. */
  args?: unknown;
  /**
   * From the `data-vendo-approval` part. ABSENT means ungraded — never
   * read-only (ruling 15): see the default in the builder below.
   */
  risk?: RiskLabel;
  invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
  /** Descriptor fields the wire part carries when the server has them. */
  descriptor?: {
    title?: string;
    description?: string;
    inputSchema?: JsonSchema;
  };
}

/** The in-thread ApprovalRequest — real descriptor first, host metadata second,
 *  never a fabricated sentence. */
export function buildApprovalRequest(part: ApprovalWirePart, tools: ToolDescriptions): ApprovalRequest {
  const authored = part.descriptor;
  const title = authored?.title?.trim();
  return {
    id: part.approvalId,
    call: { id: part.toolCallId, tool: part.tool, args: part.args as Json },
    descriptor: {
      name: part.tool,
      description: authored?.description ?? tools[part.tool]?.description ?? "",
      // The whole point: the declared schema when the wire has one, so money
      // formats as money on every surface — `{}` only when there is none.
      inputSchema: authored?.inputSchema ?? {},
      // RULING 15 — an absent risk is UNGRADED, and defaulting it to "read" made
      // every ungraded ask claim "Read-only" on its chip and "This reads your
      // data, as you." as its plain-words line: the safest-sounding thing we
      // could have said about a call we know nothing about. The cautious display
      // grade is a write — it never understates, and it does not invent the
      // irreversibility that `destructive` would claim (with its ceremony edge)
      // on an ask that may well be harmless.
      risk: part.risk ?? "write",
      // …and UNGRADED is carried, not just approximated. Defaulting the display
      // grade to `write` still let the card treat the ask as ordinary: `critical`
      // was false, so the consequence sentence FOLDED the real inputs behind
      // Details and the ceremony edge was dropped — scrutiny reduced on the
      // strength of a grade nobody supplied. `critical` is the existing
      // maximum-scrutiny flag (never fold, keep the ceremony), and unlike
      // `risk: "destructive"` it claims no irreversibility on the chip.
      ...(part.risk === undefined ? { critical: true } : {}),
      ...(title === undefined || title.length === 0 ? {} : { title }),
    },
    // Client-side humanized, never the server's `tool slug + canonical JSON`.
    inputPreview: preview(part.args),
    ...(part.invalidatedGrant === undefined ? {} : { invalidatedGrant: part.invalidatedGrant }),
    // ENG-216 — the live conversation IS the context, and the wire carries no
    // ctx: only structurally-true, stable values ride here (never shown, the
    // card sets showContext={false} in-thread).
    ctx: { principal: { kind: "user", subject: "" }, venue: "chat", presence: "present" },
    createdAt: SYNTHESIZED_CREATED_AT,
  };
}
