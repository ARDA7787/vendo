import { VendoError, type RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { appRoutes } from "./apps.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "./shared.js";

/**
 * Build contract §9.2–§9.4 — DELETE /apps/:appId/grants reads the grant list
 * back to answer, and that read is viewer-gated: removing your OWN last grant
 * legitimately loses you the right to read it. The masking is tolerated so a
 * removal that LANDED never reports failure — and nothing else is, which is what
 * these cases pin.
 *
 * The distinction matters on a Cloud-hosted store: `hosted-store.ts` carries a
 * misbehaving console's failure on a PLAIN Error with the server's code attached
 * (`Object.assign(new Error(message), { code })`), so matching on the code alone
 * would read "the console said not-found" as "the caller may no longer look".
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "kim" },
  venue: "app",
  presence: "present",
  sessionId: "s_kim",
};

const wireFor = (list: () => Promise<Array<{ id: string }>>): {
  wire: WireContext;
  revoked: string[];
} => {
  const revoked: string[] = [];
  const url = new URL("https://maple.test/api/vendo/apps/app_1/grants?principal=user%3Akim");
  const path = url.pathname.slice("/api/vendo".length);
  const deps = {
    apps: {
      access: {
        async revoke(_appId: string, principal: string) { revoked.push(principal); },
        list,
      },
    },
  } as unknown as WireDeps;
  return {
    revoked,
    wire: {
      request: new Request(url, { method: "DELETE" }),
      url,
      path,
      segments: routeSegments(path),
      params: {},
      context: async () => ctx,
      deps,
    },
  };
};

describe("§9.4 — what the DELETE read-back may forgive", () => {
  it("answers the successful removal with an empty list when the caller may no longer read it", async () => {
    // The genuine masking path: `can()` refuses, as a VendoError, because kim
    // removed her own last grant. The removal happened — say so.
    const { wire, revoked } = wireFor(async () => {
      throw new VendoError("not-found", "app not found: app_1");
    });
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ grants: [] });
    expect(revoked).toEqual(["user:kim"]);
  });

  it("forgives a `forbidden` mask the same way", async () => {
    const { wire } = wireFor(async () => {
      throw new VendoError("forbidden", "viewer access is required for app_1");
    });
    expect((await dispatchRoutes(appRoutes, wire))?.status).toBe(200);
  });

  it("SURFACES a plain Error carrying code not-found — a misbehaving hosted store is not a mask", async () => {
    // Exactly what hosted-store.ts throws when the console answers badly. It is
    // not §9.4 speaking, so it must not be read as one: the caller hears it.
    const { wire } = wireFor(async () => {
      throw Object.assign(new Error("Vendo Cloud store returned an invalid response"), {
        code: "not-found",
      });
    });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toThrow("Vendo Cloud store");
  });

  it("surfaces every other failure, masked-looking or not", async () => {
    for (const failure of [
      Object.assign(new Error("console said forbidden"), { code: "forbidden" }),
      Object.assign(new Error("store unavailable"), { code: "unavailable" }),
      new Error("bare"),
      new VendoError("validation", "nonsense"),
    ]) {
      const { wire } = wireFor(async () => { throw failure; });
      await expect(dispatchRoutes(appRoutes, wire)).rejects.toBe(failure);
    }
  });

  it("hands back the remaining grants when the caller can still read them", async () => {
    const { wire } = wireFor(async () => [{ id: "ag_1" }]);
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(await answer?.json()).toEqual({ grants: [{ id: "ag_1" }] });
  });
});
