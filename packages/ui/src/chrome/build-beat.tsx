import type { Json, JsonSchema } from "@vendoai/core";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { useEffect, useRef, useState } from "react";
import { consumerVoiceViolation } from "../consumer-voice.js";
import { useVendoContext } from "../context.js";
import { developmentMode } from "./dev-mode.js";
import { argProperties, argValue, humanizeToolName, toolTitle, type ArgProperties, type ToolMeta } from "./humanize.js";

/**
 * The thread's in-progress presentation speaks in the product's voice: each
 * tool call renders as a quiet human "beat" — a checklist line with a pulsing
 * orb while working and a tick when done. Labels come from the ENG-216
 * humanization pipeline (host `ToolMeta` wins, else the prettified tool id —
 * never the raw slug or a lifecycle string). The mechanical record stays in
 * the Activity panel.
 */

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

function rawToolName(part: AnyToolPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

/** Connector tools ("slack_SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL") → toolkit slug. */
function toolkitFromToolName(name: string): string | undefined {
  const match = /^([a-z]+)_[A-Z0-9_]+$/.exec(name) ?? /^([A-Z]+)_[A-Z0-9_]+$/.exec(name);
  return match ? match[1]!.toLowerCase() : undefined;
}

/** Toolkit marks come from Composio's logo CDN, which covers its full catalog
    (chrome surfaces only — the jail blocks remote images). Unknown slugs get
    Composio's neutral placeholder rather than a 404, so `onError` fallbacks
    only fire on real network failures. */
export function toolkitLogoUrl(toolkit: string): string {
  return `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`;
}

/**
 * The consent-surface presentation of one tool call, layered on the ENG-216
 * pipeline: the title is the humanized tool label (host meta wins), the
 * eyebrow marks an automation when the REAL inputs carry a recurrence
 * (`trigger`/`every`/`schedule`), and the description explains what granting
 * means in plain words — host meta first, else synthesized from the inputs,
 * never invented beyond them.
 */
export interface ToolPresentation {
  title: string;
  eyebrow: string;
  description?: string;
  /** Short toast byline for the post-approve notification. */
  sub?: string;
  toolkit?: string;
  logoUrl?: string;
  /** Lane pick 1-A — the consequence-first sentence, structured so the card
      can emphasize the artifact and target. Synthesized ONLY from the real
      inputs (same honesty rule as `description`); absent when the inputs
      don't support a truthful sentence, in which case the card keeps its
      always-open fields layout. */
  consequence?: ToolConsequence;
}

/** "Vendo will post ‹artifact› to ‹target› — now, as you." in parts. */
export interface ToolConsequence {
  pre: string;
  artifact?: string;
  mid?: string;
  target?: string;
  post: string;
}

/** Fields whose value can NAME the other side of an action, most specific
    first. Only these: a sentence may never guess who the counterparty is. */
const TARGET_FIELDS = ["recipient_name", "recipient", "payee", "to", "destination", "merchant", "channel"];

/** The verb CLASS a tool belongs to, read off its humanized words. A class is a
    category ("moves money"), never the tool's own label — that distinction is
    the whole point of {@link consentClassLine}. */
const VERB_CLASSES: [RegExp, string][] = [
  [/\b(delete|remove|destroy|archive|revoke|cancel)\b/, "deletes something"],
  [/\b(transfer|pay|payment|refund|charge|order|withdraw|deposit)\b/, "moves money"],
  [/\b(email|mail|message|notify|post|reply|share|send)\b/, "sends a message"],
  [/\b(create|add|draft|schedule|book)\b/, "creates something"],
  [/\b(update|edit|set|change|rename|move)\b/, "changes something"],
];

function verbClass(name: string): string | undefined {
  const words = humanizeToolName(name).toLowerCase();
  return VERB_CLASSES.find(([pattern]) => pattern.test(words))?.[1];
}

/**
 * The plain-words line when NOTHING truthful can be synthesized: no host
 * description, no authored one, no sentence the real inputs support.
 *
 * THE DEFECT it replaces: `Vendo will run Send money as you.` — the tool's own
 * label read back at a bank customer, which is exactly the machine copy the
 * consumer-voice guarantee exists to keep off a consent card. This says what
 * approving DOES by class, plus the one thing always true of a Vendo call (it
 * runs as the person approving it), and never names the tool.
 */
export function consentClassLine(name: string, risk: string): string {
  const verb = verbClass(name);
  if (verb !== undefined) return `This ${verb}, as you.`;
  if (risk === "destructive") return "This makes a change you can’t undo, as you.";
  if (risk === "write") return "This changes something in your account, as you.";
  return "This reads your data, as you.";
}

/**
 * spec §16 law 3 / ruling 11 — the plain-words line's THIRD tier: the
 * descriptor's own sentence, after the host's and the consequence synthesized
 * from the real inputs.
 *
 * THE DEFECT this closes: a descriptor is authored for the MODEL (demo-bank's
 * "Amounts are integer cents (e.g. 285000 = $2,850.00): divide by 100…") or
 * generated by extraction ("POST /api/demo/pin"), and both reached a consent
 * card because the card treated it as copy. A sentence that fails the
 * consumer-voice vocabulary is DROPPED — the caller falls through to the
 * consequence class — never shortened into something still wrong. The dropped
 * string keeps its home in the dev-mode console, so a host can see why its tool
 * has no sentence.
 *
 * The approval card and its queue row both go through here: one definition, so
 * a card and its row can never say different things about the same ask.
 */
export function admissibleDescription(description: string | undefined, title: string): string | undefined {
  const text = description?.trim();
  if (text === undefined || text.length === 0 || text === title) return undefined;
  const violation = consumerVoiceViolation(text);
  if (violation === undefined) return text;
  if (developmentMode()) {
    console.warn(
      `[vendo] "${title}": dropped the tool description from its card — it reads as ${violation}.`
      + " Give the tool a consumer sentence in its ToolMeta to show one.",
    );
  }
  return undefined;
}

/** The first argument that is REAL money — declared by the host's own field
    formatter or by the tool's input schema (`argValue`). An undeclared number
    is not money and never enters a sentence: dressing an integer as currency is
    the same defect pointing the other way. */
function moneyValue(args: Record<string, unknown>, meta?: ToolMeta, properties?: ArgProperties): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const shown = meta?.formatField?.(key, value as Json) ?? argValue(key, value, properties);
    if (shown !== String(value) && !shown.includes("unit not specified")) return shown;
  }
  return undefined;
}

export function toolPresentation(
  name: string,
  args?: unknown,
  meta?: ToolMeta,
  /** The descriptor's authored label, when the caller has the descriptor
      (approval surfaces do; a bare tool beat does not). */
  descriptorTitle?: string,
  /** The declared input schema, when the caller has the descriptor: money in
      the synthesized sentence is only ever a DECLARED unit. */
  inputSchema?: JsonSchema,
): ToolPresentation {
  const toolkit = toolkitFromToolName(name);
  const logoUrl = toolkit ? toolkitLogoUrl(toolkit) : undefined;
  const flat = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const trigger = typeof flat.trigger === "string" ? flat.trigger
    : typeof flat.every === "string" ? `every ${flat.every}`
    : typeof flat.schedule === "string" ? flat.schedule
    : undefined;
  const eyebrow = trigger ? "Automation · needs your approval" : "Needs your approval";
  const title = toolTitle(name, meta, descriptorTitle);

  let description = meta?.description;
  let sub: string | undefined;
  let consequence: ToolConsequence | undefined;
  if (toolkit === "slack" && typeof flat.channel === "string") {
    description ??= trigger
      ? `Vendo will post to ${flat.channel} on your behalf, ${trigger}. It runs as you, and you can pause it anytime.`
      : `Vendo will post to ${flat.channel} on your behalf, running as you.`;
    sub = trigger ? `Posts to ${flat.channel} ${trigger}` : `Posts to ${flat.channel} as you`;
    if (typeof flat.message === "string" && flat.message.trim().length > 0) {
      consequence = {
        pre: "Vendo will post ",
        artifact: `“${flat.message}”`,
        mid: " to ",
        target: flat.channel,
        post: trigger ? `, ${trigger} — as you.` : " — now, as you.",
      };
    }
  } else if (toolkit === "gmail" && typeof flat.to === "string") {
    description ??= `Vendo will send this email as you${trigger ? `, ${trigger}` : ""}.`;
    sub = `Emails ${flat.to} as you`;
    // No consequence for Gmail: the email's subject/body/copied recipients ARE
    // the message, and a sentence naming only `to` would fold them out of
    // sight. The fold is only earned when the sentence carries the full
    // content (the Slack branch above) — otherwise the card keeps its open
    // fields so the user reviews the real inputs before approving.
  } else if (verbClass(name) === "moves money") {
    // The general money case — the same idea as the Slack branch, for the asks
    // that actually gate money: a DECLARED amount plus a named counterparty is
    // enough for one truthful sentence ("Sends $47.50 to Acme Utilities"),
    // which is what the robotic `Vendo will run Send money as you.` replaced.
    const amount = moneyValue(flat, meta, argProperties(inputSchema));
    const target = TARGET_FIELDS
      .map(field => flat[field])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (amount !== undefined && target !== undefined) {
      consequence = {
        pre: "Sends ",
        artifact: amount,
        mid: " to ",
        target,
        post: trigger ? `, ${trigger} — as you.` : " — now, as you.",
      };
      sub ??= trigger ? `Sends ${amount} to ${target} ${trigger}` : `Sends ${amount} to ${target} as you`;
    }
  }
  return { title, eyebrow, description, sub, toolkit, logoUrl, consequence };
}

/** The live status ribbon above the composer: humanized label, live elapsed
    clock, "step N of M".

    Spec §1 (2026-08-03) retired its TOOL-NARRATION role — the transcript shows
    the work now, one beat per call — so the thread mounts it for exactly one
    moment: the hold while a parked call waits for the user's approval. The
    component itself is unchanged (hosts may still narrate any part with it).
    Label changes crossfade via the .fl-ribbon-label key remount; the elapsed
    clock resets per tool call. */
export function StatusRibbon({ part, stepIndex, stepTotal, risk = "read" }: {
  part: AnyToolPart;
  /** 1-based index of the active call within the turn's tool calls. */
  stepIndex: number;
  stepTotal: number;
  /** Rides the data attr (parity with the old beat's machine affordance). */
  risk?: string;
}) {
  const { tools } = useVendoContext();
  const name = rawToolName(part);
  const label = toolTitle(name, tools[name]);
  const waiting = part.state === "approval-requested";
  // Elapsed ticks while this call is the active one; keyed to the call id so a
  // new step restarts the clock. Interval only mounts when motion is allowed —
  // the ribbon is short-lived, but a reduced-motion reader gets a quiet label.
  const startRef = useRef<{ id: string; t0: number }>({ id: part.toolCallId, t0: Date.now() });
  const [elapsed, setElapsed] = useState(0);
  if (startRef.current.id !== part.toolCallId) {
    startRef.current = { id: part.toolCallId, t0: Date.now() };
    // Render-phase reset so the new call never flashes the previous clock
    // for the first interval tick.
    setElapsed(0);
  }
  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      setElapsed((Date.now() - startRef.current.t0) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      className="fl-ribbon"
      role="status"
      aria-live="polite"
      data-vendo-tool={name}
      data-vendo-approval={risk}
      title={name}
    >
      <span className="fl-beat-orb" aria-hidden="true" />
      <span className="fl-ribbon-label" key={part.toolCallId}>
        {label}
        {waiting ? " — waiting for your approval" : "…"}
      </span>
      {elapsed >= 0.1 ? <span className="fl-ribbon-time" aria-hidden="true">{elapsed.toFixed(1)}s</span> : null}
      {stepTotal > 1 ? <span className="fl-ribbon-count">step {stepIndex} of {stepTotal}</span> : null}
    </div>
  );
}

/** 2026-07 loading-state audit — the between-steps voice. The StatusRibbon
    narrates a LIVE tool part; but a busy turn also has quieter moments with
    no live part and no streaming text (the model deciding the next step
    after its prose settled, the gap between one settled call and the next
    input-start). Those used to show nothing. This is the same ribbon shell
    with a generic label and its own elapsed clock (reset per mount), so
    every waiting moment keeps a calm, specific voice. */
export function WorkingRibbon({ label = "Working" }: { label?: string }) {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="fl-ribbon fl-ribbon--working" role="status" aria-live="polite">
      <span className="fl-beat-orb" aria-hidden="true" />
      <span className="fl-ribbon-label">{label}&hellip;</span>
      {elapsed >= 0.1 ? <span className="fl-ribbon-time" aria-hidden="true">{elapsed.toFixed(1)}s</span> : null}
    </div>
  );
}

/** The settled tick — shared by a done beat and the turn's summary row. */
function BeatTick() {
  return (
    <span className="fl-beat-ic fl-beat-tick" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="m5 12 4 4L19 6" />
      </svg>
    </span>
  );
}

/**
 * Spec §1 — the short result a settled beat earned ("Reading transactions ·
 * 142 transactions").
 *
 * Only a COUNT rides here, named by the output's own key. An arbitrary string
 * off a tool's output is the TOOL's voice (and often a raw slug or an id), and
 * this line sits in the product's own transcript — so anything we can't say in
 * plain words is simply absent, exactly like the humanization pipeline's rule
 * for labels.
 */
export function toolResultSummary(output: unknown): string | undefined {
  if (Array.isArray(output)) return countLabel(output.length, "results");
  if (typeof output !== "object" || output === null) return undefined;
  for (const [key, value] of Object.entries(output)) {
    // Identifier-shaped keys only: a key we can't humanize into words would
    // put a slug on the line.
    if (!Array.isArray(value) || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    return countLabel(value.length, humanizeToolName(key).toLowerCase());
  }
  const count = (output as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count)
    ? countLabel(count, "results")
    : undefined;
}

/** "142 transactions" / "1 transaction"; nothing at all for an empty result —
    "0 rows" is noise on a line whose job is reassurance. */
function countLabel(count: number, noun: string): string | undefined {
  if (count <= 0) return undefined;
  const singular = count === 1 && noun.endsWith("s") ? noun.slice(0, -1) : noun;
  return `${count.toLocaleString()} ${singular}`;
}

export function BuildBeat({
  part,
  risk,
  count = 1,
}: {
  part: AnyToolPart;
  risk: string;
  /** Collapsed-run repeat count (ENG-216) — shown as a ×N suffix. */
  count?: number;
}) {
  const { tools } = useVendoContext();
  const name = rawToolName(part);
  const error = part.state === "output-error";
  const done = part.state === "output-available";
  const waiting = part.state === "approval-requested";
  // A refused ask is a settled outcome with a ✕, not a failure and not a
  // heartbeat: without this, a declined call's beat sat in the finished turn
  // still saying "…", as if it were about to happen.
  const declined = part.state === "output-denied";
  const label = toolTitle(name, tools[name]);
  const result = done ? toolResultSummary(part.output) : undefined;
  const state = error ? "fl-beat-error" : done || declined ? "fl-beat-done" : "fl-beat-working";
  return (
    <div
      className={`fl-beat ${state}`}
      data-vendo-approval={risk}
      data-vendo-tool={name}
      title={name}
    >
      {error || declined ? (
        // Same glyph, different register: the error beat is danger-colored
        // (.fl-beat-error), a decline quiets to muted like any settled line.
        <span className={`fl-beat-ic${error ? " fl-beat-x" : ""}`} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      ) : done ? (
        <BeatTick />
      ) : (
        <span className="fl-beat-orb" aria-hidden="true" />
      )}
      <span className="fl-beat-label">
        {waiting ? `${label} — waiting for your approval`
          : error ? `${label} — couldn't finish`
          : declined ? `${label} — you declined it`
          : done ? label
          : `${label}…`}
      </span>
      {result ? <span className="fl-beat-result">· {result}</span> : null}
      {count > 1 ? <span className="fl-beat-count" aria-label={`repeated ${count} times`}>×{count}</span> : null}
    </div>
  );
}

/**
 * Spec §1 — the settled turn's ONE reopenable row: "✓ Did 4 things · 7.1s".
 *
 * Beats are the live record of the work; once the turn closes, history has to
 * stay scannable, so the whole checklist folds into this line and reopens on
 * click. `seconds` is the turn's measured wall time and is absent for a turn
 * nobody watched work (restored history carries no per-part timestamps, and an
 * invented duration would be a lie on a receipt).
 */
export function BeatSummary({ steps, seconds, open, onToggle }: {
  steps: number;
  seconds?: number | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="fl-beatsummary"
      aria-expanded={open}
      onClick={onToggle}
    >
      <BeatTick />
      <span className="fl-beatsummary-label">
        Did {steps} thing{steps === 1 ? "" : "s"}
        {seconds === undefined ? "" : ` · ${seconds.toFixed(1)}s`}
      </span>
    </button>
  );
}
