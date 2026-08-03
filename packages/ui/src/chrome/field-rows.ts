/** spec §16 law 1 — the card body is NOT chosen by its data.
 *
 *  The consent cards used to pick between three mutually exclusive bodies (a
 *  consequence sentence, a `<dl>` of 1–8 primitive args, or a raw `<pre>` of the
 *  server's `inputPreview`), so the same ask looked like a different product
 *  depending on what the model happened to pass. One body now: field rows,
 *  always. Nested values flatten to compact `Key: value` lines (the shell's dd
 *  is `white-space: pre-line`), non-object args become one row, and a long arg
 *  list is simply a long list — never a fallback to raw JSON.
 */
import type { Json, JsonSchema } from "@vendoai/core";
import { argProperties, argValue, humanizeToolName, yesNo, type ToolMeta } from "./humanize.js";
import { truncateHead } from "./truncate.js";

export interface CardFieldRow {
  /** Humanized argument name ("recipient_name" → "Recipient name"). */
  label: string;
  /** What the person reads — host formatter first, else the shared money-safe
      value rule (`argValue`). */
  value: string;
  /** The raw value, for the dd tooltip: the consent honesty contract keeps the
      real input one hover away whenever display changed it. */
  raw: string;
  /** Numbers right-align on tabular figures so a column of amounts reads as a
      column (`.fl-card-field dd[data-numeric]`). */
  numeric: boolean;
}

/** A single field never renders more than this: one base64 blob or dumped row
    set otherwise lands thousands of characters inside the card (ENG-218). */
const VALUE_CAP = 400;

const bound = (text: string): string =>
  text.length > VALUE_CAP ? `${truncateHead(text, VALUE_CAP)}…` : text;

function leaf(value: unknown): string {
  if (typeof value === "string") return value;
  // A nested boolean reads as an answer too, or the same `true` leaks one level
  // down ("Options — Permanent: true").
  if (typeof value === "boolean") return yesNo(value);
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A nested object/array as compact lines — one per entry, in order. */
function nested(value: object): string {
  if (Array.isArray(value)) return value.map(leaf).join("\n");
  return Object.entries(value).map(([key, item]) => `${humanizeToolName(key)}: ${leaf(item)}`).join("\n");
}

/** The one body, for any args a tool call can carry. */
export function fieldRows(args: unknown, inputSchema?: JsonSchema, meta?: ToolMeta): CardFieldRow[] {
  const row = (label: string, value: string, raw: string, numeric: boolean): CardFieldRow =>
    ({ label, value: bound(value), raw: bound(raw), numeric });
  if (args === undefined || args === null) return [];
  if (typeof args !== "object") return [row("Input", leaf(args), leaf(args), typeof args === "number")];
  if (Array.isArray(args)) return [row("Input", nested(args), leaf(args), false)];
  const properties = argProperties(inputSchema);
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const label = humanizeToolName(key);
    if (value !== null && typeof value === "object") return row(label, nested(value), leaf(value), false);
    const formatted = meta?.formatField?.(key, value as Json) ?? argValue(key, value, properties);
    return row(label, formatted, String(value), typeof value === "number");
  });
}
