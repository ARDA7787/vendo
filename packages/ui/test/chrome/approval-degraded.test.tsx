// @vitest-environment jsdom
/**
 * spec §16 — THE regression suite for the card audit: every degraded-data case
 * that made the "same" card look like a different product, through the REAL
 * components.
 *
 * empty schema · nested args · >8 fields · connector slug names · logo 404 ·
 * missing ToolMeta — plus the defect that started it: an in-thread $47.50
 * reading as "4750 (unit not specified)" because the thread synthesized
 * `inputSchema: {}` instead of carrying the descriptor.
 */
import type { ApprovalRequest, JsonSchema } from "@vendoai/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ApprovalCard } from "../../src/chrome/index.js";
import { fieldRows } from "../../src/chrome/field-rows.js";
import { buildApprovalRequest } from "../../src/chrome/thread/approval-wire.js";
import { createWireServer } from "../wire-server.js";

let wire: Awaited<ReturnType<typeof createWireServer>>;
let client: VendoClient;

beforeEach(async () => {
  wire = await createWireServer();
  client = createVendoClient({ baseUrl: wire.url });
});

afterEach(async () => {
  cleanup();
  await wire.close();
});

function ask(over: Partial<ApprovalRequest> & { args?: unknown; inputSchema?: JsonSchema }): ApprovalRequest {
  const { args, inputSchema, ...rest } = over;
  return {
    id: "apr_deg",
    call: { id: "call_deg", tool: "host_thing_do", args: (args ?? {}) as never },
    descriptor: { name: "host_thing_do", description: "", inputSchema: inputSchema ?? {}, risk: "write" },
    inputPreview: "host_thing_do {\"a\":1}",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
    createdAt: "2026-08-03T12:00:00.000Z",
    ...rest,
  } as ApprovalRequest;
}

const show = (approval: ApprovalRequest, tools?: Record<string, { label?: string; description?: string }>) =>
  render(
    <VendoProvider client={client} {...(tools === undefined ? {} : { tools })}>
      <ApprovalCard approval={approval} onDecide={() => undefined} />
    </VendoProvider>,
  ).container;

const rowsOf = (container: HTMLElement): Array<[string, string]> =>
  [...container.querySelectorAll(".fl-card-field")].map(row => [
    row.querySelector("dt")!.textContent!,
    row.querySelector("dd")!.textContent!,
  ]);

describe("degraded data never changes the card", () => {
  it("keeps the mandatory line with an empty schema, no description and no host metadata", () => {
    const container = show(ask({ args: { note: "hi" } }));
    // Law 3 — no described tool still gets a sentence, not a blank card.
    expect(container.querySelector(".fl-card-line")!.textContent).toBe("Vendo will run Thing do as you.");
    expect(rowsOf(container)).toEqual([["Note", "hi"]]);
    // The prettified id, never the raw slug (ENG-216).
    expect(screen.queryByText("host_thing_do")).toBeNull();
  });

  it("flattens nested args into readable lines instead of falling back to raw JSON", () => {
    const container = show(ask({
      args: { recipient: { name: "Acme", id: "cus_7" }, tags: ["urgent", "ops"] },
    }));
    expect(container.querySelector("pre")).toBeNull();
    expect(rowsOf(container)).toEqual([
      ["Recipient", "Name: Acme\nId: cus_7"],
      ["Tags", "urgent\nops"],
    ]);
  });

  it("renders MORE than eight fields as rows — the old 9th arg dumped raw JSON", () => {
    const args = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field_${index}`, `v${index}`]));
    const container = show(ask({ args }));
    expect(container.querySelector("pre")).toBeNull();
    expect(rowsOf(container)).toHaveLength(12);
    expect(screen.getByLabelText("Real tool inputs").textContent).not.toContain("{");
  });

  it("brands a connector ask by its toolkit and survives a logo 404", () => {
    const container = show(ask({
      call: { id: "call_slack", tool: "slack_SLACK_SEND_MESSAGE", args: { channel: "#ops" } },
      descriptor: { name: "slack_SLACK_SEND_MESSAGE", description: "", inputSchema: {}, risk: "write" },
    }));
    const well = container.querySelector(".fl-card-ic")!;
    const logo = well.querySelector("img")!;
    expect(logo.getAttribute("src")).toContain("logos.composio.dev");
    // The CDN fails (unknown slug, offline, blocked): the well keeps a glyph
    // rather than an empty box — three of the four call sites had no onError.
    fireEvent.error(logo);
    expect(well.querySelector("img")).toBeNull();
    expect(well.querySelector("svg")).not.toBeNull();
    // The slug never reads as the title.
    expect(screen.queryByText("slack_SLACK_SEND_MESSAGE")).toBeNull();
    expect(container.querySelector(".fl-card-title")!.textContent).toBe("Slack send message");
  });

  it("prefers host ToolMeta when it exists and degrades cleanly when it does not", () => {
    const withMeta = show(ask({ args: { amount: 12 } }), {
      host_thing_do: { label: "Do the thing", description: "Runs the thing once." },
    });
    expect(withMeta.querySelector(".fl-card-title")!.textContent).toBe("Do the thing");
    expect(withMeta.querySelector(".fl-card-line")!.textContent).toBe("Runs the thing once.");
    cleanup();
    const without = show(ask({ args: { amount: 12 } }));
    expect(without.querySelector(".fl-card-title")!.textContent).toBe("Thing do");
  });

  it("formats an undeclared number honestly and a declared one as money", () => {
    const undeclared = show(ask({ args: { amount: 4750 } }));
    expect(rowsOf(undeclared)).toEqual([["Amount", "4750 (unit not specified)"]]);
    cleanup();
    const declared = show(ask({
      args: { amount: 4750 },
      inputSchema: { type: "object", properties: { amount: { type: "integer", description: "Amount in integer cents" } } },
    }));
    expect(rowsOf(declared)).toEqual([["Amount", "$47.50"]]);
  });

  it("bounds a huge single argument instead of pouring it into the card", () => {
    const rows = fieldRows({ blob: "x".repeat(5_000) });
    expect(rows[0]!.value.length).toBeLessThan(500);
    expect(rows[0]!.value.endsWith("…")).toBe(true);
  });
});

describe("the in-thread approval carries the real descriptor", () => {
  it("formats money IN-THREAD once the wire part's schema rides along", () => {
    const part = {
      approvalId: "apr_thread",
      toolCallId: "call_thread",
      tool: "host_transferMoney",
      args: { amount: 4750, recipient_name: "Acme Utilities" },
      risk: "destructive" as const,
      descriptor: {
        title: "Send money",
        description: "Send money from your checking account.",
        inputSchema: {
          type: "object",
          properties: { amount: { type: "integer", description: "Amount in integer cents" } },
        } as JsonSchema,
      },
    };
    const container = show(buildApprovalRequest(part, {}));
    // The wave-1 live proof E2c defect, on the surface it actually happened on.
    expect(rowsOf(container)).toEqual([["Amount", "$47.50"], ["Recipient name", "Acme Utilities"]]);
    expect(screen.getByLabelText("Real tool inputs").textContent).not.toContain("4750");
    expect(container.querySelector(".fl-card-title")!.textContent).toBe("Send money");
    expect(container.querySelector(".fl-card-line")!.textContent).toBe("Send money from your checking account.");
  });

  it("still builds a usable ask when the wire carries no descriptor at all", () => {
    const approval = buildApprovalRequest(
      { approvalId: "apr_bare", toolCallId: "call_bare", tool: "host_email_send", args: { to: "a@example.com" } },
      { host_email_send: { description: "Send an email as you." } },
    );
    expect(approval.descriptor.inputSchema).toEqual({});
    expect(approval.descriptor.risk).toBe("read");
    // Never the server's `tool slug + canonical JSON`.
    expect(approval.inputPreview).toBe("To: a@example.com");
    const container = show(approval);
    expect(container.querySelector(".fl-card-line")!.textContent).toBe("Send an email as you.");
  });
});
