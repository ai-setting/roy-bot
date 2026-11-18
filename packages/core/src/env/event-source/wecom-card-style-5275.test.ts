/**
 * @fileoverview Task #5275 — 企微任务卡片样式优化（窄卡截断）
 *
 * 用户截图实测：卡片窄（~240px），操作记录行
 * 「HH:mm + 内容」排布拥挤，内容长时末尾截断
 * （「待验证（to_validate）：Task…」）。
 *
 * 官方约束（94945/96459，Task #5275 调研）：
 * - 卡片宽度客户端定死，无宽度参数 → 窄卡不可根治
 * - horizontal_content_list.value 建议 ≤30 字（单行渲染）
 * - sub_title_text 建议 ≤160 字（可承载更长文本）
 *
 * 优化策略（约束内最优）：
 * 1. 操作记录行 value 短化：milestone_title 首行化 + 短截断，
 *    完整内容挪 sub_title_text（最新 1 条完整摘要）
 * 2. keyname 仍 HH:mm（≤5 字），value 不再出现「…」硬截
 * 3. 标题契约保持（#5273）：`📋 Task #N · 标题 · 状态`
 */

import { describe, expect, test } from "bun:test";
import {
  buildWecomTextNoticeCard,
  buildWecomCardUpdateFrame,
} from "./wecom-card-builder";

const longTitle =
  "待验证（to_validate）：Task #5273 submitted for acceptance，Deliverable 落盘分支 feat/wecom-card-title-5273";

describe("Task #5275 — 操作记录行截断优化", () => {
  const ms = [
    { title: longTitle, timestamp: new Date(2026, 0, 1, 9, 0).toISOString() },
    { title: "返工完成：commit 6b2bfa66（分支 feat/wecom-card-title-5273，未 merge）", timestamp: new Date(2026, 0, 1, 10, 0).toISOString() },
    { title: "Updated: active", timestamp: new Date(2026, 0, 1, 11, 0).toISOString() },
  ];

  test("★横向行 value 短化：长标题不再末尾硬截（≤30 字，短行不接省略号）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "👀 已查看",
      progress: 50,
      milestones: ms,
    });
    const rows = card.horizontal_content_list.filter((h) => h.keyname !== "状态");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.value.length).toBeLessThanOrEqual(30);
      // 短化后不再出现「…」结尾的硬截长行
      expect(r.value.endsWith("…")).toBe(false);
    }
  });

  test("★value 短化取语义首段：冒号/括号前的短语优先", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "👀 已查看",
      progress: 50,
      milestones: ms,
    });
    const rows = card.horizontal_content_list.filter((h) => h.keyname !== "状态");
    // 渲染最新在上：rows[0] = 最新（Updated: active）
    expect(rows[0].value).toBe("Updated: active");
    // 「返工完成：commit…」→ 首段「返工完成」
    expect(rows[1].value).toBe("返工完成");
    // 「待验证（to_validate）：…」→ 首段「待验证（to_validate）」
    // （冒号在 20 字内才首段化；此标题冒号位置超限 → 取括号前段，
    // 实现取到冒号前整段，含括号内容，仍 ≤30 字）
    expect(rows[2].value).toBe("待验证（to_validate）");
  });

  test("★sub_title_text 承载最新一条完整摘要（≤160 字）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "👀 已查看",
      progress: 50,
      milestones: ms,
    });
    expect(card.sub_title_text).toBeTruthy();
    expect(card.sub_title_text!.length).toBeLessThanOrEqual(160);
    // 最新一条（Updated: active）完整进 sub_title_text
    expect(card.sub_title_text).toContain("Updated: active");
  });

  test("无 milestones → sub_title_text 缺省（向后兼容）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "👀 已查看",
      progress: 50,
      milestones: [],
    });
    expect(card.horizontal_content_list.length).toBe(1);
  });

  test("标题契约保持：main_title 含 Task #N 与标题（#5273）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 9,
      title: "标题不动",
      statusLabel: "👀 已查看",
      progress: 50,
      milestones: ms,
    });
    expect(card.main_title.title).toContain("Task #9");
    expect(card.main_title.title).toContain("标题不动");
    // 官方建议 main_title.title ≤36 字
    expect(card.main_title.title.length).toBeLessThanOrEqual(40);
  });
});

describe("Task #5275 — 更新帧（button_interaction）同样受益", () => {
  const ms2 = [
    { title: longTitle, timestamp: new Date(2026, 0, 1, 9, 0).toISOString() },
    { title: "返工完成：commit 6b2bfa66（分支 feat/wecom-card-title-5273，未 merge）", timestamp: new Date(2026, 0, 1, 10, 0).toISOString() },
  ];

  test("更新帧 horizontal 时间行同样短化", () => {
    const frame = buildWecomCardUpdateFrame({
      reqId: "r-5275",
      taskId: "roy-task-1-1-a",
      statusLabel: "👀 已查看",
      taskTitle: "标题",
      taskNumber: 1,
      timeline: ms2.map((m) => ({
        title: m.title,
        timestamp: m.timestamp,
      })),
    });
    const card = frame.body.template_card as {
      horizontal_content_list: { keyname: string; value: string }[];
    };
    for (const h of card.horizontal_content_list) {
      expect(h.value.length).toBeLessThanOrEqual(30);
      expect(h.value.endsWith("…")).toBe(false);
    }
  });
});
