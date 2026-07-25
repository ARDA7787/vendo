import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
 * placement IS a write into the repo.
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
  profileRoot: string;
  /** slotsMatched counts exact allowlist reads — 0 means an all-default theme. */
  theme: { status: "written" | "failed"; slotsMatched: number };
  tools: { status: "written" | "failed"; count: number; warnings: string[] };
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
  const placement = relative(repoRoot, profileRoot);
  if (placement === "" || (!placement.startsWith("..") && !isAbsolute(placement))) {
    throw new Error(`profileRoot ${profileRoot} is inside repoRoot ${repoRoot} — the try pass never writes into the repo`);
  }
  const vendoDir = join(profileRoot, ".vendo");

  let theme: DeterministicPassResult["theme"];
  try {
    const summary = await extractTheme(repoRoot);
    await writeText(join(vendoDir, "theme.json"), `${JSON.stringify(toVendoTheme(summary.slots), null, 2)}\n`);
    theme = { status: "written", slotsMatched: Object.keys(summary.matched).length };
  } catch {
    theme = { status: "failed", slotsMatched: 0 };
  }

  let tools: DeterministicPassResult["tools"];
  try {
    const report = await vendoSync({ root: repoRoot, out: vendoDir });
    const written = toolsFileSchema.parse(JSON.parse(await readFile(join(vendoDir, "tools.json"), "utf8")));
    tools = { status: "written", count: written.tools.length, warnings: report.warnings };
  } catch {
    tools = { status: "failed", count: 0, warnings: [] };
  }

  return { profileRoot, theme, tools };
}
