// @vitest-environment jsdom
// Build contract §9.5 — "share implies promote", and it promotes into the org
// the CHOSEN principal names. The dialog is the only surface that writes grants,
// so a wrong org here silently hands an app to the wrong team.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AccessLevel } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { encodeGrantPrincipal as coreEncode } from "@vendoai/core";
import { VendoProvider, type VendoClient } from "../../src/index.js";
import { ShareDialog, encodeGrantPrincipal as chromeEncode } from "../../src/chrome/index.js";

afterEach(cleanup);

const memberships = [
  { org: "acme", display: "Acme" },
  { org: "other", display: "Other Co", teams: ["finance"] },
];

interface FakeOptions {
  personal: boolean;
  memberships?: Array<{ org: string; display?: string; teams?: string[] }>;
  /** Throw from `promote` (F2's reachable-through-share developer sentence). */
  promoteFails?: unknown;
  /** Throw from `share` (F1's keyless-deployment refusal). */
  shareFails?: unknown;
}

function fakeClient(options: FakeOptions) {
  const calls: Array<{ verb: string; args: unknown[] }> = [];
  const client = {
    async status() { return { posture: "unconfigured", memberships: options.memberships ?? memberships }; },
    apps: {
      async grants() {
        calls.push({ verb: "grants", args: [] });
        return { level: "owner" as AccessLevel, grants: [], personal: options.personal };
      },
      async promote(id: string, orgId: string) {
        calls.push({ verb: "promote", args: [id, orgId] });
        if (options.promoteFails !== undefined) throw options.promoteFails;
        return {};
      },
      async share(id: string, principal: string, level: AccessLevel) {
        calls.push({ verb: "share", args: [id, principal, level] });
        if (options.shareFails !== undefined) throw options.shareFails;
        return { grants: [] };
      },
      async unshare() { return { grants: [] }; },
    },
  } as unknown as VendoClient;
  return { client, calls };
}

/** Pick a principal the way a person does: by its human label. The encoding
    rides underneath, where nobody has to read it. */
const choose = async (label: string | RegExp): Promise<void> => {
  const picker = await screen.findByLabelText("Who to share with");
  const option = within(picker).getByRole("option", { name: label }) as HTMLOptionElement;
  fireEvent.change(picker, { target: { value: option.value } });
};

const clickShare = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
};

const shareWith = async (label: string | RegExp): Promise<void> => {
  await choose(label);
  clickShare();
};

const mount = (options: FakeOptions, props: Record<string, unknown> = {}): {
  calls: Array<{ verb: string; args: unknown[] }>;
} => {
  const { client, calls } = fakeClient(options);
  render(
    <VendoProvider client={client}>
      <ShareDialog appId="app_1" appName="Dash" memberships={options.memberships ?? memberships} {...props} />
    </VendoProvider>,
  );
  return { calls };
};

describe("the §9.2 grammar has ONE encoder", () => {
  it("re-exports core's, rather than keeping a second copy in the chrome", () => {
    // Two encoders of a frozen encoding is exactly the duplication the
    // conformance round removed everywhere else.
    expect(chromeEncode).toBe(coreEncode);
  });

  it("still encodes all three principal shapes", () => {
    expect(chromeEncode({ kind: "user", subject: "kim" })).toBe("user:kim");
    expect(chromeEncode({ kind: "org", org: "acme" })).toBe("org:acme");
    expect(chromeEncode({ kind: "team", org: "acme", team: "finance" })).toBe("team:acme/finance");
  });
});

describe("ShareDialog — the first read", () => {
  it("says nothing about access while the first grants read is still in flight", async () => {
    // "You don't have access to this app." is what a level of `null` means, and
    // `null` is also what the hook holds before the first answer arrives — so
    // the dialog used to open by telling everyone they had no access.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      async status() { return { posture: "unconfigured", memberships }; },
      apps: {
        async grants() {
          await gate;
          return { level: "owner" as AccessLevel, grants: [], personal: true };
        },
        async promote() { return {}; },
        async share() { return { grants: [] }; },
        async unshare() { return { grants: [] }; },
      },
    } as unknown as VendoClient;

    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_slow" memberships={memberships} />
      </VendoProvider>,
    );
    expect(screen.queryByText(/have access to this app/i)).toBeNull();

    release();
    // ...and once the answer lands, the owner gets the share controls.
    expect(await screen.findByLabelText("Who to share with")).toBeTruthy();
    expect(screen.queryByText(/have access to this app/i)).toBeNull();
  });
});

describe("ShareDialog — share implies promote", () => {
  it("promotes into the org the chosen principal names, not the first one", async () => {
    const { calls } = mount({ personal: true });
    await shareWith("The finance team");

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "promote", args: ["app_1", "other"] },
      { verb: "share", args: ["app_1", "team:other/finance", "viewer"] },
    ]);
  });

  it("does not promote an app that already lives in an org", async () => {
    const { calls } = mount({ personal: false });
    await shareWith("Everyone at Acme");

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.some((call) => call.verb === "promote")).toBe(false);
  });

  it("says plainly that moving the app turns its automation off", async () => {
    // Promote DISARMS an automation: it runs with a person's access, and the
    // person who armed it may not be in the team.
    mount({ personal: true }, { automation: true });
    const note = await screen.findByText(/automations run with a person’s access/i);
    expect(note.textContent).toMatch(/off until someone turns it back on/i);
  });
});

/**
 * F6 — "Live sharing implies the org workspace" (design §8), ruled 2026-08-01 to
 * hold for EVERY principal. Sharing a personal app with a PERSON never promoted,
 * so the files stayed in the owner's `/user` mount and the grantee's agent opened
 * an empty directory.
 */
describe("ShareDialog — sharing with a person also promotes", () => {
  const soleOrg = [{ org: "acme", display: "Acme" }];

  it("promotes into the ONE asserted org, then grants", async () => {
    const { calls } = mount({ personal: true, memberships: soleOrg });
    await choose(/specific person/i);
    fireEvent.change(await screen.findByLabelText("Their name or email at work"), {
      target: { value: "mia@acme.test" },
    });
    clickShare();

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "promote", args: ["app_1", "acme"] },
      { verb: "share", args: ["app_1", "user:mia@acme.test", "viewer"] },
    ]);
  });

  it("ASKS which team when there are several — never silently the first", async () => {
    const { calls } = mount({ personal: true });
    await choose(/specific person/i);
    fireEvent.change(await screen.findByLabelText("Their name or email at work"), {
      target: { value: "mia" },
    });
    clickShare();

    // Nothing moved and nothing was granted: the dialog is waiting to be told
    // which team the app should live in.
    const orgPicker = await screen.findByLabelText("Which team to move it into");
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([]);

    // Once she says, both halves run against the org SHE chose.
    fireEvent.change(orgPicker, { target: { value: "other" } });
    clickShare();
    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "promote", args: ["app_1", "other"] },
      { verb: "share", args: ["app_1", "user:mia", "viewer"] },
    ]);
  });

  it("refuses in consumer voice and offers a copy when there is no team at all", async () => {
    // The spec's own fallback: "To hand someone a copy instead, fork."
    const { calls } = mount({ personal: true, memberships: [] });
    const note = await screen.findByText(/hand someone a copy/i);
    expect(note.textContent).not.toMatch(/promote|grant|fork\(|org:/);
    // ...and there is no way to write a grant that could never work.
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([]);
  });
});

/**
 * F12 — the picker exposed the raw grant grammar, promised a "Person" option
 * that did not exist, and turned an unparseable principal into a grant row that
 * could never match.
 */
describe("ShareDialog — the picker speaks human", () => {
  it("never shows the encoding, only what each principal IS", async () => {
    mount({ personal: false });
    const picker = await screen.findByLabelText("Who to share with");
    const labels = within(picker).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(labels.some((label) => /team:|org:|user:|\//.test(label))).toBe(false);
    expect(labels).toContain("The finance team");
    expect(labels).toContain("Everyone at Acme");
    // The promise the old placeholder made, now kept.
    expect(labels.some((label) => /specific person/i.test(label))).toBe(true);
  });

  it("refuses an empty person in consumer voice instead of writing a dead grant row", async () => {
    const { calls } = mount({ personal: false });
    await choose(/specific person/i);
    fireEvent.change(await screen.findByLabelText("Their name or email at work"), {
      target: { value: "   " },
    });
    clickShare();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/who/i);
    expect(alert.textContent).not.toMatch(/user:|principal|encoding/);
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });
});

/**
 * F1 + F2 — the wire's sentences are written for the HOST DEVELOPER: one names
 * an environment variable, the other is a TypeScript snippet. Both reached a
 * bank customer's screen verbatim, on every keyless (default OSS) deployment.
 */
describe("ShareDialog — refusals in the consumer's voice", () => {
  const cloudRequired = (message: string): Error =>
    Object.assign(new Error(message), { code: "cloud-required" });

  it("renders a consumer sentence for a keyless deployment, never the env var", async () => {
    const { calls } = mount({
      personal: false,
      shareFails: cloudRequired(
        "sharing needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store)"
        + " — apps you own alone keep working without it",
      ),
    });
    await shareWith("Everyone at Acme");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/VENDO_API_KEY|hosted store|Vendo Cloud/);
    expect(alert.textContent).toMatch(/isn’t turned on/i);
    expect(calls.some((call) => call.verb === "share")).toBe(true);
  });

  it("renders a consumer sentence when the MOVE is refused, never the code snippet", async () => {
    const { calls } = mount({
      personal: true,
      promoteFails: cloudRequired(
        "moving an app into a team workspace isn't available on the hosted store yet — "
        + "wire your own Postgres with createVendo({ store: createStore({ url }) }) to move it, "
        + "or share a copy with fork instead",
      ),
    });
    await shareWith("Everyone at Acme");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/createVendo|createStore|Postgres|hosted store/);
    expect(alert.textContent).toMatch(/copy/i);
    // The move failed, so no grant was written on top of it.
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });

  it("keeps a viewer's own refusal consumer-voiced too", async () => {
    mount({
      personal: false,
      shareFails: Object.assign(new Error("owner access is required for app_7c2f9b"), { code: "forbidden" }),
    });
    await shareWith("Everyone at Acme");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/app_7c2f9b|access is required/);
    expect(alert.textContent).toMatch(/owner/i);
  });
});
