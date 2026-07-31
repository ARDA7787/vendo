import { canonicalJson } from "./jcs.js";
import { sha256Hex } from "./sha256.js";
import type { ToolDescriptor } from "./tools.js";

/** 01-core §4 */
export function descriptorHash(descriptor: ToolDescriptor): string {
  const preimage: Record<string, unknown> = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    risk: descriptor.risk,
  };
  if (descriptor.critical !== undefined) preimage.critical = descriptor.critical;
  // Embedded-agent design §12: `title` is what a PERSON approved on the card, so
  // a retitle must invalidate grants exactly like a rename — otherwise the words
  // someone consented to can be changed under a still-valid grant. Included only
  // when defined, the same rule `critical` follows, so every grant minted before
  // titles existed keeps matching instead of being silently revoked.
  if (descriptor.title !== undefined) preimage.title = descriptor.title;
  return `sha256:${sha256Hex(canonicalJson(preimage))}`;
}

/** How a title reads to a person: two actions whose labels differ only by case
 *  or padding are still indistinguishable on a card, so they collide. */
const titleKey = (title: string): string => title.trim().toLowerCase();

/** Embedded-agent design §12 — two actions must never read identically on a
 *  consent card. Returns one entry per colliding title, naming the tools, so the
 *  caller can fail boot with a message that says which tools to fix. Empty means
 *  the deployment is clean. */
export function duplicateToolTitles(
  descriptors: readonly ToolDescriptor[],
): Array<{ title: string; tools: string[] }> {
  const byTitle = new Map<string, { title: string; tools: string[] }>();
  for (const descriptor of descriptors) {
    if (descriptor.title === undefined) continue;
    const key = titleKey(descriptor.title);
    if (key === "") continue;
    const found = byTitle.get(key);
    if (found === undefined) byTitle.set(key, { title: descriptor.title, tools: [descriptor.name] });
    else found.tools.push(descriptor.name);
  }
  return [...byTitle.values()].filter((entry) => entry.tools.length > 1);
}
