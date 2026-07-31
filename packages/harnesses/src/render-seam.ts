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
 * `HarnessEvent` stays closed — a harness cannot yield a view, by construction.
 *
 * The interception point is the workspace façade, because that is what a façade
 * tool edit, in-process bash, and a sandbox mid-turn sync all funnel through.
 */
import {
  VENDO_TREE_FORMAT,
  compilePlan,
  compileWire,
  vendoViewPartSchema,
  vendoViewStreamId,
  type AppId,
  type Json,
  type Tree,
  type UIPayload,
  type VendoViewPart,
  type WorkspaceFs,
} from "@vendoai/core";
import { skeletonFromPlan } from "@vendoai/apps";

/** §1.6 — the two files that sync mid-turn. Everything else waits for turn end. */
export const HOT_PATH_FILES = ["app.vendo", "plan.vendo"] as const;

/** §3.1, frozen: `/user/apps/<appId>/app.vendo`. `appId` is the store's app id
 *  verbatim, and a path's meaning never depends on who wrote it. */
const HOT_PATH = /^\/user\/apps\/(app_[^/]+)\/(app\.vendo|plan\.vendo)$/;

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
 * Relocated from `packages/apps/src/open.ts` (`stripServerAuthoritativeFields`).
 * `inClient` and `pinDrift` are the server's answers, not the app's: echoing an
 * app-authored value back would let a document dictate its own trust level.
 */
function stripServerAuthoritativeFields<T extends object>(payload: T): T {
  delete (payload as { inClient?: unknown }).inClient;
  delete (payload as { pinDrift?: unknown }).pinDrift;
  return payload;
}

/**
 * Relocated from `packages/apps/src/runtime.ts` (`assembleTree`): the tree plus
 * its generated component sources, lifted to payload level, which is the shape
 * the client mounts.
 */
function assembleTree(source: {
  tree: Tree;
  components?: Record<string, string>;
  componentTools?: Record<string, string[]>;
}): UIPayload {
  const payload = structuredClone(source.tree) as unknown as UIPayload;
  if (source.components !== undefined && Object.keys(source.components).length > 0) {
    payload.components = source.components;
  }
  if (source.componentTools !== undefined && Object.keys(source.componentTools).length > 0) {
    payload.componentTools = source.componentTools;
  }
  return stripServerAuthoritativeFields(payload);
}

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
   * Progressive query-resolver fill (§1.6). The resolver lives in
   * `packages/apps` and needs the app's caller and document, neither of which a
   * raw file write carries — so composition injects it and the seam calls it.
   * Unwired, the view still renders: the skeleton first, data when the app's own
   * open path resolves it.
   */
  fillData?: (appId: AppId, payload: UIPayload) => Record<string, Json> | undefined;
}

/** The view a parsing hot-path write produces, or undefined if it does not parse. */
export function viewForWrite(
  path: string,
  content: string,
  options: RenderSeamOptions,
): { streamId: string; part: VendoViewPart } | undefined {
  const appId = hotPathAppId(path);
  const file = hotPathFile(path);
  if (appId === undefined || file === undefined) return undefined;

  let payload: UIPayload | undefined;
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
    payload = assembleTree({ tree: compiled.tree, components: compiled.components });
  } else {
    const facts = options.facts?.() ?? { tools: [], components: [] };
    const compiled = compilePlan(content, facts);
    if (compiled.plan === undefined) return undefined;
    // The plan format IS the render format: its skeleton is the view.
    const skeleton = skeletonFromPlan(compiled.plan);
    if (!renders(skeleton.tree)) return undefined;
    payload = assembleTree({ tree: skeleton.tree });
  }

  const data = options.fillData?.(appId, payload);
  if (data !== undefined) payload.data = data;
  // The renderer's own gate decides what reaches the wire — a payload it would
  // reject is not a view, and a half-rendered app is worse than the last good one.
  const parsed = vendoViewPartSchema.safeParse({ type: "data-vendo-view", appId, payload });
  if (!parsed.success) return undefined;
  return { streamId: vendoViewStreamId(appId), part: parsed.data };
}

/**
 * Wrap a workspace so hot-path writes emit views. Every other operation passes
 * straight through — including `commit`, so the result is still a `WorkspaceFs`.
 */
export function wrapWorkspaceForRender(workspace: WorkspaceFs, options: RenderSeamOptions): WorkspaceFs {
  const emitFor = async (path: string): Promise<void> => {
    if (hotPathAppId(path) === undefined) return;
    try {
      // Read back what the store now holds rather than trusting the argument:
      // append, encoding, and any store-side normalization all land here.
      const content = await workspace.readFile(path);
      const view = viewForWrite(path, content, options);
      if (view !== undefined) options.emit(view.streamId, view.part);
    } catch {
      // A view is a courtesy on top of a completed write. It can never fail one.
    }
  };

  return new Proxy(workspace, {
    get(target, property, receiver) {
      if (property !== "writeFile" && property !== "appendFile") {
        return Reflect.get(target, property, receiver);
      }
      const original = Reflect.get(target, property, receiver) as
        | ((...args: unknown[]) => Promise<void>)
        | undefined;
      if (typeof original !== "function") return original;
      return async (...args: unknown[]): Promise<void> => {
        await original.apply(target, args);
        await emitFor(args[0] as string);
      };
    },
  });
}

/** Re-exported so callers building a payload by hand agree with the seam. */
export { VENDO_TREE_FORMAT };
