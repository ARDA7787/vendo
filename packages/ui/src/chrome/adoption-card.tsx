import type { ApprovalRequest } from "@vendoai/core";
import { useState } from "react";
import { useVendoContext, useVendoTools } from "../context.js";
import type { AdoptionVenue } from "../wire-types.js";
import { toolPresentation } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";
import { ConsentShieldIcon, GrantRowIcon, GrantSetCard } from "./grant-set-card.js";

/** Build contract §9.9 / design §13 — the adoption card.
 *
 * An automation always runs as a named person. When that sponsorship lapses —
 * they left, their permissions went, or somebody else edited the app — the
 * automation STOPS and this card waits IN the app for whoever can edit it. It
 * is not an approval addressed to a set of people (approvals stay strictly
 * self-subject): the first editor to open the app and take it on approves the
 * automation's reads and writes AS THEMSELVES.
 *
 * Presentational, like {@link GrantSetCard}: the caller owns the adopt call and
 * the approvals that follow it.
 */

export interface AdoptionCardProps {
  card: AdoptionVenue;
  /** waiting → actionable; adopted → the settled record. */
  state?: "waiting" | "adopted";
  onAdopt?(): void | PromiseLike<void>;
}

/** `sponsor` is absent once that person's data is erased, and then the card stays
 *  anonymous instead of naming somebody it no longer knows. */
const STOPPED_BECAUSE: Record<AdoptionVenue["reason"], (sponsor: string | undefined) => string> = {
  edit: (sponsor) => `It changed after ${sponsor ?? "the person who set it up"} allowed it, so it is paused.`,
  departure: (sponsor) => sponsor === undefined
    ? "The person it ran as no longer has access to this app, so it is paused."
    : `${sponsor} no longer has access to this app, so it is paused.`,
  grants: (sponsor) =>
    `${sponsor ?? "The person who set it up"}'s permissions for this app were removed, so it is paused.`,
};

const RISK_WORD = { read: "Reads", write: "Changes", destructive: "Changes" } as const;

/** The declared arguments, as the automation will actually send them: "invoice
 *  inv_42". §12 wants the material arguments on the card, not a promise that
 *  they exist somewhere. */
function argsLine(args: Record<string, string> | undefined): string | undefined {
  if (args === undefined) return undefined;
  const parts = Object.entries(args).map(([key, value]) => `${key} ${value}`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

export function AdoptionCard({ card, state = "waiting", onAdopt }: AdoptionCardProps) {
  const tools = useVendoTools();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const adopt = async () => {
    if (onAdopt === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdopt();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      <article
        className="fl-approval fl-grantset fl-item-in"
        data-vendo-adoption-card=""
        data-state={state}
        aria-label={`Take on — ${card.automation}`}
      >
        <div className="fl-approval-head">
          <ConsentShieldIcon />
          <div className="fl-approval-heading">
            <div className="fl-approval-eyebrow">Paused automation</div>
            <div className="fl-approval-title">
              {card.sponsor === undefined
                ? `${card.automation} is paused`
                : `${card.automation} ran with ${card.sponsor}'s access`}
            </div>
            <div className="fl-approval-desc" style={{ marginTop: 3 }}>
              {STOPPED_BECAUSE[card.reason](card.sponsor)} Take it on and it runs with yours instead.
            </div>
          </div>
        </div>
        <ul className="fl-grants">
          {card.needs.map((need, index) => {
            const presentation = toolPresentation(need.tool, undefined, tools[need.tool]);
            const description = (presentation.description ?? need.description ?? "").trim();
            const args = argsLine(need.args);
            return (
              // One line per read and write, in the order they happen: two calls
              // to the same tool are two lines, so the key is positional.
              <li className="fl-grant" key={`${need.tool}-${index}`}>
                <GrantRowIcon {...(presentation.logoUrl === undefined ? {} : { logoUrl: presentation.logoUrl })} />
                <span className="fl-grant-copy">
                  <b>{RISK_WORD[need.risk]}: {presentation.title || need.title}</b>
                  {description.length > 0 ? <span>{description}</span> : null}
                  {args === undefined ? null : <span>{args}</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {state === "waiting" ? (
          <div className="fl-approval-actions">
            <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void adopt()}>
              Take it on
            </button>
          </div>
        ) : (
          <div className="fl-grantset-outcome" role="status">
            <span className="fl-connect-done-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            Running again with your access
          </div>
        )}
      </article>
    </ChromeRoot>
  );
}

/** The payload key the adoption ask rides on the app's open surface
 *  (`payload.adoption`). Re-exported from core (integration, 2026-08-01) so
 *  the renderer, the composition seam and the automations engine all read ONE
 *  definition — the server composes the key but cannot import this file. */
export { ADOPTION_VENUE_KEY } from "@vendoai/core";

/**
 * The card as the APP SURFACE renders it: bound to the client, so taking it on
 * posts through the adopt door and then walks the adopter through the rest of
 * the ceremony.
 *
 * Adoption is TWO steps, and the card must not skip the second: taking it on
 * re-mints the automation's grants under the adopter, and until they decide that
 * set the automation is NOT running. So a non-empty `missing` renders the same
 * enable-flow set card the panel uses, and only an empty one — or an approved
 * set — says it runs again.
 *
 * Split from the presentational card for the same reason every other chrome
 * surface is: the tree renderer mounts this from the payload's venue state,
 * while the card itself stays testable and reusable with no transport.
 */
export function AdoptionVenueCard({ card }: { card: AdoptionVenue }) {
  const { client } = useVendoContext();
  const [state, setState] = useState<"waiting" | "adopted">("waiting");
  const [set, setSet] = useState<{
    asks: ApprovalRequest[];
    grantSetId?: string;
    state: "parked" | "denied";
  }>();

  if (set !== undefined) {
    return (
      <GrantSetCard
        name={card.automation}
        permissions={set.asks.map((ask) => ({
          approvalId: ask.id,
          tool: ask.call.tool,
          ...(ask.descriptor.description.length > 0 ? { description: ask.descriptor.description } : {}),
          risk: ask.descriptor.risk,
        }))}
        state={set.state}
        onDecide={async (approve) => {
          await client.approvals.decide(
            set.asks.map((ask) => ask.id),
            { approve },
            set.grantSetId === undefined ? undefined : { grantSetId: set.grantSetId },
          );
          if (!approve) {
            // Declining leaves the automation theirs but ungranted — the set
            // card's own settled record ("the automation stays paused") is the
            // honest thing to leave on screen.
            setSet({ ...set, state: "denied" });
            return;
          }
          setSet(undefined);
          setState("adopted");
        }}
      />
    );
  }

  return (
    <AdoptionCard
      card={card}
      state={state}
      onAdopt={async () => {
        const result = await client.automations.adopt(card.appId);
        // A lost race is not an error to swallow: the person who tapped is told
        // that somebody else got there first, which is what actually happened.
        if (!result.adopted) throw new Error("Someone else already took this automation on.");
        if (result.missing.length > 0) {
          setSet({
            asks: result.missing,
            ...(result.grantSetId === undefined ? {} : { grantSetId: result.grantSetId }),
            state: "parked",
          });
          return;
        }
        setState("adopted");
      }}
    />
  );
}
