/**
 * The try surface's LIVE slot (unified try surface, Task 10): the same overlay
 * chrome as the scripted slot, wired to the real vendo wire the try server
 * mounts at the boot config's `apiBase`.
 *
 * The composition deliberately mirrors a customer's app, seam for seam: a
 * `createVendoClient({ baseUrl })` and NO transport override, so
 * useVendoThread builds its own DefaultChatTransport against
 * `${apiBase}/threads` — the exact code path a host's production drop-in
 * exercises, not a parallel one. Collection hooks need no special casing
 * either: the try server mounts the FULL `createVendo().handler`, so threads,
 * apps, activity, and the connector catalog all answer from the real wire
 * (a fresh store means honest empty states, and a catalog failure hides the
 * connect dock fail-soft — see useConnectorCatalog). Wire trouble mid-session
 * (5xx, stream errors) surfaces through the chrome's own error states; there
 * is NO fallback to scripted data here — that would fake a working agent.
 */
import type { VendoTheme } from "@vendoai/core";
import { createVendoClient, VendoProvider, type ToolMetaMap } from "@vendoai/ui";
import { VendoOverlay } from "@vendoai/ui/chrome";
import { useMemo } from "react";
import { useAutoSend } from "./scenario-mount.js";

export function LiveSurfaceMount({ apiBase, theme, tools, autoSend }: {
  apiBase: string;
  theme: VendoTheme;
  /** Provider tool meta derived from the profile (liveToolMeta in try-boot). */
  tools: ToolMetaMap;
  /** A pressed chip's prompt: typed into the REAL composer and submitted over
   *  the live wire (the same useAutoSend seam the scripted slot rides). */
  autoSend?: string;
}) {
  const client = useMemo(() => createVendoClient({ baseUrl: apiBase }), [apiBase]);
  useAutoSend(autoSend);
  // Mirrors the scripted slot's stances: no send → the default closed
  // launcher; a pressed chip needs a live composer, so the overlay opens.
  return (
    <VendoProvider client={client} theme={theme} tools={tools}>
      <VendoOverlay defaultOpen={autoSend !== undefined} />
    </VendoProvider>
  );
}
