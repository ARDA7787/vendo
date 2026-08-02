// @vitest-environment jsdom
// Build contract §9.5 — "share implies promote", and it promotes into the org
// the CHOSEN principal names. The dialog is the only surface that writes grants,
// so a wrong org here silently hands an app to the wrong team.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccessLevel } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, type VendoClient } from "../../src/index.js";
import { ShareDialog } from "../../src/chrome/index.js";

afterEach(cleanup);

const memberships = [
  { org: "acme", display: "Acme" },
  { org: "other", display: "Other Co", teams: ["finance"] },
];

function fakeClient(personal: boolean) {
  const calls: Array<{ verb: string; args: unknown[] }> = [];
  const client = {
    async status() { return { posture: "unconfigured", memberships }; },
    apps: {
      async grants() {
        calls.push({ verb: "grants", args: [] });
        return { level: "owner" as AccessLevel, grants: [], personal };
      },
      async promote(id: string, orgId: string) {
        calls.push({ verb: "promote", args: [id, orgId] });
        return {};
      },
      async share(id: string, principal: string, level: AccessLevel) {
        calls.push({ verb: "share", args: [id, principal, level] });
        return { grants: [] };
      },
      async unshare() { return { grants: [] }; },
    },
  } as unknown as VendoClient;
  return { client, calls };
}

const shareWith = async (principal: string) => {
  const input = await screen.findByLabelText("Who to share with");
  fireEvent.change(input, { target: { value: principal } });
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
};

describe("ShareDialog — share implies promote", () => {
  it("promotes into the org the chosen principal names, not the first one", async () => {
    const { client, calls } = fakeClient(true);
    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_1" appName="Dash" memberships={memberships} />
      </VendoProvider>,
    );
    await shareWith("team:other/finance");

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "promote", args: ["app_1", "other"] },
      { verb: "share", args: ["app_1", "team:other/finance", "viewer"] },
    ]);
  });

  it("does not promote an app that already lives in an org", async () => {
    const { client, calls } = fakeClient(false);
    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_2" memberships={memberships} />
      </VendoProvider>,
    );
    await shareWith("org:acme");

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.some((call) => call.verb === "promote")).toBe(false);
  });

  it("says plainly that moving the app turns its automation off", async () => {
    // Promote DISARMS an automation: it runs with a person's access, and the
    // person who armed it may not be in the team.
    const { client } = fakeClient(true);
    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_3" memberships={memberships} automation />
      </VendoProvider>,
    );
    const note = await screen.findByText(/automations run with a person’s access/i);
    expect(note.textContent).toMatch(/off until someone turns it back on/i);
  });
});
