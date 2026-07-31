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

/** Verbs that move money, message a human, or destroy something. This is the
 *  mechanical half of §12's two-vote rule, so it is deliberately blunt and
 *  deliberately over-inclusive: a false "destructive" costs one confirmation,
 *  a false "write" costs an unattended irreversible action.
 *
 *  `packages/actions/src/sync/common.ts` carries an equivalent list for
 *  build-time extraction. The duplication is real and flagged in the lane
 *  report — actions cannot be imported from core (layering), and converging
 *  them means editing a file this lane does not own. */
const DESTRUCTIVE_WORDS: ReadonlySet<string> = new Set([
  "delete", "remove", "destroy", "cancel", "close", "reset", "revoke", "purge", "wipe", "archive",
  "unpause", "transfer", "send", "invite", "pay", "charge", "refund", "withdraw", "email", "message",
  "notify", "text", "call", "post", "publish", "share",
]);

const READ_WORDS: ReadonlySet<string> = new Set([
  "get", "list", "fetch", "search", "find", "read", "show", "query", "describe", "count",
]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

function containsWord(value: string, vocabulary: ReadonlySet<string>): boolean {
  return words(value).some((word) => vocabulary.has(word));
}

/** §12's SECOND MECHANICAL VOTE: the risk a tool's HTTP method and verb shape
 *  imply, computed without asking a model anything.
 *
 *  Read the result as a floor, not an opinion. `resolved` below combines it with
 *  the descriptor's own label, and disagreement resolves against the tool. */
export function mechanicalRisk(descriptor: ToolDescriptor): RiskLabel {
  const method = (descriptor as { method?: unknown }).method;
  if (typeof method === "string" && method.toUpperCase() === "DELETE") return "destructive";
  if (containsWord(descriptor.name, DESTRUCTIVE_WORDS)) return "destructive";
  if (descriptor.risk === "read" && containsWord(descriptor.name, READ_WORDS)) return "read";
  if (descriptor.risk === "read") return "read";
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

/** Is a person there to see this? Unattended means nobody clicked. */
export function isUnattended(ctx: Pick<RunContext, "venue" | "presence">): boolean {
  return ctx.presence === "away" || ctx.venue === "automation";
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
