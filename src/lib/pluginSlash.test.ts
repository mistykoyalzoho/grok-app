import { describe, expect, it } from "vitest";
import {
  applyPluginAtSlash,
  isDraftEmpty,
  parseStoredContent,
  serializeForAgent,
  serializeStored,
} from "./draftDoc";
import {
  buildSlashCatalog,
  countSlashByKind,
  flattenFilteredCatalog,
  inferPluginNameFromPath,
  pluginSkillsMap,
  pluginsToSlashItems,
  type InstalledPluginInfo,
  type SkillInfo,
} from "./slashCatalog";

describe("inferPluginNameFromPath", () => {
  it("reads installed-plugins and .grok/plugins segments", () => {
    expect(
      inferPluginNameFromPath(
        "/Users/me/.grok/installed-plugins/agent-plugin-codex/skills/x/SKILL.md",
      ),
    ).toBe("agent-plugin-codex");
    expect(
      inferPluginNameFromPath("/Users/me/.grok/plugins/foo/skills/bar/SKILL.md"),
    ).toBe("foo");
    expect(
      inferPluginNameFromPath("D:\\\\work\\\\.grok\\\\plugins\\\\pdf\\\\skills\\\\a\\\\SKILL.md"),
    ).toBe("pdf");
  });

  it("ignores user / bundled / project skill paths", () => {
    expect(
      inferPluginNameFromPath("/Users/me/.grok/skills/help/SKILL.md"),
    ).toBeNull();
    expect(
      inferPluginNameFromPath("/Users/me/.grok/bundled/skills/pdf/SKILL.md"),
    ).toBeNull();
    expect(
      inferPluginNameFromPath("/repo/.grok/skills/local/SKILL.md"),
    ).toBeNull();
    expect(inferPluginNameFromPath(null)).toBeNull();
  });
});

describe("pluginsToSlashItems", () => {
  const skills: SkillInfo[] = [
    {
      name: "word-eq",
      description: "eq",
      source: "plugin",
      pluginName: "word-tools",
    },
    {
      name: "word-table",
      description: "tbl",
      source: "plugin",
      pluginName: "word-tools",
    },
    {
      name: "hidden",
      description: "no",
      source: "plugin",
      pluginName: "word-tools",
      userInvocable: false,
    },
    {
      name: "solo",
      description: "s",
      source: "plugin",
      path: "/Users/me/.grok/plugins/solo-pack/skills/solo/SKILL.md",
    },
    { name: "user-skill", description: "u", source: "user" },
  ];

  it("emits one plugin row per pack with invocable skills", () => {
    const items = pluginsToSlashItems(skills);
    expect(items.map((i) => i.name).sort()).toEqual(["solo-pack", "word-tools"]);
    const word = items.find((i) => i.name === "word-tools")!;
    expect(word.kind).toBe("plugin");
    expect(word.id).toBe("plugin:word-tools");
    expect(word.aliases).toEqual(["word-eq", "word-table"]);
  });

  it("omits empty or fully hidden plugins", () => {
    expect(
      pluginsToSlashItems([
        {
          name: "x",
          description: "",
          source: "plugin",
          pluginName: "empty",
          userInvocable: false,
        },
      ]),
    ).toEqual([]);
  });

  it("puts plugin rows ahead of skills in the catalog", () => {
    const cat = buildSlashCatalog(skills);
    const kinds = cat.skills.map((i) => i.kind);
    expect(kinds[0]).toBe("plugin");
    expect(kinds).toContain("skill");
  });
});

describe("pluginSkillsMap", () => {
  it("maps plugin → enabled invocable skill names", () => {
    const map = pluginSkillsMap([
      { name: "a", description: "", pluginName: "p" },
      { name: "b", description: "", pluginName: "p", enabled: false },
      { name: "c", description: "", pluginName: "p", userInvocable: false },
      { name: "d", description: "", source: "user" },
    ]);
    expect(map).toEqual({ p: ["a"] });
  });
});

describe("plugin draft tokens", () => {
  it("round-trips [[plugin:name]]", () => {
    const stored = "[[plugin:word-tools]] hello";
    const segs = parseStoredContent(stored);
    expect(segs).toEqual([
      { type: "plugin", name: "word-tools" },
      { type: "text", text: " hello" },
    ]);
    expect(serializeStored(segs)).toBe(stored);
    expect(isDraftEmpty([{ type: "plugin", name: "word-tools" }])).toBe(false);
  });

  it("inserts a plugin chip at a slash range", () => {
    expect(applyPluginAtSlash("/word", 0, 5, "word-tools")).toBe(
      "[[plugin:word-tools]] ",
    );
  });

  it("expands a plugin chip to its skills and drops redundant skill chips", () => {
    const segs = parseStoredContent(
      "[[plugin:word-tools]][[skill:word-eq]] please",
    );
    expect(
      serializeForAgent(segs, {
        pluginSkills: { "word-tools": ["word-eq", "word-table"] },
      }),
    ).toBe("/word-eq /word-table\nplease");
  });

  it("does not send an empty plugin name", () => {
    expect(
      serializeForAgent([{ type: "plugin", name: "missing" }], {
        pluginSkills: {},
      }),
    ).toBe("");
  });
});

describe("installed plugin catalog", () => {
  // Screenshot shape: Installed · 16, skill paths attribute only three of them.
  // `adobe` is installed under its short name; the skill lives in the hash folder.
  const installed: InstalledPluginInfo[] = [
    {
      name: "adobe",
      repoKey: "adobe-c2584161",
      path: "/Users/me/.grok/installed-plugins/adobe-c2584161",
    },
    {
      name: "browser-use",
      repoKey: "plugins-git-grok-ba06cd19",
      path: "/Users/me/.grok/installed-plugins/plugins-git-grok-ba06cd19",
    },
    {
      name: "caveman",
      repoKey: "caveman-513b8022",
      path: "/Users/me/.grok/installed-plugins/caveman-513b8022",
    },
    {
      name: "chrome-devtools-mcp",
      repoKey: "chrome-devtools-mcp-2df60288",
      path: "/Users/me/.grok/installed-plugins/chrome-devtools-mcp-2df60288",
    },
    {
      name: "crypto-desk-codex",
      repoKey: "cryptodeskcodexplugin-86ef9845",
      path: "/Users/me/.grok/installed-plugins/cryptodeskcodexplugin-86ef9845",
    },
    {
      name: "exa",
      repoKey: "exa-grok-plugin-f73327c3",
      path: "/Users/me/.grok/installed-plugins/exa-grok-plugin-f73327c3",
    },
    {
      name: "firecrawl",
      repoKey: "firecrawl-grok-plugin-ba077673",
      path: "/Users/me/.grok/installed-plugins/firecrawl-grok-plugin-ba077673",
    },
    {
      name: "gmail",
      repoKey: "gmail-8b190296",
      path: "/Users/me/.grok/installed-plugins/gmail-8b190296",
    },
    {
      name: "google-drive",
      repoKey: "google-drive-4ba1f123",
      path: "/Users/me/.grok/installed-plugins/google-drive-4ba1f123",
    },
    {
      name: "grok-imagine-cinematic-studio",
      repoKey: "grok-imagine-cinematic-studio-d395be2c",
      path: "/Users/me/.grok/installed-plugins/grok-imagine-cinematic-studio-d395be2c",
    },
    {
      name: "higgsfield",
      repoKey: "higgsfield-67f0d590",
      path: "/Users/me/.grok/installed-plugins/higgsfield-67f0d590",
    },
    {
      name: "ponytail",
      repoKey: "ponytail-3d1ab158",
      path: "/Users/me/.grok/installed-plugins/ponytail-3d1ab158",
    },
    {
      name: "superpowers",
      repoKey: "superpowers-21e2a56d",
      path: "/Users/me/.grok/installed-plugins/superpowers-21e2a56d",
    },
    {
      name: "tavily",
      repoKey: "tavily-grok-plugin-05ff8f77",
      path: "/Users/me/.grok/installed-plugins/tavily-grok-plugin-05ff8f77",
    },
    {
      name: "tinyfish",
      repoKey: "tinyfish-web-agent-integrations-git-grok-7db223a5",
      path: "/Users/me/.grok/installed-plugins/tinyfish-web-agent-integrations-git-grok-7db223a5",
    },
    {
      name: "codex",
      repoKey: "agent-plugin-codex-3bf5cefd",
      path: "/Users/me/.grok/installed-plugins/agent-plugin-codex-3bf5cefd",
    },
  ];

  const skills: SkillInfo[] = [
    {
      name: "adobe-edit",
      description: "edit",
      source: "plugin",
      path: "/Users/me/.grok/installed-plugins/adobe-c2584161/skills/adobe-edit/SKILL.md",
    },
    {
      name: "exa-search",
      description: "search",
      source: "plugin",
      pluginName: "exa",
      path: "/Users/me/.grok/skills-cache/exa-search/SKILL.md",
    },
    {
      name: "using-git-worktrees",
      description: "worktrees",
      source: "plugin",
      path: "/Users/me/.grok/installed-plugins/superpowers-21e2a56d/skills/using-git-worktrees/SKILL.md",
    },
    {
      name: "my-user-skill",
      description: "mine",
      source: "user",
      path: "/Users/me/.grok/skills/my-user-skill/SKILL.md",
    },
    {
      name: "bundled-pdf",
      description: "pdf",
      source: "bundled",
      path: "/Users/me/.grok/bundled/skills/pdf/SKILL.md",
    },
    {
      name: "project-local",
      description: "local",
      source: "project",
      path: "/repo/.grok/skills/project-local/SKILL.md",
    },
  ];

  const installedNames = [...installed.map((p) => p.name)].sort((a, b) =>
    a.localeCompare(b),
  );

  it("shows every installed plugin, including packs with no skills", () => {
    const skillDerived = buildSlashCatalog(skills);
    const skillDerivedPlugins = skillDerived.skills
      .filter((item) => item.kind === "plugin")
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b));
    expect(skillDerivedPlugins).toEqual([
      "adobe-c2584161",
      "exa",
      "superpowers-21e2a56d",
    ]);

    const cat = buildSlashCatalog(skills, installed);
    const pluginRows = cat.skills.filter((item) => item.kind === "plugin");
    expect(pluginRows.map((item) => item.name).sort((a, b) => a.localeCompare(b))).toEqual(
      installedNames,
    );
    expect(pluginRows).toHaveLength(installed.length);
    expect(pluginRows.some((item) => item.name === "adobe-c2584161")).toBe(false);
    expect(pluginRows.some((item) => item.name === "superpowers-21e2a56d")).toBe(
      false,
    );
    expect(pluginRows.find((item) => item.name === "codex")?.aliases).toEqual([]);
    expect(pluginRows.find((item) => item.name === "gmail")?.aliases).toEqual([]);
    expect(pluginRows.find((item) => item.name === "adobe")?.aliases).toEqual([
      "adobe-edit",
    ]);

    const counts = countSlashByKind([...cat.commands, ...cat.skills]);
    expect(counts.plugin).toBe(installed.length);

    const chosen = flattenFilteredCatalog(cat, { kind: "plugin" });
    expect(chosen.commands).toHaveLength(0);
    expect(chosen.skills.every((item) => item.kind === "plugin")).toBe(true);
    expect(chosen.skills.map((item) => item.name).sort((a, b) => a.localeCompare(b))).toEqual(
      installedNames,
    );

    const asSkills = flattenFilteredCatalog(cat, { kind: "skill" });
    expect(asSkills.skills.every((item) => item.kind === "skill")).toBe(true);
    for (const name of [
      "my-user-skill",
      "bundled-pdf",
      "project-local",
      "adobe-edit",
      "exa-search",
      "using-git-worktrees",
    ]) {
      expect(asSkills.skills.some((item) => item.name === name)).toBe(true);
    }
  });

  it("keeps skill-derived rows only when the installed list did not load", () => {
    expect(pluginsToSlashItems(skills, null).map((item) => item.name)).toEqual([
      "adobe-c2584161",
      "exa",
      "superpowers-21e2a56d",
    ]);
    expect(pluginsToSlashItems(skills, [])).toEqual([]);
  });

  it("inserts the installed-name chip and expands packs that have skills", () => {
    expect(applyPluginAtSlash("/adobe", 0, 6, "adobe")).toBe("[[plugin:adobe]] ");
    const map = pluginSkillsMap(skills, installed);
    expect(map.adobe).toEqual(["adobe-edit"]);
    expect(map.superpowers).toEqual(["using-git-worktrees"]);
    expect(map.exa).toEqual(["exa-search"]);
    expect(
      serializeForAgent(parseStoredContent("[[plugin:adobe]] go"), {
        pluginSkills: map,
      }),
    ).toBe("/adobe-edit\ngo");
    expect(
      serializeForAgent(parseStoredContent("[[plugin:codex]] hi"), {
        pluginSkills: map,
      }),
    ).toBe("hi");
    expect(
      serializeForAgent(parseStoredContent("[[plugin:superpowers]] please"), {
        pluginSkills: map,
      }),
    ).toBe("/using-git-worktrees\nplease");
  });
});
