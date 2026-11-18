/**
 * @fileoverview EnvironmentService Plugin Scope Tests (Task #1960)
 *
 * 验证 EnvironmentServiceOptions.loadPlugins 与 commandName 行为：
 *   - loadPlugins: false（默认） → 完全跳过 PluginComponent init + register
 *   - loadPlugins: true          → 初始化 PluginComponent + 调用 loadPlugins(plugins)
 *   - commandName: "<x>"         → 跳过时记录 debug 日志包含 commandName
 *
 * 这是 BREAKING change：默认 loadPlugins 从「始终加载」改为「不加载」，
 * 调用方（act.ts、interactive.ts、tasks/complete.ts）必须显式传 loadPlugins:true。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { EnvironmentService } from "./environment.service";
import { OutputService } from "./output.service";
import { createLogger } from "@ai-setting/roy-bot-core";

// ★ 测试隔离（Task #5181）：不再使用真实 os.homedir() 拼 ~/.roy-bot/commands
//   （11-08 事故根因：bun test 触发 CommandsComponent.init() 无条件 mkdir
//   重建了真实的 ~/.roy-bot/commands 目录）。
//   改为 beforeEach 中 mkdtemp 临时目录，afterEach 整体删除 —— 零触碰真实 HOME。
let TEST_COMMANDS_DIR = ""; // 在 beforeEach 中赋值（mkdtemp 临时目录）

describe("EnvironmentService loadPlugins + commandName (Task #1960)", () => {
  let tempDir: string;
  let configPath: string;
  let outputService: OutputService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roy-env-scope-test-"));
    TEST_COMMANDS_DIR = path.join(tempDir, "commands");
    configPath = path.join(tempDir, "config.jsonc");
    await fs.writeFile(configPath, JSON.stringify({
      // ★ 必须用嵌套形式：FileSource.getNestedValue 按点号拆分嵌套取值，
      //   扁平键 {"command.userCommandsDir": X} 读出 undefined（Task #5181 根因 2）
      command: {
        userCommandsDir: TEST_COMMANDS_DIR,
        projectCommandsDir: path.join(tempDir, "project-commands"),
      },
    }));
    await fs.mkdir(TEST_COMMANDS_DIR, { recursive: true });
    outputService = new OutputService();
    outputService.configure({ quiet: true });
  });

  afterEach(async () => {
    // 临时目录整体删除（含 commands 子目录），无需逐条清理
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. loadPlugins:false（默认）→ 完全跳过 PluginComponent
  // ─────────────────────────────────────────────────────────────────────
  it("create({}) 不应初始化 pluginComponent（默认 loadPlugins=false）", async () => {
    const envService = new EnvironmentService(outputService);

    await envService.create({ configPath, sessionStorage: { type: "memory" } });

    try {
      // 私有字段 pluginComponent 应该保持 undefined
      expect((envService as any).pluginComponent).toBeUndefined();

      // env 也不应注册 plugin 组件
      const pluginComponent = envService.getEnvironment()?.getComponent("plugin");
      expect(pluginComponent).toBeUndefined();
    } finally {
      await envService.dispose();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. loadPlugins:false（显式）→ 同上
  // ─────────────────────────────────────────────────────────────────────
  it("create({loadPlugins:false}) 不应初始化 pluginComponent", async () => {
    const envService = new EnvironmentService(outputService);

    await envService.create({
      configPath,
      sessionStorage: { type: "memory" },
      loadPlugins: false,
    });

    try {
      expect((envService as any).pluginComponent).toBeUndefined();
      const pluginComponent = envService.getEnvironment()?.getComponent("plugin");
      expect(pluginComponent).toBeUndefined();
    } finally {
      await envService.dispose();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. loadPlugins:true → PluginComponent 已注册
  // ─────────────────────────────────────────────────────────────────────
  it("create({loadPlugins:true}) 应初始化 PluginComponent 并注册到 env", async () => {
    const envService = new EnvironmentService(outputService);

    await envService.create({
      configPath,
      sessionStorage: { type: "memory" },
      loadPlugins: true,
    });

    try {
      const pluginComponent = (envService as any).pluginComponent;
      expect(pluginComponent).toBeDefined();

      const envComponent = envService.getEnvironment()?.getComponent("plugin");
      expect(envComponent).toBeDefined();
    } finally {
      await envService.dispose();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. loadPlugins:true + plugins:["task-tag"] → loadPlugins 被调用，task-tag 已注册
  // ─────────────────────────────────────────────────────────────────────
  it("create({loadPlugins:true, plugins:['task-tag']}) 应注册 task-tag 插件", async () => {
    const envService = new EnvironmentService(outputService);

    await envService.create({
      configPath,
      sessionStorage: { type: "memory" },
      loadPlugins: true,
      plugins: ["task-tag"],
    });

    try {
      const pluginComponent: any = (envService as any).pluginComponent;
      expect(pluginComponent).toBeDefined();

      // PluginComponent 提供 list() 方法
      const registered = pluginComponent.list();
      const names = registered.map((p: any) => p.name);
      expect(names).toContain("task-tag");
    } finally {
      await envService.dispose();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. commandName:"sessions:list" → 默认不加载，debug 日志含 commandName
  // ─────────────────────────────────────────────────────────────────────
  it("create({commandName:'sessions:list'}) 默认不加载 plugin，debug 日志包含 commandName", async () => {
    const logger = createLogger("environment-service");
    const debugSpy = vi.spyOn(logger, "debug");

    const envService = new EnvironmentService(outputService);

    await envService.create({
      configPath,
      sessionStorage: { type: "memory" },
      commandName: "sessions:list",
    });

    try {
      expect((envService as any).pluginComponent).toBeUndefined();

      // 验证有 debug 日志包含 commandName 与 "loadPlugins"
      const calls = debugSpy.mock.calls.map((c) => String(c[0]));
      const found = calls.some(
        (msg) =>
          msg.includes("sessions:list") &&
          (msg.includes("loadPlugins") || msg.includes("Skipping PluginComponent"))
      );
      expect(found).toBe(true);
    } finally {
      await envService.dispose();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. commandName:"act" 但未传 loadPlugins:true → 仍不加载（BREAKING 默认）
  // ─────────────────────────────────────────────────────────────────────
  it("create({commandName:'act'}) 默认也不加载（仅 commandName 不带 loadPlugins:true）", async () => {
    const envService = new EnvironmentService(outputService);

    await envService.create({
      configPath,
      sessionStorage: { type: "memory" },
      commandName: "act",
    });

    try {
      expect((envService as any).pluginComponent).toBeUndefined();
      const pluginComponent = envService.getEnvironment()?.getComponent("plugin");
      expect(pluginComponent).toBeUndefined();
    } finally {
      await envService.dispose();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. dispose() 在 loadPlugins:false 创建后不 throw
  // ─────────────────────────────────────────────────────────────────────
  it("dispose() 在 loadPlugins:false 创建后调用不 throw", async () => {
    const envService = new EnvironmentService(outputService);

    await envService.create({
      configPath,
      sessionStorage: { type: "memory" },
      loadPlugins: false,
    });

    // 不应 throw
    expect(envService.dispose()).toBeInstanceOf(Promise);
    await envService.dispose();
  });
});