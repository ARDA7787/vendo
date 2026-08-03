import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import { useVendoTheme } from "../context.js";
import { useVendoStatus } from "../hooks/use-vendo-status.js";
import { themeCssVariables } from "../theme.js";
import { PolicyNoticeBody } from "./policy-notice-body.js";

import { CHROME_CSS } from "./chrome-css.js";

/** Inject the chrome stylesheet once. Exported for surfaces that portal OUT of
    a ChromeRoot's DOM subtree (MorphToast, VendoToasts) and hand-roll their own
    `.vendo-root` theme boundary on document.body. */
export function ensureChromeStyles(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-vendo-chrome]")) return;
  const style = document.createElement("style");
  style.dataset.vendoChrome = "";
  style.textContent = CHROME_CSS;
  document.head.append(style);
}

const ChromeRootContext = createContext(false);

export function useChromeRootPresence(): boolean {
  return useContext(ChromeRootContext);
}

/**
 * The "running without a policy" banner is written for the host DEVELOPER (it
 * names a file to configure), so spec §16.3 — the consumer-voice guarantee —
 * bounds it to the developer-facing workspace surfaces: the Activity and
 * Automations panels, the stage, the page. Every CONSENT card passes
 * `automaticPolicyNotice={false}`: a card is the most end-user surface there is,
 * and this banner used to auto-prepend itself above one in any BYO host.
 */
function AutomaticPolicyNotice() {
  const { posture, connected } = useVendoStatus();
  return connected && posture === "unconfigured" ? <PolicyNoticeBody /> : null;
}

function ChromeBoundary({
  children,
  className,
  automaticPolicyNotice,
}: {
  children: ReactNode;
  className?: string;
  automaticPolicyNotice: boolean;
}) {
  const theme = useVendoTheme();
  useEffect(ensureChromeStyles, []);
  return (
    <ChromeRootContext.Provider value>
      <div
        className={["vendo-root", className].filter(Boolean).join(" ")}
        data-vendo-motion={theme.motion}
        data-vendo-density={theme.density}
        style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)", fontSize: "var(--vendo-font-size)" } as CSSProperties}
      >
        {automaticPolicyNotice ? <AutomaticPolicyNotice /> : null}
        {children}
      </div>
    </ChromeRootContext.Provider>
  );
}

/** 08-ui §4, §6 — one shared theme/style/notice boundary per chrome surface. */
export function ChromeRoot({
  children,
  className,
  automaticPolicyNotice = true,
}: {
  children: ReactNode;
  className?: string;
  automaticPolicyNotice?: boolean;
}) {
  const nested = useChromeRootPresence();
  if (nested) return <>{children}</>;
  return <ChromeBoundary className={className} automaticPolicyNotice={automaticPolicyNotice}>{children}</ChromeBoundary>;
}
