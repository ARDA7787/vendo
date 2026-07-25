/**
 * Try-mode boot logic (unified try surface, Task 8): pure, DI'd, node-testable
 * — NO React, NO DOM globals. The served page injects `window.__VENDO_TRY__`
 * pointing at a TryProfile document, an SSE deepening stream, and the wire
 * mount; this module reads that pointer and runs a tiny external store the
 * surface renders from. The hosted venue serves the SAME bundle with its own
 * URLs in the boot object, so nothing here assumes localhost — every fetch
 * goes exactly where the config points.
 *
 * Failure posture mirrors the server's fail-soft law: a malformed boot object
 * means classic playground mode, a hard profile-parse failure reports
 * `{ ok: false }` so the caller can fall back, a failed refetch keeps the
 * profile it had, and a dead event stream just stops. The surface never
 * crashes on wire trouble.
 */
import type { ToolMetaMap } from "@vendoai/ui";
import type { TryProfile } from "../../try/profile.js";

/** The boot object the try server injects as `window.__VENDO_TRY__`. */
export interface TryBootConfig {
  profileUrl: string;
  eventsUrl: string;
  apiBase: string;
}

/** `window.__VENDO_TRY__` validated — null means classic playground mode. */
export function readTryConfig(win: unknown): TryBootConfig | null {
  const candidate = (win as { __VENDO_TRY__?: unknown } | null | undefined)?.__VENDO_TRY__;
  if (typeof candidate !== "object" || candidate === null) return null;
  const { profileUrl, eventsUrl, apiBase } = candidate as Record<string, unknown>;
  if (typeof profileUrl !== "string" || profileUrl === "") return null;
  if (typeof eventsUrl !== "string" || eventsUrl === "") return null;
  if (typeof apiBase !== "string" || apiBase === "") return null;
  return { profileUrl, eventsUrl, apiBase };
}

/** The slice of EventSource the store uses, shaped for DI (addEventListener
 *  rather than onmessage/onerror so the native class satisfies it under
 *  strictFunctionTypes and node tests fake it with a Map). */
export interface TryEventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

/** The slice of fetch the store uses; `window.fetch` satisfies it. */
export type TryFetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type TryBootPhase = "loading" | "ready" | "fallback";

export interface TryBootState {
  profile: TryProfile | null;
  phase: TryBootPhase;
  /** Latest per-stage status seen on the deepening stream (raw wire strings —
   *  including in-flight "started", which the profile schema never carries). */
  stages: Record<string, string>;
}

export interface CreateTryBootOptions {
  config: TryBootConfig;
  fetchImpl: TryFetchLike;
  eventSourceFactory: (url: string) => TryEventSourceLike;
  /** Stage-event → profile-refetch debounce. Default 300ms. */
  debounceMs?: number;
  /** Consecutive stream errors before giving up on live updates. Default 5. */
  maxEventSourceErrors?: number;
}

export interface TryBoot {
  /** The boot config this store was created with — later surface pieces (live
   *  chat, refine) read `apiBase` here instead of re-reading `window.__VENDO_TRY__`. */
  readonly config: TryBootConfig;
  readonly state: TryBootState;
  /** Fetch + parse the initial profile. `{ ok: false }` = fall back to
   *  classic playground mode; `{ ok: true }` also opens the event stream. */
  load(): Promise<{ ok: boolean }>;
  subscribe(listener: () => void): () => void;
  close(): void;
}

/** Tolerant parse: any plain object IS the profile (unknown fields pass
 *  through — the serving venue owns the schema); anything else is a hard
 *  failure the caller falls back on. */
function parseProfile(value: unknown): TryProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as TryProfile;
}

export function createTryBoot(options: CreateTryBootOptions): TryBoot {
  const debounceMs = options.debounceMs ?? 300;
  const maxErrors = options.maxEventSourceErrors ?? 5;
  const listeners = new Set<() => void>();
  let state: TryBootState = { profile: null, phase: "loading", stages: {} };
  let source: TryEventSourceLike | undefined;
  let refetchTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveErrors = 0;
  let closed = false;

  const setState = (patch: Partial<TryBootState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      // Guarded per listener: one throwing subscriber must neither starve the
      // rest nor propagate into whatever triggered the notify (load's promise
      // chain, the EventSource message callback).
      try {
        listener();
      } catch {
        /* fail-soft, like everything else on this surface */
      }
    }
  };

  /** Fail-soft profile read: null on network trouble, non-2xx, bad JSON. */
  const fetchProfile = async (): Promise<TryProfile | null> => {
    try {
      const response = await options.fetchImpl(options.config.profileUrl);
      if (!response.ok) return null;
      return parseProfile(await response.json());
    } catch {
      return null;
    }
  };

  /** Deepening landed something: refresh, but never regress on a bad fetch. */
  const refetch = async (): Promise<void> => {
    const profile = await fetchProfile();
    if (closed || profile === null) return;
    setState({ profile, phase: "ready" });
  };

  const onMessage = (event: { data?: unknown }): void => {
    consecutiveErrors = 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const record = parsed as { type?: unknown; stage?: unknown; status?: unknown } | null;
    if (record?.type !== "stage" || typeof record.stage !== "string" || typeof record.status !== "string") return;
    setState({ stages: { ...state.stages, [record.stage]: record.status } });
    // Debounced: a burst of stage events costs one profile round-trip.
    if (refetchTimer !== undefined) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      refetchTimer = undefined;
      void refetch();
    }, debounceMs);
  };

  const openEvents = (): void => {
    if (closed || source !== undefined) return;
    let opened: TryEventSourceLike;
    try {
      opened = options.eventSourceFactory(options.config.eventsUrl);
    } catch {
      return; // no live updates — the loaded profile still renders
    }
    source = opened;
    opened.addEventListener("message", onMessage);
    opened.addEventListener("open", () => {
      consecutiveErrors = 0;
    });
    // Native EventSource retries on its own; onerror fires per failed attempt.
    // After N in a row, stop for good — the profile stays whatever it was.
    opened.addEventListener("error", () => {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxErrors && source === opened) {
        source = undefined;
        opened.close();
      }
    });
  };

  return {
    config: options.config,
    get state() {
      return state;
    },
    load: async () => {
      const profile = await fetchProfile();
      if (profile === null) {
        setState({ phase: "fallback" });
        return { ok: false };
      }
      setState({ profile, phase: "ready" });
      openEvents();
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (refetchTimer !== undefined) clearTimeout(refetchTimer);
      refetchTimer = undefined;
      source?.close();
      source = undefined;
      listeners.clear();
    },
  };
}

/**
 * The depth indicator's copy, kept here so it's testable. Live SSE statuses
 * (`stages`, the store's view) decide "in flight" — NOT the profile's
 * disk-derived defaults, where absent artifacts sit at "pending" forever on a
 * no-AI run that will never deepen them.
 */
export function depthLabel(profile: TryProfile | null, stages: Record<string, string> = {}): string | null {
  const inFlight = Object.values(stages).some((status) => status === "pending" || status === "started");
  if (inFlight) return "Learning your codebase…";
  if (profile?.depth?.level === "deep") return "Profiled from your codebase";
  return null;
}

/** The brand header's title: the profile's brand name, or a neutral stand-in. */
export function brandTitle(profile: TryProfile | null): string {
  const name = profile?.brand?.name;
  return typeof name === "string" && name.trim() !== "" ? name : "Your product";
}

/** Which data source the surface slot rides (Task 10). Decided from the
 *  profile ALONE — re-evaluated on every store update, never latched — and
 *  strictly `liveChat === true`: an absent, false, or malformed capability
 *  (the tolerant profile parse lets anything through) means today's scripted
 *  behavior. There is deliberately NO runtime fallback the other way: once
 *  live, wire trouble surfaces as the chrome's real error states, never as a
 *  silent swap to scripted data faking a working agent. */
export type TrySurfaceMode = "live" | "scripted";

export function selectSurfaceMode(profile: TryProfile | null): TrySurfaceMode {
  const capabilities = (profile as { capabilities?: unknown } | null)?.capabilities;
  const liveChat = (capabilities as { liveChat?: unknown } | null | undefined)?.liveChat;
  return liveChat === true ? "live" : "scripted";
}

/** Live mode's provider `tools` prop, from the profile's merged tool
 *  summaries (extracted descriptions with overrides.json corrections already
 *  applied — the same metadata a host would hand its own VendoProvider). Junk
 *  entries are dropped; missing meta just means chrome's humanize fallback
 *  prettifies the raw tool id. */
export function liveToolMeta(profile: TryProfile | null): ToolMetaMap {
  const list = (profile?.tools as { list?: unknown } | undefined)?.list;
  const meta: ToolMetaMap = {};
  for (const entry of Array.isArray(list) ? list : []) {
    const tool = entry as { name?: unknown; description?: unknown } | null;
    if (typeof tool?.name !== "string" || tool.name.trim() === "") continue;
    if (typeof tool.description !== "string" || tool.description.trim() === "") continue;
    meta[tool.name] = { description: tool.description };
  }
  return meta;
}

/** One pressable suggestion chip (the profile's usecase shape, minus whatever
 *  extra fields the passthrough schema let ride along). */
export interface UsecaseChip {
  label: string;
  prompt: string;
}

/** Shown until the seeds artifact lands. Surface-side constants copied from
 *  (kept in sync by hand with) FALLBACK_USECASES in cli/extract/seeds.ts —
 *  deliberately NOT imported, so no server-side module rides into the bundle. */
export const FALLBACK_CHIPS: UsecaseChip[] = [
  { label: "Show my recent activity", prompt: "Show me a dashboard of my recent activity" },
  { label: "Summarize my account", prompt: "Give me a summary of my account and flag anything that needs attention" },
  { label: "What can you do?", prompt: "What can you help me with in this product?" },
];

/** The chips row's data: the profile's AI-seeded usecases once they exist,
 *  generic fallbacks until then — the same call on every store update, so the
 *  swap happens live when the seeds artifact lands. The tolerant profile parse
 *  lets anything through, so junk entries (non-objects, blank or non-string
 *  label/prompt) are dropped rather than rendered as dead pills. */
export function usecaseChips(profile: TryProfile | null): UsecaseChip[] {
  const raw: unknown = profile?.usecases;
  const seeded = (Array.isArray(raw) ? raw : []).flatMap((entry): UsecaseChip[] => {
    const chip = entry as { label?: unknown; prompt?: unknown } | null;
    if (typeof chip?.label !== "string" || chip.label.trim() === "") return [];
    if (typeof chip.prompt !== "string" || chip.prompt.trim() === "") return [];
    return [{ label: chip.label, prompt: chip.prompt }];
  });
  return seeded.length > 0 ? seeded : FALLBACK_CHIPS;
}
