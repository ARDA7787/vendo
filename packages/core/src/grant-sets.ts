import { canonicalJson } from "./jcs.js";
import { sha256Hex } from "./sha256.js";
import type { Json } from "./ids.js";
import type { RiskLabel, ToolDescriptor } from "./tools.js";
import type { RunContext } from "./run-context.js";

/** Build contract §7 — a grant set is per person, bound to an app's INTENT
 *  rather than to a bare list of tool names. */
export interface GrantSet {
  id: string;
  appId: string;
  subject: string;
  intentHash: string;
  tools: string[];
  createdAt: string;
}

/** The four things a person actually consented to. Anything outside these is
 *  cosmetic: re-asking on a cosmetic change is how people are trained to tap
 *  through cards without reading them. */
export interface AppIntent {
  name: string;
  tools: readonly string[];
  trigger: Json;
  runBody: string;
}

/** Build contract §7 — sha256 over the RFC 8785 canonical form of
 *  `{ tools (sorted), trigger, runBody, name }`. Tools are sorted so that
 *  reordering a declaration is not mistaken for changing it. */
export function intentHash(intent: AppIntent): string {
  const preimage = {
    name: intent.name,
    runBody: intent.runBody,
    tools: [...intent.tools].sort(),
    trigger: intent.trigger,
  };
  return `sha256:${sha256Hex(canonicalJson(preimage))}`;
}

/** What a re-declaration actually changed. `added` is the ONLY thing a card may
 *  ask about (§12: "an addition cards only the delta"); `removed` is reported so
 *  callers can retire grants, never to ask about — dropping a capability needs
 *  no consent. */
export function grantSetDelta(
  granted: readonly string[],
  declared: readonly string[],
): { added: string[]; removed: string[] } {
  const has = new Set(granted);
  const wants = new Set(declared);
  return {
    added: [...wants].filter((tool) => !has.has(tool)).sort(),
    removed: [...has].filter((tool) => !wants.has(tool)).sort(),
  };
}

/** ACTION verbs that move money, message a human, or destroy something.
 *
 *  Matched only in a verb POSITION (see `actionTokens`), never anywhere in the
 *  name. Matching everywhere made `gmail_message_get` look destructive, and
 *  over-withholding is not a safe default: it silently breaks automations that
 *  only ever read, which trains people to widen permissions.
 *
 *  `packages/actions/src/sync/common.ts` carries an equivalent list for
 *  build-time extraction. The duplication is flagged in the lane report — core
 *  cannot import actions (layering) — and this list is now the broader of the
 *  two. */
const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  // destroy
  "delete", "remove", "destroy", "purge", "wipe", "erase", "truncate", "drop", "clear",
  // retire / revoke
  "cancel", "close", "reset", "revoke", "terminate", "deactivate", "disable", "suspend",
  "ban", "block", "expire", "unsubscribe", "archive", "void", "reject", "decline",
  // move money
  "pay", "payout", "charge", "refund", "withdraw", "transfer", "wire", "remit",
  "disburse", "settle", "capture", "chargeback",
  // reach a human / move something out
  "send", "email", "notify", "text", "sms", "message", "dm", "invite", "publish",
  "post", "share", "broadcast", "announce", "dispatch", "page", "call", "forward", "move",
  // start something irreversible
  "initiate", "submit", "execute", "launch", "trigger", "fire", "unpause", "release",
  "approve", "confirm", "finalize", "commit", "merge", "deploy",
]);

/** Verbs that only ever read. A name ENDING in one of these is a read: the
 *  trailing token is the action in `noun_verb` naming, so nouns before it are
 *  just the subject being read. */
const READ_VERBS: ReadonlySet<string> = new Set([
  "get", "list", "fetch", "read", "show", "query", "describe", "count", "search",
  "find", "lookup", "view", "peek", "head", "exists", "check", "preview", "export",
]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

/**
/**
 * The trailing token — the one that decides whether a name is READ-shaped.
 *
 * This is the noun-vs-verb discrimination that makes the vote a second opinion.
 * In `subject_verb` naming the last token is the action, so `gmail_message_get`
 * ends in `get` and is a read even though `message` is in the destructive set:
 * `message` there is the subject being read, not a verb. Checking the trailing
 * read verb FIRST is what keeps that noun from withholding a legitimate read.
 */
function trailingToken(name: string): string | undefined {
  const parts = words(name);
  return parts.length === 0 ? undefined : parts[parts.length - 1];
}

/**
 * §12's SECOND MECHANICAL VOTE: the risk a tool's HTTP method and verb shape
 * imply, computed WITHOUT consulting the AI-assigned label.
 *
 * Not reading `descriptor.risk` is the whole point — a vote that consults the
 * label is not a second opinion, it is the label wearing a hat. `resolvedRisk`
 * is where the two are combined, and disagreement resolves against the tool.
 *
 * Order matters: a destructive verb beats a permissive method (a deletion
 * exposed over GET is still a deletion), and a mutating method beats a
 * read-shaped name (a POST that calls itself `get` is not a read).
 */
export function mechanicalRisk(descriptor: ToolDescriptor): RiskLabel {
  const rawMethod = (descriptor as { method?: unknown }).method;
  const method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : undefined;
  if (method === "DELETE") return "destructive";

  const trailing = trailingToken(descriptor.name);
  const readMethod = method === undefined || method === "GET" || method === "HEAD" || method === "OPTIONS";

  // A TRAILING read verb settles it, and it is checked FIRST on purpose. In
  // `subject_verb` naming the trailing token IS the action, so everything before
  // it is the subject being read — which is exactly why `gmail_message_get` is a
  // read and not a deletion. The method still has to agree: a POST that calls
  // itself `get` is not a read. This short-circuit is the whole noun-vs-verb
  // discrimination; it must run before the destructive scan below.
  if (trailing !== undefined && READ_VERBS.has(trailing) && readMethod) return "read";

  // Not read-shaped, so a destructive verb ANYWHERE in the name decides. Match
  // anywhere, not just at the ends: `maple_customer_delete_all` and
  // `maple_money_transfer_out` bury the verb in the middle of a long name with a
  // qualifier tail (`_all`, `_out`, `_now`), and end-position-only checks let
  // those slip through as `write` and into unattended runs. The read short-circuit
  // above already protected the destructive-NOUN reads, so matching anywhere here
  // costs a false-positive only on a non-read-shaped name that merely mentions a
  // destructive word — which is the fail-toward-destructive direction §12 wants.
  if (words(descriptor.name).some((token) => DESTRUCTIVE_VERBS.has(token))) return "destructive";

  // Everything else is a write: fail-closed, because an unrecognised verb is not
  // evidence of safety — but not `destructive`, because withholding every
  // unknown tool from every automation would make them useless.
  return "write";
}

const RANK: Record<RiskLabel, number> = { read: 0, write: 1, destructive: 2 };

/** The risk the guard should act on: the RISKIER of the AI-assigned label and
 *  the mechanical vote. §12: "Eligibility never rests on the AI-assigned risk
 *  label alone … disagreement treats the tool as destructive." */
export function resolvedRisk(descriptor: ToolDescriptor): RiskLabel {
  const mechanical = mechanicalRisk(descriptor);
  return RANK[mechanical] > RANK[descriptor.risk] ? mechanical : descriptor.risk;
}

/** The one blocked-reason string that means "§12's law refused this".
 *
 *  Named once here because two sides read it: the guard writes it, and the
 *  harness runtime maps it to `DeniedNeeds{ kind: "unattended-destructive" }`
 *  (build contract §1.1) so a harness can offer prepare-then-human-sends
 *  instead of retrying. String-matching it in two places would let them drift. */
export const UNATTENDED_DESTRUCTIVE_REASON =
  "This action is destructive or external, so it is never available without a person present. "
  + "Prepare it instead and let someone send it.";

/** Is a person there to see this? Unattended means NOBODY ACTED — so the
 *  predicate is `presence`, and only `presence`.
 *
 *  The venue is deliberately NOT part of this. `venue` says which door a
 *  request came through; `presence` says whether a human is behind it, and only
 *  the second question is the law's. The two come apart in both directions:
 *   - `{ venue: "app", presence: "away" }` is a real unattended firing — that is
 *     the shape a scheduled app fn fires with (`apps/src/schedules.ts`), so a
 *     venue-based predicate would let every schedule out from under the law.
 *   - `{ venue: "automation", presence: "present" }` is a CEREMONY, not a run:
 *     the enable/capture flow and the "allow this while you're away" approval
 *     card both run with a human right there clicking, and they must SEE the
 *     destructive tools they exist to ask permission about. ORing the venue in
 *     filtered those tools out of the ceremony's own descriptor lookup, so
 *     enabling an automation reported a registered host tool as "unknown tool
 *     in automation" — the law breaking its own prescribed
 *     prepare-then-human-sends path.
 *
 *  `presence` is a required field (`"present" | "away"`), so this fails closed:
 *  there is no absent-value case that reads as attended. Every real firing
 *  passes `presence: "away"` (automations engine, schedules, agent runner,
 *  server), which is what makes presence alone both safe and sufficient. */
export function isUnattended(ctx: Pick<RunContext, "presence">): boolean {
  return ctx.presence === "away";
}

/**
 * THE LAW (§12), as a projection: destructive and external actions are **not
 * projected into an automation run at all** — not with a limit, not with a
 * condition, not with an admin override.
 *
 * This is a filter over the toolset rather than a check at call time because the
 * law is about what the model is even offered. A tool the model cannot see is a
 * tool it cannot be talked into using; a tool it can see but is refused becomes
 * something it retries and works around. Call-time enforcement still exists as
 * defence in depth, but this is the primary mechanism.
 */
export function projectableForRun(
  descriptors: readonly ToolDescriptor[],
  ctx: Pick<RunContext, "venue" | "presence">,
): ToolDescriptor[] {
  if (!isUnattended(ctx)) return [...descriptors];
  return descriptors.filter((descriptor) => resolvedRisk(descriptor) !== "destructive");
}

/** §12 — "Whole-registry declarations are rejected, not bundled; a declared set
 *  is bundle-eligible only if every member is a read or a non-destructive
 *  write." A card that asks for everything is not consent, it is a formality. */
export function isBundleEligible(
  declared: readonly string[],
  registry: readonly string[],
  descriptors: readonly ToolDescriptor[],
): boolean {
  if (declared.length === 0) return false;
  const wanted = new Set(declared);
  if (registry.length > 0 && registry.every((tool) => wanted.has(tool))) return false;
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return declared.every((name) => {
    const descriptor = byName.get(name);
    return descriptor !== undefined && resolvedRisk(descriptor) !== "destructive";
  });
}
