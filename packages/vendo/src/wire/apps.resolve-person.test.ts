import { VendoError, type AccessLevel, type RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { appRoutes } from "./apps.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "./shared.js";

/**
 * Build contract §9.1 companion — POST /apps/:appId/grants/resolve, the Share
 * dialog's one question for the host: "who is this person I typed?".
 *
 * Two properties are load-bearing. It is OWNER-GATED, because an ungated
 * directory lookup is a user-enumeration oracle on the host's own tables. And
 * "not set up" and "nobody by that name" are DIFFERENT answers, because the
 * dialog says different things about them and one of them must never offer to
 * share with a person at all.
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "dana" },
  venue: "app",
  presence: "present",
  sessionId: "s_dana",
};

const resolveWire = (options: {
  level: AccessLevel | null;
  query?: unknown;
  resolvePerson?: (query: string) => Promise<{ subject: string; display?: string } | null>;
}): { wire: WireContext; asked: string[] } => {
  const asked: string[] = [];
  const url = new URL("https://maple.test/api/vendo/apps/app_1/grants/resolve");
  const path = url.pathname.slice("/api/vendo".length);
  const deps = {
    apps: { access: { async levelFor() { return options.level; } } },
    ...(options.resolvePerson === undefined ? {} : {
      resolvePerson: async (query: string) => {
        asked.push(query);
        return await options.resolvePerson!(query);
      },
    }),
  } as unknown as WireDeps;
  return {
    asked,
    wire: {
      request: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: options.query ?? "mia" }),
      }),
      url,
      path,
      segments: routeSegments(path),
      params: { appId: "app_1" },
      context: async () => ctx,
      deps,
    },
  };
};

const known = async (query: string): Promise<{ subject: string; display?: string } | null> =>
  query.includes("mia") ? { subject: "maple-mia", display: "Mia Nakamura" } : null;

describe("§9.1 companion — the host names the person, and only for an owner", () => {
  it("answers the host's own subject and display name, never the typed string", async () => {
    const { wire, asked } = resolveWire({ level: "owner", resolvePerson: known });
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ person: { subject: "maple-mia", display: "Mia Nakamura" } });
    expect(asked).toEqual(["mia"]);
  });

  it("answers `person: null` for a name the host does not know — a real answer, not a failure", async () => {
    const { wire } = resolveWire({ level: "owner", query: "someone else", resolvePerson: known });
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ person: null });
  });

  it("is not-implemented when the host wired no directory — distinct from `nobody by that name`", async () => {
    const { wire } = resolveWire({ level: "owner" });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "not-implemented" });
  });

  it("refuses a caller who is not an owner, and never asks the host", async () => {
    // Anyone who can look up people can enumerate the host's directory. Only
    // someone who could actually write the grant gets to ask.
    for (const level of ["viewer", "editor"] as const) {
      const { wire, asked } = resolveWire({ level, resolvePerson: known });
      await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "forbidden" });
      expect(asked).toEqual([]);
    }
  });

  it("masks the app for a caller who cannot even see it", async () => {
    const { wire, asked } = resolveWire({ level: null, resolvePerson: known });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "not-found" });
    expect(asked).toEqual([]);
  });

  it("refuses a query that is not a string", async () => {
    const { wire } = resolveWire({ level: "owner", query: 7, resolvePerson: known });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toBeInstanceOf(VendoError);
  });
});
