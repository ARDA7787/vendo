import { describe, expect, test } from "vitest";
import { checkoutWorkspace, contentHash, pathAccess } from "./materialize.js";
import { testWorkspace } from "./test-doubles.test-util.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string) => ({ path, bytes: bytes(text) });

describe("pathAccess — wave-1 can(), the ONE seam wave 3 repoints", () => {
  test("/user/** belongs to its subject: read-write", () => {
    expect(pathAccess("/user/apps/app_1/app.vendo")).toBe("rw");
    expect(pathAccess("/user/memory/notes.md")).toBe("rw");
    expect(pathAccess("/user")).toBe("rw");
  });

  test("/host/** is read-only for everyone", () => {
    expect(pathAccess("/host/skills/refund/SKILL.md")).toBe("ro");
    expect(pathAccess("/host")).toBe("ro");
  });

  test("nothing else is a mount", () => {
    expect(pathAccess("/etc/passwd")).toBe("none");
    expect(pathAccess("/orgs/acme/apps/app_1/app.vendo")).toBe("none");
    expect(pathAccess("/user/../etc/passwd")).toBe("none");
  });
});

describe("checkout — the box is born filtered (design §8)", () => {
  test("carries every visible file with its mount permission", async () => {
    const workspace = testWorkspace({
      "/user/apps/app_1/app.vendo": "<App/>",
      "/host/skills/refund/SKILL.md": "# refund",
    });
    const checkout = await checkoutWorkspace(workspace);
    expect([...checkout.files].map((entry) => [entry.path, entry.readOnly]).sort()).toEqual([
      ["/host/skills/refund/SKILL.md", true],
      ["/user/apps/app_1/app.vendo", false],
    ]);
  });

  test("a path outside the two mounts is never materialized", async () => {
    const workspace = testWorkspace({ "/tmp/secret": "nope", "/user/memory/a.md": "yes" });
    const checkout = await checkoutWorkspace(workspace);
    expect(checkout.files.map((entry) => entry.path)).toEqual(["/user/memory/a.md"]);
  });
});

describe("syncAll — diff-based per file, never wholesale (§3.5)", () => {
  test("only the files whose content hash changed are committed", async () => {
    const workspace = testWorkspace({
      "/user/memory/a.md": "one",
      "/user/memory/b.md": "two",
    });
    const checkout = await checkoutWorkspace(workspace);
    const changed = await checkout.syncAll([
      file("/user/memory/a.md", "one"),
      file("/user/memory/b.md", "TWO"),
    ]);
    expect(changed).toEqual(["/user/memory/b.md"]);
    expect(workspace.commits.at(-1)?.changed).toEqual(["/user/memory/b.md"]);
  });

  test("a file the box created lands", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/user/files/report.md", "hi")])).toEqual([
      "/user/files/report.md",
    ]);
    expect(await workspace.readFile("/user/files/report.md")).toBe("hi");
  });

  test("/user/scratch/** never syncs", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/user/scratch/junk.txt", "junk")])).toEqual([]);
    expect(await workspace.exists("/user/scratch/junk.txt")).toBe(false);
  });

  test("a write to the read-only /host mount is refused, not committed", async () => {
    const workspace = testWorkspace({ "/host/skills/refund/SKILL.md": "# refund" });
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/host/skills/refund/SKILL.md", "# rewritten")])).toEqual([]);
    expect(await workspace.readFile("/host/skills/refund/SKILL.md")).toBe("# refund");
  });

  test("a path outside the two mounts is refused", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/etc/passwd", "root")])).toEqual([]);
    expect(await workspace.exists("/etc/passwd")).toBe(false);
  });

  test("a file the box deleted is removed from the store", async () => {
    const workspace = testWorkspace({ "/user/memory/gone.md": "bye", "/user/memory/stay.md": "hi" });
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/user/memory/stay.md", "hi")])).toEqual([
      "/user/memory/gone.md",
    ]);
    expect(await workspace.exists("/user/memory/gone.md")).toBe(false);
  });
});

describe("syncHot — the skeleton renders mid-turn (§3.5)", () => {
  test("commits ONLY the hot paths, leaving the rest for turn end", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    const files = [
      file("/user/apps/app_1/plan.vendo", "plan"),
      file("/user/memory/notes.md", "later"),
    ];
    expect(await checkout.syncHot(files)).toEqual(["/user/apps/app_1/plan.vendo"]);
    expect(await workspace.exists("/user/memory/notes.md")).toBe(false);
  });

  test("a hot path already synced and unchanged is not committed twice", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    const files = [file("/user/apps/app_1/app.vendo", "<App/>")];
    expect(await checkout.syncHot(files)).toEqual(["/user/apps/app_1/app.vendo"]);
    expect(await checkout.syncHot(files)).toEqual([]);
    expect(await checkout.syncAll(files)).toEqual([]);
  });

  test("a hot path that changed again after a mid-turn sync lands again", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    await checkout.syncHot([file("/user/apps/app_1/app.vendo", "<App/>")]);
    expect(await checkout.syncHot([file("/user/apps/app_1/app.vendo", "<App>2</App>")])).toEqual([
      "/user/apps/app_1/app.vendo",
    ]);
  });

  test("syncHot never deletes — a partial view of the disk is not a deletion", async () => {
    const workspace = testWorkspace({ "/user/memory/keep.md": "keep" });
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncHot([])).toEqual([]);
    expect(await workspace.exists("/user/memory/keep.md")).toBe(true);
  });
});

describe("contentHash", () => {
  test("is stable and content-addressed", () => {
    expect(contentHash(bytes("a"))).toBe(contentHash(bytes("a")));
    expect(contentHash(bytes("a"))).not.toBe(contentHash(bytes("b")));
  });
});
