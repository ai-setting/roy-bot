/**
 * @fileoverview Task #4722 — `roy-bot fallback-model` CLI 子命令测试
 *
 * CLI 是 command 子系统的**另一个前端**（与 es 卡片前端平级）：
 * 同一套 core command 实现，CLI 侧渲染为文本。
 *
 * 覆盖：
 * - 命令注册（fallback-model 主命令 + 四个子命令）
 * - 子命令 handler 真实调用 → config.jsonc 读写正确（注释保留）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  FallbackModelCommand,
  fallbackModelList,
  fallbackModelAdd,
  fallbackModelRemove,
  fallbackModelReorder,
} from "./fallback-model";
import {
  readFallbackModelList,
  writeFallbackModelList,
} from "@ai-setting/roy-bot-core";

/** 捕获 CLI 输出（替换 console.log） */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.log = collect;
  console.error = collect;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe("roy-bot fallback-model CLI (Task #4722)", () => {
  let workDir: string;
  let configPath: string;

  beforeEach(() => {
    workDir = join(
      tmpdir(),
      `roy-fbmodel-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    mkdirSync(workDir, { recursive: true });
    configPath = join(workDir, "config.jsonc");
  });

  test("命令注册：主命令名与 describe", () => {
    expect(FallbackModelCommand.command).toBe("fallback-model");
    expect(typeof FallbackModelCommand.describe).toBe("string");
    expect(typeof FallbackModelCommand.builder).toBe("function");
  });

  test("四个子命令都有 handler 与 command 名", () => {
    expect(fallbackModelList.command).toBe("list");
    expect(fallbackModelAdd.command).toBe("add <model>");
    expect(fallbackModelRemove.command).toBe("remove <index>");
    expect(fallbackModelReorder.command).toBe("reorder <from> <to>");
    for (const cmd of [
      fallbackModelList,
      fallbackModelAdd,
      fallbackModelRemove,
      fallbackModelReorder,
    ]) {
      expect(typeof cmd.handler).toBe("function");
    }
  });

  test("list handler：读出 fallback 列表并打印", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
    const cap = captureLog();
    try {
      await fallbackModelList.handler!({
        config: configPath,
      } as any);
    } finally {
      cap.restore();
    }
    const text = cap.lines.join("\n");
    expect(text).toContain("a/M1");
    expect(text).toContain("b/M2");
    // 优先级顺序
    expect(text.indexOf("a/M1")).toBeLessThan(text.indexOf("b/M2"));
  });

  test("list handler：空列表提示未配置", async () => {
    writeFileSync(configPath, '{\n  "llm": {}\n}');
    const cap = captureLog();
    try {
      await fallbackModelList.handler!({ config: configPath } as any);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("\n")).toContain("未配置");
  });

  test("add handler：写入 config（注释保留）", async () => {
    const original = [
      "{",
      "  // 用户注释必须保留",
      '  "llm": { "fallbackModels": ["a/M1"] }',
      "}",
    ].join("\n");
    writeFileSync(configPath, original);

    const cap = captureLog();
    try {
      await fallbackModelAdd.handler!({
        config: configPath,
        model: "b/M2",
      } as any);
    } finally {
      cap.restore();
    }

    expect(readFallbackModelList(configPath)).toEqual(["a/M1", "b/M2"]);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("// 用户注释必须保留");
  });

  test("add handler：重复添加 → 报错退出码非 0", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    let exitCode = 0;
    const cap = captureLog();
    const originalExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__EXIT__");
    };
    try {
      await fallbackModelAdd.handler!({
        config: configPath,
        model: "a/M1",
      } as any);
    } catch (e) {
      if ((e as Error).message !== "__EXIT__") throw e;
    } finally {
      (process as any).exit = originalExit;
      cap.restore();
    }
    expect(exitCode).not.toBe(0);
    // ★ Task #4722 收口：CLI 复用 command 实现 → 错误文案以 core 为准（单一事实源）
    expect(cap.lines.join("\n")).toContain("已在 fallback 列表");
  });

  test("remove handler：按序号删除", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2", "c/M3"] }\n}'
    );
    const cap = captureLog();
    try {
      await fallbackModelRemove.handler!({
        config: configPath,
        index: "2",
      } as any);
    } finally {
      cap.restore();
    }
    expect(readFallbackModelList(configPath)).toEqual(["a/M1", "c/M3"]);
  });

  test("remove handler：序号越界 → 报错退出码非 0", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    let exitCode = 0;
    const cap = captureLog();
    const originalExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__EXIT__");
    };
    try {
      await fallbackModelRemove.handler!({
        config: configPath,
        index: "9",
      } as any);
    } catch (e) {
      if ((e as Error).message !== "__EXIT__") throw e;
    } finally {
      (process as any).exit = originalExit;
      cap.restore();
    }
    expect(exitCode).not.toBe(0);
  });

  test("reorder handler：调整优先级", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
    const cap = captureLog();
    try {
      await fallbackModelReorder.handler!({
        config: configPath,
        from: "2",
        to: "1",
      } as any);
    } finally {
      cap.restore();
    }
    expect(readFallbackModelList(configPath)).toEqual(["b/M2", "a/M1"]);
  });

  test("core 写回函数：writeFallbackModelList 保持注释", () => {
    const original = [
      "{",
      "  // keep me",
      '  "llm": { "fallbackModels": ["a/M1"] }',
      "}",
    ].join("\n");
    writeFileSync(configPath, original);
    writeFallbackModelList(configPath, ["x/M9"]);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("// keep me");
    expect(readFallbackModelList(configPath)).toEqual(["x/M9"]);
  });
});
