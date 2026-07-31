// The filesystem shape lives in core (vendored from just-bash, Apache-2.0), so
// neither core nor the store depends on the bash interpreter at runtime.
import type {
  BufferEncoding,
  CommitResult,
  CpOptions,
  DirentEntry,
  FileContent,
  FsStat,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WorkspaceFs,
  WriteFileOptions,
} from "@vendoai/core";
import { safeErrorMessage, VendoError } from "@vendoai/core";
import type { PreparedWrite, WorkspaceFileMeta, WorkspaceRows } from "./workspace-rows.js";

/** Build contract §3.1 — the frozen layout. `/user` is the subject's, rw;
    `/host` is host-authored, ro for everyone (wave-1 `can()`, §8). No other
    top-level mount exists, and no path's meaning depends on who wrote it. */
export const USER_MOUNT = "/user";
export const HOST_MOUNT = "/host";

/** Intra-turn junk (§3.1): visible to the turn, never committed to the store.
    The bare path counts — a FILE called `/user/scratch` would otherwise persist
    and shadow the directory the layout reserves. */
const SCRATCH_MOUNT = "/user/scratch";

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

/** POSIX-shaped errors, matching the messages just-bash's own filesystems
    throw — bash prints them verbatim, so the wording is user-visible. */
const enoent = (op: string, path: string): Error =>
  new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
const erofs = (op: string, path: string): Error =>
  new Error(`EROFS: read-only file system, ${op} '${path}'`);
const eisdir = (op: string, path: string): Error =>
  new Error(`EISDIR: illegal operation on a directory, ${op} '${path}'`);
const enotdir = (op: string, path: string): Error =>
  new Error(`ENOTDIR: not a directory, ${op} '${path}'`);
const enotempty = (op: string, path: string): Error =>
  new Error(`ENOTEMPTY: directory not empty, ${op} '${path}'`);
const eexist = (op: string, path: string): Error =>
  new Error(`EEXIST: file already exists, ${op} '${path}'`);
/** The workspace is exactly two mounts (§3.1). A write anywhere else is a
    mistake — `/User/apps/...`, `/user/../x`, `/etc/passwd` — and silently
    accepting it would lose the data at commit with an `ok` status. */
const eacces = (op: string, path: string): Error =>
  new Error(
    `EACCES: permission denied, ${op} '${path}'`
      + ` (the workspace holds ${USER_MOUNT} and ${HOST_MOUNT} only)`,
  );

/** Resolve `.`/`..`, collapse slashes, drop the trailing one. Pure. */
export function normalizePath(path: string): string {
  if (path.includes("\u0000")) throw new Error(`ENOENT: path contains null byte, '${path}'`);
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

const dirnameOf = (path: string): string => {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
};

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** A file staged in memory this turn. Reads see it before the store does. */
interface Staged {
  bytes: Uint8Array;
  mtime: Date;
}

const encoder = new TextEncoder();

const toBytes = (content: FileContent, options?: WriteFileOptions | BufferEncoding): Uint8Array => {
  if (typeof content !== "string") return content;
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") {
    return encoder.encode(content);
  }
  return new Uint8Array(Buffer.from(content, encoding));
};

const fromBytes = (bytes: Uint8Array, options?: ReadFileOptions | BufferEncoding): string => {
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (encoding === undefined || encoding === null || encoding === "utf8" || encoding === "utf-8") {
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(bytes).toString(encoding);
};

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
};

const statOf = (kind: "file" | "directory", size: number, mtime: Date): FsStat => ({
  isFile: kind === "file",
  isDirectory: kind === "directory",
  isSymbolicLink: false,
  mode: kind === "file" ? FILE_MODE : DIR_MODE,
  size,
  mtime,
});

/**
 * Build contract §3.2 — just-bash's `IFileSystem` over the store.
 *
 * Two tiers, one namespace:
 *   - a **path index** built at turn start (`getAllPaths`/`resolvePath` are
 *     synchronous in just-bash, so the paths must be known without I/O), kept
 *     current on every write;
 *   - **content read through the store**, never cached — except for paths this
 *     turn has written, which stage in memory until `commit()`.
 *
 * Staging is what keeps the store write law at O(files changed): a `sed -i`
 * loop writing one file forty times is one row, one revision, one history
 * entry.
 *
 * The namespace is exactly the two mounts. A write anywhere else is refused
 * (`EACCES`) rather than accepted into memory and dropped at commit — bash's
 * own scratch belongs in `/user/scratch`, which the layout reserves for it.
 *
 * `/host/**` is a read-only overlay the caller supplies per turn, not store
 * rows: pack skills and host knowledge are code-defined (`PackSkill.body`,
 * contract §5), so projecting them per turn is always current, while a copy in
 * the store could go stale against the deployed packs.
 */
export class WorkspaceStoreFs implements WorkspaceFs {
  private readonly staged = new Map<string, Staged>();
  private readonly removed = new Set<string>();
  private readonly directories = new Set<string>();
  private readonly index: Map<string, WorkspaceFileMeta>;

  constructor(
    private readonly rows: WorkspaceRows,
    private readonly owner: string,
    index: WorkspaceFileMeta[],
    private readonly host: Map<string, Uint8Array>,
  ) {
    this.index = new Map(index.map((meta) => [meta.path, meta]));
  }

  /** Wave-1 `can()` (contract §8), in one predicate: a `/user/**` path belongs
      to its subject, `/host/**` is read-only for everyone. Anything else is
      turn-scoped memory and never persisted. */
  private storeBacked(path: string): boolean {
    return under(path, USER_MOUNT);
  }

  private readOnly(path: string): boolean {
    return under(path, HOST_MOUNT);
  }

  /** Every write goes through here: `/host` is read-only, and anything outside
      the two mounts is refused outright rather than accepted and dropped. */
  private assertWritable(op: string, path: string): void {
    if (this.readOnly(path)) throw erofs(op, path);
    if (!this.storeBacked(path)) throw eacces(op, path);
  }

  private persists(path: string): boolean {
    return this.storeBacked(path) && !under(path, SCRATCH_MOUNT);
  }

  /** Every path the turn can see: the store's index, the host overlay, and this
      turn's writes. */
  private livePaths(): string[] {
    const paths = new Set<string>();
    for (const path of this.index.keys()) if (!this.removed.has(path)) paths.add(path);
    for (const path of this.host.keys()) paths.add(path);
    for (const path of this.staged.keys()) paths.add(path);
    return [...paths];
  }

  private isFile(path: string): boolean {
    if (this.staged.has(path) || this.host.has(path)) return true;
    return this.index.has(path) && !this.removed.has(path);
  }

  /** Directories are implied by the paths under them (the store holds files,
      not directories), plus anything explicitly `mkdir`ed this turn. */
  private isDirectory(path: string): boolean {
    if (path === "/" || path === USER_MOUNT || path === HOST_MOUNT) return true;
    if (this.directories.has(path)) return true;
    return this.livePaths().some((candidate) => candidate.startsWith(`${path}/`));
  }

  private async bytesOf(op: string, path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const staged = this.staged.get(normalized);
    if (staged) return staged.bytes;
    const hosted = this.host.get(normalized);
    if (hosted) return hosted;
    if (this.isDirectory(normalized) && !this.isFile(normalized)) throw eisdir(op, path);
    if (!this.storeBacked(normalized) || this.removed.has(normalized) || !this.index.has(normalized)) {
      throw enoent(op, path);
    }
    const bytes = await this.rows.read(this.owner, normalized);
    if (bytes === undefined) throw enoent(op, path);
    return bytes;
  }

  private stage(path: string, bytes: Uint8Array): void {
    this.staged.set(path, { bytes, mtime: new Date() });
    this.removed.delete(path);
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return fromBytes(await this.bytesOf("open", path), options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return await this.bytesOf("open", path);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("open", normalized);
    if (this.isDirectory(normalized) && !this.isFile(normalized)) throw eisdir("open", path);
    this.stage(normalized, toBytes(content, options));
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("open", normalized);
    const existing = (await this.exists(normalized)) ? await this.bytesOf("open", normalized) : new Uint8Array();
    this.stage(normalized, concat(existing, toBytes(content, options)));
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    return this.isFile(normalized) || this.isDirectory(normalized);
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    const staged = this.staged.get(normalized);
    if (staged) return statOf("file", staged.bytes.byteLength, staged.mtime);
    const hosted = this.host.get(normalized);
    // Host files come from the deployment, not the store, so they carry no
    // per-file timestamp — the epoch is the honest answer.
    if (hosted) return statOf("file", hosted.byteLength, new Date(0));
    const meta = this.removed.has(normalized) ? undefined : this.index.get(normalized);
    if (meta) return statOf("file", meta.bytes, new Date(meta.updatedAt));
    if (this.isDirectory(normalized)) return statOf("directory", 0, new Date(0));
    throw enoent("stat", path);
  }

  /** No symlinks over a document store, so lstat is stat. */
  async lstat(path: string): Promise<FsStat> {
    return await this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("mkdir", normalized);
    if (this.isFile(normalized)) throw eexist("mkdir", path);
    if (this.isDirectory(normalized)) {
      if (options?.recursive === true) return;
      throw eexist("mkdir", path);
    }
    if (options?.recursive !== true && !this.isDirectory(dirnameOf(normalized))) {
      throw enoent("mkdir", path);
    }
    this.directories.add(normalized);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalized = normalizePath(path);
    if (this.isFile(normalized)) throw enotdir("scandir", path);
    if (!this.isDirectory(normalized)) throw enoent("scandir", path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const files = new Set<string>();
    const directories = new Set<string>();
    const collect = (candidate: string, kind: "file" | "directory"): void => {
      if (!candidate.startsWith(prefix) || candidate === normalized) return;
      const rest = candidate.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (rest === "") return;
      // A deeper segment always means a directory, whatever the leaf is.
      if (cut === -1) (kind === "file" ? files : directories).add(rest);
      else directories.add(rest.slice(0, cut));
    };
    for (const candidate of this.livePaths()) collect(candidate, "file");
    // An explicitly mkdir'ed path is a directory even with nothing under it —
    // reporting it as a file made `find -type f` return directories.
    for (const candidate of this.directories) collect(candidate, "directory");
    if (normalized === "/") {
      directories.add("user");
      directories.add("host");
    }
    return [...directories, ...files]
      .map((name) => ({
        name,
        isFile: !directories.has(name),
        isDirectory: directories.has(name),
        isSymbolicLink: false,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (this.readOnly(normalized)) throw erofs("rm", path);
    if (this.isFile(normalized)) {
      this.drop(normalized);
      return;
    }
    if (this.isDirectory(normalized)) {
      const children = this.livePaths().filter((candidate) => candidate.startsWith(`${normalized}/`));
      if (options?.recursive !== true && children.length > 0) throw enotempty("rm", path);
      for (const child of children) this.drop(child);
      for (const directory of [...this.directories]) {
        if (under(directory, normalized)) this.directories.delete(directory);
      }
      return;
    }
    if (options?.force !== true) throw enoent("rm", path);
  }

  private drop(path: string): void {
    this.staged.delete(path);
    if (this.index.has(path)) this.removed.add(path);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const from = normalizePath(src);
    const to = normalizePath(dest);
    this.assertWritable("copyfile", to);
    if (this.isFile(from)) {
      this.stage(to, await this.bytesOf("copyfile", from));
      return;
    }
    if (!this.isDirectory(from)) throw enoent("copyfile", src);
    if (options?.recursive !== true) throw eisdir("cp", src);
    for (const child of this.livePaths().filter((candidate) => candidate.startsWith(`${from}/`))) {
      this.stage(`${to}${child.slice(from.length)}`, await this.bytesOf("copyfile", child));
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = normalizePath(src);
    this.assertWritable("rename", from);
    await this.cp(src, dest, { recursive: true });
    await this.rm(from, { recursive: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${base}/${path}`);
  }

  getAllPaths(): string[] {
    const paths = new Set(this.livePaths());
    for (const directory of this.directories) paths.add(directory);
    return [...paths].sort();
  }

  async chmod(path: string, _mode: number): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("chmod", normalized);
    if (!(await this.exists(normalized))) throw enoent("chmod", path);
    // Modes are not part of the workspace: the store holds documents, and the
    // only permission that exists is the mount's (wave-1 `can()`).
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, symlink '${linkPath}'`);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, link '${newPath}'`);
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (!(await this.exists(normalized))) throw enoent("realpath", path);
    return normalized;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizePath(path);
    this.assertWritable("utimes", normalized);
    const bytes = await this.bytesOf("utimes", normalized);
    this.staged.set(normalized, { bytes, mtime });
  }

  /**
   * Build contract §3.2 — land the turn's writes. `/user` is last-write-wins;
   * `/orgs`' compare-and-swap (and the `conflict` outcome) arrives in wave 3.
   *
   * **Preflighted.** Every staged file's content is placed first; only when the
   * whole set is placeable does any row change. A commit therefore either lands
   * all of it or lands none of it — an oversized upload can no longer swallow
   * the same turn's app edit just by being staged first. Deterministic failures
   * (over the store-backed cap, an adapter refusal) throw a `VendoError` naming
   * the file; `CommitResult` keeps its frozen `ok | conflict` vocabulary.
   *
   * Only paths whose bytes actually changed are written (§3.5), so `changed` is
   * the honest O(files changed) count. `/user/scratch/**` never lands.
   */
  async commit(opts?: { message?: string }): Promise<CommitResult> {
    const landing: PreparedWrite[] = [];
    for (const [path, staged] of this.staged) {
      if (!this.persists(path)) continue;
      let prepared: PreparedWrite | "unchanged";
      try {
        prepared = await this.rows.prepare(this.owner, path, staged.bytes);
      } catch (cause) {
        // Nothing has been written yet; release what this commit already placed
        // so a rejected commit leaves no orphaned content behind.
        for (const done of landing) await this.rows.discard(done);
        throw new VendoError(
          "validation",
          `Cannot commit ${path}: ${safeErrorMessage(cause)}`,
          { path },
        );
      }
      if (prepared !== "unchanged") landing.push(prepared);
    }

    const changed: string[] = [];
    for (const path of [...this.removed].filter((candidate) => this.persists(candidate))) {
      if (await this.rows.remove(this.owner, path, opts?.message)) {
        this.index.delete(path);
        changed.push(path);
      }
    }
    this.removed.clear();
    for (const prepared of landing) {
      const written = await this.rows.land(this.owner, prepared, opts?.message);
      this.index.set(prepared.path, {
        path: prepared.path,
        owner: this.owner,
        bytes: prepared.bytes,
        revision: written.revision,
        updatedAt: written.updatedAt,
      });
      changed.push(prepared.path);
    }
    // Committed files now read through the store like everything else.
    for (const path of changed) this.staged.delete(path);
    return { status: "ok", changed: changed.sort() };
  }
}
