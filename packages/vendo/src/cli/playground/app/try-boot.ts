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
    for (const listener of [...listeners]) listener();
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
