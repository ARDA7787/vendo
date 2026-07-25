/**
 * Try-mode chrome (unified try surface, Task 8): the layout the surface wears
 * when the page carries a `window.__VENDO_TRY__` boot object — brand header,
 * the surface slot, the live depth indicator — all rendered from the try-boot
 * store. The slot's data source is decided per render by selectSurfaceMode
 * (Task 10): when the profile reports liveChat, the surface talks to the real
 * wire at the boot config's apiBase; otherwise the playground's scripted
 * scenario machinery, exactly as before.
 */
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme, type ToolMetaMap } from "@vendoai/ui";
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { TryProfile } from "../../try/profile.js";
import { ScenarioMount } from "./scenario-mount.js";
import { scenarios } from "./scenarios.js";
import { useGoogleFont } from "./theme-editor.js";
import { decodeThemeParam } from "./theme-state.js";
import {
  brandTitle,
  createTryBoot,
  depthLabel,
  liveToolMeta,
  selectSurfaceMode,
  usecaseChips,
  type TryBoot,
  type TryBootConfig,
  type TrySurfaceMode,
  type UsecaseChip,
} from "./try-boot.js";
import { TryChips, pressChip, type PressedChip } from "./try-chips.js";
import { TryRefine, refineEnabled } from "./try-refine.js";
import { LiveSurfaceMount } from "./try-surface-live.js";

/** The profile's theme through the SAME gate as the playground's `?theme=`
 *  (partials resolve over the shipped defaults, garbage is dropped). */
function profileTheme(profile: TryProfile | null): VendoTheme {
  const raw = profile?.theme;
  return (raw ? decodeThemeParam(JSON.stringify(raw)) : undefined) ?? defaultVendoTheme;
}

/** The ONE swappable surface slot. Live mode (profile reports liveChat) is
 *  the same overlay chrome on the REAL wire at `apiBase`; scripted mode is
 *  the scenario-mount machinery, unchanged. Both stances match: with no send
 *  it's the default closed launcher; a pressed chip needs a live composer, so
 *  the overlay opens with the chip's prompt as the auto-sent opening turn
 *  (the shared useAutoSend seam types it into the REAL composer and submits —
 *  one mount, one send, over whichever transport the mode wired). */
function TrySurface({ mode, apiBase, theme, tools, autoSend }: {
  mode: TrySurfaceMode;
  apiBase: string;
  theme: VendoTheme;
  tools: ToolMetaMap;
  autoSend?: string;
}) {
  const scenario = useMemo(() => {
    if (!autoSend) return scenarios[0]!;
    const open = scenarios.find((entry) => entry.id === "overlay-open") ?? scenarios[0]!;
    return { ...open, autoSend };
  }, [autoSend]);
  if (mode === "live") {
    return <LiveSurfaceMount apiBase={apiBase} theme={theme} tools={tools} autoSend={autoSend} />;
  }
  return <ScenarioMount scenario={scenario} theme={theme} />;
}

function TryApp({ boot }: { boot: TryBoot }) {
  const state = useSyncExternalStore(boot.subscribe, () => boot.state);
  const theme = profileTheme(state.profile);
  useGoogleFont(theme.typography.fontFamily);
  const label = depthLabel(state.profile, state.stages);
  const logoUrl = state.profile?.brand?.logoUrl ?? null;
  const chips = usecaseChips(state.profile);
  // Re-derived on every store update (liveChat happens to be fixed at server
  // startup today, but nothing here assumes that).
  const mode = selectSurfaceMode(state.profile);
  const tools = useMemo(() => liveToolMeta(state.profile), [state.profile]);

  // Unmount hygiene: the boot store dies with the app (this root lives for
  // the page today, but nothing should rely on that). Teardown-without-setup
  // is safe here: the CLI serves a production React bundle, so StrictMode's
  // dev-only effect double-invoke never fires this early.
  useEffect(() => () => boot.close(), [boot]);

  // The pressed chip drives the surface: each press remounts TrySurface (the
  // seq key) with the chip's prompt as its opening send — each press discards
  // the prior conversation (inherited contract; live mode too, where the
  // remount means a fresh thread over the real wire). The
  // double-send guard is pressChip's idempotence: re-pressing the active chip
  // returns the same reference, so no state change, no remount, no re-send.
  const [pressed, setPressed] = useState<PressedChip | null>(null);
  const onPick = (chip: UsecaseChip): void => {
    setPressed((current) => pressChip(current, chip));
  };

  // The page wears the profile theme edge to edge (the playground's stage
  // rule): the surface's own canvas never prints an abrupt rectangle.
  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.colors.background,
        color: theme.colors.text,
        fontFamily: theme.typography.fontFamily,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "14px 22px",
          borderBottom: `1px solid ${theme.colors.border}`,
        }}
      >
        {logoUrl ? (
          <img src={logoUrl} alt="" style={{ height: 22, width: "auto", display: "block" }} />
        ) : null}
        <span style={{ fontSize: 14, fontWeight: 650, letterSpacing: "-0.01em" }}>
          {brandTitle(state.profile)}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {label ? (
            <span style={{ fontSize: 12, color: theme.colors.muted }} aria-live="polite">
              {label}
            </span>
          ) : null}
          {/* Only rendered when the server reports the capability: a keyless
              run never shows a Refine affordance it couldn't honor. */}
          {refineEnabled(state.profile) ? <TryRefine theme={theme} /> : null}
        </div>
      </header>
      <main style={{ flex: 1, maxWidth: 900, width: "100%", margin: "0 auto", padding: "26px 22px 60px" }}>
        <TryChips
          chips={chips}
          activePrompt={pressed?.chip.prompt ?? null}
          onPick={onPick}
          theme={theme}
        />
        {/* Keyed by mode too: a mode flip (server-reported, never a client-
            side fallback) must remount onto the other data source cleanly. */}
        <TrySurface
          key={`${mode}:${pressed ? `chip-${pressed.seq}` : "default"}`}
          mode={mode}
          apiBase={boot.config.apiBase}
          theme={theme}
          tools={tools}
          autoSend={pressed?.chip.prompt}
        />
      </main>
    </div>
  );
}

/**
 * Boot try mode: block the FIRST render only on the initial profile load (the
 * server answers from disk — this is never an AI wait); a hard load failure
 * hands the page back to classic playground mode via `renderClassic`.
 */
export async function mountTryApp(
  rootElement: HTMLElement,
  config: TryBootConfig,
  renderClassic: () => void,
): Promise<void> {
  const boot = createTryBoot({
    config,
    fetchImpl: (url) => fetch(url),
    eventSourceFactory: (url) => new EventSource(url),
  });
  const { ok } = await boot.load();
  if (!ok) {
    boot.close();
    renderClassic();
    return;
  }
  createRoot(rootElement).render(
    <StrictMode>
      <TryApp boot={boot} />
    </StrictMode>,
  );
}
