/**
 * Which process fires schedule/external triggers (field: linkwarden
 * 2026-08-09). Under the hosted store, Cloud is the firing authority — but
 * Cloud's scheduler cannot reach a DEVELOPMENT server (a localhost wire is in
 * no deployment inventory), so deferring to it armed schedules nobody would
 * ever fire: granted, enabled, "every 5 minutes", and thirty minutes of
 * silence. A dev process fires its own; the schedule-cursor claims are atomic
 * in the shared store, so a second firer can never double-run a tick.
 */
import { describe, expect, it } from "vitest";
import { localFiringKinds } from "./compose-automations.js";

describe("localFiringKinds — which process is the firing authority", () => {
  it("fires every kind on a self-hosted store (the engine's own default)", () => {
    expect(localFiringKinds({ hostedStoreComposed: false, automationsMounted: true, development: false }))
      .toBeUndefined();
    expect(localFiringKinds({ hostedStoreComposed: false, automationsMounted: true, development: true }))
      .toBeUndefined();
  });

  it("defers schedule/external to Cloud under the hosted store — deployed processes only", () => {
    expect(localFiringKinds({ hostedStoreComposed: true, automationsMounted: true, development: false }))
      .toEqual(new Set());
  });

  it("fires locally in DEVELOPMENT even under the hosted store — Cloud cannot reach a dev server", () => {
    expect(localFiringKinds({ hostedStoreComposed: true, automationsMounted: true, development: true }))
      .toBeUndefined();
  });

  it("never fires anything when the host unmounted automations, whatever the store or mode", () => {
    for (const hostedStoreComposed of [true, false]) {
      for (const development of [true, false]) {
        expect(localFiringKinds({ hostedStoreComposed, automationsMounted: false, development }))
          .toEqual(new Set());
      }
    }
  });
});
