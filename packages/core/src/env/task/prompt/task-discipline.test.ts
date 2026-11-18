/**
 * @fileoverview Task #4889 — 任务纪律单一真相源守门测试
 *
 * 背景：roy sub-agent prompt 的「任务一等公民」机制（M1–M16）
 *   此前只存在于 prompts-index.ts 的 roy prompt 内联文本 +
 *   各工具描述里，外部 runtime（opencode/claude/codex/CLI daemon）
 *   无法取用，只能手抄 → 漂移。
 *
 * 方案：新建 env/task/prompt/task-discipline.ts（零依赖常量模块），
 *   导出 TASK_DISCIPLINE_PROMPT + 4 分片，core 内部 roy prompt
 *   同步引用，外部 runtime 通过子路径导出取用。
 *
 * 本测试守住：
 *   1. 零依赖（只允许 import 同为零依赖的 completion-copy 锚点）
 *   2. 纪律含 M1–M16 关键锚点
 *   3. process_description 100-500 字符约束在文本里
 *   4. goals 编号子项 + 四原子断言在文本里
 *   5. HINT 二选一动作精确（status=todo / milestone_type=decision）
 *   6. 不含防退化纪律（属 Roy 全局纪律，不属 task 语义）
 *   7. 不含 Roy 专属内容（CLI 命令表 / {{memory}} / deniedTools）
 *   8. core 内部同源：roy prompt 包含 TASK_DISCIPLINE_PROMPT
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TASK_DISCIPLINE_PROMPT,
  TASK_DISCIPLINE_LIFECYCLE,
  TASK_DISCIPLINE_OPERATION,
  TASK_DISCIPLINE_GOALS,
  TASK_DISCIPLINE_COMPLETE,
} from "./task-discipline";
import { builtInPrompts } from "../../prompt/prompts-index";
import {
  TASK_COMPLETE_ITEM_BY_ITEM,
  TASK_COMPLETION_HINT_ANCHOR,
  TASK_COMPLETE_VERIFY_DUTY,
} from "../tools/completion-copy";

describe("Task #4889 — task-discipline 单一真相源", () => {
  it("1. 零依赖：模块只允许 import completion-copy 锚点", () => {
    const self = fileURLToPath(import.meta.url);
    const src = readFileSync(
      self.replace(/task-discipline\.test\.ts$/, "task-discipline.ts"),
      "utf-8",
    );
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) {
      expect(imp).toMatch(/completion-copy$/);
    }
  });

  it("2. M1/M2/M13/M14/M15：生命周期锚点（时机/复用/GATHER/追加/风险）", () => {
    const t = TASK_DISCIPLINE_LIFECYCLE;
    expect(t).toContain("边干边记");
    expect(t).toContain("事后批量补");
    expect(t).toContain("task_get");
    expect(t).toContain("task_operation_list");
    expect(t).toContain("Append");
    expect(t).toContain("outdated goals");
    expect(t).toContain("missed decisions");
    expect(t).toContain("duplicated work");
  });

  it("3. M3/M4/M5/M6/M16：operation 双维度锚点", () => {
    const t = TASK_DISCIPLINE_OPERATION;
    expect(t).toContain("milestone_type");
    expect(t).toContain("workflow_extracted");
    expect(t).toContain("100-500");
    expect(t).toContain("milestone_description");
    expect(t).toContain("deprecated");
    expect(t).toContain("不要把 action 当状态");
  });

  it("4. M5/M6 数字精确：100-500 是字符数硬约束", () => {
    expect(TASK_DISCIPLINE_OPERATION).toMatch(/100-500\s*字符/);
  });

  it("5. M7/M8/M9：goals 编号子项 + 四原子 + 反例 + 例外", () => {
    const t = TASK_DISCIPLINE_GOALS;
    expect(t).toContain("编号子项");
    expect(t).toContain("四原子");
    expect(t).toContain("文件断言");
    expect(t).toContain("进程断言");
    expect(t).toContain("测试断言");
    expect(t).toContain("状态断言");
    expect(t).toContain("做好");
    expect(t).toContain("longterm");
    expect(t).toContain("cycle");
  });

  it("6. M10/M11/M12：complete 逐条验收 + deliverable + HINT 二选一", () => {
    const t = TASK_DISCIPLINE_COMPLETE;
    expect(t).toContain(TASK_COMPLETE_ITEM_BY_ITEM);
    expect(t).toContain(`[${TASK_COMPLETION_HINT_ANCHOR}]`);
    expect(t).toContain(TASK_COMPLETE_VERIFY_DUTY);
    expect(t).toContain("deliverable_storage_path");
    expect(t).toContain("status=todo");
    expect(t).toContain("milestone_type=decision");
  });

  it("7. 共享锚点复用 completion-copy（不重打一遍）", () => {
    expect(TASK_DISCIPLINE_PROMPT).toContain(TASK_COMPLETE_ITEM_BY_ITEM);
    expect(TASK_DISCIPLINE_PROMPT).toContain(`[${TASK_COMPLETION_HINT_ANCHOR}]`);
    expect(TASK_DISCIPLINE_PROMPT).toContain(TASK_COMPLETE_VERIFY_DUTY);
  });

  it("8. 不含防退化纪律（属 Roy 全局纪律，不属 task 语义）", () => {
    const t = TASK_DISCIPLINE_PROMPT;
    expect(t).not.toContain("防退化");
    expect(t).not.toContain("80 行");
    expect(t).not.toContain("重复同一句话");
    expect(t).not.toContain("degeneration");
  });

  it("9. 不含 Roy 专属内容（CLI 命令 / {{memory}} / deniedTools）", () => {
    const t = TASK_DISCIPLINE_PROMPT;
    expect(t).not.toContain("roy-bot tasks");
    expect(t).not.toContain("roy-bot act");
    expect(t).not.toContain("{{memory}}");
    expect(t).not.toContain("deniedTools");
    expect(t).not.toContain("delegate_task");
  });

  it("10. 完整正文 = 4 分片之和（分片拼装无遗漏）", () => {
    for (const piece of [
      TASK_DISCIPLINE_LIFECYCLE,
      TASK_DISCIPLINE_OPERATION,
      TASK_DISCIPLINE_GOALS,
      TASK_DISCIPLINE_COMPLETE,
    ]) {
      expect(TASK_DISCIPLINE_PROMPT).toContain(piece);
    }
  });

  it("11. core 内部同源：roy prompt 引用 TASK_DISCIPLINE_PROMPT", () => {
    const roy = builtInPrompts["roy"] || "";
    expect(roy).toContain("Task as First-Class Citizen");
    // roy prompt 的 Task 章节必须内嵌纪律常量（同源而非手抄）
    expect(roy).toContain(TASK_DISCIPLINE_PROMPT);
  });
});
