// @vitest-environment jsdom
// Defect 2 regression (unified-try-surface try-venue generation E2E,
// 2026-07-26 — local v2 run: "generated island forms are raw <form>, not
// Kit Form, so the preventDefault fix (form.tsx) never runs -> dead submit
// persists"). Root cause: the jail sandbox carries no allow-forms
// (JailedComponent.tsx `sandbox="allow-scripts"`), so a native <form> submit
// must never be allowed to reach the browser's default action — but a
// generated ISLAND frequently writes a raw HTML <form onSubmit={handler}>
// (pretraining habit) whose handler is an async function taking no event
// argument, so it can never call event.preventDefault() itself. Only the
// Kit's own <Form> wrapper (packages/ui/src/kit/forms/form.tsx) called
// preventDefault, so a raw <form> island's submit fell through to the
// sandboxed default action and never visibly resolved.
//
// Fix: runtime-entry.tsx registers ONE document-level capture-phase `submit`
// listener that unconditionally calls preventDefault() — it protects every
// <form> an island can emit, Kit-wrapped or raw, without depending on the
// model writing the call itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class FakeResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

let postMessage: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  await import("../../src/tree/jail/runtime-entry.js");
});

beforeEach(() => {
  postMessage.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderSource = (source: string, props: Record<string, unknown> = {}) => {
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    data: { vendo: true, kind: "render", source, props },
  }));
};

describe("jail runtime — document-level submit capture", () => {
  it("prevents the native default action for a RAW <form> whose handler takes no event argument, while still running the handler", async () => {
    renderSource(`
      export default function RawForm() {
        const [phase, setPhase] = useState("idle");
        // The exact shape the report found: an async handler with NO event
        // parameter — it structurally cannot call preventDefault() itself.
        const handleSubmit = async () => { setPhase("submitted"); };
        return (
          <form data-raw-form onSubmit={handleSubmit}>
            <button type="submit">Create issue</button>
            <p data-phase>{phase}</p>
          </form>
        );
      }`);
    await vi.waitFor(() => expect(document.querySelector("[data-raw-form]")).toBeTruthy());
    const form = document.querySelector("[data-raw-form]") as HTMLFormElement;

    let observedDefaultPrevented: boolean | undefined;
    // A bubble-phase listener on the form fires AFTER the document's
    // capture-phase listener already ran (capture travels document -> form
    // before the event reaches its target), so this observes the outcome of
    // the fix under test without racing it.
    form.addEventListener("submit", (event) => { observedDefaultPrevented = event.defaultPrevented; });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    (form.querySelector("button") as HTMLButtonElement).click();

    // The model's own onSubmit handler still runs — the fix only suppresses
    // the native default action, it never stops propagation.
    await vi.waitFor(() => expect(document.querySelector("[data-phase]")?.textContent).toBe("submitted"));
    expect(observedDefaultPrevented).toBe(true);
    // jsdom logs "Not implemented: HTMLFormElement.prototype.requestSubmit"
    // when a form's native submission actually proceeds — its absence is
    // direct evidence the sandboxed default action never ran.
    expect(consoleError.mock.calls.some(([message]) => String(message).includes("Not implemented"))).toBe(false);
    consoleError.mockRestore();
  });

  it("also wins the race against the Kit's own <Form> preventDefault, which runs later (React's bubble-phase delegation, after this test's own target-phase check)", async () => {
    renderSource(`
      export default function Wrapped() {
        const [phase, setPhase] = useState("idle");
        return (
          <Form onSubmit={() => setPhase("submitted")} submitLabel="Save">
            <p data-phase>{phase}</p>
          </Form>
        );
      }`);
    await vi.waitFor(() => expect(document.querySelector("[data-kit='Form']")).toBeTruthy());
    const form = document.querySelector("[data-kit='Form']") as HTMLFormElement;
    let observedDefaultPrevented: boolean | undefined;
    form.addEventListener("submit", (event) => { observedDefaultPrevented = event.defaultPrevented; });
    (form.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("[data-phase]")?.textContent).toBe("submitted"));
    expect(observedDefaultPrevented).toBe(true);
  });
});
