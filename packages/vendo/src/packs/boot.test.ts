/**
 * The two things composition has to SAY about packs: a name a pack claimed that
 * something else in the deployment already owns (F4), and a `packs:` list that
 * quietly leaves the agent unable to build apps (F6).
 */
import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { APPS_PACK_NAME } from "./apps.js";
import { hostPackToolCollision, missingAppsPackWarning } from "./boot.js";

const owners = new Map([["check_report", "compliance-reports"]]);

describe("hostPackToolCollision (F4)", () => {
  it("names the pack, the tool, and the host as the other claimant", () => {
    const error = hostPackToolCollision(owners, ["host_listInvoices", "check_report"]);

    expect(error).toBeInstanceOf(VendoError);
    expect(error?.code).toBe("conflict");
    expect(error?.message).toContain("compliance-reports");
    expect(error?.message).toContain("check_report");
    expect(error?.message).toMatch(/host tools/);
  });

  it("tells the host what to do about it, both ways round", () => {
    const message = hostPackToolCollision(owners, ["check_report"])?.message ?? "";
    expect(message).toMatch(/rename it in the pack/);
    expect(message).toMatch(/overrides\.json/);
  });

  it("says nothing when no host tool name is claimed by a pack", () => {
    expect(hostPackToolCollision(owners, ["host_listInvoices", "host_sendEmail"])).toBeUndefined();
  });

  it("says nothing when the host has no tools at all", () => {
    expect(hostPackToolCollision(owners, [])).toBeUndefined();
  });

  it("does not mistake a name that merely CONTAINS a pack tool name", () => {
    expect(hostPackToolCollision(owners, ["check_report_v2", "precheck_report"])).toBeUndefined();
  });

  it("says nothing when no pack declared any tool", () => {
    expect(hostPackToolCollision(new Map(), ["check_report"])).toBeUndefined();
  });
});

describe("missingAppsPackWarning (F6)", () => {
  it("warns when an explicit packs list has no apps pack", () => {
    const warning = missingAppsPackWarning(["compliance-reports"]);

    expect(warning).toContain("compliance-reports");
    expect(warning).toMatch(/apps\(\)/);
    // The consequence, said plainly — this is the whole point of the warning.
    expect(warning).toMatch(/cannot build|no longer build|build apps/i);
  });

  it("says nothing when the list includes the apps pack", () => {
    expect(missingAppsPackWarning([APPS_PACK_NAME, "compliance-reports"])).toBeUndefined();
  });

  it("says nothing when packs was never configured — the default already includes apps()", () => {
    expect(missingAppsPackWarning(undefined)).toBeUndefined();
  });

  it("warns for an explicitly empty list", () => {
    expect(missingAppsPackWarning([])).toMatch(/apps\(\)/);
  });
});
