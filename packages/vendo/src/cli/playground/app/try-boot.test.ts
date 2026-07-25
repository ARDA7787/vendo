import { afterEach, describe, expect, it, vi } from "vitest";
import type { TryProfile } from "../../try/profile.js";
import {
  brandTitle,
  createTryBoot,
  depthLabel,
  readTryConfig,
  type TryBootConfig,
  type TryEventSourceLike,
} from "./try-boot.js";

const config: TryBootConfig = { profileUrl: "/profile.json", eventsUrl: "/events", apiBase: "/api/vendo" };

function profileFixture(overrides: Partial<TryProfile> = {}): TryProfile {
  return {
    venue: "local",
    brand: { name: "Acme", domain: null, logoUrl: null },
    theme: null,
    brief: null,
    tools: { list: [], counts: { total: 0, enabled: 0 } },
    catalog: [],
    usecases: [],
    fixturesAvailable: false,
    depth: { level: "shallow", stages: {} },
    capabilities: { liveChat: false, refine: false },
    ...overrides,
  };
}

/** DI'd EventSource: records listeners, lets tests push wire events. */
class FakeEventSource implements TryEventSourceLike {
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data });
  }
  close(): void {
    this.closed = true;
  }
}

/** A boot wired to a scripted fetch: each call consumes the next body (the
 *  last one repeats); an Error body rejects like a network failure. */
function harness(bodies: unknown[], options: { maxEventSourceErrors?: number } = {}) {
  const queue = [...bodies];
  const calls: string[] = [];
  const sources: FakeEventSource[] = [];
  const boot = createTryBoot({
    config,
    fetchImpl: async (url) => {
      calls.push(url);
      const body = queue.length > 1 ? queue.shift() : queue[0];
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body };
    },
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    ...options,
  });
  return { boot, calls, sources };
}

function stageEvent(stage: string, status: string): string {
  return JSON.stringify({ type: "stage", stage, status });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readTryConfig", () => {
  it("returns the boot object the server injects", () => {
    const win = { __VENDO_TRY__: { profileUrl: "/profile.json", eventsUrl: "/events", apiBase: "/api/vendo" } };
    expect(readTryConfig(win)).toEqual(config);
  });

  it("hosted venues point the same keys elsewhere — any non-empty strings pass", () => {
    const win = {
      __VENDO_TRY__: {
        profileUrl: "https://console.vendo.run/try/abc/profile.json",
        eventsUrl: "https://console.vendo.run/try/abc/events",
        apiBase: "https://console.vendo.run/try/abc/api/vendo",
      },
    };
    expect(readTryConfig(win)?.profileUrl).toBe("https://console.vendo.run/try/abc/profile.json");
  });

  it("null (classic playground mode) when the object is absent or malformed", () => {
    expect(readTryConfig({})).toBeNull();
    expect(readTryConfig(null)).toBeNull();
    expect(readTryConfig(undefined)).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: "nope" })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: null })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: { profileUrl: "/p" } })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: { profileUrl: "/p", eventsUrl: "/e", apiBase: 7 } })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: { profileUrl: "", eventsUrl: "/e", apiBase: "/a" } })).toBeNull();
  });
});

describe("createTryBoot load", () => {
  it("starts loading, fetches the profile once, lands ready, opens the event stream", async () => {
    const { boot, calls, sources } = harness([profileFixture()]);
    expect(boot.state.phase).toBe("loading");
    expect(boot.state.profile).toBeNull();

    const result = await boot.load();

    expect(result.ok).toBe(true);
    expect(boot.state.phase).toBe("ready");
    expect(boot.state.profile?.brand.name).toBe("Acme");
    expect(calls).toEqual(["/profile.json"]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe("/events");
  });

  it("is tolerant: unknown profile fields pass through untouched", async () => {
    const { boot } = harness([{ ...profileFixture(), futureField: { keep: true } }]);
    await boot.load();
    expect((boot.state.profile as Record<string, unknown>)["futureField"]).toEqual({ keep: true });
  });

  it("hard parse failure → { ok: false } + fallback phase, and no event stream", async () => {
    const { boot, sources } = harness(["not a profile object"]);
    const result = await boot.load();
    expect(result.ok).toBe(false);
    expect(boot.state.phase).toBe("fallback");
    expect(boot.state.profile).toBeNull();
    expect(sources).toHaveLength(0);
  });

  it("a network failure falls back the same way", async () => {
    const { boot } = harness([new Error("connection refused")]);
    expect((await boot.load()).ok).toBe(false);
    expect(boot.state.phase).toBe("fallback");
  });

  it("a non-2xx response falls back the same way", async () => {
    const sources: FakeEventSource[] = [];
    const boot = createTryBoot({
      config,
      fetchImpl: async () => ({ ok: false, json: async () => profileFixture() }),
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
    });
    expect((await boot.load()).ok).toBe(false);
    expect(sources).toHaveLength(0);
  });
});

describe("createTryBoot deepening stream", () => {
  it("a stage event updates stages immediately and re-fetches the profile after the debounce", async () => {
    vi.useFakeTimers();
    const deepened = profileFixture({ depth: { level: "deep", stages: { brief: "done" } } });
    const { boot, calls, sources } = harness([profileFixture(), deepened]);
    await boot.load();
    let notified = 0;
    boot.subscribe(() => {
      notified += 1;
    });

    sources[0]!.emit("message", stageEvent("brief", "started"));
    expect(boot.state.stages).toEqual({ brief: "started" });
    expect(notified).toBeGreaterThan(0);
    // Burst of events: ONE debounced refetch, keyed off the last event.
    sources[0]!.emit("message", stageEvent("brief", "done"));
    sources[0]!.emit("message", stageEvent("usecases", "done"));
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300);

    expect(calls).toHaveLength(2);
    expect(boot.state.profile?.depth.level).toBe("deep");
    expect(boot.state.stages).toEqual({ brief: "done", usecases: "done" });
  });

  it("junk wire data never crashes the store", async () => {
    vi.useFakeTimers();
    const { boot, calls, sources } = harness([profileFixture()]);
    await boot.load();
    sources[0]!.emit("message", "not json");
    sources[0]!.emit("message", JSON.stringify({ type: "other" }));
    sources[0]!.emit("message", JSON.stringify({ type: "stage", stage: 7, status: "done" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(boot.state.stages).toEqual({});
    expect(boot.state.phase).toBe("ready");
  });

  it("a failed refetch keeps the profile it had — the surface never blanks", async () => {
    vi.useFakeTimers();
    const { boot, calls, sources } = harness([profileFixture(), new Error("server restarting")]);
    await boot.load();
    sources[0]!.emit("message", stageEvent("brief", "done"));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(2);
    expect(boot.state.phase).toBe("ready");
    expect(boot.state.profile?.brand.name).toBe("Acme");
  });

  it("close() tears down: EventSource closed, pending refetch cancelled, listeners dropped", async () => {
    vi.useFakeTimers();
    const { boot, calls, sources } = harness([profileFixture()]);
    await boot.load();
    let notified = 0;
    boot.subscribe(() => {
      notified += 1;
    });
    sources[0]!.emit("message", stageEvent("brief", "done"));
    const notifiedBeforeClose = notified;

    boot.close();

    expect(sources[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(notified).toBe(notifiedBeforeClose);
  });

  it("hard errors: after N consecutive failures the stream just stops — state stays intact", async () => {
    const { boot, sources } = harness([profileFixture()], { maxEventSourceErrors: 2 });
    await boot.load();
    sources[0]!.emit("error");
    expect(sources[0]!.closed).toBe(false);
    sources[0]!.emit("error");
    expect(sources[0]!.closed).toBe(true);
    expect(boot.state.phase).toBe("ready");
    expect(boot.state.profile?.brand.name).toBe("Acme");
  });

  it("a live message resets the error count (native retry recovered)", async () => {
    const { boot, sources } = harness([profileFixture()], { maxEventSourceErrors: 2 });
    await boot.load();
    sources[0]!.emit("error");
    sources[0]!.emit("open");
    sources[0]!.emit("error");
    expect(sources[0]!.closed).toBe(false);
  });
});

describe("depthLabel", () => {
  it("learning while any live stage is pending/started", () => {
    expect(depthLabel(profileFixture(), { brief: "started" })).toBe("Learning your codebase…");
    expect(depthLabel(profileFixture(), { usecases: "pending" })).toBe("Learning your codebase…");
    expect(depthLabel(null, { brief: "started" })).toBe("Learning your codebase…");
  });

  it("learning wins over deep while a re-run is in flight", () => {
    const deep = profileFixture({ depth: { level: "deep", stages: {} } });
    expect(depthLabel(deep, { fixtures: "started" })).toBe("Learning your codebase…");
  });

  it("profiled once the profile reports deep", () => {
    const deep = profileFixture({ depth: { level: "deep", stages: { brief: "done" } } });
    expect(depthLabel(deep)).toBe("Profiled from your codebase");
    expect(depthLabel(deep, { brief: "done", usecases: "skipped" })).toBe("Profiled from your codebase");
  });

  it("null when shallow with no AI in flight (disk-default pending stages don't count)", () => {
    expect(depthLabel(profileFixture())).toBeNull();
    expect(depthLabel(profileFixture(), {})).toBeNull();
    expect(depthLabel(profileFixture(), { brief: "failed", usecases: "skipped" })).toBeNull();
    expect(depthLabel(null)).toBeNull();
  });
});

describe("brandTitle", () => {
  it("uses the profile's brand name", () => {
    expect(brandTitle(profileFixture())).toBe("Acme");
  });

  it("falls back to the neutral label when unset", () => {
    expect(brandTitle(profileFixture({ brand: { name: null, domain: null, logoUrl: null } }))).toBe("Your product");
    expect(brandTitle(profileFixture({ brand: { name: "  ", domain: null, logoUrl: null } }))).toBe("Your product");
    expect(brandTitle(null)).toBe("Your product");
  });
});
