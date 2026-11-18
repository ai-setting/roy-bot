/**
 * @fileoverview Roy Agent Prompt Tests
 *
 * TDD 测试：验证 `roy` agent 的 systemPrompt 与它的 allowedTools/deniedTools 一致。
 *
 * 背景（来自 /tmp/prompt-hallucination-audit.md）：
 * - `roy` agent 的 `deniedTools = ["delegate_task", "stop_task"]`
 * - 旧版 prompt 把 `delegate_task` / `stop_task` 列在「Task Management Tools」表里 +
 *   把生命周期里第 3 步标成 `EXECUTE (delegate_task)` + 在文本里反复推荐 delegate_task。
 * - LLM 读到 prompt 后会尝试调这两个工具 → 被框架拦截 → 浪费迭代。
 *
 * 修复目标：这两个工具必须从 prompt 的"可用工具表"里消失，并明确放到"禁止使用"区块。
 */

import { describe, expect, test } from "vitest";
import { builtInPrompts } from "./prompts-index";

describe("roy Agent Prompt — Tool Hallucination (Task #2033 P0-1)", () => {
  const prompt = builtInPrompts["roy"];

  test("roy prompt exists", () => {
    expect(prompt).toBeDefined();
    expect(typeof prompt).toBe("string");
  });

  // ============================================================
  // RED assertions: 这些是修复后应该全部满足的不变式
  // ============================================================

  describe("工具表不允许出现 delegate_task / stop_task（这两个在 deniedTools 里）", () => {
    test("Task Management Tools 表里不应该出现 delegate_task", () => {
      // 抓取「Task Management Tools」表格（`| 工具 |` 开头到下一个空行/标题）
      const tableMatch = prompt.match(/### Task Management Tools[\s\S]*?(?=\n### |\n## |\n$)/);
      expect(tableMatch).not.toBeNull();
      const table = tableMatch![0];
      expect(table).not.toMatch(/\| `?delegate_task`? \|/);
    });

    test("Task Management Tools 表里不应该出现 stop_task", () => {
      const tableMatch = prompt.match(/### Task Management Tools[\s\S]*?(?=\n### |\n## |\n$)/);
      expect(tableMatch).not.toBeNull();
      const table = tableMatch![0];
      expect(table).not.toMatch(/\| `?stop_task`? \|/);
    });
  });

  describe("生命周期里不应该用 EXECUTE (delegate_task)", () => {
    test("lifecycle 步骤 3 不应该是 'EXECUTE (delegate_task)'", () => {
      // 抓取 Task Lifecycle 段落
      const lifecycleMatch = prompt.match(/### Task Lifecycle[\s\S]*?(?=\n### |\n## |\n$)/);
      expect(lifecycleMatch).not.toBeNull();
      const lifecycle = lifecycleMatch![0];
      // 不能出现 "EXECUTE (delegate_task)" 这种标题行
      expect(lifecycle).not.toMatch(/3\.\s*EXECUTE\s*\(delegate_task\)/);
    });
  });

  describe("必须有禁止使用区块明确列出 delegate_task / stop_task", () => {
    test("roy prompt 应该包含禁止/不支持 delegate_task 的说明", () => {
      // 至少有"禁止"/"不要使用"/"不支持"/"cannot"/"denied"等关键词 + delegate_task
      // 允许的多种表达形式：禁止使用的工具 / 不支持的工具 / 不可用工具等
      // 抓取禁止区块（标题后整段），再检查其中是否出现 delegate_task
      const forbiddenSection = prompt.match(
        /###[^#]*禁止使用[\s\S]*?(?=\n### |\n## |\n$)/,
      );
      expect(forbiddenSection, "必须有禁止使用区块").not.toBeNull();
      expect(forbiddenSection![0]).toMatch(/delegate_task/);
    });

    test("roy prompt 应该包含禁止/不支持 stop_task 的说明", () => {
      const forbiddenSection = prompt.match(
        /###[^#]*禁止使用[\s\S]*?(?=\n### |\n## |\n$)/,
      );
      expect(forbiddenSection, "必须有禁止使用区块").not.toBeNull();
      expect(forbiddenSection![0]).toMatch(/stop_task/);
    });

    test("禁止使用区块中禁止工具应该至少有一句'不能调用'类的明确说明", () => {
      const forbiddenSection = prompt.match(
        /###[^#]*禁止使用[\s\S]*?(?=\n### |\n## |\n$)/,
      );
      expect(forbiddenSection).not.toBeNull();
      // 必须有"不能调用"/"不能使用"/"不要使用"/"禁止调用"等
      expect(forbiddenSection![0]).toMatch(/不能调用|不能使用|不要调用|不要使用|禁止调用|不支持/);
    });
  });
});