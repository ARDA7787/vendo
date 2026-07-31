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

const segment = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/** The key prefix holding one owner's workspace blobs. Base64url segments keep
    every key URL-safe as written (no escaping decisions in the S3 adapter) and
    give the erase cascade an exact prefix to match. */
export const workspaceBlobPrefix = (owner: string): string => `ws/${segment(owner)}/`;

/** Blob keys carry the revision, so a history row and the live row never share
    a blob — popping one never strands the other. */
const blobKey = (owner: string, path: string, revision: number): string =>
  `${workspaceBlobPrefix(owner)}${segment(path)}/r${revision}`;

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

/** Row-level access to the workspace pair (build contract §3.3). Content lands
 *  inline or in the files adapter; every overwrite appends the superseded
 *  revision to history, and undo pops it back off. */
export interface WorkspaceRows {
  /** The path index the façade builds at turn start (§3.2). */
  index(owners: string[]): Promise<WorkspaceFileMeta[]>;
  read(owner: string, path: string): Promise<Uint8Array | undefined>;
  /** Last write wins for /user (§3.2). `changed: false` means the bytes were
      already stored — no revision bump, no history row, nothing to sync. */
  write(
    owner: string,
    path: string,
    bytes: Uint8Array,
    intent?: string,
  ): Promise<{ changed: boolean; revision: number; updatedAt: IsoDateTime }>;
  remove(owner: string, path: string): Promise<boolean>;
  history(owner: string, path: string): Promise<WorkspaceHistoryEntry[]>;
  /** Walks history backwards: restores the newest superseded revision and
      consumes it, so a second call walks one step further back. */
  undo(owner: string, path: string): Promise<{ status: "ok"; revision: number } | { status: "empty" }>;
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

  /** Put the bytes where they belong and hand back the two column values. */
  const place = async (
    owner: string,
    path: string,
    revision: number,
    bytes: Uint8Array,
  ): Promise<StoredContent> => {
    const inline = inlineText(bytes);
    if (inline !== undefined) return { content: inline, blobRef: undefined };
    const key = blobKey(owner, path, revision);
    await files.put(key, bytes);
    return { content: undefined, blobRef: key };
  };

  const dropBlob = async (stored: StoredContent): Promise<void> => {
    if (stored.blobRef !== undefined) await files.delete(stored.blobRef);
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

  const currentOf = async (
    owner: string,
    path: string,
  ): Promise<{ revision: number; updatedAt: IsoDateTime; stored: StoredContent } | undefined> => {
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

  /** The write path. /user is last-write-wins (§3.2), and one session owns one
   *  workspace, so these statements need no transaction; wave 3's /orgs CAS is
   *  what arms `revision` in the UPDATE's WHERE. */
  const put = async (
    owner: string,
    path: string,
    bytes: Uint8Array,
    prior: { revision: number; stored: StoredContent } | undefined,
    options: { intent?: string; recordHistory: boolean },
  ): Promise<{ revision: number; updatedAt: IsoDateTime }> => {
    const revision = (prior?.revision ?? 0) + 1;
    const stored = await place(owner, path, revision, bytes);
    const now = new Date().toISOString();
    // Without a history row, nothing references the revision being replaced —
    // so its blob (if any) goes with it rather than lingering unreachable.
    if (prior !== undefined && !options.recordHistory) await dropBlob(prior.stored);
    if (prior !== undefined && options.recordHistory) {
      await db.query(
        `INSERT INTO vendo_workspace_history (id, path, owner, revision, content, blob_ref, intent, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `wsh_${globalThis.crypto.randomUUID()}`,
          path,
          owner,
          prior.revision,
          prior.stored.content ?? null,
          prior.stored.blobRef ?? null,
          options.intent ?? null,
          now,
        ],
      );
    }
    await db.query(
      `INSERT INTO vendo_workspace_files (path, owner, content, blob_ref, bytes, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (path, owner) DO UPDATE SET content = EXCLUDED.content,
         blob_ref = EXCLUDED.blob_ref, bytes = EXCLUDED.bytes,
         revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`,
      [path, owner, stored.content ?? null, stored.blobRef ?? null, bytes.byteLength, revision, now],
    );
    await trim(owner, path);
    return { revision, updatedAt: now };
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

    async write(owner, path, bytes, intent) {
      const prior = await currentOf(owner, path);
      if (prior !== undefined) {
        const stored = await load(prior.stored);
        if (stored !== undefined && sameBytes(stored, bytes)) {
          return { changed: false, revision: prior.revision, updatedAt: prior.updatedAt };
        }
      }
      const written = await put(owner, path, bytes, prior, {
        ...(intent === undefined ? {} : { intent }),
        recordHistory: true,
      });
      return { changed: true, ...written };
    },

    async remove(owner, path) {
      const dropped = await db.query(
        "DELETE FROM vendo_workspace_files WHERE path = $1 AND owner = $2 RETURNING content, blob_ref",
        [path, owner],
      );
      const row = dropped.rows[0];
      if (row === undefined) return false;
      await dropBlob(storedOf(row));
      // The file is gone, so its past revisions have nothing to undo onto.
      const history = await db.query(
        "DELETE FROM vendo_workspace_history WHERE path = $1 AND owner = $2 RETURNING content, blob_ref",
        [path, owner],
      );
      for (const entry of history.rows) await dropBlob(storedOf(entry));
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
      const stored = storedOf(row);
      const bytes = await load(stored);
      if (bytes === undefined) return { status: "empty" };
      const prior = await currentOf(owner, path);
      // No history row for the state undo discards: appending one would make it
      // the newest entry and the next undo would restore it, toggling between
      // two revisions instead of walking back. Undo has no redo (wave 1).
      const written = await put(owner, path, bytes, prior, { recordHistory: false });
      // Consumed: the restored revision leaves history, so the next undo walks
      // one step further back.
      await db.query("DELETE FROM vendo_workspace_history WHERE id = $1", [text(row["id"])]);
      await dropBlob(stored);
      return { status: "ok", revision: written.revision };
    },
  };
}
