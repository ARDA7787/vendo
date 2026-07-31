import type { Json, Principal, ThreadId } from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";
import type { ThreadRow } from "./types.js";
import { putThreadRow, THREAD_MESSAGES_AGGREGATE, threadFromRow } from "./rows.js";
import { iso, text } from "./utils.js";
import { parseThreadData } from "../validate.js";

/** 02-store §3 */
export function threadStore(store: VendoStore): {
  put(principal: Principal, thread: { id: ThreadId; messages: Json[] }): Promise<ThreadRow>;
  get(principal: Principal, id: ThreadId): Promise<ThreadRow | null>;
  list(principal: Principal): Promise<Array<{ id: ThreadId; createdAt: string; updatedAt: string }>>;
  delete(principal: Principal, id: ThreadId): Promise<void>;
} {
  const db = dbFor(store);
  return {
    async put(principal, thread) {
      const parsed = parseThreadData({ subject: principal.subject, messages: thread.messages }, thread.id);
      // Threads never cross subjects (03 §5): the guarded upsert refuses a
      // foreign-owned id atomically.
      return putThreadRow(db, {
        id: thread.id,
        subject: parsed.subject,
        messages: parsed.messages,
      });
    },
    async get(principal, id) {
      // v6 (build contract §6): the transcript is reassembled by seq from
      // vendo_thread_messages — the thread row holds metadata only.
      const result = await db.query(
        `SELECT t.id, t.subject, ${THREAD_MESSAGES_AGGREGATE("t")} AS messages,
                t.title, t.created_at, t.updated_at, t.revision FROM vendo_threads t
         WHERE t.id = $1 AND t.subject = $2`,
        [id, principal.subject],
      );
      return result.rows[0] ? threadFromRow(result.rows[0]) : null;
    },
    async list(principal) {
      const result = await db.query(
        `SELECT id, created_at, updated_at FROM vendo_threads WHERE subject = $1
         ORDER BY updated_at DESC, id DESC`,
        [principal.subject],
      );
      return result.rows.map((row) => ({
        id: text(row["id"]),
        createdAt: iso(row["created_at"]),
        updatedAt: iso(row["updated_at"]),
      }));
    },
    async delete(principal, id) {
      await db.query("DELETE FROM vendo_threads WHERE id = $1 AND subject = $2", [id, principal.subject]);
    },
  };
}

export type { ThreadRow } from "./types.js";
