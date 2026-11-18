/**
 * @fileoverview Task #5109 P7 —— 斜杠命令**注册表**单元测试（TDD RED 先行）。
 *
 * 被测模块：`./slash-registry.js`（P7 新增）。
 *
 * ## 为什么先测
 *
 * 注册表是纯函数、无 I/O 的数据层 —— 它决定「哪些命令存在、别名怎么匹配、
 * 面板里显示什么」三件事。先把它锁死，UI 才有稳定契约。
 *
 * ## 与既有 slash.ts 的关系
 *
 * `packages/cli/src/slash.ts`（Task #2610）是 **run REPL** 的纯 switch-case
 * 分发器，interactive 已在 RunScreen.tsx:752 调用。本模块是 **P7 注册表**
 * —— 结构化（name/aliases/description/group/handler），供补全面板渲染 +
 * 命令执行共用。
 */

import { describe, expect, it } from "bun:test";
import {
  findSlashCommand,
  filterSlashCommands,
  listSlashCommands,
  matchSlashCommands,
  type SlashCommandSpec,
} from "./slash-registry.js";

const SPECS: SlashCommandSpec[] = [
  {
    name: "help",
    description: "List available slash commands",
    group: "System",
    run: () => ({ kind: "handled", message: "help text" }),
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Exit interactive",
    group: "System",
    run: () => ({ kind: "exit" }),
  },
  {
    name: "clear",
    description: "Clear conversation history",
    group: "Session",
    run: () => ({ kind: "handled", message: "__CLEAR__" }),
  },
];

describe("tui-solid P7 slash-registry — 命令匹配", () => {
  it("matches by primary name", () => {
    const hit = findSlashCommand(SPECS, "/help");
    expect(hit?.spec.name).toBe("help");
    expect(hit?.args).toBe("");
  });

  it("matches by alias", () => {
    const hit = findSlashCommand(SPECS, "/quit");
    expect(hit?.spec.name).toBe("exit");
  });

  it("matches by second alias", () => {
    const hit = findSlashCommand(SPECS, "/q");
    expect(hit?.spec.name).toBe("exit");
  });

  it("is case-insensitive", () => {
    const hit = findSlashCommand(SPECS, "/HELP");
    expect(hit?.spec.name).toBe("help");
  });

  it("captures trailing args", () => {
    const hit = findSlashCommand(SPECS, "/help now please");
    expect(hit?.spec.name).toBe("help");
    expect(hit?.args).toBe("now please");
  });

  it("returns null for unknown command", () => {
    expect(findSlashCommand(SPECS, "/nope")).toBeNull();
  });

  it("returns null for a non-slash string", () => {
    expect(findSlashCommand(SPECS, "hello")).toBeNull();
  });

  it("does not match a prefix of a longer name", () => {
    // `/hel` 不是 `/help` —— 避免补全面板把半截名字误执行。
    expect(findSlashCommand(SPECS, "/hel")).toBeNull();
  });
});

describe("tui-solid P7 slash-registry — 面板过滤", () => {
  it("returns all specs for an empty query", () => {
    expect(filterSlashCommands(SPECS, "").length).toBe(3);
  });

  it("filters by name prefix", () => {
    const hits = filterSlashCommands(SPECS, "cl");
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("clear");
  });

  it("filters by alias", () => {
    const hits = filterSlashCommands(SPECS, "quit");
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("exit");
  });

  it("filters by description substring", () => {
    const hits = filterSlashCommands(SPECS, "conversation");
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("clear");
  });

  it("name matches rank before description matches", () => {
    const hits = filterSlashCommands(SPECS, "exit");
    expect(hits[0].name).toBe("exit");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSlashCommands(SPECS, "zzzz")).toEqual([]);
  });
});

describe("tui-solid P7 slash-registry — 匹配方式标注（DS r3 MAJOR-1）", () => {
  const SPECS2: SlashCommandSpec[] = [
    {
      name: "help",
      description: "List commands",
      run: () => ({ kind: "handled", message: "x" }),
    },
    {
      name: "clear",
      description: "Clear conversation history",
      run: () => ({ kind: "handled", message: "x" }),
    },
  ];

  it("name hits are tagged as name", () => {
    const hits = matchSlashCommands(SPECS2, "cl");
    expect(hits[0].spec.name).toBe("clear");
    expect(hits[0].match).toBe("name");
  });

  it("description-only hits are tagged as description", () => {
    // "history" 只出现在 clear 的描述里 ⇒ 名字不命中
    const hits = matchSlashCommands(SPECS2, "history");
    expect(hits.length).toBe(1);
    expect(hits[0].spec.name).toBe("clear");
    expect(hits[0].match).toBe("description");
  });

  it("an empty query treats every command as a name hit", () => {
    const hits = matchSlashCommands(SPECS2, "");
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.match === "name")).toBe(true);
  });

  it("name hits are ordered before description hits", () => {
    const hits = matchSlashCommands(SPECS2, "c");
    expect(hits[0].match).toBe("name");
  });
});

describe("tui-solid P7 slash-registry — 列表视图", () => {
  it("lists primary names with a leading slash", () => {
    const names = listSlashCommands(SPECS).map((c) => c.display);
    expect(names).toContain("/help");
    expect(names).toContain("/exit");
  });

  it("exposes aliases in the display hint", () => {
    const exit = listSlashCommands(SPECS).find((c) => c.name === "exit");
    expect(exit?.aliases).toEqual(["quit", "q"]);
  });

  it("exposes the description for the panel", () => {
    const help = listSlashCommands(SPECS).find((c) => c.name === "help");
    expect(help?.description).toBe("List available slash commands");
  });
});
