/**
 * Task #4804 — renderCompletionState 逐条对照行（【逐条对照】段）
 *
 * 背景（e2e 探针 J/K/L/M）：v13e 对「goals 子项 vs 交付物声明」的
 * 隐式差异不敏感（H 形态 PASS 0.98），需要 state 里**明示**未达成
 * 子项才判 FAIL（J 形态 0.955，J2 复测稳定；K 全完成不误报 0.985；
 * L 纯事实枚举无结论词 PASS 0.911 —— 模型需要结论词）。
 *
 * 方案：renderCompletionState 渲染时自动生成【逐条对照】行 ——
 *   - goals 按「编号子项」拆行（1. / 2. / 3. …）
 *   - 每个子项抽首个路径 token，与交付物声明做包含比对
 *   - 命中 → 「已产出」；未命中 → 「未产出」+ 结论词
 *   - goals 无编号子项 / 无路径可抽 → 不生成对照行（保持原形态）
 */
import { describe, test, expect } from "bun:test";
import { renderCompletionState } from "./laya-completion-plugin";
import type { Task, TaskOperation } from "../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "T",
    description: "d",
    status: "completed",
    priority: "medium",
    type: "normal",
    progress: 100,
    current_status: "",
    goals_and_expected_deliverables: "",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    context: "{}",
    ...overrides,
  } as unknown as Task;
}

function oneCreateOp(): TaskOperation[] {
  return [
    {
      id: 1,
      taskId: 1,
      sessionId: "s",
      milestoneType: "create",
      milestoneTitle: "Task created",
      milestoneDescription: "任务已创建",
    } as unknown as TaskOperation,
  ];
}

describe("Task #4804 — renderCompletionState 逐条对照行", () => {
  test("编号子项 + 交付物声明 → 生成逐条对照（含未产出结论词）", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/a.txt，内容为 A\n2. 产出 /tmp/x/b.txt\n3. 产出 /tmp/x/c.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt, /tmp/x/b.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("【逐条对照】");
    // 已完成子项（Q 措辞：已产出）
    expect(state).toMatch(/1[.、]?\s*[^；]*已产出/);
    // 未完成子项必须带「未产出」+「目标未完成」结论词 + 全路径
    expect(state).toContain("未产出");
    expect(state).toContain("目标未完成");
    expect(state).toContain("/tmp/x/c.txt");
  });

  test("全部子项都在交付物声明中 → 对照行全部已产出 + 目标全部完成（不引入未完成字样）", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/a.txt\n2. 产出 /tmp/x/b.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt, /tmp/x/b.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("【逐条对照】");
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未完成");
    expect(state).not.toContain("未产出");
  });

  test("无交付物声明 → 不生成对照行（保持原形态，避免噪音）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: "{}",
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).not.toContain("【逐条对照】");
  });

  test("goals 无编号子项 → 不生成对照行", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "把事情做好",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).not.toContain("【逐条对照】");
  });

  test("编号子项但抽不出路径 → 不生成对照行（无法可靠比对）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 写测试\n2. 跑测试",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).not.toContain("【逐条对照】");
  });

  test("既有段落顺序保持：标题/目标/交付物声明/逐条对照/操作记录", () => {
    const task = makeTask({
      title: "顺序验证",
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    const iTitle = state.indexOf("【任务标题】");
    const iGoal = state.indexOf("【任务目标】");
    const iDeliv = state.indexOf("【交付物声明】");
    const iCheck = state.indexOf("【逐条对照】");
    const iOps = state.indexOf("【操作记录】");
    expect(iTitle).toBeGreaterThanOrEqual(0);
    expect(iGoal).toBeGreaterThan(iTitle);
    expect(iDeliv).toBeGreaterThan(iGoal);
    expect(iCheck).toBeGreaterThan(iDeliv);
    expect(iOps).toBeGreaterThan(iCheck);
  });
});

describe("Task #4804 — CV 修复（MAJOR-1/2/3）", () => {
  test("M1: 中文括号/引号不污染路径 token（产出（/tmp/x/a.txt）→ 已产出）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出（/tmp/x/a.txt）",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("已产出");
    expect(state).not.toContain("未产出");
  });

  test("M2a: deliverable 是分支名/URL（非路径形态）→ 不生成对照行（避免系统性误判）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 ~/src/a.ts",
      context: JSON.stringify({ deliverable_storage_path: "feature/my-branch" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).not.toContain("【逐条对照】");
  });

  test("M2b: 子串假阳性防护（/tmp/x/a.txt vs /tmp/x/a.txt.bak → 未产出）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt.bak" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    // a.txt 不是 a.txt.bak 的「完整 token 命中」→ 未产出
    expect(state).toContain("未产出");
  });

  test("M3: 对照行受上限约束（大量子项不突破 state 预算）", () => {
    const items = Array.from({ length: 200 }, (_, i) => `${i + 1}. 产出 /tmp/x/f${i}.txt`).join("\n");
    const deliverable = Array.from({ length: 200 }, (_, i) => `/tmp/x/f${i}.txt`).join(", ");
    const task = makeTask({
      goals_and_expected_deliverables: items,
      context: JSON.stringify({ deliverable_storage_path: deliverable }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    // 对照行不超过 1200 字符（与 GOALS_MAX 同量级的护栏）
    const m = state.match(/【逐条对照】([^\n]*)/);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray)[1].length).toBeLessThanOrEqual(1200);
  });
});

describe("Task #4804 — DS 复审 v2 修复", () => {
  test("开括号后置：产出 /tmp/x/a.txt（内容为 A）→ 已产出", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt（内容为 A）",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("已产出");
    expect(state).not.toContain("未产出");
  });

  test("全角冒号：报告 /tmp/x/r.md：每个生态 → token 截断到纯路径", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 报告 /tmp/x/r.md：每个生态的机制",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/r.md" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/r.md 已产出");
  });

  test("deliverable 用分号/顿号分隔 → 正确拆分比对", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt\n2. 产出 /tmp/x/b.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt；/tmp/x/b.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
  });

  test("deliverable 带附注（/path + URL）→ 剥附注后命中", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt + https://my.feishu.cn/file/xyz",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });
});

describe("Task #4804 — DS 复审 v3 修复", () => {
  test("MAJOR-1: deliverable 用 ' + ' 连接多路径 → 全部命中", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/a.md\n2. 产出 /tmp/b.md\n3. 产出 /tmp/c.diff",
      context: JSON.stringify({
        deliverable_storage_path:
          "/tmp/a.md (1616 行) + 报告 /tmp/b.md + diff /tmp/c.diff",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
  });

  test("MAJOR-2: 散文斜杠（分支名/比值/工具名）不产生假 token", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. commit 到 fix/task-show-* 分支\n2. 处理 (reward/duration/UnknownReadOperatorError)\n3. 6 节点全 tool/bash",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    // 三个子项都抽不出绝对路径 → 不生成对照行
    expect(state).not.toContain("【逐条对照】");
  });

  test("MINOR-2: deliverable 尾部标点被剥掉", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt。" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });

  test("MAJOR-2 回归：真实绝对路径仍能抽出（带左边界）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt，内容为 A",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });
});

describe("Task #4804 — DS 复审 v3 收尾（MAJOR-2b）", () => {
  test("伪路径 /tmp-host（单斜杠无扩展名）不产生 token", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 写 V3 YAML: 6 节点全 tool/bash + python_versions string 输入 + /tmp-host mount + cp13 --memory=12g",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/workflow_prod_wheels_validate_v3.yaml",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).not.toContain("【逐条对照】");
  });

  test("真路径 /tmp/x/a.txt（含 2 斜杠）仍被抽出", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });

  test("单层目录带扩展名 /report.md 仍被抽出", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /report.md",
      context: JSON.stringify({ deliverable_storage_path: "/report.md" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/report.md 已产出");
  });
});

describe("Task #4804 — DS 复审 round-4 修复", () => {
  // DS round-4 MAJOR-1: goals 子项含 URL → firstPathToken 抽出
  // "//my.feishu.cn/docx/abc" 假 token → 恒判「未产出」→ 假 FAIL hint
  test("MAJOR-1: goals 子项含 URL（且 URL 也已声明）→ 不误报未产出", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 发布 https://my.feishu.cn/docx/abc\n2. 产出 /tmp/x/a.md",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.md, https://my.feishu.cn/docx/abc",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    // URL 不是可比对路径 —— 该子项不可比对 → 整行不生成，绝不误报未产出
    expect(state).not.toContain("未产出");
    expect(state).not.toContain("【逐条对照】");
  });

  test("MAJOR-1b: goals 子项纯 URL → 不生成对照行（无可比对锚点）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 发布 https://my.feishu.cn/docx/abc",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.md, https://my.feishu.cn/docx/abc",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).not.toContain("【逐条对照】");
  });

  test("MAJOR-1c: goals 含 URL 子项 → 该子项不可比对 → 不生成对照行（不误报）", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 发布 https://my.feishu.cn/docx/abc\n2. 产出 /tmp/x/a.md\n3. 产出 /tmp/x/b.md",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.md, /tmp/x/b.md, https://x.cn/d",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    // 保守语义：任一子项无可比对锚点 → 整行不生成（宁可不生成，不误报）
    expect(state).not.toContain("【逐条对照】");
    expect(state).not.toContain("未产出");
  });

  // DS round-4 MINOR-1: 尾部 ASCII 标点未剥
  test("MINOR-1: deliverable 尾部 ASCII 标点（. ; )）被剥掉", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt." }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
    expect(state).not.toContain("未产出");
  });

  // DS round-4 MINOR-2: 截断把 token 切成半截
  test("MINOR-2: 截断后不出现半截 token（末尾是完整条目或结论）", () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `1. 产出 /tmp/x/file-${String(i).padStart(3, "0")}.txt`,
    ).join("\n");
    const task = makeTask({
      goals_and_expected_deliverables: many,
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/file-000.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    const line = state.split("\n").find((l) => l.includes("【逐条对照】")) ?? "";
    expect(line).not.toBe("");
    // 预算护栏：整体仍 <= 1200
    expect(line.length).toBeLessThanOrEqual(1200);
    // 结论词必须保留
    expect(line).toMatch(/目标(未完成|全部完成)/);
    // 截断必须切在**条目边界** —— 每个条目都是完整的「N. /path 已产出|未产出」
    const body = line.split("【逐条对照】")[1] ?? "";
    const entries = body.split("；").filter((e) => /^\d+\./.test(e.trim()));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.trim()).toMatch(/^\d+\. \/\S+ (已产出|未产出)$/);
    }
    // 不允许出现半截 token —— 上面的逐条格式校验已覆盖：
    // 任何被切断的条目都不可能匹配「N. /path 已产出|未产出」
    expect(body).toContain("…，目标");
  });
});

describe("Task #4804 — DS 复审 round-4 回归防护", () => {
  test("回归：冒号紧贴路径的合法形态仍能抽出（不因 URL 守卫被误杀）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出:/tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });

  test("回归：半角冒号 + 空格 + 路径仍能抽出", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出: /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });

  test("回归：全角冒号 + 路径仍能抽出", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出：/tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });

  test("回归：deliverable 侧含 URL 但目标是真路径 → 仍正确判定已产出", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt + https://my.feishu.cn/d",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
    expect(state).not.toContain("未产出");
  });
});

// ======================================================================
// Task #4834 — F1 修复：DELIVERABLE_SPLIT 不含空格
// ======================================================================
// 背景（reports/goals-criteria-rules-e2e-rebase.md §遗留 F1）：
//   DELIVERABLE_SPLIT = /[,，;；、\n]/ 不含空格 —— deliverable
//   用**空格**分隔多路径（"/tmp/a.md /tmp/b.md"）时，整串被当
//   一个段 → stripDeliverableToken 只扫出第一个路径 token
//   → 第二个子项被判「未产出」→ 误报 hint。
//   修复：splitDeliverableSegments 增加「空格分隔的裸路径」
//   拆段 —— 段内每个 / 开头的路径 token 独立成段。
describe("Task #4834 — F1: deliverable 空格分隔多路径", () => {
  test("空格分隔两路径 → 全部命中（不误报未产出）", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/a.txt\n2. 产出 /tmp/x/b.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt /tmp/x/b.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("【逐条对照】");
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
    expect(state).toContain("/tmp/x/a.txt 已产出");
    expect(state).toContain("/tmp/x/b.txt 已产出");
  });

  test("空格分隔 + 附注前缀（报告 /tmp/a.md 报告 /tmp/b.md）→ 全部命中", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/a.md\n2. 产出 /tmp/b.md",
      context: JSON.stringify({
        deliverable_storage_path: "报告 /tmp/a.md 报告 /tmp/b.md",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
  });

  test("空格分隔三路径（混合逗号）→ 全部命中", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/a.txt\n2. 产出 /tmp/x/b.txt\n3. 产出 /tmp/x/c.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt, /tmp/x/b.txt /tmp/x/c.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
  });

  test("回归：单个路径（无空格）不受影响", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({ deliverable_storage_path: "/tmp/x/a.txt" }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
  });

  test("回归：空格分隔但只声明了一个路径 → 仍正确报未产出（不放过真失败）", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/a.txt\n2. 产出 /tmp/x/b.txt",
      context: JSON.stringify({
        deliverable_storage_path: "/tmp/x/a.txt /tmp/x/missing.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("未产出");
    expect(state).toContain("/tmp/x/b.txt 未产出");
  });

  test("回归：URL + 空格分隔路径 → URL 段忽略，路径命中", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/a.txt\n2. 产出 /tmp/x/b.txt",
      context: JSON.stringify({
        deliverable_storage_path:
          "/tmp/x/a.txt https://my.feishu.cn/docx/abc /tmp/x/b.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
  });

  // CV MAJOR-1（交叉验证发现）：URL 打头 + 空格分隔多路径时，
  // URL 前缀与首个路径被合并成一段 → 该段以 "https://" 开头
  // → stripDeliverableToken 判为 URL 返回 null → 首个路径丢失
  // → 该子项被误标「未产出」（与 F1 要消灭的误报同类）。
  test("回归：URL 打头 + 空格分隔多路径 → 首个路径不被吞（不误报未产出）", () => {
    const task = makeTask({
      goals_and_expected_deliverables:
        "1. 产出 /tmp/x/b.txt\n2. 产出 /tmp/x/c.txt",
      context: JSON.stringify({
        deliverable_storage_path:
          "https://my.feishu.cn/docx/abc /tmp/x/b.txt /tmp/x/c.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("目标全部完成");
    expect(state).not.toContain("未产出");
    expect(state).toContain("/tmp/x/b.txt 已产出");
    expect(state).toContain("/tmp/x/c.txt 已产出");
  });

  test("回归：URL 打头 + 单个路径 → URL 与路径都能识别", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/b.txt",
      context: JSON.stringify({
        deliverable_storage_path:
          "https://my.feishu.cn/docx/abc /tmp/x/b.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/b.txt 已产出");
    expect(state).not.toContain("未产出");
  });

  // CV MINOR-2（第二轮交叉验证）：file:// 是本地路径的 URL 形态，
  // 不是「远端资源」—— 剥掉 scheme 后应按本地路径比对。
  test("回归：file:// URL 打头 + 空格路径 → 按本地路径比对（不误报未产出）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/b.txt",
      context: JSON.stringify({
        deliverable_storage_path: "file:///tmp/x/b.txt /tmp/x/c.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/b.txt 已产出");
    expect(state).not.toContain("未产出");
  });

  // CV MINOR-3（第二轮交叉验证）：段内多个 URL 时，只有最后一个
  // URL 之后的路径能被识别 → 前面的路径被静默丢弃。
  test("回归：多个 URL + 空格路径 → 路径不被丢弃（可被比对）", () => {
    const task = makeTask({
      goals_and_expected_deliverables: "1. 产出 /tmp/x/a.txt",
      context: JSON.stringify({
        deliverable_storage_path:
          "https://a.cn/x https://b.cn/y /tmp/x/a.txt",
      }),
    });
    const state = renderCompletionState(task, oneCreateOp());
    expect(state).toContain("/tmp/x/a.txt 已产出");
    expect(state).not.toContain("未产出");
  });
});
