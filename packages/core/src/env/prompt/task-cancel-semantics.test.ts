/**
 * @fileoverview Task #5055 — task_cancel 语义收窄为「仅用户明令」+ 行为规则 6/6a 主语拆分
 *
 * 用户明令（2026-11-05）：
 *   「失败通知：最后多一步 task_cancel 收尾，这个不对，失败了，需要找原因继续推进任务，
 *     而不是 task-cancel，task-cancel 是用户明令下令才会调用哈」
 *
 *   「'行为规则 6 改了：… 并提醒「不要指示它用 task_complete」'这个看不明白行为规则是限制哪个 agent 的呢？」
 *
 * 本测试守住五条契约：
 *   A. default prompt 里 task_cancel 的触发条件是「用户明令」，不是 agent 自判「不值得继续」
 *   B. 失败通知小节不含「确定不再继续时 task_cancel 收尾」这类失败即取消的表述
 *   C. 行为规则 6 与 6a 各自写明主语（6 = 委托 prompt / sub-agent；6a = default agent）
 *   D. TASK_CANCEL_DESCRIPTION 工具描述同样体现「用户明令」语义
 *   E. 边界锁定：roy prompt 不含 task_cancel 新增措辞、也不含 compact_session
 */

import { describe, expect, test } from "vitest";
import { builtInPrompts } from "./prompts-index";
import { TASK_CANCEL_DESCRIPTION } from "../task/tools/cancel-tool";

const defaultPrompt = builtInPrompts["default"];
const royPrompt = builtInPrompts["roy"];

/** 取出 default prompt 中包含指定锚点的那一节（到下一个同级标题为止） */
const sectionAround = (prompt: string, anchor: string): string => {
  const idx = prompt.indexOf(anchor);
  expect(idx, `必须能在 default prompt 里定位锚点：${anchor}`).toBeGreaterThan(-1);
  const rest = prompt.slice(idx);
  // 下一个同级标题（## 或 ###）即为该节结束
  const nextHeading = rest.slice(1).search(/\n#{2,3} /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
};

/**
 * 取出「## 行为规则」整节 —— 行为规则的编号 6/6a 是全局唯一的，
 * 但 default prompt 其它小节也有以 "6. " 开头的行（如"如何处理用户请求"的"6. 汇报结果"），
 * 所以必须先按节切片再取编号行，否则会匹配到错误的 6。
 */
const behaviorRules = (prompt: string): string => {
  const idx = prompt.indexOf("## 行为规则");
  expect(idx, "必须能定位「## 行为规则」小节").toBeGreaterThan(-1);
  const rest = prompt.slice(idx);
  const next = rest.slice(1).search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("Task #5055 — task_cancel 语义收窄（仅用户明令）", () => {
  // ============================================================
  // A. 触发条件收窄为「用户明令」
  // ============================================================

  describe("A. default prompt 的 task_cancel 触发条件", () => {
    test("A1. 工具表里的 task_cancel 描述写明「用户明令」语义，不再是「验收不通过 / 用户要求」", () => {
      const row = defaultPrompt.split("\n").find((l) => l.includes("task_cancel") && l.trim().startsWith("|"));
      expect(row, "必须能定位工具表里的 task_cancel 行").toBeDefined();
      expect(row!, "工具表 task_cancel 行必须含「用户明令」").toContain("用户明令");
      // 旧的 agent 自判授权措辞必须消失
      expect(row!, "工具表 task_cancel 行不应再出现「验收不通过」自判授权").not.toContain("验收不通过");
    });

    test("A2. 全文不再出现「不值得继续 / 用户要求 → task_cancel」这类 agent 自判授权分支", () => {
      // 5 处旧表述里，2 处是「不值得继续 / 用户要求」，2 处是「不值得就 task_cancel」，1 处是「验收不通过」
      expect(defaultPrompt).not.toMatch(/不值得继续\s*\/\s*用户要求/);
      expect(defaultPrompt).not.toMatch(/不值得就\s*\\?`?task_cancel/);
    });

    test("A3. 「何时验收」表里 timeout/failed 通知不再导向 task_cancel，而是导向找根因后重新委托", () => {
      const table = sectionAround(defaultPrompt, "### 何时验收");
      expect(table).not.toMatch(/不值得就\s*\\?`?task_cancel/);
      expect(table).toMatch(/重新委托|续跑|找根因|修复/);
    });

    test("A4. 「验收四步」的第三步不含「不值得继续 → task_cancel」分支", () => {
      const steps = sectionAround(defaultPrompt, "### 验收四步");
      expect(steps).not.toMatch(/不值得继续/);
      expect(steps, "验收四步必须保留「重新委托」出路").toMatch(/重新委托/);
    });

    test("A5. 用户明令取消的路径仍然保留（不能把唯一入口也删掉）", () => {
      expect(defaultPrompt).toMatch(/用户说"取消|用户明令/);
      expect(defaultPrompt).toMatch(/task_cancel/);
    });
  });

  // ============================================================
  // B. 失败通知小节
  // ============================================================

  describe("B. 失败通知小节", () => {
    test("B1. 「任务失败通知」小节不含「确定不再继续时 task_cancel 收尾」", () => {
      const sec = sectionAround(defaultPrompt, "### 2. 任务失败通知");
      expect(sec).not.toMatch(/确定不再继续时\s*\\?`?task_cancel/);
    });

    test("B2. 失败通知小节给出「找根因 → 提修复方案 → 重新委托 → 如实告知用户等决定」的正路", () => {
      const sec = sectionAround(defaultPrompt, "### 2. 任务失败通知");
      expect(sec, "失败小节必须含重新委托出路").toMatch(/重新委托|续跑/);
      expect(sec, "失败小节必须含如实告知用户的出路").toMatch(/知会用户|告知用户|等用户|由用户/);
      expect(sec, "失败小节必须明确不自行取消").toMatch(/不.{0,10}(自行|自己).{0,10}(cancel|取消)/);
    });
  });

  // ============================================================
  // C. 行为规则 6 / 6a 主语拆分
  // ============================================================

  describe("C. 行为规则 6 与 6a 各自写明主语", () => {
    test("C1. 规则 6 写明主语是「委托 prompt 里」+「sub-agent」", () => {
      const m = behaviorRules(defaultPrompt).match(/^6\. .*$/m);
      expect(m, "必须能定位行为规则 6").not.toBeNull();
      const rule6 = m![0];
      expect(rule6, "规则 6 必须写明主语「委托 prompt 里」").toMatch(/委托\s*prompt\s*里/);
      expect(rule6, "规则 6 必须写明主语「sub-agent」").toMatch(/sub-?agent|子智能体/);
    });

    test("C2. 规则 6a 写明主语是「default agent」", () => {
      const m = behaviorRules(defaultPrompt).match(/^6a\. .*$/m);
      expect(m, "必须能定位行为规则 6a").not.toBeNull();
      expect(m![0], "规则 6a 必须写明主语「default agent」").toMatch(/default agent/);
    });

    test("C3. 规则 6 不得出现「default agent 自己要走 task_create→task_update→…」的误读空间", () => {
      const m = behaviorRules(defaultPrompt).match(/^6\. .*$/m);
      expect(m![0]).not.toMatch(/default agent/);
    });

    test("C4. 规则 6a 里提到 task_cancel 时必须体现「用户明令」要求", () => {
      const m = behaviorRules(defaultPrompt).match(/^6a\. .*$/m);
      expect(m![0]).toMatch(/用户明令|用户.{0,4}取消/);
    });
  });

  // ============================================================
  // D. 工具描述同步
  // ============================================================

  describe("D. TASK_CANCEL_DESCRIPTION 工具描述", () => {
    test("D1. 工具描述含「用户」明令相关措辞", () => {
      expect(TASK_CANCEL_DESCRIPTION).toMatch(/用户/);
      expect(TASK_CANCEL_DESCRIPTION).toMatch(/明令|asks to cancel|asks to stop|user asks/i);
    });

    test("D2. 工具描述不再把「验收不通过 / 不值得重试」列为可自行 cancel 的理由", () => {
      expect(TASK_CANCEL_DESCRIPTION).not.toMatch(/Acceptance failed and re-delegation is not worth it/);
      expect(TASK_CANCEL_DESCRIPTION).not.toMatch(/no longer relevant/);
    });
  });

  // ============================================================
  // E. 边界锁定：roy prompt 0 改动
  // ============================================================

  describe("E. 边界锁定（roy prompt 必须 0 改动）", () => {
    test("E1. roy prompt 不含 task_cancel", () => {
      expect(royPrompt).not.toContain("task_cancel");
    });

    test("E2. roy prompt 不含 compact_session", () => {
      expect(royPrompt).not.toContain("compact_session");
    });
  });
});
