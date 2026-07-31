import { describe, expect, it } from "vitest";
import { mechanicalRisk, projectableForRun, resolvedRisk, type ToolDescriptor } from "./index.js";

const tool = (name: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  description: "a tool",
  inputSchema: { type: "object" },
  // The declared label is deliberately the LEAST destructive value on every
  // fixture here: the mechanical vote must reach its verdict without it.
  risk: "read",
  ...extra,
});

describe("the mechanical vote is genuinely independent of the AI label", () => {
  it("does not consult descriptor.risk at all", () => {
    // Same name, three different declared labels — one mechanical verdict.
    const verdicts = (["read", "write", "destructive"] as const).map((risk) =>
      mechanicalRisk(tool("maple_payments_send", { risk })));
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe("destructive");
  });

  it("reaches read on its own, without the label saying read", () => {
    expect(mechanicalRisk(tool("maple_invoices_list", { risk: "destructive" }))).toBe("read");
  });

  it("defaults an unrecognisable name to write, never to read", () => {
    // Fail-closed: an unknown verb is not evidence of safety.
    expect(mechanicalRisk(tool("maple_frobnicate_widget"))).toBe("write");
  });
});

describe("destructive verbs the old vocabulary missed (verifier findings 11/12)", () => {
  for (const name of [
    "maple_wire_initiate",
    "maple_invoice_void",
    "maple_subscription_terminate",
    "maple_table_truncate",
    "maple_courier_dispatch",
    "maple_user_ban",
    "maple_payout_submit",
    "maple_account_close",
    "maple_records_purge",
    "maple_key_revoke",
    "maple_funds_withdraw",
    "maple_charge_refund",
    "maple_data_erase",
    "maple_user_deactivate",
    "maple_order_cancel",
  ]) {
    it(`treats ${name} as destructive`, () => {
      expect(mechanicalRisk(tool(name))).toBe("destructive");
    });
  }

  it("withholds every one of them from an unattended run", () => {
    const tools = ["maple_wire_initiate", "maple_invoice_void", "maple_payout_submit"].map((n) => tool(n));
    expect(projectableForRun(tools, { venue: "automation", presence: "away" })).toEqual([]);
  });
});

describe("destructive NOUNS must not withhold a read (verifier finding 12)", () => {
  // The old vote matched any token anywhere, so a noun like "message" or
  // "payment" made an obvious read look destructive. Over-withholding is not a
  // safe default here: it silently breaks automations that only ever read.
  for (const name of [
    "gmail_message_get",
    "gmail_messages_list",
    "maple_payment_get",
    "maple_transfers_list",
    "maple_invite_show",
    "maple_email_search",
    "maple_archive_query",
  ]) {
    it(`treats ${name} as a read`, () => {
      expect(mechanicalRisk(tool(name))).toBe("read");
    });
  }

  it("still projects those reads into an unattended run", () => {
    const reads = ["gmail_message_get", "maple_payment_get"].map((n) => tool(n));
    expect(projectableForRun(reads, { venue: "automation", presence: "away" })).toHaveLength(2);
  });
});

describe("the HTTP method is the axis the name cannot fake", () => {
  it("reads DELETE as destructive whatever the name says", () => {
    expect(mechanicalRisk(tool("maple_thing_update", { method: "DELETE" } as Partial<ToolDescriptor>)))
      .toBe("destructive");
  });

  it("does not let a GET method downgrade a destructive verb", () => {
    // A destructive action exposed over GET is still destructive.
    expect(mechanicalRisk(tool("maple_account_delete", { method: "GET" } as Partial<ToolDescriptor>)))
      .toBe("destructive");
  });

  it("treats a write method with a read-shaped name as a write, not a read", () => {
    expect(mechanicalRisk(tool("maple_report_get", { method: "POST" } as Partial<ToolDescriptor>)))
      .toBe("write");
  });
});

describe("resolvedRisk escalates, never downgrades", () => {
  it("takes the AI label when it is the riskier of the two", () => {
    expect(resolvedRisk(tool("maple_invoices_list", { risk: "destructive" }))).toBe("destructive");
  });

  it("takes the mechanical verdict when the label understates it", () => {
    expect(resolvedRisk(tool("maple_payments_send", { risk: "write" }))).toBe("destructive");
  });

  it("agrees when both agree", () => {
    expect(resolvedRisk(tool("maple_invoices_list", { risk: "read" }))).toBe("read");
  });
});
