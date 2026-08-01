import { VendoError, type Membership, type RunContext } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appAccess } from "./helpers/app-access.js";
import { appStore } from "./helpers/apps.js";
import { appFixture } from "./fixtures.test-util.js";
import { backends, type MadeBackend } from "./backends.test-util.js";

/** Build contract §9.2–§9.4 — grants are the only rows Vendo stores, and
    `can()` is the one function every door reaches. */

const doc = appFixture;

const ctxFor = (subject: string, memberships?: Membership[]): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
  ...(memberships === undefined ? {} : { memberships }),
});

for (const backend of backends()) {
  describe(`${backend.name} build contract §9 — app access`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const access = (): ReturnType<typeof appAccess> => appAccess(made.store);

    it("gives the row's subject owner without any grant row", async () => {
      const app = "app_owned";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      expect(await access().levelFor(ctxFor("dana"), app)).toBe("owner");
      expect(await access().can(ctxFor("dana"), "owner", { app })).toBe(true);
      // A stranger sees nothing at all.
      expect(await access().levelFor(ctxFor("mal"), app)).toBeNull();
      expect(await access().can(ctxFor("mal"), "viewer", { app })).toBe(false);
    });

    it("makes an org admin an implicit owner of an org-owned app", async () => {
      const app = "app_org_admin";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const admin = ctxFor("dana", [{ org: "acme", admin: true }]);
      const member = ctxFor("kim", [{ org: "acme" }]);
      expect(await access().levelFor(admin, app)).toBe("owner");
      // Membership alone is NOT access — the grant rows decide.
      expect(await access().levelFor(member, app)).toBeNull();
    });

    it("resolves user / team / org grants against the asserted memberships", async () => {
      const app = "app_grants";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
      await access().grant(owner, app, "user:kim", "viewer");
      await access().grant(owner, app, "team:acme/finance", "editor");
      await access().grant(owner, app, "org:acme", "viewer");

      // Direct user grant.
      expect(await access().levelFor(ctxFor("kim"), app)).toBe("viewer");
      // Effective access is the MAX of the matching grants: kim in finance is
      // an editor through the team even though her own row says viewer.
      expect(await access().levelFor(
        ctxFor("kim", [{ org: "acme", teams: ["finance"] }]),
        app,
      )).toBe("editor");
      // Org-wide grant reaches any asserted member.
      expect(await access().levelFor(ctxFor("sam", [{ org: "acme" }]), app)).toBe("viewer");
      // A team grant in a DIFFERENT org never matches.
      expect(await access().levelFor(
        ctxFor("sam", [{ org: "other", teams: ["finance"] }]),
        app,
      )).toBeNull();
    });

    it("re-granting one principal updates the level in place", async () => {
      const app = "app_regrant";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      const owner = ctxFor("dana");
      await access().grant(owner, app, "user:kim", "viewer");
      await access().grant(owner, app, "user:kim", "editor");
      const rows = await access().list(owner, app);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe("editor");
      expect(rows[0]?.createdBy).toBe("dana");
      expect(await access().levelFor(ctxFor("kim"), app)).toBe("editor");
    });

    it("revoke removes the grant and access with it", async () => {
      const app = "app_revoke";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      const owner = ctxFor("dana");
      await access().grant(owner, app, "user:kim", "editor");
      expect(await access().can(ctxFor("kim"), "editor", { app })).toBe(true);
      await access().revoke(owner, app, "user:kim");
      expect(await access().levelFor(ctxFor("kim"), app)).toBeNull();
      expect(await access().list(owner, app)).toEqual([]);
    });

    // §9.4 posture, and the red half of the permission gate: these MUST fail.
    it("refuses grant/revoke to a non-owner and list to a non-viewer", async () => {
      const app = "app_posture";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      await access().grant(ctxFor("dana"), app, "user:kim", "editor");

      // An editor provably SEES the app, so denial is `forbidden`.
      await expect(access().grant(ctxFor("kim"), app, "user:mal", "viewer"))
        .rejects.toMatchObject({ code: "forbidden" });
      await expect(access().revoke(ctxFor("kim"), app, "user:mal"))
        .rejects.toMatchObject({ code: "forbidden" });
      // A stranger cannot even see it — existence stays masked.
      await expect(access().grant(ctxFor("mal"), app, "user:mal", "owner"))
        .rejects.toMatchObject({ code: "not-found" });
      await expect(access().list(ctxFor("mal"), app))
        .rejects.toMatchObject({ code: "not-found" });
      // ...and a viewer may read the grant list.
      expect(await access().list(ctxFor("kim"), app)).toHaveLength(1);
    });

    it("refuses an unknown grant principal encoding", async () => {
      const app = "app_encoding";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      await expect(access().grant(ctxFor("dana"), app, "kim", "viewer"))
        .rejects.toBeInstanceOf(VendoError);
      await expect(access().grant(ctxFor("dana"), app, "group:x", "viewer"))
        .rejects.toBeInstanceOf(VendoError);
    });

    describe("path access (§9.3)", () => {
      it("keeps /user/** the caller's own, at every level", async () => {
        const ctx = ctxFor("dana");
        expect(await access().can(ctx, "owner", { path: "/user/apps/app_1/app.vendo" })).toBe(true);
        expect(await access().can(ctx, "viewer", { path: "/user/memory/notes.md" })).toBe(true);
      });

      it("requires an asserted membership for /orgs/<org>/**", async () => {
        const member = ctxFor("dana", [{ org: "acme" }]);
        expect(await access().can(member, "editor", { path: "/orgs/acme/files/x" })).toBe(true);
        expect(await access().can(ctxFor("dana"), "viewer", { path: "/orgs/acme/files/x" })).toBe(false);
        expect(await access().can(member, "viewer", { path: "/orgs/other/files/x" })).toBe(false);
      });

      it("lets the app grant govern under /orgs/<org>/apps/<appId>/", async () => {
        const app = "app_pathed";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
        const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
        await access().grant(owner, app, "user:kim", "viewer");
        const viewer = ctxFor("kim", [{ org: "acme" }]);
        const path = `/orgs/acme/apps/${app}/app.vendo`;
        expect(await access().can(viewer, "viewer", { path })).toBe(true);
        expect(await access().can(viewer, "editor", { path })).toBe(false);
        // A member with no grant on the app cannot see the app's subtree at all.
        expect(await access().can(ctxFor("sam", [{ org: "acme" }]), "viewer", { path })).toBe(false);
      });

      it("reserves /orgs/<org>/policy.json writes for org admins", async () => {
        const path = "/orgs/acme/policy.json";
        const admin = ctxFor("dana", [{ org: "acme", admin: true }]);
        const member = ctxFor("kim", [{ org: "acme" }]);
        expect(await access().can(member, "viewer", { path })).toBe(true);
        expect(await access().can(member, "editor", { path })).toBe(false);
        expect(await access().can(admin, "editor", { path })).toBe(true);
      });

      it("refuses a path outside the frozen mounts", async () => {
        expect(await access().can(ctxFor("dana"), "viewer", { path: "/etc/passwd" })).toBe(false);
        expect(await access().can(ctxFor("dana"), "viewer", { path: "/orgs" })).toBe(false);
      });
    });
  });
}
