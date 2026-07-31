import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { FILES_STORE_MAX_BYTES } from "./files-store.js";
import { workspaceStore, WORKSPACE_HISTORY_LIMIT, WORKSPACE_INLINE_MAX_BYTES } from "./workspace.js";

const user: Principal = { kind: "user", subject: "user_ws" };
const APP = "/user/apps/app_1/app.vendo";

for (const backend of backends()) {
  describe(`${backend.name} build contract §3 — the workspace façade`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const rowsFor = async (path: string): Promise<Record<string, unknown>[]> =>
      await made.sql(
        "SELECT content, blob_ref, bytes, revision FROM vendo_workspace_files WHERE path = $1",
        [path],
      );

    it("commits a written file into the store and reads it back next turn", async () => {
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(APP, "page: hello");
      const commit = await first.commit({ message: "made a page" });

      expect(commit).toEqual({ status: "ok", changed: [APP] });

      // A different façade instance — the next turn's harness — sees it.
      const next = await workspace.open(user);
      expect(await next.readFile(APP)).toBe("page: hello");

      expect(await rowsFor(APP)).toEqual([
        { content: "page: hello", blob_ref: null, bytes: 11, revision: 1 },
      ]);
    });

    it("stages writes until commit, so a turn that never commits leaves no row", async () => {
      const path = "/user/memory/uncommitted.md";
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile(path, "thinking out loud");
      // Visible to the turn...
      expect(await fs.readFile(path)).toBe("thinking out loud");
      // ...and absent from the store.
      expect(await rowsFor(path)).toEqual([]);
    });

    it("writes one row per changed file however many times the turn edits it", async () => {
      // The store write law (design §8): O(files changed), never O(writes).
      const path = "/user/apps/app_2/plan.vendo";
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      await fs.writeFile(path, "draft 0");
      await fs.commit();

      const editing = await workspace.open(user);
      for (let edit = 1; edit <= 40; edit += 1) await editing.writeFile(path, `draft ${edit}`);
      const commit = await editing.commit({ message: "rewrote the plan" });

      expect(commit).toEqual({ status: "ok", changed: [path] });
      // 41 writes, one revision bump, one history row — not 41 of either.
      expect(await rowsFor(path)).toEqual([
        { content: "draft 40", blob_ref: null, bytes: 8, revision: 2 },
      ]);
      const history = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_workspace_history WHERE path = $1",
        [path],
      );
      expect(Number(history[0]?.["count"])).toBe(1);
    });

    it("skips a commit whose bytes did not change", async () => {
      const path = "/user/memory/same.md";
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(path, "unchanged");
      await first.commit();

      const second = await workspace.open(user);
      await second.writeFile(path, "unchanged");
      expect(await second.commit()).toEqual({ status: "ok", changed: [] });
      expect(await rowsFor(path)).toEqual([
        { content: "unchanged", blob_ref: null, bytes: 9, revision: 1 },
      ]);
    });

    it("records prior content and the consumer-voice intent in history, and undo walks it back", async () => {
      const path = "/user/apps/app_3/app.vendo";
      const workspace = workspaceStore(made.store);
      for (const [colour, intent] of [
        ["red", "made the chart red"],
        ["blue", "made the chart blue"],
        ["green", "made the chart green"],
      ] as const) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, `chart: ${colour}`);
        await fs.commit({ message: intent });
      }

      const history = await workspace.history(user, path);
      expect(history.map((entry) => [entry.revision, entry.intent])).toEqual([
        [2, "made the chart green"],
        [1, "made the chart blue"],
      ]);

      const reader = async (): Promise<string> =>
        await (await workspace.open(user)).readFile(path);
      expect(await reader()).toBe("chart: green");

      // Each undo walks one step further back, never toggling between two.
      expect(await workspace.undo(user, path)).toEqual({ status: "ok", revision: 4 });
      expect(await reader()).toBe("chart: blue");
      expect(await workspace.undo(user, path)).toEqual({ status: "ok", revision: 5 });
      expect(await reader()).toBe("chart: red");
      // Nothing left to undo.
      expect(await workspace.undo(user, path)).toEqual({ status: "empty" });
      expect(await reader()).toBe("chart: red");
    });

    it("keeps /host read-only for everyone and readable by all of them", async () => {
      const skill = "/host/skills/charting/SKILL.md";
      const fs = await workspaceStore(made.store).open(user, {
        host: { [skill]: "# Charting\nUse a bar chart for counts." },
      });

      expect(await fs.readFile(skill)).toContain("bar chart");
      expect(await fs.readdir("/host/skills")).toEqual(["charting"]);
      await expect(fs.writeFile(skill, "mine now")).rejects.toThrow(/EROFS: read-only file system/);
      await expect(fs.rm(skill)).rejects.toThrow(/EROFS: read-only file system/);
      expect(await rowsFor(skill)).toEqual([]);
    });

    it("never commits /user/scratch, though the turn reads and writes it freely", async () => {
      const scratch = "/user/scratch/notes.txt";
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile(scratch, "intra-turn junk");
      await fs.writeFile("/user/files/keep.txt", "kept");
      expect(await fs.readFile(scratch)).toBe("intra-turn junk");

      expect(await fs.commit()).toEqual({ status: "ok", changed: ["/user/files/keep.txt"] });
      expect(await rowsFor(scratch)).toEqual([]);
    });

    it("commits a delete, and the deleted path is gone next turn", async () => {
      const path = "/user/files/temporary.txt";
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(path, "here");
      await first.commit();

      const second = await workspace.open(user);
      await second.rm(path);
      expect(await second.commit()).toEqual({ status: "ok", changed: [path] });
      expect(await rowsFor(path)).toEqual([]);

      const third = await workspace.open(user);
      expect(await third.exists(path)).toBe(false);
    });

    it("keeps one subject's files out of another's workspace", async () => {
      const other: Principal = { kind: "user", subject: "user_ws_other" };
      const path = "/user/memory/private.md";
      const workspace = workspaceStore(made.store);
      const mine = await workspace.open(user);
      await mine.writeFile(path, "mine only");
      await mine.commit();

      const theirs = await workspace.open(other);
      expect(await theirs.exists(path)).toBe(false);
      expect(theirs.getAllPaths()).not.toContain(path);
    });

    it("sends a file past the inline cap to the files adapter, byte for byte", async () => {
      const path = "/user/files/big.txt";
      const big = "x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      await fs.writeFile(path, big);
      await fs.commit();

      const row = (await rowsFor(path))[0];
      expect(row?.["content"]).toBeNull();
      expect(row?.["blob_ref"]).toMatch(/^wsb_[0-9a-f-]{36}$/);
      expect(Number(row?.["bytes"])).toBe(WORKSPACE_INLINE_MAX_BYTES + 1);
      expect(await (await workspace.open(user)).readFile(path)).toBe(big);
    });

    it("sends bytes that are not text to the files adapter whatever their size", async () => {
      const path = "/user/files/tiny.png";
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      await fs.writeFile(path, bytes);
      await fs.commit();

      const row = (await rowsFor(path))[0];
      expect(row?.["content"]).toBeNull();
      expect(row?.["blob_ref"]).toMatch(/^wsb_[0-9a-f-]{36}$/);
      expect(await (await workspace.open(user)).readFileBuffer(path)).toEqual(bytes);
    });

    it("puts over-cap bytes in a wired files adapter instead of the store", async () => {
      const held = new Map<string, Uint8Array>();
      const files = {
        async put(key: string, bytes: Uint8Array) { held.set(key, bytes); },
        async get(key: string) {
          const bytes = held.get(key);
          return bytes === undefined ? undefined : { bytes };
        },
        async delete(key: string) { held.delete(key); },
      };
      const path = "/user/files/wired.bin";
      const overCap = new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1).fill(7);
      const blobCount = async (): Promise<number> => Number(
        (await made.sql("SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = 'workspace'"))[0]?.["count"],
      );
      const before = await blobCount();

      const workspace = workspaceStore(made.store, { files });
      const fs = await workspace.open(user);
      await fs.writeFile(path, overCap);
      expect(await fs.commit()).toEqual({ status: "ok", changed: [path] });

      expect(held.size).toBe(1);
      const read = await (await workspace.open(user)).readFileBuffer(path);
      expect(Buffer.compare(Buffer.from(read), Buffer.from(overCap))).toBe(0);
      // The store's own blob table never saw it — the wired adapter took it.
      expect(await blobCount()).toBe(before);
    });

    it("strands no blob when undo discards a blob-backed revision", async () => {
      const path = "/user/files/big-history.txt";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      for (const marker of ["a", "b"]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, big(marker));
        await fs.commit({ message: `wrote ${marker}` });
      }
      // Keys are random ids, so reachability is the question: how many blobs do
      // this path's rows still point at?
      const blobsFor = async (): Promise<number> => Number(
        (await made.sql(
          `SELECT COUNT(*)::int AS count FROM vendo_blobs
           WHERE namespace = 'workspace' AND key IN (
             SELECT blob_ref FROM vendo_workspace_files WHERE path = $1 AND blob_ref IS NOT NULL
             UNION SELECT blob_ref FROM vendo_workspace_history WHERE path = $1 AND blob_ref IS NOT NULL
           )`,
          [path],
        ))[0]?.["count"],
      );
      // One live revision + one superseded revision.
      expect(await blobsFor()).toBe(2);

      expect(await workspace.undo(user, path)).toEqual({ status: "ok", revision: 3 });
      expect(await (await workspace.open(user)).readFile(path)).toBe(big("a"));
      // Undo has no redo, so the discarded revision's blob must not linger:
      // only the restored one is still referenced.
      expect(await blobsFor()).toBe(1);
    });

    it("keeps history to WORKSPACE_HISTORY_LIMIT revisions per path", async () => {
      const path = "/user/memory/chatty.md";
      const workspace = workspaceStore(made.store);
      for (let revision = 0; revision <= WORKSPACE_HISTORY_LIMIT + 5; revision += 1) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, `revision ${revision}`);
        await fs.commit({ message: `edit ${revision}` });
      }
      const rows = await made.sql(
        `SELECT COUNT(*)::int AS count, MIN(revision)::int AS oldest, MAX(revision)::int AS newest
         FROM vendo_workspace_history WHERE path = $1`,
        [path],
      );
      expect(Number(rows[0]?.["count"])).toBe(WORKSPACE_HISTORY_LIMIT);
      // The newest revisions survive; the oldest are trimmed.
      expect(Number(rows[0]?.["newest"])).toBe(WORKSPACE_HISTORY_LIMIT + 5);
      expect(Number(rows[0]?.["oldest"])).toBe(6);
    });

    // F5 (verifier): commit wrote files in insertion order and aborted on the
    // first failure, so an oversized upload staged BEFORE the app edit silently
    // dropped the edit — and staged AFTER it, kept it. Order decided the data.
    it("commits nothing when one staged file cannot be stored, whatever the order", async () => {
      const app = "/user/apps/app_preflight/app.vendo";
      const upload = "/user/files/too-big.bin";
      const workspace = workspaceStore(made.store);

      for (const uploadFirst of [true, false]) {
        const fs = await workspace.open(user);
        if (uploadFirst) {
          await fs.writeFile(upload, new Uint8Array(FILES_STORE_MAX_BYTES + 1));
          await fs.writeFile(app, "page: survives");
        } else {
          await fs.writeFile(app, "page: survives");
          await fs.writeFile(upload, new Uint8Array(FILES_STORE_MAX_BYTES + 1));
        }

        // Rejected up front, naming the file that cannot be stored...
        await expect(fs.commit({ message: "tried both" }))
          .rejects.toMatchObject<Partial<VendoError>>({ code: "validation" });
        await expect(fs.commit()).rejects.toThrow(new RegExp(upload));
        // ...and no row landed for EITHER path, in either order.
        expect(await rowsFor(app)).toEqual([]);
        expect(await rowsFor(upload)).toEqual([]);
      }
    });

    it("leaves no orphaned content behind when a commit is rejected", async () => {
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      const blobs = async (): Promise<number> => Number(
        (await made.sql(
          "SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = 'workspace'",
        ))[0]?.["count"],
      );
      const before = await blobs();

      // A storable over-cap-for-inline file (goes to a blob) plus an unstorable one.
      await fs.writeFile("/user/files/fine.txt", "y".repeat(WORKSPACE_INLINE_MAX_BYTES + 1));
      await fs.writeFile("/user/files/doomed.bin", new Uint8Array(FILES_STORE_MAX_BYTES + 1));
      await expect(fs.commit()).rejects.toThrow(/doomed\.bin/);

      // The blob placed for the storable file is released with the rejection.
      expect(await blobs()).toBe(before);
    });

    // F6 (verifier): an explicitly mkdir'ed directory was reported as a file, so
    // `find -type f` returned directories.
    it("reports an explicitly created directory as a directory", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.mkdir("/user/files/reports", { recursive: true });
      await fs.writeFile("/user/files/summary.txt", "a file");

      const entries = await fs.readdirWithFileTypes("/user/files");
      expect(entries.find((entry) => entry.name === "reports"))
        .toMatchObject({ isDirectory: true, isFile: false });
      expect(entries.find((entry) => entry.name === "summary.txt"))
        .toMatchObject({ isDirectory: false, isFile: true });
      expect((await fs.stat("/user/files/reports")).isDirectory).toBe(true);
    });

    // F7 (verifier): rm erased the path's whole history, so a deleted file could
    // never be undone — contract §3.3 says history is append-only.
    it("records a delete in history so undo brings the file back", async () => {
      const path = "/user/files/deleted-then-restored.txt";
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(path, "the only copy");
      await first.commit({ message: "wrote it" });

      const second = await workspace.open(user);
      await second.rm(path);
      expect(await second.commit({ message: "deleted the file" })).toEqual({
        status: "ok",
        changed: [path],
      });
      expect(await rowsFor(path)).toEqual([]);

      // History kept what the delete removed, with the delete's own intent.
      expect(await workspace.history(user, path)).toMatchObject([
        { revision: 1, intent: "deleted the file" },
      ]);

      expect(await workspace.undo(user, path)).toMatchObject({ status: "ok" });
      expect(await (await workspace.open(user)).readFile(path)).toBe("the only copy");
      // Revisions never go backwards, even across a delete and a restore.
      expect(Number((await rowsFor(path))[0]?.["revision"])).toBeGreaterThan(1);
    });

    // F10 (verifier): writes outside the two mounts were staged and then
    // silently discarded with status ok — data loss on a typo.
    it("refuses a write outside the two mounts instead of dropping it at commit", async () => {
      const fs = await workspaceStore(made.store).open(user);
      for (const path of ["/User/apps/app_1/app.vendo", "/user/../x", "/etc/passwd", "/tmp/scratch.txt"]) {
        await expect(fs.writeFile(path, "lost?")).rejects.toThrow(/EACCES: permission denied/);
      }
      await expect(fs.mkdir("/etc/vendo")).rejects.toThrow(/EACCES: permission denied/);
      expect(await fs.commit()).toEqual({ status: "ok", changed: [] });
    });

    // F13 (verifier): a file literally named /user/scratch persisted and
    // shadowed the scratch directory.
    it("treats the bare /user/scratch path as scratch, not a persisted file", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile("/user/scratch", "not a real document");
      expect(await fs.commit()).toEqual({ status: "ok", changed: [] });
      expect(await rowsFor("/user/scratch")).toEqual([]);
    });

    // F8 (verifier): a revision whose blob had vanished reported "empty" — a lie
    // that also wedged every older revision behind it.
    it("reports a revision whose content is gone and keeps walking past it", async () => {
      const path = "/user/files/lost-blob.txt";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      for (const content of [big("a"), big("b"), big("c")]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, content);
        await fs.commit({ message: "wrote" });
      }
      // Lose the content of the newest superseded revision behind the store's back.
      const ref = String((await made.sql(
        `SELECT blob_ref FROM vendo_workspace_history WHERE path = $1
         ORDER BY revision DESC LIMIT 1`,
        [path],
      ))[0]?.["blob_ref"]);
      await made.sql("DELETE FROM vendo_blobs WHERE namespace = 'workspace' AND key = $1", [ref]);

      // Honest about what happened, rather than claiming there is nothing to undo...
      expect(await workspace.undo(user, path)).toMatchObject({ status: "content-missing" });
      // ...and the older revision is still reachable.
      expect(await workspace.undo(user, path)).toMatchObject({ status: "ok" });
      expect(await (await workspace.open(user)).readFile(path)).toBe(big("a"));
    });

    it("names the fix when a file passes the store-backed cap with no files adapter wired", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile("/user/files/huge.bin", new Uint8Array(FILES_STORE_MAX_BYTES + 1));
      await expect(fs.commit()).rejects.toMatchObject<Partial<VendoError>>({ code: "validation" });
      await expect(fs.commit()).rejects.toThrow(/Wire `files:`/);
    });
  });
}
