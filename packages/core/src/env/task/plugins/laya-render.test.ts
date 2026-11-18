/**
 * @fileoverview Task #4620 — laya 渲染器 + systemone 渲染器单测
 *
 * 覆盖：
 *   - laya state 形态：【新任务标题】/【新任务描述】/【候选任务】三段
 *   - laya criteria key = `#<id> <title[:50]>`（**无** `[type]` 段）
 *   - laya value = `{大写status字母}|{ago}|{desc[:45]} [tags: ...]`
 *   - NEW_TASK 描述逐字匹配训练集
 *   - 候选同时出现在 state 与 criteria
 *   - matchChoiceToCandidate：完整 key / 裸 #id / 截断 key / 不匹配
 *   - systemone 渲染器保持 #4481 的原有形态（回归保护）
 */

import { describe, test, expect } from "bun:test";
import {
  renderLayaState,
  renderLayaCriteria,
  layaCandidateKey,
  layaCandidateValue,
  matchChoiceToCandidate,
  LAYA_NEW_TASK_DESC,
  LAYA_CANDIDATE_TITLE_MAX,
  LAYA_CANDIDATE_DESC_MAX,
  LAYA_CANDIDATE_TAGS_MAX,
  LAYA_STATE_DESC_MAX,
} from "./laya-render";
import {
  systemoneRenderer,
  layaRenderer,
  LAYA_STAGE_A_INSTRUCTIONS,
} from "./decision-renderers";
import type { Task } from "../types";

const cand = (over: Partial<{ id: number; title: string; status: string; ago: string; description: string; tags: string[] }> = {}) => ({
  id: over.id ?? 4502,
  title: over.title ?? "同步最新 chongqing-wuye domain 到飞书云盘",
  status: over.status ?? "completed",
  ago: over.ago ?? "5d",
  description: over.description ?? "## 用户指令（飞书群 oc_8904d6f184e31b6cc51ba53a0a19aa",
  tags: over.tags ?? ["sync", "feishu-drive", "chongqing-wuye", "filing-split", "extra5"],
});

describe("laya 渲染器", () => {
  test("state 有【新任务标题】/【新任务描述】/【候选任务】三段", () => {
    const s = renderLayaState({
      title: "编写 SDK 接口测试（TDD）",
      description: "编写 SDK 接口的测试用例",
      candidates: [cand()],
    });
    expect(s.startsWith("【新任务标题】编写 SDK 接口测试（TDD）")).toBe(true);
    expect(s).toContain("【新任务描述】编写 SDK 接口的测试用例");
    expect(s).toContain("【候选任务】");
  });

  test("候选同时出现在 state 与 criteria（训练时的形态，不是冗余）", () => {
    const c = cand();
    const s = renderLayaState({ title: "t", description: "d", candidates: [c] });
    const crit = renderLayaCriteria([c]);
    const key = layaCandidateKey(c);
    expect(s).toContain(key);
    expect(crit[key]).toBeDefined();
    expect(s).toContain(crit[key]);
  });

  test("key = `#<id> <title[:50]>`，没有 [type] 段", () => {
    const key = layaCandidateKey({ id: 4502, title: "A".repeat(80) });
    expect(key.startsWith("#4502 ")).toBe(true);
    expect(key).not.toContain("[");
    expect(key.length).toBe("#4502 ".length + LAYA_CANDIDATE_TITLE_MAX);
  });

  test("value = 大写status|ago|desc[:45] [tags: 前4个]", () => {
    const v = layaCandidateValue({
      status: "completed",
      ago: "5d",
      description: "B".repeat(100),
      tags: ["t1", "t2", "t3", "t4", "t5"],
    });
    expect(v.startsWith("C|5d|")).toBe(true);
    expect(v).toContain("[tags: t1,t2,t3,t4]");
    expect(v).not.toContain("t5");
  });

  test("desc 截断到 45 字符且换行被替换为空格", () => {
    const v = layaCandidateValue({ status: "todo", ago: "1d", description: "x\ny" + "z".repeat(80) });
    expect(v).not.toContain("\n");
    expect(v.split("|")[2].replace(/\s?\[tags.*$/, "").length).toBeLessThanOrEqual(LAYA_CANDIDATE_DESC_MAX);
  });

  test("status 字母大写（laya 训练格式）", () => {
    expect(layaCandidateValue({ status: "active", ago: "1h", description: "d" }).startsWith("A|")).toBe(true);
    expect(layaCandidateValue({ status: "archived", ago: "1d", description: "d" }).startsWith("R|")).toBe(true);
    expect(layaCandidateValue({ status: "unknown-status", ago: "1d", description: "d" }).startsWith("U|")).toBe(true);
  });

  test("无 tags 时不产生 [tags: ] 段", () => {
    const v = layaCandidateValue({ status: "todo", ago: "1d", description: "d", tags: [] });
    expect(v).not.toContain("[tags:");
  });

  test("NEW_TASK 描述逐字等于训练集里的那句", () => {
    const crit = renderLayaCriteria([cand()]);
    expect(crit["NEW_TASK"]).toBe(LAYA_NEW_TASK_DESC);
    expect(LAYA_NEW_TASK_DESC).toBe("新建为独立任务（与所有现有候选均无明确关联）");
  });

  test("state 描述截断到 600，空描述用 (无)", () => {
    const s1 = renderLayaState({ title: "t", description: "y".repeat(900), candidates: [] });
    expect(s1).toContain("y".repeat(LAYA_STATE_DESC_MAX));
    expect(s1).not.toContain("y".repeat(LAYA_STATE_DESC_MAX + 1));
    const s2 = renderLayaState({ title: "t", description: "", candidates: [] });
    expect(s2).toContain("【新任务描述】(无)");
  });
});

describe("matchChoiceToCandidate", () => {
  test("完整 key 精确匹配", () => {
    const c = cand();
    expect(matchChoiceToCandidate(layaCandidateKey(c), [c])).toBe(4502);
  });

  test("裸 #id 匹配", () => {
    expect(matchChoiceToCandidate("#4502", [cand()])).toBe(4502);
  });

  test("截断的 key（`#id 标题...`）按 #id 前缀匹配", () => {
    expect(matchChoiceToCandidate("#4502 同步最新 chongqing-wuye", [cand()])).toBe(4502);
  });

  test("不在候选集里 → undefined", () => {
    expect(matchChoiceToCandidate("#99999 其他", [cand()])).toBeUndefined();
    expect(matchChoiceToCandidate("NEW_TASK", [cand()])).toBeUndefined();
    expect(matchChoiceToCandidate("", [cand()])).toBeUndefined();
  });

  test("多个候选时按 id 精确区分", () => {
    const a = cand({ id: 1, title: "A" });
    const b = cand({ id: 2, title: "B" });
    expect(matchChoiceToCandidate(layaCandidateKey(a), [a, b])).toBe(1);
    expect(matchChoiceToCandidate(layaCandidateKey(b), [a, b])).toBe(2);
  });
});

describe("renderer 选择（载体格式隔离）", () => {
  const task = (over: Partial<Task> = {}): Task =>
    ({
      id: 4502,
      title: "同步最新 domain 到飞书云盘",
      description: "## 用户指令（飞书群 oc_8904d6f184e31b6cc51ba53a0a19aa",
      status: "completed",
      type: "normal",
      tags: ["sync", "feishu-drive"],
      updatedAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
      ...over,
    }) as Task;

  test("layaRenderer 发的是中文文本 state，不是 JSON", () => {
    const req = layaRenderer.buildStageA({
      title: "T", description: "D", goals: "", tags: [], projectPath: "", candidates: [task()], now: Date.now(),
    });
    expect(typeof req.state).toBe("string");
    expect(String(req.state)).toContain("【新任务标题】T");
  });

  test("systemoneRenderer 发的是 JSON state（#4481 原有形态，回归保护）", () => {
    const req = systemoneRenderer.buildStageA({
      title: "T", description: "D", goals: "", tags: [], projectPath: "", candidates: [task()], now: Date.now(),
    });
    expect(typeof req.state).toBe("object");
    expect((req.state as any).task_to_route).toBeDefined();
    const crit = (req.questions as any).reuse_or_create.criteria;
    expect(Object.keys(crit).some((k) => k.includes("[normal]"))).toBe(true);
  });

  test("两个 renderer 的 criteria key 形态不同（这就是格式敏感的来源）", () => {
    const input = {
      title: "T", description: "D", goals: "", tags: [], projectPath: "", candidates: [task()], now: Date.now(),
    };
    const layaKey = Object.keys((layaRenderer.buildStageA(input).questions as any).reuse_or_create.criteria)[0];
    const sysKey = Object.keys((systemoneRenderer.buildStageA(input).questions as any).reuse_or_create.criteria)[0];
    expect(layaKey).not.toBe(sysKey);
    expect(layaKey.startsWith("#4502 ")).toBe(true);
    expect(sysKey.startsWith("#4502 [")).toBe(true);
  });

  test("layaRenderer.matchChoice 认 laya key", () => {
    const t = task();
    expect(layaRenderer.matchChoice("#4502 同步最新 domain 到飞书云盘", [t])).toBe(4502);
    expect(layaRenderer.matchChoice("#4502", [t])).toBe(4502);
  });

  test("systemoneRenderer.matchChoice 认 systemone key（回归保护）", () => {
    const t = task();
    expect(systemoneRenderer.matchChoice("#4502 [normal] 同步最新 domain 到飞书云盘", [t])).toBe(4502);
    expect(systemoneRenderer.matchChoice("#4502", [t])).toBe(4502);
  });
});

// ========================================================================
// Task #4669 — req 任务的 tags 进入 state 与 question
// ========================================================================

describe("req tags 渲染（Task #4669）", () => {
  test("state 含【请求标签】行（有 tags 时）", () => {
    const s = renderLayaState({
      title: "写周报",
      description: "汇总本周进展",
      tags: ["weekly", "report"],
      candidates: [cand()],
    });
    expect(s).toContain("【请求标签】weekly,report");
    // 顺序：标签行在描述之后、候选之前
    const descIdx = s.indexOf("【新任务描述】");
    const tagIdx = s.indexOf("【请求标签】");
    const candIdx = s.indexOf("【候选任务】");
    expect(tagIdx).toBeGreaterThan(descIdx);
    expect(tagIdx).toBeLessThan(candIdx);
  });

  test("无 tags 时【请求标签】行省略（向后兼容）", () => {
    const s = renderLayaState({
      title: "写周报",
      description: "汇总本周进展",
      candidates: [cand()],
    });
    expect(s).not.toContain("【请求标签】");
  });

  test("空 tags 数组同样省略（向后兼容）", () => {
    const s = renderLayaState({
      title: "t", description: "d", tags: [], candidates: [cand()],
    });
    expect(s).not.toContain("【请求标签】");
  });

  test("layaRenderer.buildStageA：state 与 instructions 都带 req tags", () => {
    const task = (over: Partial<Task> = {}): Task =>
      ({
        id: 4502, title: "同步 domain", description: "d", status: "completed",
        type: "normal", tags: ["sync"], updatedAt: new Date().toISOString(), ...over,
      }) as Task;
    const req = layaRenderer.buildStageA({
      title: "同步最新 chongqing-wuye domain",
      description: "把 domain 同步到云盘",
      goals: "",
      tags: ["filing-split", "chongqing-wuye"],
      projectPath: "/tmp/x",
      candidates: [task()],
      now: Date.now(),
    });
    const state = String(req.state);
    expect(state).toContain("【请求标签】filing-split,chongqing-wuye");
    const q = (req.questions as any).reuse_or_create;
    expect(q.instructions).toContain("请求标签：filing-split,chongqing-wuye");
  });

  test("layaRenderer.buildStageA：无 tags 时 instructions 与旧格式逐字一致（向后兼容）", () => {
    const task = (over: Partial<Task> = {}): Task =>
      ({
        id: 4502, title: "同步 domain", description: "d", status: "completed",
        type: "normal", tags: [], updatedAt: new Date().toISOString(), ...over,
      }) as Task;
    const req = layaRenderer.buildStageA({
      title: "T", description: "D", goals: "", tags: [], projectPath: "",
      candidates: [task()], now: Date.now(),
    });
    const q = (req.questions as any).reuse_or_create;
    expect(q.instructions).toBe(LAYA_STAGE_A_INSTRUCTIONS);
    expect(String(req.state)).not.toContain("【请求标签】");
  });
});
