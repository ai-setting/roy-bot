/**
 * @fileoverview Task #4722 round3 — `llm.fallbackModels` 必须真正到达 agent
 *
 * ★ 交叉验证第 2 轮 MAJOR（M1）：`llm.fallbackModels` **从未被加载进
 *   ConfigComponent 的内存层** ——
 *   - `llm.ts` 的 `llmKeys` 白名单里没有 `llm.fallbackModels`
 *     → file source 读到了也不会 `configComponent.set(...)`
 *   - `ConfigComponent.get()` 只读内存层
 *   → `agent-component.ts` 的 `configComponent.get("llm.fallbackModels")`
 *     在生产里**恒为 undefined**
 *   → agent 一直用旧的 `llm.fallbackModel` 单值
 *   → 卡片/CLI 改的列表**运行时毫无效果**（假功能）。
 *
 * 本测试走**真实加载路径**（file source → 内存层），不是 `set()` 直接注入
 * —— 原测试正是用 `set()` 注入才掩盖了这个 bug。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { ConfigComponent } from "../../config/config-component";
import { LLMComponent } from "./llm";

describe("Task #4722 round3：llm.fallbackModels 加载进 ConfigComponent 内存层", () => {
  let dir: string;
  let configPath: string;
  let configComponent: ConfigComponent;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roy-4722-m1-"));
    configPath = join(dir, "config.jsonc");
    configComponent = new ConfigComponent();
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("从真实 config.jsonc 文件加载 → llm.fallbackModels 出现在内存层", async () => {
    writeFileSync(
      configPath,
      [
        "{",
        '  "llm": {',
        '    "defaultModel": "tong/GLM-5.3-Flash",',
        '    "fallbackModels": ["a/M1", "b/M2"]',
        "  }",
        "}",
      ].join("\n")
    );

    const llm = new LLMComponent();
    await llm.init({
      name: "llm",
      version: "1.0.0",
      enabled: true,
      options: { configComponent, configPath },
    } as any);

    // ★ 关键断言：数组必须真的进了内存层
    const loaded = configComponent.get("llm.fallbackModels");
    expect(loaded).toBeDefined();
    expect(loaded).toEqual(["a/M1", "b/M2"]);
  });

  test("对照组：llm.defaultModel 走同一条路径（证明加载机制本身正常）", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "defaultModel": "tong/GLM-5.3-Flash" }\n}'
    );

    const llm = new LLMComponent();
    await llm.init({
      name: "llm",
      version: "1.0.0",
      enabled: true,
      options: { configComponent, configPath },
    } as any);

    expect(configComponent.get("llm.defaultModel")).toBe("tong/GLM-5.3-Flash");
  });

  test("fallbackModels 数组的顺序被保留（顺序 = 优先级）", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["z/M9", "a/M1", "b/M2"] }\n}\n'
    );

    const llm = new LLMComponent();
    await llm.init({
      name: "llm",
      version: "1.0.0",
      enabled: true,
      options: { configComponent, configPath },
    } as any);

    expect(configComponent.get("llm.fallbackModels")).toEqual([
      "z/M9",
      "a/M1",
      "b/M2",
    ]);
  });
});
