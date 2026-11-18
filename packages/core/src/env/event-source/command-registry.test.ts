/**
 * @fileoverview Task #4722 — command 子系统测试
 *
 * ## 设计要点（用户需求）
 *
 * 用户在飞书输入 `##command##: list model`，es handler 识别 `##command##:`
 * 前缀后**不走 agent 处理链路**，转交 command 子系统执行，结果用飞书卡片
 * 展示。command 子系统本身是纯核心层能力，**不耦合 es**。
 *
 * ## 测试覆盖
 *
 * 1. 前缀识别：命中 / 不命中 / 大小写 / 空白容错 / 无冒号
 * 2. 分发：注册表查找 / 未知命令 / 无参数
 * 3. 执行结果：结构化输出（text / card）
 * 4. es 集成：LarkCliInstance.handleEvent 分流（command 消息不进 agent 链路）
 * 5. 卡片渲染：fallback-model list 卡片 JSON
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  extractCommandInvocation,
  isCommandMessage,
  CommandRegistry,
  type CommandContext,
  type CommandResult,
} from "./command-registry";
import { fallbackModelCommand } from "./fallback-model-command";
import { renderFallbackModelCard, renderTextCard } from "./command-cards";
import { readFallbackModelList, writeFallbackModelList } from "./fallback-model-command";

// =============================================================================
// 1. 前缀识别
// =============================================================================

describe("isCommandMessage / extractCommandInvocation", () => {
  test("命中：##command##: list model", () => {
    expect(isCommandMessage("##command##: list model")).toBe(true);
  });

  test("命中：前导空白容忍", () => {
    expect(isCommandMessage("  ##command##: list model")).toBe(true);
    expect(isCommandMessage("\n##command##: list model")).toBe(true);
  });

  test("命中：##command##: 后无内容（空命令）", () => {
    expect(isCommandMessage("##command##:")).toBe(true);
    expect(isCommandMessage("##command##:   ")).toBe(true);
  });

  test("不命中：普通消息", () => {
    expect(isCommandMessage("你好，帮我查一下")).toBe(false);
    expect(isCommandMessage("")).toBe(false);
  });

  test("不命中：##command## 出现在消息中间（必须前缀）", () => {
    expect(isCommandMessage("请执行 ##command##: list model")).toBe(false);
  });

  test("命中：大小写不敏感（##COMMAND##: / ##Command##: 都识别）", () => {
    // ★ Task #4722 收口：前缀识别鲁棒性 —— 大小写不敏感
    // （`##` 包裹 + 尾随冒号已足够特异，不会与正文强调词混淆）
    expect(isCommandMessage("##COMMAND##: list model")).toBe(true);
    expect(isCommandMessage("##Command##: list model")).toBe(true);
  });

  test("不命中：缺冒号（##command## list model）", () => {
    expect(isCommandMessage("##command## list model")).toBe(false);
  });

  test("extractCommandInvocation：解析 subcommand 与 args", () => {
    const inv = extractCommandInvocation("##command##: list model");
    expect(inv).not.toBeNull();
    expect(inv!.subcommand).toBe("list");
    expect(inv!.args).toEqual(["model"]);
  });

  test("extractCommandInvocation：多参数", () => {
    const inv = extractCommandInvocation("##command##: fallback-model add tong/GLM-5.3-Flash");
    expect(inv!.subcommand).toBe("fallback-model");
    expect(inv!.args).toEqual(["add", "tong/GLM-5.3-Flash"]);
  });

  test("extractCommandInvocation：空白规整（多空格 / 全角冒号不识别）", () => {
    const inv = extractCommandInvocation("##command##:    list    model   ");
    expect(inv!.subcommand).toBe("list");
    expect(inv!.args).toEqual(["model"]);

    // 全角冒号不是命令前缀
    expect(extractCommandInvocation("##command##：list model")).toBeNull();
  });

  test("extractCommandInvocation：空命令 → subcommand 为空串", () => {
    const inv = extractCommandInvocation("##command##:");
    expect(inv).not.toBeNull();
    expect(inv!.subcommand).toBe("");
    expect(inv!.args).toEqual([]);
  });

  test("不命中时 extractCommandInvocation 返回 null", () => {
    expect(extractCommandInvocation("普通消息")).toBeNull();
  });
});

// =============================================================================
// 2. 注册表分发
// =============================================================================

describe("CommandRegistry", () => {
  const makeResult = (text: string): CommandResult => ({
    ok: true,
    output: { kind: "text", text },
  });

  function makeRegistry(): CommandRegistry {
    const registry = new CommandRegistry();
    registry.register({
      name: "echo",
      description: "回显",
      usage: "echo <text>",
      execute: async (ctx: CommandContext) => makeResult(ctx.args.join(" ")),
    });
    registry.register({
      name: "fail",
      description: "总是失败",
      usage: "fail",
      execute: async () => ({ ok: false, error: "boom" }),
    });
    return registry;
  }

  test("register + has + list", () => {
    const registry = makeRegistry();
    expect(registry.has("echo")).toBe(true);
    expect(registry.has("nope")).toBe(false);
    const names = registry.list().map((c) => c.name);
    expect(names).toContain("echo");
    expect(names).toContain("fail");
  });

  test("dispatch：命中并执行，args 传递正确", async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch("echo", ["hello", "world"]);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ kind: "text", text: "hello world" });
  });

  test("dispatch：未知命令返回 ok=false + 可用命令提示", async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch("nope", []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nope");
    // 提示里应列出可用命令
    expect(result.error).toContain("echo");
  });

  test("dispatch：空 subcommand 返回帮助", async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch("", []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("echo");
    expect(result.error).toContain("fail");
  });

  test("dispatch：execute 抛异常 → ok=false + error", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "throw",
      description: "抛异常",
      usage: "throw",
      execute: async () => {
        throw new Error("kaboom");
      },
    });
    const result = await registry.dispatch("throw", []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("kaboom");
  });

  test("dispatch：重复注册被拒绝", () => {
    const registry = makeRegistry();
    expect(() =>
      registry.register({
        name: "echo",
        description: "重复",
        usage: "echo",
        execute: async () => makeResult("dup"),
      })
    ).toThrow();
  });
});

// =============================================================================
// 3. fallback-model 子命令（config 读写走临时目录）
// =============================================================================

describe("fallback-model command", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = `/tmp/roy-cmd-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    configPath = `${tmpDir}/config.jsonc`;
    require("fs").mkdirSync(tmpDir, { recursive: true });
  });

  const ctx = (args: string[]): CommandContext => ({
    args,
    configPath,
    rawText: `##command##: ${args.join(" ")}`,
  });

  test("list：空配置 → 提示未配置", async () => {
    require("fs").writeFileSync(configPath, '{\n  "llm": {}\n}');
    const result = await fallbackModelCommand.execute(ctx(["list"]));
    expect(result.ok).toBe(true);
    // list 输出卡片（用户需求：飞书卡片展示）
    const card = (result.output as { kind: string; card: Record<string, unknown> }).card;
    expect(result.output?.kind).toBe("card");
    expect(JSON.stringify(card)).toContain("未配置");
  });

  test("list：读取 llm.fallbackModel 单值（向后兼容）", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModel": "tong/GLM-5.3-Flash" }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["list"]));
    const card = (result.output as { kind: string; card: Record<string, unknown> }).card;
    expect(JSON.stringify(card)).toContain("tong/GLM-5.3-Flash");
  });

  test("list：读取 llm.fallbackModels 数组（有序 = 优先级）", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["list"]));
    const json = JSON.stringify((result.output as { card: Record<string, unknown> }).card);
    expect(json).toContain("a/M1");
    expect(json).toContain("b/M2");
    // 优先级顺序：M1 在 M2 前
    expect(json.indexOf("a/M1")).toBeLessThan(json.indexOf("b/M2"));
  });

  test("add：新增到 fallbackModels 末尾", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["add", "b/M2"]));
    expect(result.ok).toBe(true);
    const list = readFallbackModelList(configPath);
    expect(list).toEqual(["a/M1", "b/M2"]);
  });

  test("add：重复添加被拒绝", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["add", "a/M1"]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("已在 fallback 列表");
  });

  test("add：无参数报错", async () => {
    const result = await fallbackModelCommand.execute(ctx(["add"]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("用法");
  });

  test("add：从单值 fallbackModel 迁移到数组", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModel": "a/M1" }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["add", "b/M2"]));
    expect(result.ok).toBe(true);
    const list = readFallbackModelList(configPath);
    expect(list).toEqual(["a/M1", "b/M2"]);
  });

  test("remove：按序号删除（1-based）", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2", "c/M3"] }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["remove", "2"]));
    expect(result.ok).toBe(true);
    const list = readFallbackModelList(configPath);
    expect(list).toEqual(["a/M1", "c/M3"]);
  });

  test("remove：序号越界报错", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["remove", "5"]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("序号");
  });

  test("reorder：把第 2 项移到第 1 位", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
    const result = await fallbackModelCommand.execute(
      ctx(["reorder", "2", "1"])
    );
    expect(result.ok).toBe(true);
    const list = readFallbackModelList(configPath);
    expect(list).toEqual(["b/M2", "a/M1"]);
  });

  test("reorder：非法序号报错", async () => {
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    const result = await fallbackModelCommand.execute(ctx(["reorder", "9", "1"]));
    expect(result.ok).toBe(false);
  });

  test("未知子命令报错并提示用法", async () => {
    const result = await fallbackModelCommand.execute(ctx(["frobnicate"]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("用法");
  });

  test("config.jsonc 写回后注释保留（jsonc modify）", async () => {
    const original = [
      "{",
      "  // 主模型配置",
      '  "llm": {',
      '    // 默认走 tong 网关',
      '    "defaultModel": "GLM-5.3-Flash",',
      '    "fallbackModels": ["a/M1"]',
      "  }",
      "}",
    ].join("\n");
    require("fs").writeFileSync(configPath, original);

    const result = await fallbackModelCommand.execute(ctx(["add", "b/M2"]));
    expect(result.ok).toBe(true);

    const after = require("fs").readFileSync(configPath, "utf-8");
    // 注释必须还在
    expect(after).toContain("// 主模型配置");
    expect(after).toContain("// 默认走 tong 网关");
    // 新值必须写入
    const list = readFallbackModelList(configPath);
    expect(list).toEqual(["a/M1", "b/M2"]);
  });

  test("config 文件不存在时 add 自动创建", async () => {
    const result = await fallbackModelCommand.execute(ctx(["add", "a/M1"]));
    expect(result.ok).toBe(true);
    const list = readFallbackModelList(configPath);
    expect(list).toEqual(["a/M1"]);
  });
});

// =============================================================================
// 4. 卡片渲染
// =============================================================================

describe("command cards", () => {
  test("renderFallbackModelCard：生成飞书 interactive 卡片 JSON（Card 2.0）", () => {
    const card = renderFallbackModelCard(["a/M1", "b/M2"], "tong/GLM-5.3-Flash");
    expect(card).toBeTruthy();
    // ★ Task #4722 收口：Card 2.0 骨架（schema 2.0 + body.elements）
    expect(card.schema).toBe("2.0");
    expect(Array.isArray((card.body as any)?.elements)).toBe(true);
    // 卡片内容应包含模型列表
    const json = JSON.stringify(card);
    expect(json).toContain("a/M1");
    expect(json).toContain("b/M2");
    expect(json).toContain("tong/GLM-5.3-Flash");
  });

  test("renderFallbackModelCard：空列表也有引导文案", () => {
    const card = renderFallbackModelCard([], undefined);
    const json = JSON.stringify(card);
    expect(json).toContain("未配置");
  });

  test("renderTextCard：纯文本卡片", () => {
    const card = renderTextCard("标题", "正文内容");
    const json = JSON.stringify(card);
    expect(json).toContain("标题");
    expect(json).toContain("正文内容");
  });

  test("卡片 JSON 可被 JSON.parse 往返（序列化安全）", () => {
    const card = renderFallbackModelCard(["a/M1"], undefined);
    const roundtrip = JSON.parse(JSON.stringify(card));
    expect(roundtrip).toEqual(card);
  });
});

// =============================================================================
// 5. es 分流集成（command 消息不进 agent 链路）
// =============================================================================

describe("es handler 分流：##command##: 不进 agent 链路", () => {
  test("handleCommandMessage：识别命令 → 执行 → 返回结果（不调用 eventHandler）", async () => {
    // 动态导入避免循环依赖问题
    const { handleCommandMessage } = await import("./command-registry");
    const tmpDir = `/tmp/roy-cmd-es-${Date.now()}`;
    require("fs").mkdirSync(tmpDir, { recursive: true });
    const configPath = `${tmpDir}/config.jsonc`;
    require("fs").writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );

    let agentCalled = false;
    const result = await handleCommandMessage("##command##: list model", {
      configPath,
      onAgentFallback: () => {
        agentCalled = true;
      },
    });

    expect(agentCalled).toBe(false);
    expect(result).toBeTruthy();
    // list model → fallback-model list（卡片输出）
    expect(result.output.kind).toBe("card");
  });

  test("handleCommandMessage：普通消息返回 null（走 agent 链路）", async () => {
    const { handleCommandMessage } = await import("./command-registry");
    const result = await handleCommandMessage("你好，正常消息", {});
    expect(result).toBeNull();
  });
});
