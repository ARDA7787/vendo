// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const NOTICE = "Data didn't load";

/**
 * The view a failed load and a genuinely empty dataset produce the SAME way: a
 * table bound to a query result that isn't there renders its own empty state
 * ("No data"), which is exactly why the failure has to be said out loud —
 * otherwise the user cannot tell "this couldn't load" from "you have nothing".
 */
function spendingTree(extras: Record<string, unknown> = {}): UIPayload {
  return {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["table"] },
      {
        id: "table",
        component: "Table",
        props: { columns: ["merchant", "amount"], rows: { $path: "/spend/rows" } },
      },
    ],
    ...extras,
  } as UIPayload;
}

describe("the data-unavailable notice (render-seam F6)", () => {
  it("says the view could not load its data, in the user's own words", () => {
    render(<TreeView tree={spendingTree({ dataUnavailable: true })} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: NOTICE });
    // Consumer voice: no tool names, no file paths, no codes.
    expect(notice.textContent).toContain("couldn't load its data");
    expect(notice.textContent).toContain("isn't your data being empty");
    expect(notice.textContent).not.toMatch(/vendo|app\.vendo|authored|query|tool/i);
    // The settled view still renders underneath — the notice is a header on the
    // app, never a replacement for it.
    expect(screen.getByText("No data")).not.toBeNull();
  });

  it("says NOTHING for a genuinely empty dataset — the whole point of the marker", () => {
    render(<TreeView tree={spendingTree()} components={{}} onAction={ok} />);

    // Same empty table, no claim that anything failed.
    expect(screen.getByText("No data")).not.toBeNull();
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });

  it("says nothing when the data DID load", () => {
    render(
      <TreeView
        tree={spendingTree()}
        components={{}}
        data={{ spend: { rows: [{ merchant: "Maple Coffee", amount: 4.5 }] } }}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Maple Coffee")).not.toBeNull();
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });

  it("tolerates a malformed marker — only exactly `true` speaks", () => {
    for (const value of ["yes", 1, {}, null]) {
      render(<TreeView tree={spendingTree({ dataUnavailable: value })} components={{}} onAction={ok} />);
      expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
      cleanup();
    }
  });
});
