import { isPlainObject as isRecord, type ApprovalRequest } from "@vendoai/core";
import {
  CardActions,
  CardFields,
  CardHead,
  CardLine,
  CardShell,
  CARD_EYEBROWS,
  SHIELD_GLYPH,
  ToolkitLogo,
} from "../chrome/card-shell.js";
import { fieldRows } from "../chrome/field-rows.js";
import { argProperties, argValue, humanizeToolName } from "../chrome/humanize.js";
import { approvalTitle, type VoiceApprovalReceipt } from "./use-voice-approvals.js";

/** spec §16 — the voice consent used to be a hand-rolled strip PLUS a
    hand-rolled article for automation asks: two more re-implementations of "the
    approval". Both are the one card shell now; `.fl-voice-consent` rides on the
    shell itself so the stage's listening/critical/automation registers (and the
    CSS that animates them) keep working while the geometry comes from the shell. */
export interface VoiceConsentProps {
  request?: ApprovalRequest;
  receipt?: VoiceApprovalReceipt;
  listening: boolean;
  busy: boolean;
  error?: string;
  /** C-A spoken-yes — a recognized spoken decision; flips the hint to "heard". */
  intent?: "approve" | "decline" | null;
  onDecide(request: ApprovalRequest, approve: boolean): void;
}

export function VoiceConsent({ request, receipt, listening, busy, error, intent, onDecide }: VoiceConsentProps) {
  if (!request && receipt) {
    return (
      <div
        className={`fl-voice-consent is-receipt${receipt.approved ? "" : " is-declined"}`}
        role="status"
        aria-live="polite"
      >
        {receipt.approved ? "Approved" : "Declined"}: {receipt.title}
      </div>
    );
  }
  if (!request) return null;

  const critical = request.descriptor.risk === "destructive" || request.descriptor.critical === true;
  const automation = isAutomation(request);
  const title = approvalTitle(request);
  const fact = approvalFact(request);
  const register = automation ? " is-automation" : critical ? " is-critical" : listening ? " is-listening" : "";

  return (
    <CardShell
      label={`Approval for ${title}`}
      className={`fl-approval fl-voice-consent${register}`}
      ceremony={critical}
      role="status"
      aria-live="polite"
    >
      <CardHead
        icon={<ToolkitLogo fallback={SHIELD_GLYPH} />}
        eyebrow={automation ? CARD_EYEBROWS.automationApproval : CARD_EYEBROWS.approval}
        title={title}
      />
      {automation ? (
        <CardLine>This can run on its own after you approve it.</CardLine>
      ) : (
        // The spoken register keeps ONE fact in the line (a voice user is
        // listening, not reading a table) — the same money-safe value rule.
        <CardLine className="fl-voice-consent-fact">{fact ?? "Approving runs it as you."}</CardLine>
      )}
      {automation ? (
        <CardFields rows={fieldRows(request.call.args, request.descriptor.inputSchema)} />
      ) : null}
      {critical ? <div className="fl-voice-consent-warn">Confirm this action by hand</div> : null}
      {!critical && !automation && listening ? (
        intent === "approve" ? (
          <div className="fl-voice-consent-hint is-heard" role="status">&ldquo;Approve&rdquo; heard ✓</div>
        ) : intent === "decline" ? (
          <div className="fl-voice-consent-hint is-heard" role="status">&ldquo;Decline&rdquo; heard ✓</div>
        ) : (
          <div className="fl-voice-consent-hint">
            Say &ldquo;approve&rdquo; — or tap
            <span className="fl-voice-eq" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )
      ) : null}
      {error ? <div className="fl-tool-err" role="alert">{error}</div> : null}
      <CardActions>
        <button type="button" className="fl-btn" disabled={busy} onClick={() => onDecide(request, false)}>Decline</button>
        <button
          type="button"
          className={`fl-btn ${critical ? "fl-btn-ceremony" : "fl-btn-primary"}`}
          disabled={busy}
          onClick={() => onDecide(request, true)}
        >
          {critical ? `Confirm — ${title}` : "Approve"}
        </button>
      </CardActions>
    </CardShell>
  );
}

function approvalFact(request: ApprovalRequest): string | undefined {
  const args = request.call.args;
  if (isRecord(args)) {
    const keys = ["amount", "recipient", "recipient_email", "to", "payee", "channel", "invoiceId"];
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        // `amount` is tried FIRST, so this ONE fact is usually the money itself —
        // it goes through the consent surfaces' shared value rule, never `String`.
        return `${humanizeToolName(key)}: ${argValue(key, value, argProperties(request.descriptor.inputSchema))}`;
      }
    }
  }
  // No named fact: the args' own first row rather than the server's preview
  // string (which is the guard's `tool slug + canonical JSON`).
  return fieldRows(args, request.descriptor.inputSchema)[0]?.value;
}

/** Exported for the stage's spoken-yes guard: automation requests use the rich
    card register with NO spoken affordance, so an intent must never decide one. */
export function isAutomation(request: ApprovalRequest): boolean {
  return request.ctx.venue === "automation" || [request.descriptor.name, request.descriptor.description, request.call.tool]
    .some((value) => /automation|schedule|recurring/i.test(value));
}
