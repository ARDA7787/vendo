import {
  canonicalJson,
  sha256Hex,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { ContainedNotice } from "../tree/notice.js";
import { toolPresentation } from "./build-beat.js";
import {
  CardActions,
  CardByline,
  CardFields,
  CardHead,
  CardLine,
  CardShell,
  runsAsYouLine,
  SHIELD_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { fieldRows } from "./field-rows.js";

/** The wire risk slugs, in the user's language (the raw slug stays available
    on the chip's tooltip via the tool name; end users never read jargon). */
const RISK_LABEL: Record<string, string> = {
  read: "Read-only",
  write: "Makes changes",
  destructive: "Irreversible",
};

const VENUE_LABEL: Record<string, string> = {
  chat: "asked here in chat",
  page: "asked on the page",
  slot: "asked in a view",
  voice: "asked by voice",
  mcp: "asked over MCP",
  app: "asked in an app",
  automation: "asked by an automation",
};

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  onDecide(decision: ApprovalDecision): void | PromiseLike<void>;
  /**
   * The in-thread native resume path (`addToolApprovalResponse`) has no
   * channel for `ApprovalDecision.remember`, so thread chrome hides the
   * disclosure rather than dropping the answer silently. Queue surfaces
   * (the real wire decision) keep it. Default true.
   */
  allowRemember?: boolean;
  /**
   * ENG-216 — show the `venue · presence · appId` context byline. Queue
   * surfaces carry a real server `ctx` and keep it (default true); the
   * in-thread card sets this false because the live conversation is already
   * the context and the wire carries no ctx to display honestly.
   */
  showContext?: boolean;
}

function approvalDate(grantedAt: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(grantedAt),
  );
}

/** 01-core §5; 08-ui §4; spec §16 — the one consent surface, on the one card
    shell, always showing the real inputs. */
export function ApprovalCard({ approval, onDecide, allowRemember = true, showContext = true }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "tool">("exact");
  const [duration, setDuration] = useState<"session" | "standing">("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const critical = approval.descriptor.risk === "destructive" || approval.descriptor.critical === true;
  // ENG-216 humanization (host ToolMeta wins, else the prettified id — never
  // the raw slug) layered with the consent presentation: toolkit mark,
  // automation eyebrow, and a plain-language description synthesized from the
  // REAL inputs when the host supplies none.
  const meta = useVendoTools()[approval.descriptor.name];
  const presentation = toolPresentation(
    approval.descriptor.name,
    approval.call.args,
    meta,
    approval.descriptor.title,
  );
  const title = presentation.title;
  const description = (presentation.description ?? approval.descriptor.description).trim();
  const rows = fieldRows(approval.call.args, approval.descriptor.inputSchema, meta);
  // Lane pick 1-A — consequence-first: when the presentation can truthfully
  // say what approving does in one sentence, that sentence leads and the raw
  // fields fold behind a "Details" disclosure (still the same real inputs,
  // one tap away). Critical/destructive asks are exempt: maximum scrutiny
  // keeps every input in plain sight.
  const consequence = !critical ? presentation.consequence : undefined;

  const decide = async (approve: boolean) => {
    const decision: ApprovalDecision = { approve };
    if (approve && allowRemember && remember) {
      decision.remember = {
        scope: scope === "tool"
          ? { kind: "tool" }
          : {
              kind: "exact",
              inputHash: `sha256:${sha256Hex(canonicalJson(approval.call.args))}`,
              inputPreview: approval.inputPreview,
            },
        duration,
      };
    }
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(decision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const inputs = <CardFields rows={rows} />;
  return (
    // No automatic policy notice: that banner is written for the host
    // DEVELOPER, and a consent card is the most end-user surface there is
    // (spec §16.3, the consumer-voice guarantee).
    <ChromeRoot automaticPolicyNotice={false}>
      <CardShell label={`Approval for ${title}`} className="fl-approval fl-item-in" ceremony={critical}>
        <CardHead
          icon={<ToolkitLogo {...(presentation.logoUrl === undefined ? {} : { src: presentation.logoUrl })} fallback={SHIELD_GLYPH} />}
          eyebrow={presentation.eyebrow}
          title={title}
          aside={
            <span
              className="fl-chip"
              data-risk={approval.descriptor.risk}
              title={approval.descriptor.name}
              style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
            >
              {RISK_LABEL[approval.descriptor.risk] ?? approval.descriptor.risk}
            </span>
          }
        />
        {/* Law 3 — the card always says what approving DOES: the synthesized
            consequence, else the described one, else the one thing that is
            true of every call. */}
        {consequence ? (
          <CardLine className="fl-approval-consequence-line">
            {consequence.pre}
            {consequence.artifact !== undefined ? <strong>{consequence.artifact}</strong> : null}
            {consequence.mid}
            {consequence.target !== undefined ? <strong>{consequence.target}</strong> : null}
            {consequence.post}
          </CardLine>
        ) : (
          <CardLine>{description.length > 0 && description !== title ? description : runsAsYouLine(title)}</CardLine>
        )}
        {/* The consequence sentence carries the meaning; the mechanical rows
            fold but never leave the DOM (the a11y contract keeps its name). */}
        {consequence ? (
          <details className="fl-approval-details">
            <summary>Details — real inputs</summary>
            {inputs}
          </details>
        ) : inputs}
        {showContext ? (
          <CardByline>
            Runs as you · {VENUE_LABEL[approval.ctx.venue] ?? approval.ctx.venue}
            {approval.ctx.appId ? ` · ${approval.ctx.appId}` : ""}
          </CardByline>
        ) : null}
        {allowRemember ? (
          <details className="fl-auto-details">
            <summary>Remember this decision</summary>
            <div className="fl-approval-batch-list">
              <div className="fl-approval-batch-row">
                <label>
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={event => setRemember(event.currentTarget.checked)}
                  />
                  Create a reusable grant when approved
                </label>
              </div>
              <fieldset disabled={!remember} style={{ margin: 0, padding: 0, border: 0 }}>
                <legend className="fl-approval-more">Scope</legend>
                <div className="fl-approval-batch-row">
                  <label><input type="radio" name={`scope-${approval.id}`} checked={scope === "exact"} onChange={() => setScope("exact")} style={{ accentColor: "var(--vendo-accent)" }} />This exact input</label>
                </div>
                <div className="fl-approval-batch-row">
                  <label><input type="radio" name={`scope-${approval.id}`} checked={scope === "tool"} onChange={() => setScope("tool")} style={{ accentColor: "var(--vendo-accent)" }} />The whole tool</label>
                </div>
              </fieldset>
              <fieldset disabled={!remember} style={{ margin: 0, padding: 0, border: 0 }}>
                <legend className="fl-approval-more">Duration</legend>
                <div className="fl-approval-batch-row">
                  <label><input type="radio" name={`duration-${approval.id}`} checked={duration === "session"} onChange={() => setDuration("session")} style={{ accentColor: "var(--vendo-accent)" }} />This session</label>
                </div>
                <div className="fl-approval-batch-row">
                  <label><input type="radio" name={`duration-${approval.id}`} checked={duration === "standing"} onChange={() => setDuration("standing")} style={{ accentColor: "var(--vendo-accent)" }} />Standing</label>
                </div>
              </fieldset>
            </div>
          </details>
        ) : null}
        {approval.invalidatedGrant ? (
          <div style={{ marginTop: "12px" }}>
            <ContainedNotice label="Previous permission invalidated">
              {`This tool changed since you approved it on ${approvalDate(approval.invalidatedGrant.grantedAt)} — your previous permission no longer applies.`}
            </ContainedNotice>
          </div>
        ) : null}
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        <CardActions>
          <button className={`fl-btn ${critical ? "fl-btn-ceremony" : "fl-btn-primary"}`} type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
          <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
        </CardActions>
      </CardShell>
    </ChromeRoot>
  );
}
