/**
 * CR-1 — the consent surfaces classify an ask from its VERB, and only its verb.
 *
 * THE REGRESSION this pins: the class was matched by running keyword regexes
 * over the whole humanized tool name, so the OBJECT of the call voted on what
 * the sentence claimed. Proven output before the fix, on real tool ids:
 *
 *   host_getSharePrice      → "Sends"       / "This sends a message, as you."
 *   host_getOrder           → "Moves money" / "This moves money, as you."
 *   host_getChargeDetails   → "Moves money" / "This moves money, as you."
 *   host_listEmailTemplates → "Sends"       / "This sends a message, as you."
 *
 * A brokerage price lookup told a customer "This moves money, as you."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consentClassLine, verbWord } from "../../src/chrome/build-beat.js";
import { grantRowWord } from "../../src/chrome/grant-set-card.js";

/** The four proven strings, plus the read tool the wave already tested. */
const READ_ASKS = [
  "host_getSharePrice",
  "host_getOrder",
  "host_getChargeDetails",
  "host_listEmailTemplates",
  "host_getSpendingInsights",
];

/** demo-bank's real catalog — the host every live proof in this wave ran on. */
function demoBankTools(): Array<{ name: string; risk: string }> {
  // cwd is packages/ui under vitest (see the consumer-voice law's source sweep).
  const catalog = JSON.parse(
    readFileSync("../../examples/demo-bank/.vendo/tools.json", "utf8"),
  ) as { tools?: Array<{ name: string; risk: string }> } | Array<{ name: string; risk: string }>;
  const tools = Array.isArray(catalog) ? catalog : catalog.tools ?? [];
  expect(tools.length).toBeGreaterThan(0);
  return tools;
}

describe("a read is never dressed as money or a message", () => {
  it.each(READ_ASKS)("%s reads as a read, on both consent cadences", name => {
    expect(consentClassLine(name, "read")).toBe("This reads your data, as you.");
    expect(verbWord(name, "read")).toBe("Reads");
    expect(grantRowWord(name, "read")).toBe("Reads");
  });

  it("holds for every READ-graded tool in demo-bank's own catalog", () => {
    const offenders = demoBankTools()
      .filter(tool => tool.risk === "read")
      .map(tool => [tool.name, consentClassLine(tool.name, "read"), grantRowWord(tool.name, "read")] as const)
      .filter(([, line, word]) =>
        /moves money|sends a message|deletes something/.test(line)
        || ["Moves money", "Sends", "Deletes"].includes(word));
    expect(offenders).toEqual([]);
  });
});

describe("the verb still decides, from its own position", () => {
  it("keeps ruling 15 — a send tool graded read still reads as a send", () => {
    expect(grantRowWord("host_email_send", "read")).toBe("Sends");
    expect(consentClassLine("host_email_send", "read")).toBe("This sends a message, as you.");
  });

  it("reads a connector's verb past its toolkit prefix", () => {
    expect(consentClassLine("gmail_GMAIL_SEND_EMAIL", "write")).toBe("This sends a message, as you.");
    expect(consentClassLine("slack_SLACK_SEND_MESSAGE", "write")).toBe("This sends a message, as you.");
  });

  it("still names money when money is the VERB", () => {
    expect(consentClassLine("host_transferMoney", "write")).toBe("This moves money, as you.");
    expect(grantRowWord("host_transferMoney", "destructive")).toBe("Irreversible");
  });

  it("guesses NOTHING when the leading token names no verb — the risk grade answers", () => {
    expect(consentClassLine("host_thing_do", "write")).toBe("This changes something in your account, as you.");
    expect(consentClassLine("host_thing_do", "destructive")).toBe("This makes a change you can’t undo, as you.");
    expect(verbWord("host_thing_do")).toBeUndefined();
  });

  it("never lets a read VERB speak for a graded write", () => {
    expect(consentClassLine("host_getSharePrice", "write")).toBe("This changes something in your account, as you.");
    expect(grantRowWord("host_getSharePrice", "write")).toBe("Changes");
  });
});
