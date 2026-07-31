/**
 * The skills store: pack and host skills as files on the workspace's read-only
 * `/host/` mount, and the cheap two-call surface a harness reads them through.
 *
 * The on-disk format is agentskills.io's SKILL.md — the format Claude Code and
 * Pi already read natively — so projecting a skill for a harness is a COPY, not
 * a translation. A translation would rewrite tool names, and tool names are
 * global as authored (build contract §5): a rewritten body would point the
 * model at a tool that does not exist.
 *
 * The disk is the one source of truth here, which is why a hand-authored
 * host skill lists beside a pack's without registering anywhere.
 */
import type { PackSkill } from "./pack.js";

export type { PackSkill };

/** Build contract §3.1 — host + pack skills, read-only for everyone. */
export const HOST_SKILLS_MOUNT = "/host/skills";

/** The file one skill lives in. The directory name is the skill's name. */
export const skillPath = (name: string): string => `${HOST_SKILLS_MOUNT}/${name}/SKILL.md`;

/**
 * The slice of the workspace filesystem the skills store touches. The signatures
 * are just-bash's `IFileSystem` (build contract §3.2) for exactly these five
 * methods, so lane B's `WorkspaceFs` — and just-bash's own `InMemoryFs` —
 * satisfy it structurally, with nothing to adapt.
 */
export interface SkillsFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  getAllPaths(): string[];
}

/** Build contract §1.2 — what a harness sees. `list()` is always cheap enough
 *  to carry every turn; `load()` is the only thing that costs a body. */
export interface TurnSkills {
  list(): Promise<SkillListing[]>;
  load(name: string): Promise<string>;
}

export interface SkillListing {
  name: string;
  description: string;
}

/** A double-quoted YAML scalar, so a description carrying colons, quotes, or
 *  backslashes survives the roundtrip that `list()` reads it back through. */
const quoted = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const unquoted = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
};

/** One skill as its SKILL.md text: agentskills.io frontmatter, then the body
 *  exactly as authored. */
export const renderSkillMd = ({ name, description, body }: PackSkill): string =>
  `---\nname: ${quoted(name)}\ndescription: ${quoted(description)}\n---\n\n${body}`;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n?/;

/** The description a listing shows, read from the frontmatter. A SKILL.md
 *  without frontmatter is still a skill — it just describes itself in its body,
 *  which `list()` never pays for. */
const describe = (text: string): string => {
  const front = FRONTMATTER.exec(text);
  if (front === null) return "";
  for (const line of front[1]?.split("\n") ?? []) {
    const colon = line.indexOf(":");
    if (colon !== -1 && line.slice(0, colon).trim() === "description") {
      return unquoted(line.slice(colon + 1));
    }
  }
  return "";
};

/** The body a harness loads: everything after the frontmatter, verbatim. */
const bodyOf = (text: string): string => text.replace(FRONTMATTER, "");

/**
 * Write the pack skills onto the mount. Called once at boot, and it overwrites:
 * the configured packs are the truth about what skills exist, so a skill
 * renamed or reworded between boots never leaves a stale copy behind.
 */
export const projectSkills = async (fs: SkillsFs, skills: readonly PackSkill[]): Promise<void> => {
  for (const skill of skills) {
    await fs.mkdir(`${HOST_SKILLS_MOUNT}/${skill.name}`, { recursive: true });
    await fs.writeFile(skillPath(skill.name), renderSkillMd(skill));
  }
};

/** Every skill directory on the mount, sorted, so a listing never depends on
 *  how the filesystem happens to enumerate. */
const mountedNames = (fs: SkillsFs): string[] => {
  const names = new Set<string>();
  for (const path of fs.getAllPaths()) {
    const match = new RegExp(`^${HOST_SKILLS_MOUNT}/([^/]+)/SKILL\\.md$`).exec(path);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
};

/**
 * The skills surface for one turn.
 *
 * The name is the directory's, never the frontmatter's: a hand-edited SKILL.md
 * whose `name:` disagreed with its folder would otherwise list a name `load()`
 * cannot resolve.
 */
export const createTurnSkills = (fs: SkillsFs): TurnSkills => ({
  async list(): Promise<SkillListing[]> {
    return Promise.all(mountedNames(fs).map(async (name) => ({
      name,
      description: describe(await fs.readFile(skillPath(name))),
    })));
  },
  async load(name: string): Promise<string> {
    const path = skillPath(name);
    if (!await fs.exists(path)) {
      throw new Error(`no skill named "${name}" is mounted at ${HOST_SKILLS_MOUNT}`);
    }
    return bodyOf(await fs.readFile(path));
  },
});
