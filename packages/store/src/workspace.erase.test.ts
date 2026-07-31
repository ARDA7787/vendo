import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { eraseStore } from "./erase.js";
import { adoptEphemeralSubject } from "./helpers/subjects.js";
import { registerEphemeralSubject } from "./sessions.js";
import { WORKSPACE_INLINE_MAX_BYTES, workspaceStore } from "./workspace.js";

// Build contract §3.3: "Both join ERASE_TABLES and the anon→signed-in adoption
// path, keyed on `owner`." These tests are that sentence, run against both
// tables AND the blobs the store-backed files adapter holds for them.

const seed = async (
  store: MadeBackend["store"],
  principal: Principal,
  path: string,
  revisions: string[],
): Promise<void> => {
  const workspace = workspaceStore(store);
  for (const content of revisions) {
    const fs = await workspace.open(principal);
    await fs.writeFile(path, content);
    await fs.commit({ message: `wrote ${path}` });
  }
};

for (const backend of backends()) {
  describe(`${backend.name} workspace erase + adoption`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const count = async (table: string, where: string, params: unknown[]): Promise<number> => {
      const rows = await made.sql(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
      return Number(rows[0]?.["count"]);
    };

    it("cascades a subject's workspace files, history and blobs, and spares everyone else", async () => {
      const erased: Principal = { kind: "user", subject: "user_ws_erased" };
      const bystander: Principal = { kind: "user", subject: "user_ws_kept" };
      // Two revisions each, so history is non-empty; one file past the inline
      // cap, so a blob exists to strand if the cascade misses it.
      await seed(made.store, erased, "/user/apps/app_e/app.vendo", ["v1", "v2"]);
      await seed(made.store, erased, "/user/files/big.txt", [
        "x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1),
        "y".repeat(WORKSPACE_INLINE_MAX_BYTES + 1),
      ]);
      await seed(made.store, bystander, "/user/apps/app_k/app.vendo", ["theirs", "theirs again"]);

      expect(await count("vendo_workspace_files", "owner = $1", [erased.subject])).toBe(2);
      expect(await count("vendo_workspace_history", "owner = $1", [erased.subject])).toBe(2);
      expect(await count("vendo_blobs", "namespace = 'workspace'", [])).toBeGreaterThan(0);

      const report = await eraseStore(made.store).bySubject(erased.subject);
      expect(report.vendo_workspace_files).toBe(2);
      expect(report.vendo_workspace_history).toBe(2);
      // The over-cap file's live blob and its superseded one both go.
      expect(report.vendo_blobs).toBe(2);

      expect(await count("vendo_workspace_files", "owner = $1", [erased.subject])).toBe(0);
      expect(await count("vendo_workspace_history", "owner = $1", [erased.subject])).toBe(0);
      expect(await count("vendo_blobs", "namespace = 'workspace'", [])).toBe(0);

      // The bystander keeps their files and their history.
      expect(await count("vendo_workspace_files", "owner = $1", [bystander.subject])).toBe(1);
      expect(await count("vendo_workspace_history", "owner = $1", [bystander.subject])).toBe(1);
    });

    it("erases an app's workspace documents with the app, whoever's workspace holds them", async () => {
      const owner: Principal = { kind: "user", subject: "user_ws_by_app" };
      await seed(made.store, owner, "/user/apps/app_drop/app.vendo", ["drop me", "still drop me"]);
      await seed(made.store, owner, "/user/apps/app_keep/app.vendo", ["keep me"]);

      const report = await eraseStore(made.store).byApp("app_drop");
      expect(report.vendo_workspace_files).toBe(1);
      expect(report.vendo_workspace_history).toBe(1);

      expect(await count("vendo_workspace_files", "path LIKE '/user/apps/app_drop/%'", [])).toBe(0);
      expect(await count("vendo_workspace_files", "path LIKE '/user/apps/app_keep/%'", [])).toBe(1);
    });

    it("adopts an anonymous session's workspace into the signed-in subject", async () => {
      const anon: Principal = { kind: "user", subject: "anon_ws_adopt", ephemeral: true };
      const signedIn: Principal = { kind: "user", subject: "user_ws_adopter" };
      await registerEphemeralSubject(made.store, anon.subject);
      await seed(made.store, anon, "/user/apps/app_anon/app.vendo", ["made while anonymous", "then edited"]);

      const report = await adoptEphemeralSubject(made.store, anon.subject, signedIn.subject);
      expect(report?.files).toBe(1);

      // The signed-in subject opens the workspace and finds their own work.
      const fs = await workspaceStore(made.store).open(signedIn);
      expect(await fs.readFile("/user/apps/app_anon/app.vendo")).toBe("then edited");
      // History travelled with the file, so undo still works after signing in.
      const undone = await workspaceStore(made.store).undo(signedIn, "/user/apps/app_anon/app.vendo");
      expect(undone).toEqual({ status: "ok", revision: 3 });
      expect(await (await workspaceStore(made.store).open(signedIn))
        .readFile("/user/apps/app_anon/app.vendo")).toBe("made while anonymous");

      expect(await count("vendo_workspace_files", "owner = $1", [anon.subject])).toBe(0);
    });

    it("never lets an adopted file overwrite one the signed-in subject already owns", async () => {
      const anon: Principal = { kind: "user", subject: "anon_ws_collide", ephemeral: true };
      const signedIn: Principal = { kind: "user", subject: "user_ws_collider" };
      const path = "/user/memory/notes.md";
      await registerEphemeralSubject(made.store, anon.subject);
      await seed(made.store, anon, path, ["anonymous notes"]);
      await seed(made.store, signedIn, path, ["my real notes"]);

      const report = await adoptEphemeralSubject(made.store, anon.subject, signedIn.subject);
      expect(report?.files).toBe(0);
      expect(report?.skipped).toBeGreaterThan(0);

      const fs = await workspaceStore(made.store).open(signedIn);
      expect(await fs.readFile(path)).toBe("my real notes");
      expect(await count("vendo_workspace_files", "owner = $1", [anon.subject])).toBe(0);
      expect(await count("vendo_workspace_history", "owner = $1", [anon.subject])).toBe(0);
    });
  });
}
