/**
 * How a boot-constructed harness reaches a COMPOSED adapter.
 *
 * `harness: claudeCode()` is written by the HOST, at boot, where no `createVendo`
 * composition exists yet — the same gap that made the documented `harness:
 * vendo()` opt-in think with a zero-character prompt (contract §1 amendment).
 * `Turn` is frozen and carries no adapter slot, and design §3's law is that
 * host-side dependencies "arrive by factory closure", so a harness that wants a
 * sandbox may simply be handed one: `claudeCode({ sandbox })`.
 *
 * This is the other half — for the host who wired `createVendo({ sandbox })` and
 * reasonably expects `requires: { sandbox: true }` to MEAN something. Composition
 * fills the slot once, keyed by the harness value itself, and the harness reads
 * it at turn time. Deployment-scoped, not per-turn: the adapter is a deployment
 * fact, so there is nothing here that could attribute one user's machine to
 * another user's thread.
 *
 * A `WeakMap` rather than an `AsyncLocalStorage` deliberately — ALS would have to
 * survive `createUIMessageStream`'s deferral of `execute`, and a slot that is
 * silently empty is exactly the failure mode this file exists to close.
 */
import type { Harness } from "@vendoai/core";

/** The composed adapters a harness may be handed. Mirrors `ComposedAdapters`
 *  (the boot gate's view) plus the blob door session artifacts need. */
export interface HarnessAdapters {
  /** `SandboxAdapter` from `@vendoai/apps`; typed loosely so the root entry of
   *  this package never pulls a provider SDK into scope. */
  sandbox?: unknown;
  /** `FilesAdapter` — where a harness parks an artifact too big for `turn.state`. */
  files?: unknown;
}

const slots = new WeakMap<object, HarnessAdapters>();

/** Composition's call, once, at `createVendo` time. */
export function provideHarnessAdapters(harness: object, adapters: HarnessAdapters): void {
  slots.set(harness, { ...slots.get(harness), ...adapters });
}

/** The harness's call, at turn time. Empty when the host composed nothing. */
export function harnessAdapters(harness: Harness<never> | object): HarnessAdapters {
  return slots.get(harness as object) ?? {};
}
