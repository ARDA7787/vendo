import type { RiskLabel } from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { toolPresentation } from "./build-beat.js";
import {
  CardActions,
  CardHead,
  CardLine,
  CardList,
  CardShell,
  CARD_EYEBROWS,
  SHIELD_GLYPH,
  TICK_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";

/** demo-live-readiness 2026-07 — the grant-SET consent card (approved mockup,
 * section 2): an automation that needs several standing grants asks for ALL of
 * them in one card — every permission enumerated, ONE Approve that grants the
 * whole set, one Deny that declines it. The decided card stays in the
 * transcript as the settled record ("Enabled · N permissions granted" /
 * "Denied — the automation stays paused."). Presentational: the caller owns
 * deciding the guard approvals and resuming the parked turn.
 *
 * spec §16 — contents only: the geometry is the one card shell.
 */

export interface GrantSetPermission {
  /** The pending guard approval this row settles. */
  approvalId: string;
  tool: string;
  /** The tool descriptor's one-line description. */
  description?: string;
  risk: RiskLabel;
}

export interface GrantSetCardProps {
  /** The automation's display name. */
  name: string;
  permissions: GrantSetPermission[];
  /** parked → actionable; approved/denied → the settled record. */
  state: "parked" | "approved" | "denied";
  onDecide?(approve: boolean): void | PromiseLike<void>;
}

const permissionCount = (count: number): string => count === 1 ? "1 permission" : `${count} permissions`;

/** Mockup copy: "Allow both & enable" for the pair; sensible words either side. */
export function allowLabel(count: number): string {
  if (count === 1) return "Allow & enable";
  if (count === 2) return "Allow both & enable";
  return `Allow all ${count} & enable`;
}

const revokePronoun = (count: number): string =>
  count === 1 ? "it" : count === 2 ? "either" : "any of them";

export function GrantSetCard({ name, permissions, state, onDecide }: GrantSetCardProps) {
  const tools = useVendoTools();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const decide = async (approve: boolean) => {
    if (onDecide === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(approve);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot automaticPolicyNotice={false}>
      <CardShell
        label={`Standing access — ${name}`}
        className="fl-approval fl-grantset fl-item-in"
        data-vendo-grant-set-card=""
        data-state={state}
      >
        <CardHead
          icon={<ToolkitLogo fallback={SHIELD_GLYPH} />}
          eyebrow={CARD_EYEBROWS.standingAccess}
          title={`${name} needs ${permissionCount(permissions.length)}`}
        />
        <CardLine>
          Granted once, used every run. You can revoke {revokePronoun(permissions.length)} any time in Settings.
        </CardLine>
        <CardList className="fl-grants">
          {permissions.map(permission => {
            const presentation = toolPresentation(permission.tool, undefined, tools[permission.tool]);
            const description = (presentation.description ?? permission.description ?? "").trim();
            return (
              <li className="fl-grant" key={permission.approvalId}>
                <ToolkitLogo {...(presentation.logoUrl === undefined ? {} : { src: presentation.logoUrl })} />
                <span className="fl-grant-copy">
                  <b>{presentation.title}</b>
                  {description.length > 0 ? <span>{description}</span> : null}
                </span>
                {state === "approved" ? (
                  <span className="fl-grant-check" aria-hidden="true">{TICK_GLYPH}</span>
                ) : null}
              </li>
            );
          })}
        </CardList>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {state === "parked" ? (
          <CardActions>
            <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void decide(true)}>
              {allowLabel(permissions.length)}
            </button>
            <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          </CardActions>
        ) : (
          <div className="fl-grantset-outcome" role="status">
            {state === "approved" ? (
              <>
                <span className="fl-connect-done-ic" aria-hidden="true">{TICK_GLYPH}</span>
                Enabled · {permissionCount(permissions.length)} granted
              </>
            ) : (
              <>Denied — the automation stays paused.</>
            )}
          </div>
        )}
      </CardShell>
    </ChromeRoot>
  );
}
