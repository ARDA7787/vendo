import { describe, expect, it } from "vitest";
import {
  HOST_SKILLS_MOUNT,
  createTurnSkills,
  projectSkills,
  renderSkillMd,
  skillPath,
  type PackSkill,
  type SkillsFs,
} from "./skills.js";

/**
 * An in-memory stand-in for the workspace filesystem, with the exact method
 * signatures just-bash 3.1.0 gives `IFileSystem` (`dist/fs/interface.d.ts`) for
 * the five methods the skills store touches — so anything that satisfies
 * {@link SkillsFs} here satisfies it for lane B's real `WorkspaceFs` too.
 */
const memoryFs = (initial: Record<string, string> = {}): SkillsFs & { paths(): string[] } => {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>(["/"]);
  return {
    async readFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return content;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async mkdir(path: string): Promise<void> {
      dirs.add(path);
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path) || dirs.has(path);
    },
    getAllPaths(): string[] {
      return [...dirs, ...files.keys()];
    },
    paths: () => [...files.keys()],
  };
};

const skill = (name: string, description: string, body: string): PackSkill => ({ name, description, body });

describe("skill paths (build contract §3.1)", () => {
  it("puts every skill at /host/skills/<name>/SKILL.md", () => {
    expect(HOST_SKILLS_MOUNT).toBe("/host/skills");
    expect(skillPath("building-apps")).toBe("/host/skills/building-apps/SKILL.md");
  });
});

describe("SKILL.md on disk (agentskills.io format)", () => {
  it("renders name and description as frontmatter above the verbatim body", () => {
    const rendered = renderSkillMd(skill("building-apps", "Build an app for someone.", "# Building apps\n\nWrite the plan first.\n"));
    expect(rendered).toBe([
      "---",
      'name: "building-apps"',
      'description: "Build an app for someone."',
      "---",
      "",
      "# Building apps",
      "",
      "Write the plan first.",
      "",
    ].join("\n"));
  });

  it("keeps the body byte-identical — projection is a copy, never a translation", async () => {
    // Every character class that a translator would be tempted to touch:
    // frontmatter delimiters inside the body, quotes, backslashes, unicode.
    const body = '---\nnot: frontmatter\n---\n\n"quoted" \\ backslash — em dash 🎈\n\ttab\n';
    const fs = memoryFs();
    await projectSkills(fs, [skill("edges", "Every awkward character.", body)]);

    const loaded = await createTurnSkills(fs).load("edges");
    expect(loaded).toBe(body);
  });

  it("roundtrips a description carrying colons and quotes", async () => {
    const description = 'Totals: cite the query, and never say "done".';
    const fs = memoryFs();
    await projectSkills(fs, [skill("tricky", description, "body\n")]);

    expect(await createTurnSkills(fs).list()).toEqual([{ name: "tricky", description }]);
  });
});

describe("projectSkills", () => {
  it("writes one SKILL.md per skill under the host mount", async () => {
    const fs = memoryFs();
    await projectSkills(fs, [skill("a", "First.", "a body\n"), skill("b", "Second.", "b body\n")]);

    expect(fs.paths().sort()).toEqual([
      "/host/skills/a/SKILL.md",
      "/host/skills/b/SKILL.md",
    ]);
  });

  it("overwrites a stale copy so the store is the source of truth each boot", async () => {
    const fs = memoryFs();
    await projectSkills(fs, [skill("a", "Old.", "old\n")]);
    await projectSkills(fs, [skill("a", "New.", "new\n")]);

    const skills = createTurnSkills(fs);
    expect(await skills.list()).toEqual([{ name: "a", description: "New." }]);
    expect(await skills.load("a")).toBe("new\n");
  });
});

describe("TurnSkills (build contract §1.2)", () => {
  it("lists name and description only — never the body", async () => {
    const fs = memoryFs();
    const body = "a very long body ".repeat(500);
    await projectSkills(fs, [skill("big", "One short line.", body)]);

    const listing = await createTurnSkills(fs).list();
    expect(listing).toEqual([{ name: "big", description: "One short line." }]);
    expect(JSON.stringify(listing)).not.toContain("very long body");
  });

  it("lists host-authored skills already on the mount, not just projected ones", async () => {
    // /host/ is the host's own skills + pack skills alike (architecture §8):
    // the disk is the one source of truth, so a hand-authored SKILL.md lists.
    const fs = memoryFs({
      "/host/skills/house-style/SKILL.md": '---\nname: house-style\ndescription: How this company writes.\n---\n\nBe brief.\n',
    });

    expect(await createTurnSkills(fs).list()).toEqual([
      { name: "house-style", description: "How this company writes." },
    ]);
  });

  it("ignores files under the mount that are not a SKILL.md", async () => {
    const fs = memoryFs({
      "/host/skills/a/SKILL.md": "---\nname: a\ndescription: Real.\n---\n\nbody\n",
      "/host/skills/a/reference.md": "not a skill",
      "/host/knowledge/notes.md": "not a skill either",
    });

    expect(await createTurnSkills(fs).list()).toEqual([{ name: "a", description: "Real." }]);
  });

  it("lists in a stable order regardless of how the filesystem enumerates", async () => {
    const fs = memoryFs({
      "/host/skills/zeta/SKILL.md": "---\nname: zeta\ndescription: Z.\n---\n\nz\n",
      "/host/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: A.\n---\n\na\n",
    });

    expect((await createTurnSkills(fs).list()).map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("takes the directory name as the skill's name, so load(name) always finds it", async () => {
    // A hand-edited frontmatter name that disagrees with its folder would
    // otherwise list a name load() cannot resolve.
    const fs = memoryFs({
      "/host/skills/on-disk/SKILL.md": "---\nname: something-else\ndescription: Mismatched.\n---\n\nbody\n",
    });

    const skills = createTurnSkills(fs);
    expect(await skills.list()).toEqual([{ name: "on-disk", description: "Mismatched." }]);
    expect(await skills.load("on-disk")).toBe("body\n");
  });

  it("describes a skill whose SKILL.md has no frontmatter with an empty description", async () => {
    const fs = memoryFs({ "/host/skills/bare/SKILL.md": "just a body\n" });

    const skills = createTurnSkills(fs);
    expect(await skills.list()).toEqual([{ name: "bare", description: "" }]);
    expect(await skills.load("bare")).toBe("just a body\n");
  });

  it("throws naming the skill when load() is asked for one that is not mounted", async () => {
    const skills = createTurnSkills(memoryFs());
    await expect(skills.load("absent")).rejects.toThrow(/absent/);
  });

  it("lists nothing when the mount is empty", async () => {
    expect(await createTurnSkills(memoryFs()).list()).toEqual([]);
  });
});
