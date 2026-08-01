import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appStore } from "./helpers/apps.js";
import { appFixture } from "./fixtures.test-util.js";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { workspaceStore } from "./workspace.js";

/** Build contract §9.5 — promote is the SECOND sanctioned door through 02-store
    §2's "rows never cross subjects" (the first is anon→signed-in adoption): the
    canonical app moves into the org, documents and history following. */

const dana: Principal = { kind: "user", subject: "dana" };

for (const backend of backends()) {
  describe(`${backend.name} build contract §9.5 — promote`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("flips the row subject to the org and rewrites the app's workspace paths", async () => {
      const app = "app_promoted";
      await appStore(made.store).put(dana, appFixture(app));
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(dana);
      await fs.writeFile(`/user/apps/${app}/app.vendo`, "page: v1");
      await fs.commit();
      // A second revision, so history has something to follow.
      const again = await workspace.open(dana);
      await again.writeFile(`/user/apps/${app}/app.vendo`, "page: v2");
      await again.commit();
      // A file that is NOT this app's must stay exactly where it is.
      const other = await workspace.open(dana);
      await other.writeFile("/user/memory/notes.md", "mine");
      await other.commit();

      await appStore(made.store).promote(app, "dana", "acme");
      await workspace.promoteApp(app, "dana", "acme");

      expect(await appStore(made.store).get(app)).toMatchObject({ subject: "acme" });
      expect(await made.sql(
        "SELECT path, owner FROM vendo_workspace_files ORDER BY path",
      )).toEqual([
        { path: "/orgs/acme/apps/app_promoted/app.vendo", owner: "acme" },
        { path: "/user/memory/notes.md", owner: "dana" },
      ]);
      // History follows, or undo would walk into rows nobody can reach.
      expect(await made.sql(
        "SELECT DISTINCT path, owner FROM vendo_workspace_history",
      )).toEqual([{ path: "/orgs/acme/apps/app_promoted/app.vendo", owner: "acme" }]);
    });

    it("refuses to promote a row that belongs to someone else", async () => {
      const app = "app_not_yours";
      await appStore(made.store).put(dana, appFixture(app));
      await expect(appStore(made.store).promote(app, "mal", "acme")).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await appStore(made.store).get(app)).toMatchObject({ subject: "dana" });
    });
  });
}
