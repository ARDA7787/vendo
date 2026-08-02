import { encodeGrantPrincipal, parseGrantPrincipal, type AccessLevel, type AppId, type Membership } from "@vendoai/core";
import { useState } from "react";
import { useAppGrants } from "../hooks/use-app-grants.js";
import { ChromeRoot } from "./chrome-root.js";

/**
 * Build contract §9.2–§9.6 — the Share dialog: the ONE surface that writes
 * app-access grants. Pick a principal (a person, a team, or the whole org) and
 * a level; the list below is who reaches the app today, each row revocable.
 *
 * "Share implies promote" (§9.5): handing a personal app to an org moves the
 * canonical copy into that org first, so there is one living app rather than
 * two drifting copies. The dialog says so before it does it.
 */

const LEVELS: Array<{ value: AccessLevel; label: string; blurb: string }> = [
  { value: "viewer", label: "Can view", blurb: "See it and use it." },
  { value: "editor", label: "Can edit", blurb: "Change what it does." },
  { value: "owner", label: "Can share", blurb: "Edit, share, and delete it." },
];

/** The frozen §9.2 encoding lives in core, next to the parser that reads it —
    ONE encoder, so a surface can never write a shape `can()` cannot match.
    Re-exported here because the chrome surface has always offered it. */
export { encodeGrantPrincipal };

/** Which org a chosen principal names — the org a personal app moves into.
    `user:` names a person, not a team, so it moves nothing. */
function orgOf(encoded: string): string | undefined {
  const named = parseGrantPrincipal(encoded);
  return named === undefined || named.kind === "user" ? undefined : named.org;
}

/** Consumer voice, not the encoding: "the finance team", not "team:acme/finance". */
function describePrincipal(encoded: string, memberships: readonly Membership[]): string {
  const named = parseGrantPrincipal(encoded);
  if (named === undefined) return encoded;
  if (named.kind === "user") return named.subject;
  if (named.kind === "team") return `The ${named.team} team`;
  return memberships.find((membership) => membership.org === named.org)?.display
    ?? `Everyone at ${named.org}`;
}

export interface ShareDialogProps {
  appId: AppId;
  /** The app's display name, for the "moves into" sentence. */
  appName?: string;
  /** The orgs and teams the host asserted for this caller — the only
      principals a share can name (§9.1: Vendo has no org chart of its own). */
  memberships?: readonly Membership[];
  /** The app declares an automation. Moving it into a team turns that
      automation OFF, and the dialog says so before it happens (§9.5). */
  automation?: boolean;
  onClose?(): void;
}

export function ShareDialog({ appId, appName, memberships = [], automation = false, onClose }: ShareDialogProps) {
  // Whether this is still the caller's own copy comes from the SAME read that
  // answers their level — no caller can forget to pass it, which is exactly how
  // "share implies promote" never fired in the shipped surface.
  const { level, grants, personal, isLoading, share, unshare, promote } = useAppGrants(appId);
  const [target, setTarget] = useState("");
  const [nextLevel, setNextLevel] = useState<AccessLevel>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** The org this app was just moved into, so the note that follows a move is
      about what happened, not about what might. */
  const [moved, setMoved] = useState<string>();

  const canShare = level === "owner";
  const orgs = memberships.map((membership) => membership.org);
  const options: Array<{ value: string; label: string }> = [
    ...memberships.flatMap((membership) => [
      { value: encodeGrantPrincipal({ kind: "org", org: membership.org }), label: `Everyone at ${membership.display ?? membership.org}` },
      ...(membership.teams ?? []).map((team) => ({
        value: encodeGrantPrincipal({ kind: "team", org: membership.org, team }),
        label: `The ${team} team`,
      })),
    ]),
  ];

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (reason) {
      // The wire's own sentence, verbatim: `cloud-required` and `forbidden`
      // both already say what to do, and paraphrasing them loses that.
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    const principal = target.trim();
    if (principal === "") return;
    const named = orgOf(principal);
    await run(async () => {
      // §9.5 — share implies promote: a personal app moves into the org THIS
      // SHARE NAMES (never "the first org you belong to") before the grant is
      // written, so everyone lands on ONE app, in the right team.
      if (personal && named !== undefined) {
        await promote(named);
        setMoved(named);
      }
      await share(principal, nextLevel);
      setTarget("");
    });
  };

  return (
    <ChromeRoot className="fl-share">
      <div className="fl-share-head">
        <div className="fl-share-title">Share{appName === undefined ? "" : ` ${appName}`}</div>
        {onClose === undefined ? null : (
          <button type="button" className="fl-btn fl-btn--ghost" onClick={onClose}>Done</button>
        )}
      </div>

      {/* Nothing is said about access until the first read has answered: `null`
          is also what the hook holds while it is still in flight, so rendering
          it told every caller they had no access for as long as the fetch took. */}
      {canShare || isLoading ? null : (
        <p className="fl-share-note">
          {level === null
            ? "You don’t have access to this app."
            : "Only an owner can change who this app is shared with."}
        </p>
      )}

      {canShare && personal && orgs.length > 0 ? (
        <p className="fl-share-note">
          This is your own copy. Sharing it with a team moves it there, so everyone works on
          the same one.
          {automation ? " Its automation turns off in the move — automations run with a person’s"
            + " access, so it stays off until someone turns it back on." : ""}
        </p>
      ) : null}

      {moved === undefined ? null : (
        <p className="fl-share-note" role="status">
          Moved into <b>{memberships.find((entry) => entry.org === moved)?.display ?? moved}</b>.
          {automation ? " Its automation is off until someone turns it back on — automations run"
            + " with a person’s access." : ""}
        </p>
      )}

      {canShare ? (
        <div className="fl-share-add">
          <input
            className="fl-share-input"
            value={target}
            list={`fl-share-options-${appId}`}
            placeholder="Person, team, or everyone"
            aria-label="Who to share with"
            disabled={busy}
            onChange={(event) => setTarget(event.target.value)}
          />
          <datalist id={`fl-share-options-${appId}`}>
            {options.map((option) => <option key={option.value} value={option.value} label={option.label} />)}
          </datalist>
          <select
            className="fl-share-level"
            value={nextLevel}
            aria-label="Access level"
            disabled={busy}
            onChange={(event) => setNextLevel(event.target.value as AccessLevel)}
          >
            {LEVELS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
          <button type="button" className="fl-btn fl-btn--primary" disabled={busy || target.trim() === ""} onClick={() => void submit()}>
            Share
          </button>
        </div>
      ) : null}

      {error === undefined ? null : <p className="fl-share-error" role="alert">{error}</p>}

      <ul className="fl-share-list">
        {isLoading && grants.length === 0 ? <li className="fl-share-empty">Loading…</li> : null}
        {!isLoading && grants.length === 0 ? (
          <li className="fl-share-empty">Nobody else yet — it’s just you.</li>
        ) : null}
        {grants.map((grant) => (
          <li key={grant.id} className="fl-share-row">
            <span className="fl-share-who">{describePrincipal(grant.principal, memberships)}</span>
            <span className="fl-share-lvl">{LEVELS.find((entry) => entry.value === grant.level)?.label ?? grant.level}</span>
            {canShare ? (
              <button
                type="button"
                className="fl-btn fl-btn--ghost fl-share-revoke"
                disabled={busy}
                onClick={() => void run(() => unshare(grant.principal))}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </ChromeRoot>
  );
}

export interface ForkOfferProps {
  /** What the person was trying to change, in their words. */
  instruction?: string;
  onFork(): void | PromiseLike<void>;
  onDismiss?(): void;
}

/**
 * Build contract §9.4 — what a VIEWER sees instead of a bare refusal. The
 * `forbidden` code exists precisely so this can be offered: the caller
 * provably sees the app, so "you can't" is answerable with "…but here's what
 * you can do".
 */
export function ForkOffer({ instruction, onFork, onDismiss }: ForkOfferProps) {
  const [busy, setBusy] = useState(false);
  return (
    <ChromeRoot className="fl-share-fork">
      <p className="fl-share-fork-copy">
        I can’t change the team’s copy{instruction === undefined ? "" : ` to ${instruction}`} — but I can make you your own.
      </p>
      <div className="fl-share-fork-actions">
        <button
          type="button"
          className="fl-btn fl-btn--primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onFork()).finally(() => setBusy(false));
          }}
        >
          Make me my own copy
        </button>
        {onDismiss === undefined ? null : (
          <button type="button" className="fl-btn fl-btn--ghost" onClick={onDismiss}>Never mind</button>
        )}
      </div>
    </ChromeRoot>
  );
}
