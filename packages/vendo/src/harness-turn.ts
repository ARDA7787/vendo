/**
 * The composition seam that turns a `Harness` into a served turn.
 *
 * `@vendoai/harnesses` owns the runtime — building the `Turn`, mirroring tool
 * calls, persisting, emitting hot-path views. What it deliberately does NOT own
 * is anything that needs a `RunContext`, because a harness is permission-blind by
 * contract (§1). That leaves exactly this file's job: resolve the per-turn things
 * from the request's principal — the thread, the workspace, the `/host`
 * projection, the system prompt, the descriptor catalog — and hand the runtime a
 * `TurnRunInput`.
 *
 * It decides nothing about how to think. Every value below is a façade or a gate.
 */
import {
  VendoError,
  createTurnSkills,
  hostSkillFiles,
  isUnattended,
  type FilesAdapter,
  type Harness,
  type PackSkill,
  type Principal,
  type ResolvedModels,
  type RunContext,
  type ThreadId,
  type ToolDescriptor,
  type ToolRegistry,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  latestUserIntent,
  THREAD_ID_HEADER,
  ThreadRepository,
  upsertMessage,
  validateMessage,
  validateUpsert,
  type CapabilityMissConfig,
  type ToolBridgeOptions,
  type ToolSearchConfig,
} from "@vendoai/agent/internal";
import type { VendoGuard } from "@vendoai/guard";
import { threadMessageStore, workspaceStore, type VendoStore } from "@vendoai/store";
import {
  createDiscoveryRails,
  createHarnessRuntime,
  memoryHarnessStateStore,
  reportHire,
  vendo,
  type DiscoveryRails,
  type HarnessRuntimeDeps,
} from "@vendoai/harnesses";
import type { LanguageModel, UIMessage } from "ai";


export interface HarnessTurnsConfig {
  /** The host's chosen harness. Unset means `vendo()` — see {@link resolveHarness}. */
  harness?: Harness<never>;
  store: VendoStore;
  /** THE deployment's files adapter (`selectStore`), so workspace blobs are
   *  written where the erase cascade will look for them. */
  files: FilesAdapter;
  guard: VendoGuard;
  /** The guard-bound registry — the one choke point, already carrying the
   *  connect gate and unique-title assertion. */
  tools: ToolRegistry;
  /** Merged pack skills, projected into the read-only `/host/skills` mount. */
  packSkills: readonly PackSkill[];
  models: ResolvedModels<LanguageModel>;
  /** The venue-gated, guard-directions-carrying system prompt. Assembled per
   *  turn by composition because it needs the ctx a `Turn` does not carry. */
  system: (ctx: RunContext) => Promise<string | undefined>;
  /** The descriptor catalog the loadout and `find_tools` work over — projected for
   *  THIS ctx, so THE LAW's unattended filter decides what the model can even see,
   *  and search can never resolve its way back to a withheld tool. */
  descriptors: (ctx: RunContext) => Promise<ToolDescriptor[]>;
  /** The shipped `find_tools` rail: the search seam, the connect-required
   *  annotation, and the loadout caps. Unset → no discovery rail (`list()` offers
   *  everything projected), which is what the harness path carried before. */
  toolSearch?: ToolSearchConfig;
  /** The shipped capability-miss rail. Load-bearing for evaluation E1's fifth ask:
   *  an impossible request must produce an honest refusal, not an invention. */
  capabilityMiss?: CapabilityMissConfig;
  render?: HarnessRuntimeDeps["render"];
  /** The shipped tool-bridge rails composition owns, per turn (`toolOutputCap`,
   *  the connect `preflight`, the capability-miss `onCall`). */
  bridge?: (ctx: RunContext, threadId: ThreadId) => HarnessRuntimeDeps["bridge"];
  /** Test seam only; production uses the frozen APPROVAL_WAIT_MS. */
  approvalWaitMs?: number;
}

export interface HarnessTurns {
  /** One turn. Mirrors `VendoAgent.stream`'s signature so the wire route reads
   *  the same either way — including the `x-vendo-thread-id` response header. */
  stream(input: {
    threadId?: string;
    message: UIMessage;
    ctx: RunContext;
    signal?: AbortSignal;
  }): Promise<Response>;
  /** The workspace as one principal sees it this turn. Exposed for the host and
   *  for the undo/history doors; `open` builds a fresh path index per call. */
  workspace(principal: Principal, opts?: { host?: Record<string, string> }): Promise<WorkspaceFs>;
}

export function createHarnessTurns(config: HarnessTurnsConfig): HarnessTurns {
  const threads = new ThreadRepository(config.store);
  // LAZY, and the laziness is load-bearing twice over.
  //
  // `threadMessageStore` and `workspaceStore` both resolve a SQL handle
  // (`dbFor`) as their first act. Building them at compose would (a) do work
  // inside `createVendo`, which the common edge wiring calls at module init where
  // Workers forbids it, and (b) throw "Unknown VendoStore handle" outright for a
  // hosted store — which has no local SQL and, in wave 1, no workspace or
  // transcript door of its own. Deferred, a hosted deployment composes exactly as
  // before and only a host that actually drives a harness turn meets the gap.
  let sql: { transcript: ReturnType<typeof threadMessageStore<UIMessage>>; workspaces: ReturnType<typeof workspaceStore> } | undefined;
  const sqlDoors = (): NonNullable<typeof sql> => {
    if (sql === undefined) {
      try {
        sql = {
          transcript: threadMessageStore<UIMessage>(config.store),
          workspaces: workspaceStore(config.store, { files: config.files }),
        };
      } catch (cause) {
        throw new VendoError(
          "not-implemented",
          "Serving a turn through a harness needs a SQL-backed store: the transcript and the workspace "
          + "(build contract §3.3 / §6) are tables. The configured store has no SQL handle — the Cloud "
          + "hosted store does not serve the workspace or per-message transcript doors yet. Pass "
          + "`store: postgres(url)` (or the local default) to use `harness:`.",
          { cause },
        );
      }
    }
    return sql;
  };
  // Hoisted, NOT per turn: `turn.state` is read on the turn AFTER the one that
  // wrote it (§1.3), so a per-turn store would hand every session-owning harness
  // a blank slate forever.
  const harnessState = memoryHarnessStateStore();

  /**
   * The `/host` mount for this deployment: pack skills as SKILL.md files.
   *
   * A plain value recomputed per turn rather than stored rows — a pack skill is a
   * code value the host's own deploy updates, so there is nothing to migrate,
   * invalidate, or erase (core `skills.ts`).
   */
  const hostProjection = (): Record<string, string> => hostSkillFiles(config.packSkills);

  /**
   * Who thinks. `config.harness` if the host chose one, else `vendo()`.
   *
   * The system prompt is deliberately NOT a dep here. It used to be, and that is
   * exactly what made the documented `harness: vendo()` opt-in think with an empty
   * prompt: a named harness is constructed by the HOST, at boot, so composition
   * has no seam to hand it anything. It rides `Turn.system` instead (core §1
   * amendment), which the runtime delivers to every harness — named, defaulted, or
   * a host's own — off ONE assembly.
   *
   * `vendo()` no longer takes a descriptor catalog either. It reads
   * `turn.tools.list()` like any other harness, which is what puts every harness on
   * the same discovery rail: the loadout, `find_tools` and the curated menu are the
   * RUNTIME's, so a host's own thinker gets them without asking.
   */
  const defaultHarness = vendo({ onHire: reportHire }) as unknown as Harness<never>;
  const resolveHarness = (): Harness<never> => config.harness ?? defaultHarness;

  /**
   * The per-THREAD searched-in set, exactly as `createAgent` keeps one: a tool
   * discovered through `find_tools` stays callable for the rest of the
   * conversation, and the LRU cap bounds memory in a long-lived process where
   * threads are never evicted.
   */
  const loadedTools = new Map<string, Set<string>>();
  const MAX_LOADED_THREADS = 1024;
  const loadedFor = (threadId: string): Set<string> => {
    const existing = loadedTools.get(threadId);
    if (existing !== undefined) {
      loadedTools.delete(threadId);
      loadedTools.set(threadId, existing); // touch: most-recently-used
      return existing;
    }
    const fresh = new Set<string>();
    loadedTools.set(threadId, fresh);
    while (loadedTools.size > MAX_LOADED_THREADS) {
      const oldest = loadedTools.keys().next().value;
      if (oldest === undefined) break;
      loadedTools.delete(oldest);
    }
    return fresh;
  };

  /**
   * This turn's discovery rails. Every input is ctx-shaped, which is why they are
   * built here and not at compose: the projected catalog, the connection-scoped
   * seed, the host's surface menu, and the user's latest intent.
   *
   * The seed and the menu are resolved BESIDE each other and each degrades on
   * failure rather than failing the turn — the shipped path's own rule. A failed
   * menu degrades to unrestricted (the composition seam owns the warning); an
   * EMPTY menu is a real answer and must not read as unrestricted, which is why
   * `undefined` and `[]` are kept apart.
   */
  const discoveryFor = async (
    ctx: RunContext,
    threadId: ThreadId,
    messages: readonly UIMessage[],
  ): Promise<DiscoveryRails | undefined> => {
    if (config.toolSearch === undefined && config.capabilityMiss === undefined) return undefined;
    let seedNames: string[] | undefined;
    if (config.toolSearch?.seed !== undefined) {
      try {
        seedNames = await config.toolSearch.seed(ctx);
      } catch {
        seedNames = undefined;
      }
    }
    let menuNames: readonly string[] | undefined;
    if (config.toolSearch?.menu !== undefined) {
      try {
        menuNames = await config.toolSearch.menu(ctx);
      } catch {
        menuNames = undefined;
      }
    }
    return createDiscoveryRails({
      descriptors: await config.descriptors(ctx),
      ctx,
      loaded: loadedFor(threadId),
      ...(config.toolSearch === undefined ? {} : { toolSearch: config.toolSearch }),
      ...(seedNames === undefined ? {} : { seedNames }),
      ...(menuNames === undefined ? {} : { menuNames }),
      // A search hit outside the built catalog was lazily expanded during the
      // search itself; re-reading the PROJECTED catalog resolves it, so the same
      // LAW filter applies to what search can reach.
      resolve: async (names) => (await config.descriptors(ctx)).filter((d) => names.includes(d.name)),
      ...(config.capabilityMiss === undefined
        ? {}
        : {
            capabilityMiss: {
              config: config.capabilityMiss,
              intent: latestUserIntent([...messages]),
              threadId,
            },
          }),
    });
  };

  return {
    workspace: (principal, opts) =>
      sqlDoors().workspaces.open(principal, { host: opts?.host ?? hostProjection() }),

    async stream(input) {
      validateMessage(input?.message);
      // The thread is resolved through the SHIPPED repository: same id pattern,
      // same "already in use" refusal for a foreign thread, same title
      // derivation — and `thread.messages` is the canonical transcript read back
      // from `vendo_thread_messages`.
      const thread = await threads.resolve(input.threadId as ThreadId | undefined, input.ctx);

      // THE CONSTRAINT (lane A's verifier): `TurnRunInput.messages` is
      // STORE-SOURCED. The client contributes at most this one message, and
      // `validateUpsert` is the shipped rule for whether it may — a fresh user
      // message, or an answer to a pending approval, and nothing else.
      //
      // Wiring the client's posted transcript instead is the bug that hides
      // here: the runtime flips a superseded `approval-requested` part to
      // abandoned and persists the flip, so a client holding the PRE-flip copy
      // re-posts an assistant message that no longer matches the store. That is
      // a history-forging attempt by the validator's rules, so it throws — and it
      // throws on every subsequent turn too, for as long as that client keeps
      // sending its stale copy. The thread becomes permanently unusable for them.
      validateUpsert(thread.messages, input.message);
      upsertMessage(thread.messages, input.message);

      // The thread ROW has to exist before the runtime writes message rows:
      // `threadMessageStore.upsert` sources its INSERT from `vendo_threads`
      // joined on the subject, so a missing row is refused rather than created.
      // This one write also lands the user's message and refreshes the listing
      // title, exactly as a `createAgent` turn's persist does.
      await threads.persist(thread, [input.message]);

      const { transcript, workspaces } = sqlDoors();
      const workspace = await workspaces.open(input.ctx.principal, { host: hostProjection() });
      const runtime = createHarnessRuntime({
        tools: config.tools,
        guard: config.guard,
        // Read off THIS turn's mount, so a skill the host stopped shipping is
        // gone the moment they deploy — no stale copy to invalidate.
        skills: createTurnSkills(workspace),
        transcript,
        harnessState,
        ...(config.render === undefined ? {} : { render: config.render }),
        ...(config.bridge === undefined
          ? {}
          : { bridge: config.bridge(input.ctx, thread.id) as ToolBridgeOptions | undefined }),
        ...(config.approvalWaitMs === undefined ? {} : { approvalWaitMs: config.approvalWaitMs }),
      });

      const discovery = await discoveryFor(input.ctx, thread.id, thread.messages);
      // Assembled once, per turn, for WHOEVER thinks. The venue gate and the
      // guard's directions live in here, which is why it is composition's job and
      // not the harness's.
      const system = await config.system(input.ctx);
      const response = await runtime.run<never>({
        harness: resolveHarness(),
        threadId: thread.id,
        messages: thread.messages,
        ctx: input.ctx,
        workspace,
        models: config.models,
        ...(system === undefined ? {} : { system }),
        ...(discovery === undefined ? {} : { discovery }),
        // §1.4 — presence is proof, and `isUnattended` is the one predicate that
        // decides it. Interactive turns await the tap inside `call()`; the rest
        // fail loudly with a standing card.
        interactive: !isUnattended(input.ctx),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // A caller may begin without an id; hand the effective one back on every
      // turn, like `createAgent` does, so the wire can register turn liveness.
      response.headers.set(THREAD_ID_HEADER, thread.id);
      return response;
    },
  };
}
