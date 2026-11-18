/**
 * @fileoverview Task #4722 收口 — CLI 前端复用 command 子系统（不复制业务逻辑）
 *
 * 缺口（审计发现）：原 CLI `fallback-model` 命令把 list/add/remove/reorder
 * 的业务逻辑**整份复制**了一遍，与 core 的 command 实现各写各的。
 * 后果：两处逻辑会漂移（比如 core 支持 `show` 别名、CLI 不支持；
 * core 的错误文案与 CLI 的也不一致）。
 *
 * 目标契约：CLI 只是 command 子系统的**文本前端**，
 * 通过 `getGlobalCommandRegistry().dispatch(...)` 拿到结果后打印 `output.text`。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  FallbackModelCommand,
  fallbackModelList,
  fallbackModelShow,
  fallbackModelAdd,
  fallbackModelRemove,
  fallbackModelReorder,
  fallbackModelMove,
} from "./fallback-model";
import { readFallbackModelList } from "@ai-setting/roy-bot-core";

/** 捕获 CLI 输出（替换 console.log / console.error） */
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

describe("Task #4722 收口：CLI 复用 command 子系统", () => {
  let workDir: string;
  let configPath: string;

  beforeEach(() => {
    workDir = join(
      tmpdir(),
      `roy-fbmodel-cli2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    mkdirSync(workDir, { recursive: true });
    configPath = join(workDir, "config.jsonc");
  });

  test("CLI list：输出与 command 子系统的 text 形态一致（含顺序）", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
    const cap = captureLog();
    try {
      await fallbackModelList.handler!({ config: configPath } as any);
    } finally {
      cap.restore();
    }
    const text = cap.lines.join("\n");
    expect(text).toContain("a/M1");
    expect(text).toContain("b/M2");
    expect(text.indexOf("a/M1")).toBeLessThan(text.indexOf("b/M2"));
  });

  test("CLI add：复用 command 实现 → 写盘结果与 core 一致", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
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
  });

  test("CLI add：core 不支持的能力不会静默漂移（错误文案与 core 一致）", async () => {
    // 重复添加：CLI 应报「已存在」——与 core command 的错误语义一致
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
    // ★ Task #4722 收口：错误文案以 core command 为准（单一事实源）
    expect(cap.lines.join("\n")).toContain("已在 fallback 列表");
  });

  test("CLI remove：复用 command 实现", async () => {
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

  test("CLI reorder：复用 command 实现", async () => {
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

  test("CLI show 别名（core 有、CLI 之前没有）→ 现在行为一致", async () => {
    // core command 支持 `show` 别名；CLI 复用后应自动获得同源行为
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    const cap = captureLog();
    try {
      await fallbackModelList.handler!({ config: configPath } as any);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("\n")).toContain("a/M1");
  });

  test("CLI 注释保留仍生效（复用 core 的 jsonc modify 写回）", async () => {
    const original = [
      "{",
      "  // keep me",
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
    expect(readFileSync(configPath, "utf-8")).toContain("// keep me");
    expect(readFallbackModelList(configPath)).toEqual(["a/M1", "b/M2"]);
  });

  test("CLI 命令注册结构不变（主命令 + 4 子命令）", () => {
    expect(FallbackModelCommand.command).toBe("fallback-model");
    expect(fallbackModelList.command).toBe("list");
    expect(fallbackModelAdd.command).toBe("add <model>");
    expect(fallbackModelRemove.command).toBe("remove <index>");
    expect(fallbackModelReorder.command).toBe("reorder <from> <to>");
  });

  test("★ CLI 补齐 core 的 show / move 子命令（消除 CLI-core 漂移）", async () => {
    // show = list 的别名
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1"] }\n}'
    );
    const cap = captureLog();
    try {
      await fallbackModelShow.handler!({ config: configPath } as any);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("\n")).toContain("a/M1");

    // move = 按模型标识 + 方向（与卡片按钮同语义）
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
    const cap2 = captureLog();
    try {
      await fallbackModelMove.handler!({
        config: configPath,
        model: "b/M2",
        direction: "up",
      } as any);
    } finally {
      cap2.restore();
    }
    expect(readFallbackModelList(configPath)).toEqual(["b/M2", "a/M1"]);
  });
});
