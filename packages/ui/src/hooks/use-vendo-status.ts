/** Live guard posture probe (08-ui §3, §6). */
import { useEffect, useState } from "react";
import { useVendoContext } from "../context.js";
import type { Membership } from "@vendoai/core";
import type { GuardPosture } from "../wire-types.js";

export function useVendoStatus(): {
  posture: GuardPosture;
  connected: boolean;
  /** Build contract §9.1 — the orgs the host asserted for this caller, or []
      when the deployment is single-player. */
  memberships: Membership[];
} {
  const { client } = useVendoContext();
  const [state, setState] = useState<{ posture: GuardPosture; connected: boolean; memberships: Membership[] }>({
    posture: "unconfigured",
    connected: false,
    memberships: [],
  });

  useEffect(() => {
    let active = true;
    void client
      .status()
      .then(status => {
        if (active) setState({ posture: status.posture, connected: true, memberships: status.memberships ?? [] });
      })
      .catch(() => {
        if (active) setState({ posture: "unconfigured", connected: false, memberships: [] });
      });
    return () => {
      active = false;
    };
  }, [client]);

  return state;
}
