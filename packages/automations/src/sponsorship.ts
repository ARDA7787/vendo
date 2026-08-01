import {
  canonicalJson,
  intentHash,
  type AppDocument,
  type AppIntent,
  type IsoDateTime,
  type Json,
  type RecordStore,
  type Trigger,
} from "@vendoai/core";
import { z } from "zod";

/** Build contract §9.9 — sponsorship lives in its OWN routed collection, never
 *  on the app row: the row is the automation's declaration, this is who it runs
 *  as, and two independent facts on one row drift. Engine-internal state like
 *  `automations:captures`, so the generic records door is right here. */
export const SPONSORSHIPS = "automations:sponsorships";

/** Build contract §9.9, frozen. Keyed by appId — one automation, one sponsor. */
export interface Sponsorship {
  appId: string;
  /** The sponsor's subject. An automation always runs as a named person. */
  sponsor: string;
  /** Core `intentHash()` over the app's §7 intent at mint time. */
  intentHash: string;
  status: "active" | "invalidated";
  reason?: "edit" | "departure" | "grants";
  invalidatedAt?: IsoDateTime;
}

export const sponsorshipSchema = z.object({
  appId: z.string(),
  sponsor: z.string(),
  intentHash: z.string(),
  status: z.enum(["active", "invalidated"]),
  reason: z.enum(["edit", "departure", "grants"]).optional(),
  invalidatedAt: z.string().optional(),
}) satisfies z.ZodType<Sponsorship>;

/** The tools an automation DECLARES it will use: its steps' host tools, deduped
 *  and `fn:` refs excluded (those are the app's own code, not host authority).
 *  An agentic run declares nothing — its toolset is whatever the registry binds
 *  at fire time, which is not a declaration and must not enter the intent hash
 *  (a new connector would silently invalidate every agentic automation). */
export const declaredSurface = (trigger: Trigger | undefined): string[] =>
  trigger === undefined || trigger.run.kind !== "steps"
    ? []
    : [...new Set(trigger.run.steps.map((step) => step.tool).filter((tool) => !tool.startsWith("fn:")))];

/** Build contract §7's `AppIntent` for an automation document.
 *
 *  `runBody` is the canonical JSON of the trigger's RUN definition — for steps
 *  that is the ordered steps (tool, args, if, forEach), for an agentic run the
 *  prompt and budget. It is derived rather than hand-picked so that every part
 *  of "what this automation will do" is bound: an argument change is as much a
 *  change of intent as a new tool is, and a hash that ignored it would let an
 *  edit re-point a granted call at a different invoice. */
export const appIntentOf = (doc: AppDocument): AppIntent => ({
  name: doc.name,
  tools: declaredSurface(doc.trigger),
  trigger: (doc.trigger?.on ?? null) as Json,
  runBody: doc.trigger === undefined ? "" : canonicalJson(doc.trigger.run),
});

export const currentIntentHash = (doc: AppDocument): string => intentHash(appIntentOf(doc));

const rowOf = (records: RecordStore, appId: string) => records.get(appId);

/** The stored sponsorship, or undefined when there is none (an automation
 *  enabled before sponsorship shipped) or the row is unreadable. A corrupt row
 *  is not a sponsorship — it degenerates to the pre-sponsorship behavior of
 *  running as the app's owner rather than stranding the automation. */
export const readSponsorship = async (
  records: RecordStore,
  appId: string,
): Promise<{ row: Sponsorship; revision?: string } | undefined> => {
  const record = await rowOf(records, appId);
  if (record === null) return undefined;
  const parsed = sponsorshipSchema.safeParse(record.data);
  if (!parsed.success) return undefined;
  return { row: parsed.data, ...(record.revision === undefined ? {} : { revision: record.revision }) };
};

/** Both refs are load-bearing: the 02-store §5 erase cascade collects generic
 *  rows by `refs.subject` (erasing the sponsor takes their name off the row)
 *  AND by `refs.app_id` (deleting the app takes its sponsorship with it). A row
 *  that survived either cascade would be a dangling name. */
const sponsorshipRefs = (row: Sponsorship): Record<string, string> =>
  ({ subject: row.sponsor, app_id: row.appId });

export const writeSponsorship = async (records: RecordStore, row: Sponsorship): Promise<void> => {
  await records.put({ id: row.appId, data: { ...row }, refs: sponsorshipRefs(row) });
};

/** Compare-and-swap the row onto a new sponsor. Returns false when another
 *  editor got there first — adoption is first-past-the-post, and the loser is
 *  told so honestly rather than silently overwriting the winner. Stores with no
 *  atomic door re-read and check instead: it narrows, but cannot close, a
 *  cross-process race (the engine's schedule cursor makes the same trade). */
export const swapSponsor = async (
  records: RecordStore,
  next: Sponsorship,
  expected: { revision?: string },
): Promise<boolean> => {
  if (records.atomic !== undefined && expected.revision !== undefined) {
    const swapped = await records.atomic.compareAndSwap(
      { id: next.appId, data: { ...next }, refs: sponsorshipRefs(next) },
      expected.revision,
    );
    return swapped !== null;
  }
  const current = await readSponsorship(records, next.appId);
  if (current?.row.status !== "invalidated") return false;
  await writeSponsorship(records, next);
  return true;
};
