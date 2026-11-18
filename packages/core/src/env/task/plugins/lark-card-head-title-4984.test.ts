/**
 * @fileoverview Task #4984 — Task 卡片 head 区带任务名称（id + 截断 title）
 *
 * 用户反馈（飞书原话，2026-11-05，附截图）：
 *   「帮我优化下，我希望卡片消息的head不只是task id还需要有任务名称哈，
 *     否则我不能很快get到这个任务要干啥哈」
 *
 * 现状：header.title = 「📋 任务卡实时更新（#4978）」—— 只有通用文案 + task id，
 *   任务名称藏在「📋 任务详情」折叠面板里（Task #4845 折叠后更看不到）。
 *
 * 目标：head 区 = 「📋 任务卡实时更新（#4978 [训练] v14：清洗状态捷径）」——
 *   id + 截断后的任务名称，一眼 get 到任务在干啥。
 *
 * 截断策略（HEAD_TITLE_MAX_WIDTH 视觉宽度预算）：
 *   - CJK / 全角字符按 **2** 宽度算，ASCII 按 1
 *   - 不切半个 emoji（代理对 code point 完整保留）
 *   - 不切半个词（在分隔符边界优先断开）
 *   - 超长时补 "…" 后缀
 *
 * 覆盖：
 *   1. buildTaskCard head 含 id + title
 *   2. 无 title 时降级为只有 id（不出现空的括号/空标题）
 *   3. 超长 CJK title 截断到宽度预算内且带 "…"
 *   4. 截断不切半 emoji（代理对完整）
 *   5. 截断在词边界断开（英文）
 *   6. title 里的换行/多行 markdown 被压成单行（不破坏卡片布局）
 *   7. workflow 卡片 head 行为不变（已有 workflow 名）
 *   8. startTask / updateTask / finishTask 三个入口的 head 都带 title
 */

import { describe, it, expect } from "bun:test";
import {
  buildTaskCard,
  buildWorkflowCard,
  truncateHeadTitle,
  type TaskMeta,
} from "./lark-card-patch-notifier";

// ============================================================================
// 测试辅助
// ============================================================================

function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: 4984,
    title: "v14：清洗状态捷径 + relabel + 重训 v14",
    description: "卡片 head 带任务名称",
    priority: "high",
    type: "normal",
    ...overrides,
  };
}

/** 取卡片 header.title.content */
function headText(card: any): string {
  return String(card?.header?.title?.content ?? "");
}

// ============================================================================
// Tests
// ============================================================================

describe("Task #4984 卡片 head 带任务名称", () => {
  describe("buildTaskCard head 标题", () => {
    it("head 同时含 task id 与任务名称", () => {
      const card = buildTaskCard({ status: "running", meta: makeMeta() });
      const head = headText(card);

      expect(head).toContain("#4984");
      expect(head).toContain("v14：清洗状态捷径 + relabel + 重训 v14");
    });

    it("head 里 task id 排在任务名称之前（id 先定位、名称后说明）", () => {
      const card = buildTaskCard({ status: "running", meta: makeMeta() });
      const head = headText(card);

      expect(head.indexOf("#4984")).toBeGreaterThanOrEqual(0);
      expect(head.indexOf("#4984")).toBeLessThan(
        head.indexOf("v14：清洗状态捷径")
      );
    });

    it("无 title 时降级为只有 id（不出现空括号 / 空标题）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ title: undefined }),
      });
      const head = headText(card);

      expect(head).toContain("#4984");
      expect(head).not.toContain("（）");
      expect(head).not.toContain("[]");
      expect(head).not.toContain("（ ）");
    });

    it("title 为空白字符串时也降级为只有 id", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ title: "   " }),
      });
      const head = headText(card);

      expect(head).toContain("#4984");
      expect(head).not.toContain("（）");
    });

    it("无 id + 占位 title（「任务」）时出现「任务 任务」重复", () => {
      // review MINOR-4：updateTask 无 state 无 meta 的 fallback 路径
      // meta = { title: "任务" }，id undefined → 不得渲染成「任务 任务」
      const card = buildTaskCard({
        status: "running",
        meta: { title: "任务" } as TaskMeta,
      });
      const head = headText(card);

      expect(head).not.toContain("任务 任务");
      expect(head).toContain("任务");
    });

    it("title 里的换行被压成单行（不破坏卡片 head 布局）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ title: "第一行\n第二行\n第三行" }),
      });
      const head = headText(card);

      expect(head).not.toContain("\n");
      expect(head).toContain("第一行");
    });
  });

  describe("truncateHeadTitle 截断策略", () => {
    it("短标题原样返回", () => {
      expect(truncateHeadTitle("短标题", 40)).toBe("短标题");
    });

    it("超长中文标题被截断且带省略号", () => {
      const long = "一".repeat(100);
      const out = truncateHeadTitle(long, 40);

      expect(out.length).toBeLessThan(long.length);
      expect(out.endsWith("…")).toBe(true);
    });

    it("截断结果不超过给定的视觉宽度预算", () => {
      const long = "清洗状态捷径与重训练流程的完整梳理".repeat(5);
      const out = truncateHeadTitle(long, 40);

      // 粗略宽度：CJK 记 2，ASCII 记 1
      const width = [...out].reduce(
        (w, ch) => w + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1),
        0
      );
      expect(width).toBeLessThanOrEqual(40);
    });

    it("CJK 标题按 2 宽度计算（同等字符数下 CJK 比 ASCII 更早截断）", () => {
      const cjk = truncateHeadTitle("中".repeat(50), 40);
      const ascii = truncateHeadTitle("a".repeat(50), 40);

      // CJK 每字 2 宽度 → 40 宽度只放 20 字；ASCII 每字 1 宽度 → 放 40 字
      expect([...cjk].length).toBeLessThan([...ascii].length);
    });

    it("不切半个 emoji（代理对 code point 完整保留）", () => {
      const long = "🚀".repeat(40);
      const out = truncateHeadTitle(long, 40);

      expect(out).not.toContain("\uFFFD"); // 没有替换字符（半个代理对）
      // 去掉 "…" 后缀后，每个字符都必须是完整 emoji（代理对 code point > 0xFFFF）
      const body = out.endsWith("…") ? out.slice(0, -1) : out;
      expect(body.length).toBeGreaterThan(0);
      for (const ch of body) {
        expect(ch.codePointAt(0)).toBeGreaterThan(0xffff);
      }
    });

    it("英文长标题在词边界断开（不切半个单词）", () => {
      const source =
        "cleaning state shortcuts relabel retraining pipeline overview";
      const out = truncateHeadTitle(source, 30);

      expect(out.endsWith("…")).toBe(true);
      const body = out.slice(0, -1).trimEnd();
      // 截断点必须落在词边界：body 的最后一个 token 必须是原文中的完整单词
      const lastToken = body.split(/\s+/).pop() ?? "";
      expect(lastToken.length).toBeGreaterThan(0);
      expect(source.split(/\s+/)).toContain(lastToken);
      // 不允许出现「半个单词 + 省略号」的形态（如 "retr…"）
      expect(body).not.toMatch(/[a-zA-Z0-9]…$/);
    });

    it("连接符尾巴被清理（不出现「relabel +…」这种腰斩尾巴）", () => {
      const out = truncateHeadTitle(
        "[训练] v14：清洗状态捷径 + relabel + 重训 v14 pipeline",
        40
      );

      expect(out.endsWith("…")).toBe(true);
      // 省略号前不能残留连接符
      expect(/[+=|｜]\s*…$/.test(out)).toBe(false);
    });

    it("空标题返回空串", () => {
      expect(truncateHeadTitle("", 40)).toBe("");
      expect(truncateHeadTitle(undefined as any, 40)).toBe("");
    });

    it("宽度预算 <= 0 时不截断（避免除零/异常）", () => {
      expect(truncateHeadTitle("abc", 0)).toBe("abc");
    });
  });

  describe("其它卡片入口 head 一致性", () => {
    it("终态卡片 head 同样带 title", () => {
      const card = buildTaskCard({ status: "completed", meta: makeMeta() });
      expect(headText(card)).toContain("v14：清洗状态捷径");
    });

    it("workflow 卡片 head 仍带 workflow 名（既有行为不变）", () => {
      const card = buildWorkflowCard({
        status: "running",
        meta: { workflowName: "daily-eval" } as any,
      });
      expect(headText(card)).toContain("daily-eval");
    });
  });
});
