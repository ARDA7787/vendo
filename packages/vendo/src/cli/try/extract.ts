import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { toolsFileSchema } from "@vendoai/actions";
import { vendoSync } from "@vendoai/actions/sync";
import { toVendoTheme } from "../init.js";
import { writeText } from "../shared.js";
import { extractTheme } from "../theme/extract-theme.js";

/**
 * The deterministic extraction pass behind `npx vendo try` (unified try
 * surface, Task 2): profile a host repo for the first paint with ZERO
 * commitment — no key, no network, no model, and above all no writes.
 *
 * The zero-commit contract: `repoRoot` is read-only, byte for byte. Every
 * artifact lands under `profileRoot` (a fresh `vendo-try-` temp dir when the
 * caller doesn't supply one), laid out exactly like a normal `.vendo/`
 * profile root so `assembleTryProfile(profileRoot)` (Task 1) boots from it
 * directly. A `profileRoot` inside `repoRoot` is refused outright — that
 * placement IS a write into the repo — with symlinks resolved on both sides
 * first, so a link cannot smuggle the profile back into the repo. The
 * returned `profileRoot` is caller-owned: this pass never deletes it, so a
 * temp dir it created leaks unless the caller removes it when done.
 *
 * Two existing extractors run, never reimplementations:
 *   - theme: `extractTheme` (exact-only allowlist pass), converted through
 *     init's own `toVendoTheme` → `.vendo/theme.json`
 *   - tools/catalog: `vendoSync` with `out` pointed at the profile root →
 *     `.vendo/tools.json`, `catalog.json`, ...
 *
 * Fail-soft like the assembler it feeds: either extractor throwing is
 * recorded in the summary (`status: "failed"`), never rethrown — the surface
 * must paint from whatever partial profile survived.
 */

export interface DeterministicPassOptions {
  /** The host repo to profile. Never written to. */
  repoRoot: string;
  /** Where artifacts land; a fresh temp dir is created when omitted. */
  profileRoot?: string;
}

export interface DeterministicPassResult {
  /** Caller-owned (never cleaned up here), whether supplied or freshly made. */
  profileRoot: string;
  /** slotsMatched counts exact allowlist reads plus their derived slots
   *  (contrast accentText, inherited headingFamily) — 0 = all-default theme. */
  theme: { status: "written" | "failed"; slotsMatched: number; error?: string };
  /** A failed sync carries its error as a warning — same channel as sync's own. */
  tools: { status: "written" | "failed"; count: number; warnings: string[] };
}

/** Resolve symlinks through the nearest EXISTING ancestor, re-joining any
 *  not-yet-created tail; falls back to the lexical path when nothing on the
 *  way exists (the relative() guard then judges the lexical spelling). */
async function realpathToward(path: string): Promise<string> {
  let existing = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...tail);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Run the deterministic extractors against `repoRoot`, writing a paintable
 *  profile under `profileRoot`. Resolves (never rejects) for any readable
 *  repo; only the zero-commit placement guard throws. */
export async function runDeterministicPass(
  options: DeterministicPassOptions,
): Promise<DeterministicPassResult> {
  const repoRoot = resolve(options.repoRoot);
  const profileRoot = options.profileRoot === undefined
    ? await mkdtemp(join(tmpdir(), "vendo-try-"))
    : resolve(options.profileRoot);
  const placement = relative(await realpathToward(repoRoot), await realpathToward(profileRoot));
  if (placement === "" || (!placement.startsWith("..") && !isAbsolute(placement))) {
    throw new Error(`profileRoot ${profileRoot} is inside repoRoot ${repoRoot} — the try pass never writes into the repo`);
  }
  const vendoDir = join(profileRoot, ".vendo");

  let theme: DeterministicPassResult["theme"];
  try {
    const summary = await extractTheme(repoRoot);
    await writeText(join(vendoDir, "theme.json"), `${JSON.stringify(toVendoTheme(summary.slots), null, 2)}\n`);
    theme = { status: "written", slotsMatched: Object.keys(summary.matched).length };
  } catch (error) {
    theme = { status: "failed", slotsMatched: 0, error: String(error) };
  }

  let tools: DeterministicPassResult["tools"];
  try {
    const report = await vendoSync({ root: repoRoot, out: vendoDir });
    const written = toolsFileSchema.parse(JSON.parse(await readFile(join(vendoDir, "tools.json"), "utf8")));
    tools = { status: "written", count: written.tools.length, warnings: report.warnings };
  } catch (error) {
    tools = { status: "failed", count: 0, warnings: [String(error)] };
  }

  return { profileRoot, theme, tools };
}
