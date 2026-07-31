import { VendoError, type Principal, type ThreadId } from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";

/** The least a transcript row must have for this store to key it: an id.
 *
 *  Build contract §6 writes the surface in terms of the ai-SDK's `UIMessage`,
 *  and lane A's runtime instantiates it that way — `threadMessageStore<UIMessage>(store)`
 *  — so callers get the frozen signature exactly. The parameter stays generic
 *  here because `@vendoai/store` (like `@vendoai/core`) deliberately does not
 *  depend on `ai`: the store never interprets a message, only orders and
 *  returns it. Importing the type would put `ai` + a `zod` floor into the
 *  store's published peer set for one type annotation, which
 *  `scripts/dependency-guard.mjs` rejects outright. See the lane report. */
export interface ThreadMessageLike {
  id: string;
}

/** Build contract §6 — one row per transcript message.
 *
 *  Why this exists: rewriting a whole `messages` array on every turn is
 *  O(messages²) over a conversation. One row per message makes a turn's write
 *  O(new messages), which is the property E6 measures.
 *
 *  Two invariants the SQL below enforces rather than trusts:
 *  - **`seq` is the only ordering authority.** Approval flips rewrite older
 *    messages, so `updated_at` does not order a transcript and is never read
 *    for ordering.
 *  - **Threads never cross subjects** (03 §5). The thread row is the ownership
 *    record; every read and write here joins it under `principal.subject`, so a
 *    foreign thread id reads as empty and writes to it are refused.
 */
export function threadMessageStore<M extends ThreadMessageLike = ThreadMessageLike>(
  store: VendoStore,
): {
  /** One row per message; per-row CAS on `revision` for edits. */
  upsert(principal: Principal, threadId: ThreadId, message: M, seq: number): Promise<void>;
  /** Reassembled by seq, oldest → newest. */
  list(principal: Principal, threadId: ThreadId): Promise<M[]>;
} {
  const db = dbFor(store);
  return {
    async upsert(principal, threadId, message, seq) {
      // The ownership gate is the INSERT's own source of rows: the SELECT
      // yields nothing unless a vendo_threads row with this id belongs to this
      // subject, so a foreign (or absent) thread writes nothing and we refuse.
      // Doing it in ONE statement closes the TOCTOU window a read-then-write
      // pre-check leaves open (the same reasoning as putThreadRow's guarded
      // upsert), and it is why the answer cannot be "insert anyway".
      const messageId = message.id;
      if (typeof messageId !== "string" || messageId === "") {
        throw new VendoError("validation", "a thread message needs a non-empty id");
      }
      const result = await db.query(
        `INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
         SELECT t.id, $2, $3, $4::jsonb, $5, $5 FROM vendo_threads t
           WHERE t.id = $1 AND t.subject = $6
         ON CONFLICT (thread_id, id) DO UPDATE
           SET seq = EXCLUDED.seq, message = EXCLUDED.message,
               updated_at = EXCLUDED.updated_at,
               revision = vendo_thread_messages.revision + 1
         RETURNING thread_id`,
        [threadId, messageId, seq, JSON.stringify(message), new Date().toISOString(), principal.subject],
      );
      if (result.rows[0] === undefined) {
        throw new VendoError("conflict", `thread ${threadId} does not belong to this subject`);
      }
    },
    async list(principal, threadId) {
      const result = await db.query(
        `SELECT m.message FROM vendo_thread_messages m
         JOIN vendo_threads t ON t.id = m.thread_id
         WHERE m.thread_id = $1 AND t.subject = $2
         ORDER BY m.seq ASC`,
        [threadId, principal.subject],
      );
      return result.rows.map((row) => row["message"] as M);
    },
  };
}
