import type { ResolvedPerson } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { auth0 } from "./auth0.js";
import { authJs } from "./auth-js.js";
import { clerk } from "./clerk.js";
import { jwt } from "./jwt.js";
import { supabase } from "./supabase.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "./shared.js";

/**
 * Build contract §9.1 companion (orchestrator-ratified 2026-08-01) — the FIFTH
 * seam, threaded exactly like `memberships` and for the same reason: Vendo holds
 * no directory, so only the HOST can turn "Mia" into a subject. Unset, the Share
 * dialog does not offer to share with one person at all; set, the grant is
 * written for the SUBJECT it returns and never for what was typed.
 */

const resolvePerson = async (query: string): Promise<ResolvedPerson | null> =>
  query.toLowerCase().includes("mia") ? { subject: "maple-mia", display: "Mia Nakamura" } : null;

const secret = "vendo-preset-resolve-person-secret-with-entropy";

const presets: Record<string, (options: HostAuthPresetOptions) => HostAuthPreset> = {
  authJs: (options) => authJs({ ...options, secret }),
  jwt: (options) => jwt({ ...options, secret }),
  supabase: (options) => supabase({ ...options, secret }),
  clerk: (options) => clerk({ ...options, secret }),
  auth0: (options) => auth0({ ...options, secret }),
};

describe("§9.1 companion — the resolvePerson auth-preset seam", () => {
  for (const [name, build] of Object.entries(presets)) {
    it(`${name}() forwards the resolvePerson callback onto the preset`, async () => {
      const preset = build({ resolvePerson });
      expect(preset.resolvePerson).toBeDefined();
      expect(await preset.resolvePerson?.("mia@maple.com"))
        .toEqual({ subject: "maple-mia", display: "Mia Nakamura" });
      // A name the host does not know is NULL — never a guess, never the query.
      expect(await preset.resolvePerson?.("someone from another company")).toBeNull();
    });

    it(`${name}() leaves the seam unset when the host has no directory to offer`, () => {
      expect(build({}).resolvePerson).toBeUndefined();
    });
  }
});
