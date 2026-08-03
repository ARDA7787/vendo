/**
 * The hot-path render seam — build contract §1.6.
 *
 * "The skeleton renders the moment the plan file exists, whoever wrote it." The
 * runtime is the one place that knows, so the runtime is the one place that
 * emits: every store write to `app.vendo` or `plan.vendo` is parsed here and, iff
 * it parses, becomes today's `data-vendo-view` part — same payload shape, same
 * stable per-app stream id, same server-authoritative field stripping. An
 * unparseable write emits NOTHING: the last good view stays on screen and the
 * brokenness reaches the harness through `validate`, never the user.
 *
 * A parsing `app.vendo` commit is also the moment a files-first app (D4) BECOMES
 * an app: the compile goes to `AppsRuntime.authored` (the `authoredApp` seam),
 * which stores the row the person's Apps list and `vendo_apps_open` read, and
 * resolves the tree's queries so the paint carries real data instead of "—".
 *
 * `HarnessEvent` stays closed — a harness cannot yield a view, by construction.
 *
 * The interception point is **`commit()`** (orchestrator seam answer, 2026-07-30,
 * after lane B landed): the workspace façade STAGES writes in memory, so a
 * `writeFile` is not a store write — `commit()` is, and `CommitResult.changed`
 * names exactly the paths that reached the store. Hooking the write instead would
 * emit views for content that never landed, and would miss the sandbox sync-back
 * path, which commits without ever calling `writeFile` on this façade.
 */
import {
  compilePlan,
  compileWire,
  safeErrorMessage,
  vendoViewPartSchema,
  vendoViewStreamId,
  type AppId,
  type CommitResult,
  type Json,
  type Tree,
  type UIPayload,
  type VendoViewPart,
  type WireCompileResult,
  type WorkspaceFs,
} from "@vendoai/core";
// `skeletonFromPlan` was already public before this lane; the payload-assembly
// pair is a cross-block internal.
import { skeletonFromPlan } from "@vendoai/apps";
import { assembleTree, stripServerAuthoritativeFields } from "@vendoai/apps/internal";

/** §1.6 — the two files that sync mid-turn. Everything else waits for turn end. */
export const HOT_PATH_FILES = ["app.vendo", "plan.vendo"] as const;

/** §3.1, frozen: `/user/apps/<appId>/app.vendo` and — since wave 3 (§9.7) —
 *  `/orgs/<orgId>/apps/<appId>/app.vendo`. `appId` is the store's app id
 *  verbatim in BOTH, which is exactly why one regex can read either: a path's
 *  meaning never depends on who wrote it, so a promoted app's hot paths must
 *  keep painting the skeleton mid-turn like a personal one's. */
const HOT_PATH = /^\/(?:user|orgs\/[^/]+)\/apps\/(app_[^/]+)\/(app\.vendo|plan\.vendo)$/;

/**
 * §3.5's hot paths as WATCH SHAPES — what a machine's mid-turn collect asks for,
 * where `*` stands for exactly one segment (both machines' rule).
 *
 * BOTH mounts, for the same reason `HOT_PATH` reads either: a team app's
 * skeleton has to paint mid-turn like a personal one's. Watching only
 * `/user/apps/*` left an `/orgs` app with nothing to sync until turn end — a
 * blank pane for the length of the turn instead of a skeleton in seconds.
 *
 * Shapes, never a list of files that already exist: on the one ask the skeleton
 * exists for ("make me an app") the appId is invented DURING the turn, so an
 * enumeration watches nothing at all — measured 52.8s of silence against 5.0s.
 */
export const HOT_PATH_WATCH: readonly string[] = ["/user/apps/*", "/orgs/*/apps/*"]
  .flatMap((prefix) => HOT_PATH_FILES.map((name) => `${prefix}/${name}`));

/** The appId a hot-path write belongs to, or undefined if this is not one. */
export function hotPathAppId(path: string): AppId | undefined {
  const match = HOT_PATH.exec(path);
  return match === null ? undefined : (match[1] as AppId);
}

const hotPathFile = (path: string): (typeof HOT_PATH_FILES)[number] | undefined => {
  const match = HOT_PATH.exec(path);
  return match === null ? undefined : (match[2] as (typeof HOT_PATH_FILES)[number]);
};

/**
 * Did this content parse into something worth putting on screen?
 *
 * `compileWire` is total: unparseable input still yields a synthetic `root`
 * Stack node, so a node count is NOT the test. A childless root is exactly the
 * compiler's degraded floor — nothing to render — and putting it on the wire
 * would blank a working app.
 */
const renders = (tree: Tree): boolean => {
  const root = tree.nodes.find((node) => node.id === tree.root);
  return root !== undefined && (root.children?.length ?? 0) > 0;
};

export interface RenderSeamOptions {
  /** Write the part on the stable per-app stream id, so successive views
   *  reconcile in place instead of stacking. */
  emit: (streamId: string, part: VendoViewPart) => void;
  /**
   * The live tool/component names, for the plan compiler's fact check. Facts only
   * shape `issues` — never whether a plan parses — so omitting them costs the
   * seam nothing; composition supplies them when it has them.
   */
  facts?: () => { tools: readonly string[]; components: readonly string[] };
  /**
   * The app-runtime half of an `app.vendo` commit (§1.6) — what makes a
   * file-authored app a real app instead of a picture of one.
   *
   * Composition injects `AppsRuntime.authored`, which UPSERTS the app's store row
   * (so a D4 files-first app lists, opens and shares like an engine-built one) and
   * resolves the tree's queries through the guard-bound registry with this turn's
   * ctx — the same call path, the same risk and consent rules, as any tool call.
   * Its answer is this app's `data`.
   *
   * ASYNC on purpose: it runs real host queries, which is also why the skeleton is
   * emitted BEFORE it is awaited (below) — §1.6 is a promise about seconds.
   *
   * Unwired, the view still renders: the skeleton, with no data at all and no row
   * anywhere. That was the shipped state until 2026-08-03, and it is exactly what
   * an app full of "—" looks like.
   */
  authoredApp?: (input: { appId: AppId; compiled: WireCompileResult }) => Promise<Record<string, Json> | undefined>;
}

/** The view part for a payload, or undefined when the renderer's own gate would
 *  reject it — a payload it would not render is not a view, and a half-rendered
 *  app is worse than the last good one.
 *
 *  `streaming` is the mid-build flag the shipped emitter stamps on its partial
 *  trees (packages/apps runtime.ts), and it has to FLIP OFF for the last paint,
 *  exactly as that emitter's final view does. While it is on, the renderer holds
 *  the forming skeleton instead of ever reaching a verdict, the card's bar stays
 *  on "Building your view…" and its settle-scroll, stage registration and pin
 *  affordance never arm. Stamped on a finished app it is not caution, it is an
 *  app that never finishes. */
const viewPart = (
  appId: AppId,
  payload: UIPayload,
  streaming: boolean,
): { streamId: string; part: VendoViewPart } | undefined => {
  const parsed = vendoViewPartSchema.safeParse({
    type: "data-vendo-view",
    appId,
    // Spread, never mutated in place: the emitted part must not change under the
    // consumer when this function's caller fills the data in afterwards.
    payload: { ...payload, streaming },
  });
  if (!parsed.success) return undefined;
  return { streamId: vendoViewStreamId(appId), part: parsed.data };
};

/** The view a parsing hot-path commit produces, or undefined if it does not parse. */
export async function viewForWrite(
  path: string,
  content: string,
  options: RenderSeamOptions,
): Promise<{ streamId: string; part: VendoViewPart } | undefined> {
  const appId = hotPathAppId(path);
  const file = hotPathFile(path);
  if (appId === undefined || file === undefined) return undefined;

  let payload: UIPayload | undefined;
  /** Set for `app.vendo` only: a plan is a skeleton, not an app document — there
   *  is nothing to store and no query to run until the app itself is written. */
  let compiledApp: WireCompileResult | undefined;
  if (file === "app.vendo") {
    // compileWire is TOTAL and valid-while-partial: every prefix of a wire
    // compiles, which is what makes a mid-generation save renderable. Only a
    // `compile-failed` issue means it truly did not parse.
    const compiled = compileWire(content);
    // `missing-app` means there was no `<App>` document to read at all, and
    // `compile-failed` means the compiler itself gave up: both are "unparseable".
    if (compiled.issues.some((issue) => issue.code === "compile-failed" || issue.code === "missing-app")) {
      return undefined;
    }
    if (!renders(compiled.tree)) return undefined;
    compiledApp = compiled;
    payload = stripServerAuthoritativeFields(
      assembleTree({ tree: compiled.tree, components: compiled.components }),
    ) as unknown as UIPayload;
  } else {
    const facts = options.facts?.() ?? { tools: [], components: [] };
    const compiled = compilePlan(content, facts);
    if (compiled.plan === undefined) return undefined;
    // The plan format IS the render format: its skeleton is the view.
    const skeleton = skeletonFromPlan(compiled.plan);
    if (!renders(skeleton.tree)) return undefined;
    payload = stripServerAuthoritativeFields(
      assembleTree({ tree: skeleton.tree }),
    ) as unknown as UIPayload;
  }

  // A plan IS the mid-build state: its skeleton stays streaming until the app
  // document itself lands.
  if (compiledApp === undefined) return viewPart(appId, payload, true);
  // "The skeleton renders the moment the plan file exists" is a promise about
  // SECONDS, and the app half runs real host queries. So the skeleton goes out
  // first and the same stream id is written again when the data lands — the
  // engine's own progressive behavior, and the reason successive views reconcile
  // in place instead of stacking.
  if (options.authoredApp !== undefined) {
    const skeleton = viewPart(appId, payload, true);
    if (skeleton !== undefined) options.emit(skeleton.streamId, skeleton.part);
  }
  let data: Record<string, Json> | undefined;
  /**
   * The app half FAILED, as opposed to answering with nothing.
   *
   * Settling alone is honest about the spinner and dishonest about the data: every
   * unresolved binding renders "—" (packages/ui branded.tsx), so a failed load is
   * indistinguishable from "you have no spending". The operator gets the log
   * below; without this marker the user gets a plausible lie. So the failure rides
   * the payload as a server-written extra — the same channel `inClient`,
   * `pinDrift` and `streaming` ride — and the renderer says, in the surface, that
   * this view could not load its data.
   */
  let dataUnavailable = false;
  try {
    data = await options.authoredApp?.({ appId, compiled: compiledApp });
  } catch (error) {
    // The streaming skeleton is ALREADY on screen. Rethrowing here would leave it
    // there forever — the card stuck on "Building your view…", which is the exact
    // symptom the settle flag exists to prevent. `authored` can genuinely throw
    // (its own store reads and hold checks run before its internal try), so this
    // path is reachable. So the view settles AND says it could not load its data,
    // and the brokenness reaches the operator here and the harness through
    // `validate`.
    dataUnavailable = true;
    console.error(
      `[vendo] the app half of ${appId} failed; the view settles without its data — ${safeErrorMessage(error)}`,
    );
  }
  // The app half has run: this is the finished paint, so it SETTLES.
  return viewPart(appId, {
    ...payload,
    ...(data === undefined ? {} : { data }),
    ...(dataUnavailable ? { dataUnavailable: true } : {}),
  }, false);
}

/**
 * Wrap a workspace so a commit that lands a hot-path file emits its view. Every
 * other operation passes straight through, so the result is still a `WorkspaceFs`.
 */
export function wrapWorkspaceForRender(workspace: WorkspaceFs, options: RenderSeamOptions): WorkspaceFs {
  /** True iff this path put a view on screen — what the plan's yield is keyed on. */
  const emitFor = async (path: string): Promise<boolean> => {
    if (hotPathAppId(path) === undefined) return false;
    try {
      // Read back what the store now holds rather than trusting a remembered
      // argument: append, encoding and any store-side normalization land here.
      const content = await workspace.readFile(path);
      const view = await viewForWrite(path, content, options);
      if (view === undefined) return false;
      options.emit(view.streamId, view.part);
      return true;
    } catch {
      // A view is a courtesy on top of a landed commit. It can never fail one.
      return false;
    }
  };

  return new Proxy(workspace, {
    // `receiver` is deliberately NOT forwarded to Reflect.get: a method read off
    // the proxy and then called would run with `this` === proxy, and any real
    // façade using `#private` fields (lane B's may) throws on the first access.
    // Binding to the target keeps `this` the real object, which also stops writes
    // from re-entering this trap.
    get(target, property) {
      if (property !== "commit") {
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      const original = Reflect.get(target, property) as
        | ((opts?: { message?: string }) => Promise<CommitResult>)
        | undefined;
      if (typeof original !== "function") return original;
      return async (opts?: { message?: string }): Promise<CommitResult> => {
        const result = await original.call(target, opts);
        // A conflict means nothing landed — the harness re-reads and re-applies,
        // and the last good view stays on screen until something actually does.
        if (result.status !== "ok") return result;
        // Both hot-path files of one app write the SAME stream id, so a commit
        // carrying both would have the plan's data-less skeleton land as one of
        // the two views — and since `changed` is sorted, `app.vendo` sorts first
        // and the plan would overwrite the finished app with a picture of it.
        // The app document is the better view by definition, so the plan yields
        // to it — but only to an app that ACTUALLY PAINTED. An `app.vendo` that
        // does not parse or does not render emits nothing, and a plan that yielded
        // to it would leave the pane blank for the whole turn: the one thing the
        // skeleton exists to prevent. So the app half runs first, and each plan
        // then paints unless its own app already did.
        const authored = new Set(
          result.changed
            .filter((path) => hotPathFile(path) === "app.vendo")
            .map((path) => hotPathAppId(path)),
        );
        const deferred: Array<{ path: string; appId: AppId }> = [];
        const painted = new Set<AppId>();
        for (const path of result.changed) {
          const appId = hotPathAppId(path);
          if (appId === undefined) continue;
          if (hotPathFile(path) === "plan.vendo" && authored.has(appId)) {
            deferred.push({ path, appId });
            continue;
          }
          if (await emitFor(path)) painted.add(appId);
        }
        for (const { path, appId } of deferred) {
          if (!painted.has(appId)) await emitFor(path);
        }
        return result;
      };
    },
  });
}
