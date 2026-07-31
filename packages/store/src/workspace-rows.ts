import type { FilesAdapter, IsoDateTime } from "@vendoai/core";
import type { Db } from "./db.js";
import { iso, text } from "./helpers/utils.js";

/** Build contract §3.3 — inline in `content` up to this size; past it the row
    carries a `blob_ref` into the files adapter instead. */
export const WORKSPACE_INLINE_MAX_BYTES = 65_536;

/** Build contract §3.3 — retention per path, same as app history. */
export const WORKSPACE_HISTORY_LIMIT = 50;

/** One file's metadata. Content is fetched separately (it may live in a blob). */
export interface WorkspaceFileMeta {
  path: string;
  owner: string;
  bytes: number;
  revision: number;
  updatedAt: IsoDateTime;
}

/** One superseded revision: which revision it was, and why it was replaced.
    The content itself stays behind the table — `undo` restores it; nothing else
    needs to read it, and fetching it here would mean one blob read per entry. */
export interface WorkspaceHistoryEntry {
  revision: number;
  intent?: string;
  at: IsoDateTime;
}

/**
 * A blob key is a random id and nothing else. The ROW is the pointer: keys
 * derived from owner/path/revision were guessable across tenants, and they
 * broke every operation that moves a row without rewriting content (adoption
 * flips `owner`, so an owner-keyed blob became unreachable by the new owner's
 * erase). Random ids make `blob_ref` the single source of truth, which is what
 * lets every delete path collect exactly the blobs it orphans.
 */
const mintBlobRef = (): string => `wsb_${globalThis.crypto.randomUUID()}`;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The `content` column is text, so bytes only go inline when they ARE text:
 *  valid UTF-8, no NUL. Anything else (uploads, images) takes the blob path
 *  regardless of size — which is also where every oversized document goes. */
function inlineText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > WORKSPACE_INLINE_MAX_BYTES) return undefined;
  let decoded: string;
  try {
    decoded = utf8.decode(bytes);
  } catch {
    return undefined; // not UTF-8 — store as a blob
  }
  return decoded.includes("\u0000") ? undefined : decoded;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

interface StoredContent {
  content: string | undefined;
  blobRef: string | undefined;
}

interface Current {
  revision: number;
  updatedAt: IsoDateTime;
  stored: StoredContent;
}

/**
 * A write whose content is already placed (inline decided, blob uploaded) but
 * whose rows have not been touched yet — the unit `commit()` preflights with.
 * Everything that can deterministically fail (an over-cap file, an adapter
 * refusal) fails while producing one of these, so a commit either lands every
 * file or writes no row at all.
 */
export interface PreparedWrite {
  path: string;
  bytes: number;
  revision: number;
  stored: StoredContent;
  prior: Current | undefined;
}

/** What one step of `undo` did. */
export type UndoOutcome =
  | { status: "ok"; revision: number }
  | { status: "content-missing"; revision: number }
  | { status: "empty" };

/** Row-level access to the workspace pair (build contract §3.3). Content lands
 *  inline or in the files adapter; every overwrite appends the superseded
 *  revision to history, and undo pops it back off. */
export interface WorkspaceRows {
  /** The path index the façade builds at turn start (§3.2). */
  index(owners: string[]): Promise<WorkspaceFileMeta[]>;
  read(owner: string, path: string): Promise<Uint8Array | undefined>;
  /** Place the content and reserve a revision, touching no row. `unchanged`
      means the bytes are already stored: no revision bump, nothing to sync. */
  prepare(owner: string, path: string, bytes: Uint8Array): Promise<PreparedWrite | "unchanged">;
  /** Land a prepared write: history row for the superseded revision, then the
      file row. Last write wins for /user (§3.2). */
  land(owner: string, prepared: PreparedWrite, intent?: string): Promise<{ revision: number; updatedAt: IsoDateTime }>;
  /** Drop a prepared write that will never land, so its blob is not orphaned. */
  discard(prepared: PreparedWrite): Promise<void>;
  /** Deleting records the content it removed (history is append-only, §3.3), so
      `undo` can bring the file back. Returns false if there was nothing there. */
  remove(owner: string, path: string, intent?: string): Promise<boolean>;
  history(owner: string, path: string): Promise<WorkspaceHistoryEntry[]>;
  /** Walks history backwards: restores the newest superseded revision and
      consumes it, so a second call walks one step further back.
      `content-missing` is a revision whose blob is gone — it is consumed too,
      rather than wedging the walk on a revision that can never come back. */
  undo(owner: string, path: string): Promise<UndoOutcome>;
  /** Every blob the given rows point at, so a caller deleting rows outside this
      module (the erase cascade, the adoption merge) can delete the content too. */
  blobRefsWhere(clause: { table: "vendo_workspace_files" | "vendo_workspace_history"; where: string; params: unknown[] }): Promise<string[]>;
}

export function workspaceRows(db: Db, files: FilesAdapter): WorkspaceRows {
  const load = async (stored: StoredContent): Promise<Uint8Array | undefined> => {
    if (stored.content !== undefined) return encode(stored.content);
    if (stored.blobRef === undefined) return undefined;
    return (await files.get(stored.blobRef))?.bytes;
  };

  const storedOf = (row: Record<string, unknown>): StoredContent => ({
    content: typeof row["content"] === "string" ? row["content"] : undefined,
    blobRef: typeof row["blob_ref"] === "string" ? row["blob_ref"] : undefined,
  });

  const dropBlob = async (stored: StoredContent): Promise<void> => {
    if (stored.blobRef !== undefined) await files.delete(stored.blobRef);
  };

  const currentOf = async (owner: string, path: string): Promise<Current | undefined> => {
    const result = await db.query(
      "SELECT content, blob_ref, revision, updated_at FROM vendo_workspace_files WHERE path = $1 AND owner = $2",
      [path, owner],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      revision: Number(row["revision"]),
      updatedAt: iso(row["updated_at"]),
      stored: storedOf(row),
    };
  };

  /** Revisions are monotonic per path for its whole life — including across a
   *  delete, so a re-created file never reuses a number history still holds
   *  (which would make `ORDER BY revision DESC` surface stale revisions first). */
  const highestRevision = async (owner: string, path: string): Promise<number> => {
    const result = await db.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(revision) FROM vendo_workspace_files WHERE path = $1 AND owner = $2), 0),
         COALESCE((SELECT MAX(revision) FROM vendo_workspace_history WHERE path = $1 AND owner = $2), 0)
       ) AS revision`,
      [path, owner],
    );
    return Number(result.rows[0]?.["revision"] ?? 0);
  };

  const appendHistory = async (
    owner: string,
    path: string,
    superseded: Current,
    intent: string | undefined,
    at: IsoDateTime,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO vendo_workspace_history (id, path, owner, revision, content, blob_ref, intent, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        `wsh_${globalThis.crypto.randomUUID()}`,
        path,
        owner,
        superseded.revision,
        superseded.stored.content ?? null,
        superseded.stored.blobRef ?? null,
        intent ?? null,
        at,
      ],
    );
  };

  /** Retention (§3.3): keep the newest WORKSPACE_HISTORY_LIMIT revisions. */
  const trim = async (owner: string, path: string): Promise<void> => {
    const dropped = await db.query(
      `DELETE FROM vendo_workspace_history WHERE id IN (
         SELECT id FROM vendo_workspace_history WHERE path = $1 AND owner = $2
         ORDER BY revision DESC OFFSET $3
       ) RETURNING content, blob_ref`,
      [path, owner, WORKSPACE_HISTORY_LIMIT],
    );
    for (const row of dropped.rows) await dropBlob(storedOf(row));
  };

  /** Put the bytes where they belong and hand back the two column values. */
  const place = async (bytes: Uint8Array): Promise<StoredContent> => {
    const inline = inlineText(bytes);
    if (inline !== undefined) return { content: inline, blobRef: undefined };
    const key = mintBlobRef();
    await files.put(key, bytes);
    return { content: undefined, blobRef: key };
  };

  /** The write path. /user is last-write-wins (§3.2), and one session owns one
   *  workspace, so these statements need no transaction; wave 3's /orgs CAS is
   *  what arms `revision` in the UPDATE's WHERE. */
  const landRow = async (
    owner: string,
    prepared: PreparedWrite,
    options: { intent?: string; recordHistory: boolean },
  ): Promise<{ revision: number; updatedAt: IsoDateTime }> => {
    const now = new Date().toISOString();
    if (prepared.prior !== undefined && options.recordHistory) {
      await appendHistory(owner, prepared.path, prepared.prior, options.intent, now);
    }
    // Without a history row nothing references the revision being replaced, so
    // its blob goes with it rather than lingering unreachable.
    if (prepared.prior !== undefined && !options.recordHistory) await dropBlob(prepared.prior.stored);
    await db.query(
      `INSERT INTO vendo_workspace_files (path, owner, content, blob_ref, bytes, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (path, owner) DO UPDATE SET content = EXCLUDED.content,
         blob_ref = EXCLUDED.blob_ref, bytes = EXCLUDED.bytes,
         revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`,
      [
        prepared.path,
        owner,
        prepared.stored.content ?? null,
        prepared.stored.blobRef ?? null,
        prepared.bytes,
        prepared.revision,
        now,
      ],
    );
    await trim(owner, prepared.path);
    return { revision: prepared.revision, updatedAt: now };
  };

  return {
    async index(owners) {
      const result = await db.query(
        `SELECT path, owner, bytes, revision, updated_at FROM vendo_workspace_files
         WHERE owner = ANY($1::text[]) ORDER BY path ASC`,
        [owners],
      );
      return result.rows.map((row) => ({
        path: text(row["path"]),
        owner: text(row["owner"]),
        bytes: Number(row["bytes"]),
        revision: Number(row["revision"]),
        updatedAt: iso(row["updated_at"]),
      }));
    },

    async read(owner, path) {
      const current = await currentOf(owner, path);
      return current === undefined ? undefined : await load(current.stored);
    },

    async prepare(owner, path, bytes) {
      const prior = await currentOf(owner, path);
      if (prior !== undefined) {
        const stored = await load(prior.stored);
        if (stored !== undefined && sameBytes(stored, bytes)) return "unchanged";
      }
      return {
        path,
        bytes: bytes.byteLength,
        revision: (await highestRevision(owner, path)) + 1,
        stored: await place(bytes),
        prior,
      };
    },

    async land(owner, prepared, intent) {
      return await landRow(owner, prepared, {
        ...(intent === undefined ? {} : { intent }),
        recordHistory: true,
      });
    },

    async discard(prepared) {
      await dropBlob(prepared.stored);
    },

    async remove(owner, path, intent) {
      const current = await currentOf(owner, path);
      if (current === undefined) return false;
      // History is append-only (§3.3): the delete records what it removed, so
      // the blob stays — the history row is its pointer now — and undo can
      // bring the file back.
      await appendHistory(owner, path, current, intent, new Date().toISOString());
      await db.query("DELETE FROM vendo_workspace_files WHERE path = $1 AND owner = $2", [path, owner]);
      await trim(owner, path);
      return true;
    },

    async history(owner, path) {
      const result = await db.query(
        `SELECT revision, intent, at FROM vendo_workspace_history
         WHERE path = $1 AND owner = $2 ORDER BY revision DESC`,
        [path, owner],
      );
      return result.rows.map((row) => {
        const intent = row["intent"];
        return {
          revision: Number(row["revision"]),
          ...(typeof intent === "string" ? { intent } : {}),
          at: iso(row["at"]),
        };
      });
    },

    async undo(owner, path) {
      const previous = await db.query(
        `SELECT id, revision, content, blob_ref FROM vendo_workspace_history
         WHERE path = $1 AND owner = $2 ORDER BY revision DESC LIMIT 1`,
        [path, owner],
      );
      const row = previous.rows[0];
      if (row === undefined) return { status: "empty" };
      const consume = async (): Promise<void> => {
        await db.query("DELETE FROM vendo_workspace_history WHERE id = $1", [text(row["id"])]);
      };
      const stored = storedOf(row);
      const revision = Number(row["revision"]);
      const bytes = await load(stored);
      if (bytes === undefined) {
        // The content is gone from the files adapter, so this revision can never
        // be restored. Consume it anyway: leaving it would wedge every older
        // revision behind a step that can only ever fail.
        await consume();
        return { status: "content-missing", revision };
      }
      const prior = await currentOf(owner, path);
      // No history row for the state undo discards: appending one would make it
      // the newest entry and the next undo would restore it, toggling between
      // two revisions instead of walking back. Undo has no redo (wave 1).
      const written = await landRow(
        owner,
        { path, bytes: bytes.byteLength, revision: (await highestRevision(owner, path)) + 1, stored, prior },
        { recordHistory: false },
      );
      // Consumed: the restored revision leaves history, so the next undo walks
      // one step further back. Its blob is now the live row's, so it stays.
      await consume();
      return { status: "ok", revision: written.revision };
    },

    async blobRefsWhere({ table, where, params }) {
      const result = await db.query(
        `SELECT blob_ref FROM ${table} WHERE ${where} AND blob_ref IS NOT NULL`,
        params,
      );
      return result.rows.map((row) => text(row["blob_ref"]));
    },
  };
}
