import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { toolsFileSchema } from "@vendoai/actions";
import { vendoThemeSchema } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { runDeterministicPass } from "./extract.js";
import { assembleTryProfile } from "./profile.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

/** A minimal Next-ish host: one shadcn-token stylesheet the theme allowlist
 *  reads exactly, one app-router API route the route scan extracts. */
async function nextFixture(): Promise<string> {
  const root = await tempDir("vendo-try-fixture-");
  await write(root, "package.json", `${JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.4.0" },
  }, null, 2)}\n`);
  await write(root, "app/layout.tsx", [
    'import "./globals.css";',
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    "",
  ].join("\n"));
  await write(root, "app/globals.css", [
    ":root {",
    "  --background: #fffdf8;",
    "  --foreground: #1c1917;",
    "  --primary: #7c3aed;",
    "  --radius: 10px;",
    "}",
    "",
  ].join("\n"));
  await write(root, "app/api/invoices/route.ts",
    "export async function GET() { return Response.json([]); }\n");
  return root;
}

/** Full recursive inventory of a tree: every directory (trailing slash) and
 *  every file with a content hash — the zero-commit comparison unit. */
async function inventory(root: string, at = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      entries[`${relative}/`] = "dir";
      Object.assign(entries, await inventory(root, path));
    } else {
      entries[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return entries;
}

describe("runDeterministicPass zero-commit contract", () => {
  it("never writes a byte under repoRoot: full before/after inventories are identical", async () => {
    const repoRoot = await nextFixture();
    const before = await inventory(repoRoot);

    await runDeterministicPass({ repoRoot, profileRoot: await tempDir("vendo-try-profile-") });

    expect(await inventory(repoRoot)).toEqual(before);
  });

  it("rejects a profileRoot inside repoRoot instead of breaking the guarantee", async () => {
    const repoRoot = await nextFixture();

    await expect(runDeterministicPass({ repoRoot, profileRoot: join(repoRoot, ".vendo") }))
      .rejects.toThrow(/repoRoot/);
    await expect(runDeterministicPass({ repoRoot, profileRoot: repoRoot }))
      .rejects.toThrow(/repoRoot/);
  });
});

describe("runDeterministicPass artifacts", () => {
  it("writes theme.json (frozen shape) and tools.json (vendo/tools@1) into profileRoot", async () => {
    const repoRoot = await nextFixture();
    const profileRoot = await tempDir("vendo-try-profile-");

    const result = await runDeterministicPass({ repoRoot, profileRoot });

    expect(result.profileRoot).toBe(profileRoot);
    const theme = vendoThemeSchema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "theme.json"), "utf8")));
    expect(theme.colors.accent).toBe("#7c3aed");
    expect(theme.colors.background).toBe("#fffdf8");
    expect(theme.radius.medium).toBe("10px");

    const tools = toolsFileSchema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "tools.json"), "utf8")));
    expect(tools.tools.map((tool) => tool.name)).toContain("host_invoices_list");

    expect(result.theme.status).toBe("written");
    expect(result.theme.slotsMatched).toBeGreaterThan(0);
    expect(result.tools.status).toBe("written");
    expect(result.tools.count).toBe(tools.tools.length);
  });

  it("produces a profileRoot that assembleTryProfile boots from directly", async () => {
    const repoRoot = await nextFixture();
    const { profileRoot } = await runDeterministicPass({ repoRoot, profileRoot: await tempDir("vendo-try-profile-") });

    const profile = await assembleTryProfile(profileRoot);

    expect(profile.theme).not.toBeNull();
    expect(profile.tools.counts.total).toBeGreaterThan(0);
    expect(profile.depth.stages).toMatchObject({ tools: "done", theme: "done" });
  });

  it("creates a recognizable temp profileRoot when the caller omits one", async () => {
    const result = await runDeterministicPass({ repoRoot: await nextFixture() });
    cleanup.push(result.profileRoot);

    expect(basename(result.profileRoot)).toMatch(/^vendo-try-/);
    // The directory is real and populated.
    expect(await readdir(join(result.profileRoot, ".vendo"))).toContain("theme.json");
  });
});

describe("runDeterministicPass degradation", () => {
  it("still returns a paintable profileRoot for a repo where extraction finds nothing", async () => {
    const repoRoot = await tempDir("vendo-try-empty-");

    const result = await runDeterministicPass({ repoRoot });
    cleanup.push(result.profileRoot);

    // Nothing matched, nothing extracted — and the summary says so.
    expect(result.theme.slotsMatched).toBe(0);
    expect(result.tools.count).toBe(0);
    // The surface still paints: a valid (shallow, all-default) profile assembles.
    const profile = await assembleTryProfile(result.profileRoot);
    expect(profile.depth.level).toBe("shallow");
  });
});
