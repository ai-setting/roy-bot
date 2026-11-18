/**
 * @fileoverview Task #4722 收口 — CommandOutput 双形态（text + card）
 *
 * 缺口（审计发现）：原 `CommandOutput` 是**互斥联合**
 * （`CommandTextOutput | CommandCardOutput`），同一命令只能产出一种形态。
 * 后果：CLI 前端拿不到 card、只能把业务逻辑复制一遍（list/add/remove/
 * reorder 各写一份），违背「可复用 roy-bot 已有 command 逻辑」的需求。
 *
 * 本文件定义目标契约：
 * - `output.text`：**恒为字符串**（任何前端都能渲染的降级形态）
 * - `output.card`：**可选**（es 飞书前端优先用的 interactive 卡片）
 *
 * 同一命令同时产出两者 → CLI 直接打印 text，es 直接发 card，
 * 业务逻辑只存在 core 一份。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  getGlobalCommandRegistry,
  isCommandMessage,
  extractCommandInvocation,
} from "./command-registry";

describe("Task #4722 收口：CommandOutput 双形态（text + card）", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `roy-cmd-dual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "config.jsonc");
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", "b/M2"] }\n}'
    );
  });

  test("list：同时产出 text 与 card（两种形态都可渲染）", async () => {
    const registry = getGlobalCommandRegistry();
    const result = await registry.dispatch("fallback-model", ["list"], {
      configPath,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
    // text 形态：恒为字符串，CLI 前端直接打印
    expect(typeof result.output!.text).toBe("string");
    expect(result.output!.text).toContain("a/M1");
    expect(result.output!.text).toContain("b/M2");
    // 优先级顺序在 text 里也成立
    expect(result.output!.text.indexOf("a/M1")).toBeLessThan(
      result.output!.text.indexOf("b/M2")
    );
    // card 形态：es 前端优先用
    expect(result.output!.card).toBeDefined();
  });

  test("add：产出 text + card（编辑后能回一张新卡片）", async () => {
    const registry = getGlobalCommandRegistry();
    const result = await registry.dispatch("fallback-model", ["add", "c/M3"], {
      configPath,
    });

    expect(result.ok).toBe(true);
    expect(result.output!.text).toContain("c/M3");
    // 新卡片应反映最新的 3 项
    expect(JSON.stringify(result.output!.card)).toContain("c/M3");
  });

  test("remove：产出 text + card", async () => {
    const registry = getGlobalCommandRegistry();
    const result = await registry.dispatch("fallback-model", ["remove", "1"], {
      configPath,
    });

    expect(result.ok).toBe(true);
    expect(result.output!.text).toContain("b/M2");
    expect(result.output!.card).toBeDefined();
  });

  test("reorder：产出 text + card", async () => {
    const registry = getGlobalCommandRegistry();
    const result = await registry.dispatch(
      "fallback-model",
      ["reorder", "2", "1"],
      { configPath }
    );

    expect(result.ok).toBe(true);
    expect(result.output!.text).toContain("b/M2");
    expect(result.output!.card).toBeDefined();
  });

  test("失败：ok=false + error（不产出 output）", async () => {
    const registry = getGlobalCommandRegistry();
    const result = await registry.dispatch("fallback-model", ["remove", "9"], {
      configPath,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.error).toContain("序号");
  });
});

describe("Task #4722 收口：前缀识别鲁棒性", () => {
  test("大小写不敏感（##COMMAND##: / ##Command##: 都识别）", () => {
    expect(isCommandMessage("##COMMAND##: list model")).toBe(true);
    expect(isCommandMessage("##Command##: list model")).toBe(true);
  });

  test("大小写不敏感时 subcommand 解析正常", () => {
    const inv = extractCommandInvocation("##COMMAND##: list model");
    expect(inv).not.toBeNull();
    expect(inv!.subcommand).toBe("list");
    expect(inv!.args).toEqual(["model"]);
  });

  test("前后空白容忍（前置空白 + 尾随空白）", () => {
    expect(isCommandMessage("   ##command##: list model   ")).toBe(true);
    const inv = extractCommandInvocation("  ##command##:   fallback-model   add   x/M1  ");
    expect(inv!.subcommand).toBe("fallback-model");
    expect(inv!.args).toEqual(["add", "x/M1"]);
  });
});
