/**
 * Try-mode chrome (unified try surface, Task 8): the layout the surface wears
 * when the page carries a `window.__VENDO_TRY__` boot object — brand header,
 * the surface slot, the live depth indicator — all rendered from the try-boot
 * store. The slot keeps riding the playground's scenario-mount machinery on
 * the default scripted scenario for now; Tasks 9/10 swap TrySurface's data
 * source without touching the frame around it.
 */
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme } from "@vendoai/ui";
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
  usecaseChips,
  type TryBoot,
  type TryBootConfig,
  type UsecaseChip,
} from "./try-boot.js";
import { TryChips, pressChip, type PressedChip } from "./try-chips.js";

/** The profile's theme through the SAME gate as the playground's `?theme=`
 *  (partials resolve over the shipped defaults, garbage is dropped). */
function profileTheme(profile: TryProfile | null): VendoTheme {
  const raw = profile?.theme;
  return (raw ? decodeThemeParam(JSON.stringify(raw)) : undefined) ?? defaultVendoTheme;
}

/** The ONE swappable surface slot: today scripted scenarios on the
 *  scenario-mount machinery; Task 10 replaces this component's insides. With
 *  no send it's the default closed-launcher scenario; a pressed chip needs a
 *  live composer, so it rides the open-overlay scenario with the chip's
 *  prompt as the auto-sent opening turn (scenario-mount's useAutoSend types
 *  it into the REAL composer and submits — one mount, one send). */
function TrySurface({ theme, autoSend }: { theme: VendoTheme; autoSend?: string }) {
  const scenario = useMemo(() => {
    if (!autoSend) return scenarios[0]!;
    const open = scenarios.find((entry) => entry.id === "overlay-open") ?? scenarios[0]!;
    return { ...open, autoSend };
  }, [autoSend]);
  return <ScenarioMount scenario={scenario} theme={theme} />;
}

function TryApp({ boot }: { boot: TryBoot }) {
  const state = useSyncExternalStore(boot.subscribe, () => boot.state);
  const theme = profileTheme(state.profile);
  useGoogleFont(theme.typography.fontFamily);
  const label = depthLabel(state.profile, state.stages);
  const logoUrl = state.profile?.brand?.logoUrl ?? null;
  const chips = usecaseChips(state.profile);

  // Unmount hygiene: the boot store dies with the app (this root lives for
  // the page today, but nothing should rely on that). Teardown-without-setup
  // is safe here: the CLI serves a production React bundle, so StrictMode's
  // dev-only effect double-invoke never fires this early.
  useEffect(() => () => boot.close(), [boot]);

  // The pressed chip drives the surface: each press remounts TrySurface (the
  // seq key) with the chip's prompt as its opening send — each press discards
  // the prior conversation (Task 10's live transport inherits this). The
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
        {label ? (
          <span style={{ marginLeft: "auto", fontSize: 12, color: theme.colors.muted }} aria-live="polite">
            {label}
          </span>
        ) : null}
      </header>
      <main style={{ flex: 1, maxWidth: 900, width: "100%", margin: "0 auto", padding: "26px 22px 60px" }}>
        <TryChips
          chips={chips}
          activePrompt={pressed?.chip.prompt ?? null}
          onPick={onPick}
          theme={theme}
        />
        <TrySurface
          key={pressed ? `chip-${pressed.seq}` : "default"}
          theme={theme}
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
