/**
 * @fileoverview Task #4467 — task_create 合理性检测：verdict 纯函数单测
 *
 * 契约：/tmp/task-create-verdict-contract-v2.md
 *
 * 覆盖：
 *   - parseSimilarTaskIds：正常 / 空 / 非 JSON / 非数组 / 超 20 截断 / 非法 id
 *   - deriveActionFromStatus：6 种 status → reopen / enhance
 *   - buildHintText：4 种场景输出含正确的 task_update 参数
 *   - assertNoLeakage：含 expected_decision 的 state 必须抛错；
 *     含用户自由文本里的 "expected"/"label" 字样不得误报
 */

import { describe, test, expect } from "bun:test";
import {
  parseSimilarTaskIds,
  deriveActionFromStatus,
  buildHintText,
  assertNoLeakage,
  writeDecisionHint,
  renderCandidateKey,
  renderCandidateValue,
  formatRelativeAge,
  MAX_SIMILAR_TASK_IDS,
} from "./verdict";
import type { CreateTaskOptions } from "../types";

// ========================================================================
// parseSimilarTaskIds
// ========================================================================

describe("parseSimilarTaskIds", () => {
  test("returns [] for undefined / empty context", () => {
    expect(parseSimilarTaskIds(undefined)).toEqual([]);
    expect(parseSimilarTaskIds("")).toEqual([]);
  });

  test("returns [] for non-JSON context (no throw)", () => {
    expect(parseSimilarTaskIds("not json")).toEqual([]);
    expect(parseSimilarTaskIds("{broken")).toEqual([]);
  });

  test("returns [] for valid JSON that is not an object", () => {
    expect(parseSimilarTaskIds("123")).toEqual([]);
    expect(parseSimilarTaskIds("[1,2,3]")).toEqual([]);
    expect(parseSimilarTaskIds('"hello"')).toEqual([]);
    expect(parseSimilarTaskIds("null")).toEqual([]);
  });

  test("returns [] when field is missing", () => {
    expect(parseSimilarTaskIds('{"type":"feature"}')).toEqual([]);
  });

  test("returns [] when field is an empty array", () => {
    expect(parseSimilarTaskIds('{"similar_task_ids":[]}')).toEqual([]);
  });

  test("returns [] when field is not an array (string)", () => {
    expect(parseSimilarTaskIds('{"similar_task_ids":"4433"}')).toEqual([]);
  });

  test("returns [] when field is not an array (object/number)", () => {
    expect(parseSimilarTaskIds('{"similar_task_ids":{"a":1}}')).toEqual([]);
    expect(parseSimilarTaskIds('{"similar_task_ids":42}')).toEqual([]);
  });

  test("parses normal array", () => {
    expect(parseSimilarTaskIds('{"similar_task_ids":[4433,4445]}')).toEqual([4433, 4445]);
  });

  test("drops invalid ids but keeps valid ones", () => {
    expect(parseSimilarTaskIds('{"similar_task_ids":[4433,"4445"]}')).toEqual([4433]);
    expect(parseSimilarTaskIds('{"similar_task_ids":[0,-1,4433]}')).toEqual([4433]);
    expect(parseSimilarTaskIds('{"similar_task_ids":[4433.7]}')).toEqual([]);
    expect(parseSimilarTaskIds('{"similar_task_ids":[4433,null,true]}')).toEqual([4433]);
    expect(parseSimilarTaskIds('{"similar_task_ids":[4433,[1]]}')).toEqual([4433]);
  });

  test("truncates to 20 entries (MAX_SIMILAR_TASK_IDS)", () => {
    const ids = Array.from({ length: 30 }, (_, i) => 1000 + i);
    const parsed = parseSimilarTaskIds(JSON.stringify({ similar_task_ids: ids }));
    expect(parsed).toHaveLength(MAX_SIMILAR_TASK_IDS);
    expect(parsed[0]).toBe(1000);
    expect(parsed[MAX_SIMILAR_TASK_IDS - 1]).toBe(1000 + MAX_SIMILAR_TASK_IDS - 1);
  });

  test("de-duplicates preserving first occurrence order", () => {
    expect(parseSimilarTaskIds('{"similar_task_ids":[3,1,3,2,1]}')).toEqual([3, 1, 2]);
  });

  test("keeps other context fields intact when parsing (read-only)", () => {
    const ctx = '{"type":"feature","similar_task_ids":[1,2]}';
    parseSimilarTaskIds(ctx);
    expect(JSON.parse(ctx)).toEqual({ type: "feature", similar_task_ids: [1, 2] });
  });
});

// ========================================================================
// deriveActionFromStatus
// ========================================================================

describe("deriveActionFromStatus", () => {
  test("terminal / paused statuses derive to reopen", () => {
    expect(deriveActionFromStatus("completed")).toBe("reopen");
    expect(deriveActionFromStatus("cancelled")).toBe("reopen");
    expect(deriveActionFromStatus("paused")).toBe("reopen");
    expect(deriveActionFromStatus("archived")).toBe("reopen");
  });

  test("active statuses derive to enhance", () => {
    expect(deriveActionFromStatus("todo")).toBe("enhance");
    expect(deriveActionFromStatus("active")).toBe("enhance");
  });

  test("unknown status falls back to enhance", () => {
    expect(deriveActionFromStatus("weird")).toBe("enhance");
    expect(deriveActionFromStatus("")).toBe("enhance");
  });
});

// ========================================================================
// buildHintText
// ========================================================================

describe("buildHintText", () => {
  const targetTask = {
    title: "[Investigate] extractor operator 行为分析",
    status: "active",
    type: "normal",
  };

  test("scenario reuse → contains task_update with description (no status=)", () => {
    const out = buildHintText({
      scenario: "reuse",
      newTaskId: 4482,
      targetTaskId: 4447,
      targetTask,
    });
    expect(out).toContain("[TASK_CREATE_HINT]");
    expect(out).toContain("task_update(task_id=4447");
    expect(out).toContain("description=");
    expect(out).toContain("本次已创建新任务 #4482");
    // active → enhance：不应改 status
    expect(out).not.toContain("status=");
  });

  test("scenario reopen (completed) → contains task_update with status=todo", () => {
    const out = buildHintText({
      scenario: "reopen",
      newTaskId: 4482,
      targetTaskId: 4447,
      targetTask: { ...targetTask, status: "completed" },
    });
    expect(out).toContain("[TASK_CREATE_HINT]");
    expect(out).toContain("task_update(task_id=4447, status=todo");
    expect(out).toContain("本次已创建新任务 #4482");
  });

  test("scenario reopen (paused) → contains status=active", () => {
    const out = buildHintText({
      scenario: "reopen",
      newTaskId: 4482,
      targetTaskId: 4447,
      targetTask: { ...targetTask, status: "paused" },
    });
    expect(out).toContain("task_update(task_id=4447, status=active");
  });

  test("scenario reopen_enhance → contains status AND goals param", () => {
    const out = buildHintText({
      scenario: "reopen_enhance",
      newTaskId: 4482,
      targetTaskId: 4447,
      targetTask: { ...targetTask, status: "completed" },
      includeGoals: true,
    });
    expect(out).toContain("task_update(task_id=4447, status=todo");
    expect(out).toContain("goals_and_expected_deliverables=");
  });

  test("scenario remount → contains parent_task_id param", () => {
    const out = buildHintText({
      scenario: "remount",
      newTaskId: 4482,
      recommendedRootId: 2859,
      recommendedRootTitle: "[Longterm] roy-bot 主线研发",
      currentParentId: 4480,
      currentRootAncestorId: 4467,
    });
    expect(out).toContain("[TASK_CREATE_HINT]");
    expect(out).toContain("task_update(task_id=4482, parent_task_id=2859)");
    expect(out).toContain("#2859");
    expect(out).toContain("本次已创建新任务 #4482");
  });

  test("scenario soft_reuse → conservative wording, no archive instruction", () => {
    const out = buildHintText({
      scenario: "soft_reuse",
      newTaskId: 4482,
      targetTaskId: 4447,
      targetTask,
      confidence: 0.5,
    });
    expect(out).toContain("[TASK_CREATE_HINT]");
    expect(out).toContain("可能");
    expect(out).toContain("仅供参考");
    expect(out).not.toContain("建议复用");
  });

  test("every scenario mentions the created task id and the hint marker", () => {
    const scenarios = ["reuse", "reopen", "reopen_enhance", "remount", "soft_reuse"] as const;
    for (const scenario of scenarios) {
      const out = buildHintText({
        scenario,
        newTaskId: 4482,
        targetTaskId: 4447,
        targetTask,
        recommendedRootId: 2859,
        recommendedRootTitle: "root",
        currentParentId: 4480,
        currentRootAncestorId: 4467,
      });
      expect(out).toContain("[TASK_CREATE_HINT]");
      expect(out).toContain("#4482");
    }
  });
});

// ========================================================================
// buildHintText — 核实义务 + 行动指引（Task #4697）
//
// 背景（Task #4687 结论）：hint 文案自称「仅供参考，不影响本次创建结果」，
// 且 roy agent prompt 无任何 hint 政策指引 → agent 选择「转述给用户等确认」
// 而不是「核实后自主执行」。本次改造把 hint 结尾统一改为：
//   ① 核实义务（必须 task_get 核实）
//   ② 场景化核实要点（每种 hint 各自的核实锚点）
//   ③ 二选一行动指引（采纳 → 执行 task_update；不采纳 → 说明理由）
//   ④ 不允许无视
//
// 原则不变：hint 只是提示，不是拦截 —— 任务照常创建，agent 保留否决权，
// 但必须**表态**（采纳或不采纳的理由）。
// ========================================================================

describe("buildHintText — 核实义务 + 行动指引（Task #4697）", () => {
  const targetTask = {
    title: "[Investigate] extractor operator 行为分析",
    status: "active",
    type: "normal",
  };

  const scenarios = ["reuse", "reopen", "reopen_enhance", "remount", "soft_reuse"] as const;

  function buildFor(scenario: (typeof scenarios)[number]) {
    return buildHintText({
      scenario,
      newTaskId: 4482,
      targetTaskId: 4447,
      targetTask:
        scenario === "reopen" || scenario === "reopen_enhance"
          ? { ...targetTask, status: "completed" }
          : targetTask,
      includeGoals: true,
      recommendedRootId: 2859,
      recommendedRootTitle: "[Longterm] roy-bot 主线研发",
      currentParentId: 4480,
      currentRootAncestorId: 4467,
    });
  }

  test("every scenario carries the verification duty + two-way action guide", () => {
    for (const scenario of scenarios) {
      const out = buildFor(scenario);
      // ① 核实义务
      expect(out).toContain("你必须核实本提示");
      expect(out).toContain("task_get(");
      // ② 场景化核实要点
      expect(out).toContain("核实要点");
      // ③ 二选一行动指引
      expect(out).toContain("核实后二选一执行");
      expect(out).toContain("(a) 确认");
      expect(out).toContain("(b) 确认");
      expect(out).toContain("明确说明不采纳的理由");
      // ④ 不允许无视
      expect(out).toContain("不允许无视本提示");
    }
  });

  test("no scenario keeps the old 'doesn't affect creation' disclaimer", () => {
    for (const scenario of scenarios) {
      const out = buildFor(scenario);
      // 旧文案让 agent 有理由「视而不见」——必须彻底移除
      expect(out).not.toContain("不影响本次创建结果");
      expect(out).not.toContain("本提示仅供参考，不影响");
    }
  });

  test("reuse → check point asks 'same thing' vs 'new step of same topic'", () => {
    const out = buildFor("reuse");
    expect(out).toContain("同一件事");
    expect(out).toContain("同主题的新一步");
    // 同主题新一步 → 建子任务不算「不采纳」，但仍需说明
    expect(out).toContain("建子任务不算不采纳");
  });

  test("reopen → check point asks whether target really finished", () => {
    const out = buildFor("reopen");
    expect(out).toContain("完结");
    expect(out).toContain("重开");
  });

  test("reopen_enhance → check point also asks whether new goals belong to target scope", () => {
    const out = buildFor("reopen_enhance");
    expect(out).toContain("完结");
    expect(out).toContain("范围内");
  });

  test("remount → check point asks which root ancestor line is the right one", () => {
    const out = buildFor("remount");
    expect(out).toContain("归属线");
    // remount 的核实对象是新任务 + 建议 root（不是 target task）
    expect(out).toContain("task_get(4482)");
    expect(out).toContain("task_get(2859)");
    // (a) 必须是改挂语义
    expect(out).toContain("执行改挂");
  });

  test("soft_reuse → low confidence lowers the weight but still requires a statement", () => {
    const out = buildFor("soft_reuse");
    expect(out).toContain("权重");
    expect(out).toContain("表态");
    // 旧措辞「仅供参考」保留（低置信提示）
    expect(out).toContain("仅供参考");
  });

  test("reuse action (a) still points at the suggested task_update and archiving", () => {
    const out = buildFor("reuse");
    expect(out).toContain("(a) 确认实质相同");
    expect(out).toContain("执行复用");
    expect(out).toContain("归档");
    // 不放宽原有断言：reuse 不应改 status
    expect(out).not.toContain("status=");
  });
});

// ========================================================================
// assertNoLeakage
// ========================================================================

describe("assertNoLeakage", () => {
  test("throws when state contains expected_decision", () => {
    const state = {
      task_to_route: {
        title: "x",
        expected_decision: "attach_to_existing",
      },
    };
    expect(() => assertNoLeakage(state, {})).toThrow();
  });

  test("throws when state contains expected_root", () => {
    const state = { task_to_route: { title: "x", expected_root: "#2859" } };
    expect(() => assertNoLeakage(state, {})).toThrow();
  });

  test("throws when questions contain case_id / best_match* keys", () => {
    expect(() => assertNoLeakage({}, { best_match: { type: "choice" } })).toThrow();
    expect(() => assertNoLeakage({}, { q: { case_id: "T01" } })).toThrow();
  });

  test("throws for nested array-of-object leakage", () => {
    const state = {
      similar_tasks: [{ id: 1, gold: "should be #4447" }],
    };
    expect(() => assertNoLeakage(state, {})).toThrow();
  });

  test("does NOT false-positive on user free text containing expected/label", () => {
    const state = {
      task_to_route: {
        title: "用户期望的 label 是 expected-value",
        description: "This description mentions label and expected and answer in plain text.",
        goals: "希望得到 answer",
      },
      similar_tasks: [{ id: 4447, snippet: "expected label answer hint" }],
    };
    expect(() => assertNoLeakage(state, {})).not.toThrow();
  });

  test("does NOT false-positive on legitimate keys (title/description/tags/id)", () => {
    const state = {
      task_to_route: {
        title: "ok",
        description: "ok",
        goals: "ok",
        tags: ["a"],
        project_path: "/p",
      },
      similar_tasks: [{ id: 1, status: "active", ago: "2d", title: "t", snippet: "s", tags: ["x"] }],
    };
    expect(() => assertNoLeakage(state, {})).not.toThrow();
  });

  test("accepts the documented Stage A state shape", () => {
    const state = {
      task_to_route: {
        title: "优化 Workflow 引擎 P0 timeout 报错信息",
        description: "…",
        goals: "",
        tags: ["workflow"],
        project_path: "/p",
      },
      similar_tasks: [{ id: 4447, status: "completed", ago: "2d", title: "t", snippet: "s", tags: ["e2e"] }],
    };
    const questions = {
      reuse_or_create: { type: "choice", instructions: "…", criteria: { "NEW_TASK": "…" } },
    };
    expect(() => assertNoLeakage(state, questions)).not.toThrow();
  });
});

// ========================================================================
// writeDecisionHint
// ========================================================================

describe("writeDecisionHint", () => {
  function makeOptions(context: string): CreateTaskOptions {
    return {
      title: "t",
      sessionId: "s",
      project_path: "/p",
      context,
    };
  }

  test("writes decision_hint into a valid context and preserves other fields", () => {
    const opts = makeOptions('{"type":"feature","branch":"feat/x"}');
    const ok = writeDecisionHint(opts, "[TASK_CREATE_HINT] hello");
    expect(ok).toBe(true);
    const parsed = JSON.parse(opts.context);
    expect(parsed.decision_hint).toBe("[TASK_CREATE_HINT] hello");
    expect(parsed.type).toBe("feature");
    expect(parsed.branch).toBe("feat/x");
  });

  test("returns false and does NOT modify context when context is invalid JSON", () => {
    const opts = makeOptions("not json");
    const ok = writeDecisionHint(opts, "hint");
    expect(ok).toBe(false);
    expect(opts.context).toBe("not json");
  });

  test("returns false when context is a JSON array / scalar", () => {
    const arr = makeOptions("[1,2]");
    expect(writeDecisionHint(arr, "hint")).toBe(false);
    expect(arr.context).toBe("[1,2]");

    const num = makeOptions("42");
    expect(writeDecisionHint(num, "hint")).toBe(false);
    expect(num.context).toBe("42");
  });
});

// ========================================================================
// Candidate rendering (99-char template, #4107 measured)
// ========================================================================

describe("candidate rendering", () => {
  test("renderCandidateKey matches the #4107 template", () => {
    expect(renderCandidateKey({ id: 4447, type: "normal", title: "[E2E-4433-run3] 飞书私聊 E2E 回归" })).toBe(
      "#4447 [normal] [E2E-4433-run3] 飞书私聊 E2E 回归",
    );
  });

  test("renderCandidateKey truncates long titles to 40 chars", () => {
    const key = renderCandidateKey({ id: 1, type: "normal", title: "x".repeat(100) });
    expect(key.length).toBeLessThanOrEqual(60);
    expect(key).toContain("…");
  });

  test("renderCandidateValue matches the #4107 template", () => {
    expect(
      renderCandidateValue({
        id: 4447,
        status: "completed",
        ago: "2d",
        description: "飞书私聊 E2E 回归：建任务并一句话回复",
        tags: ["e2e"],
      }),
    ).toBe("c|2d|飞书私聊 E2E 回归：建任务并一句话回复 [tags: e2e]");
  });

  test("renderCandidateValue truncates description to 45 chars and limits tags to 4", () => {
    const value = renderCandidateValue({
      id: 1,
      status: "active",
      ago: "1d",
      description: "d".repeat(100),
      tags: ["t1", "t2", "t3", "t4", "t5"],
    });
    expect(value).toContain("…");
    expect(value).toContain("[tags: t1,t2,t3,t4]");
    expect(value).not.toContain("t5");
  });

  test("renderCandidateValue omits tags segment when there are no tags", () => {
    const value = renderCandidateValue({
      id: 1,
      status: "todo",
      ago: "0m",
      description: "desc",
      tags: [],
    });
    expect(value).toBe("t|0m|desc");
  });

  test("formatRelativeAge renders d/h/m and clamps future times to 0m", () => {
    const now = Date.parse("2026-10-22T16:00:00Z");
    expect(formatRelativeAge("2026-10-20T16:00:00Z", now)).toBe("2d");
    expect(formatRelativeAge("2026-10-22T14:00:00Z", now)).toBe("2h");
    expect(formatRelativeAge("2026-10-22T15:30:00Z", now)).toBe("30m");
    expect(formatRelativeAge("2026-10-23T16:00:00Z", now)).toBe("0m");
  });
});
