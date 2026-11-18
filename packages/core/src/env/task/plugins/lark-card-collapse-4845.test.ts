/**
 * @fileoverview Task #4845 — Task/Workflow 卡片默认折叠（collapsible_panel）
 *
 * 用户反馈（飞书群 oc_9ccbed865babdd9c1ed2f11dede26c5d，罗智）：
 *   「这些是不是可以默认折叠起来，比较干扰阅读」
 *   —— 指群里「📋 任务卡实时更新」卡片满屏任务元信息 + 里程碑时间线。
 *
 * 方案（飞书卡片 2.0 原生折叠组件，官方文档
 *   open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel）：
 *   - 任务详情（ID/标题/描述/目标/优先级/context 展开）→ collapsible_panel，默认折叠
 *   - 执行动态（🎯 里程碑序列 + 🔧 过程信息）→ collapsible_panel，运行中默认折叠
 *   - 真终态（completed/failed/cancelled/deleted）→ 执行动态面板展开
 *     （用户不用点开就能看到最终结果摘要），详情面板仍折叠
 *   - task 的 paused（可 resume）→ **保持折叠**；archived（终态）→ 展开
 *     （两者都映射成 CardStatus "stopped"，由调用方用 expandTimeline 显式区分）
 *   - workflow 的 stopped 是真终态 → 展开
 *   - 顶层始终可见：按钮 + 专属群链接 + 📊 进度行（关键信息一眼可见）
 *
 * 覆盖：
 *   1. buildTaskCard：详情/执行动态两个折叠面板的结构与 expanded 状态
 *   2. 顶层不再铺开元信息与时间线（默认视图精简）
 *   3. 真终态展开执行动态面板；paused 折叠、archived 展开
 *   4. 空时间线不渲染执行动态面板
 *   5. 进度行仍在顶层最后 + 按钮仍是第一个元素（不破坏既有契约）
 *   6. buildWorkflowCard 同样折叠
 *   7. 面板 schema 守卫（element_id 格式/唯一性/必填字段）
 */

import { describe, it, expect } from "bun:test";
import {
  buildTaskCard,
  buildWorkflowCard,
  type TaskMeta,
} from "./lark-card-patch-notifier";

// ============================================================================
// 测试辅助
// ============================================================================

/** 造一个完整 TaskMeta */
function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: 4845,
    title: "卡片默认折叠",
    description: "减少群聊干扰",
    goals: "卡片默认只留标题+状态+链接",
    parentTaskId: 4230,
    priority: "high",
    type: "normal",
    projectPath: "~/proj",
    context: JSON.stringify({ branch: "feat/4845-card-collapse" }),
    currentStatus: "进行中",
    ...overrides,
  };
}

/** 卡片顶层（非面板内部）所有 markdown 文本 */
function topMarkdown(card: any): string {
  return (card?.body?.elements ?? [])
    .filter((e: any) => e.tag === "markdown")
    .map((e: any) => e.content)
    .join("\n");
}

/** 卡片里所有折叠面板 */
function panels(card: any): any[] {
  return (card?.body?.elements ?? []).filter(
    (e: any) => e.tag === "collapsible_panel"
  );
}

/** 按标题关键词找折叠面板 */
function panelByTitle(card: any, keyword: string): any | undefined {
  return panels(card).find((p: any) =>
    String(p?.header?.title?.content ?? "").includes(keyword)
  );
}

/** 面板内部所有 markdown 文本 */
function panelMarkdown(p: any): string {
  return (p?.elements ?? [])
    .filter((e: any) => e.tag === "markdown")
    .map((e: any) => e.content)
    .join("\n");
}

/** 造测试时间线 */
function makeTimeline() {
  return {
    milestones: [
      { title: "Task 创建", timestamp: "2026-11-02T08:00:00.000Z" },
      { title: "调研完成", timestamp: "2026-11-02T09:00:00.000Z" },
    ],
    processSteps: [
      {
        title: "扫描文档",
        timestamp: "2026-11-02T08:30:00.000Z",
        description: "读了 5 个文件",
      },
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Task #4845 卡片默认折叠（collapsible_panel）", () => {
  describe("buildTaskCard", () => {
    it("任务详情收进默认折叠面板（expanded=false，含 ID/描述/目标/优先级/context）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
      });

      const detail = panelByTitle(card, "任务详情");
      expect(detail).toBeDefined();
      expect(detail.expanded).toBe(false);

      const md = panelMarkdown(detail);
      expect(md).toContain("🆔 任务 ID");
      expect(md).toContain("📌 标题");
      expect(md).toContain("📝 描述");
      expect(md).toContain("🎯 目标");
      expect(md).toContain("⚡ 优先级 / 类型");
      expect(md).toContain("🌿 分支");
    });

    it("执行动态面板运行中默认折叠（含里程碑+过程时间线）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
      });

      const timeline = panelByTitle(card, "执行动态");
      expect(timeline).toBeDefined();
      expect(timeline.expanded).toBe(false);

      const md = panelMarkdown(timeline);
      expect(md).toContain("🎯 里程碑序列");
      expect(md).toContain("Task 创建");
      // ★ Task #4889：过程信息区拆成「操作记录」/「执行轨迹（工具调用）」两区。
      //   本例的步骤无 source（= operation 记录）→ 落在「操作记录」区。
      expect(md).toContain("📝 操作记录");
      expect(md).toContain("扫描文档");
      // 面板标题带条目数（折叠时也能看出规模）
      expect(String(timeline.header.title.content)).toContain("2");
    });

    it("默认视图（顶层）不再铺开元信息与时间线", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
      });

      const top = topMarkdown(card);
      expect(top).not.toContain("🆔 任务 ID");
      expect(top).not.toContain("📝 描述");
      expect(top).not.toContain("🎯 里程碑序列");
      // ★ Task #4889：过程信息区拆成「操作记录」/「执行轨迹（工具调用）」两区。
      expect(top).not.toContain("📝 操作记录");
      expect(top).not.toContain("🔧 执行轨迹");
      expect(top).not.toContain("Task 创建");
      expect(top).not.toContain("扫描文档");
    });

    it("stopped（暂停）：执行动态面板**保持折叠**（paused 可 resume，非终态）", () => {
      // ★ xval MINOR-2：paused 是高频非终态（max-iteration reminder / 用户 stop
      //   都会走 pauseTask），展开反而正是用户抱怨的"刷屏"场景。
      //   与仓库自身终态集合（lark-cli-task-notify-plugin.isTerminalTaskStatus）
      //   保持一致：只有 completed/failed/cancelled/deleted 才展开。
      const card = buildTaskCard({
        status: "stopped",
        meta: makeMeta(),
        ...makeTimeline(),
      });
      expect(panelByTitle(card, "执行动态").expanded).toBe(false);
      expect(panelByTitle(card, "任务详情").expanded).toBe(false);
    });

    it("archived（归档）：执行动态面板**展开**（归档是终态，映射到 stopped 但语义不同于 paused）", () => {
      // ★ xval MINOR-2 补充：task.status=archived 也映射成 CardStatus "stopped"，
      //   但 archived 在 isTerminalTaskStatus 里是**终态**（不再有进展），
      //   应与 paused 区分开 → 归档时展开时间线。
      const card = buildTaskCard({
        status: "stopped",
        meta: makeMeta(),
        ...makeTimeline(),
        expandTimeline: true,
      });
      expect(panelByTitle(card, "执行动态").expanded).toBe(true);
    });

    it("notifier 层：pauseTask 传 expandTimeline=true → 卡片时间线展开", async () => {
      // ★ 端到端校验决策链路：插件侧（知道原始 task.status）→ notifier → 卡片
      const { LarkCardPatchNotifier } = await import("./lark-card-patch-notifier");
      const original = (LarkCardPatchNotifier.prototype as any).runLarkCli;
      const sent: any[] = [];
      (LarkCardPatchNotifier.prototype as any).runLarkCli = async (
        argv: string[],
        op: string
      ) => {
        sent.push({ argv, op });
        if (argv.includes("+messages-send")) {
          return JSON.stringify({ ok: true, data: { message_id: "om_x" } });
        }
        return JSON.stringify({ ok: true, data: {} });
      };
      try {
        const notifier = new LarkCardPatchNotifier();
        await notifier.startTask({ chatId: "oc_x", meta: makeMeta() });
        await notifier.pauseTask({
          messageId: "om_x",
          status: "stopped",
          expandTimeline: true,
        });
        const patch = sent.find((s) => s.op === "patch");
        const raw = patch.argv[patch.argv.indexOf("--data") + 1];
        const card = JSON.parse(JSON.parse(raw).content);
        expect(panelByTitle(card, "执行动态").expanded).toBe(true);
      } finally {
        (LarkCardPatchNotifier.prototype as any).runLarkCli = original;
      }
    });

    it("真终态（completed/failed/cancelled/deleted）：执行动态面板展开", () => {
      for (const status of [
        "completed",
        "failed",
        "cancelled",
        "deleted",
      ] as const) {
        const card = buildTaskCard({
          status,
          meta: makeMeta(),
          ...makeTimeline(),
        });
        expect(panelByTitle(card, "执行动态").expanded).toBe(true);
        expect(panelByTitle(card, "任务详情").expanded).toBe(false);
      }
    });

    it("无里程碑无过程 → 不渲染执行动态面板（不出现「暂无里程碑」占位）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
      });
      expect(panelByTitle(card, "执行动态")).toBeUndefined();
      expect(topMarkdown(card)).not.toContain("暂无里程碑");
    });

    it("关键信息仍顶层可见：按钮第一个 + 进度行最后", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
        progress: 60,
      });

      const elements = card.body.elements;
      expect(elements[0].tag).toBe("button");

      const top = topMarkdown(card);
      expect(top).toContain("**📊 进度**");
      expect(top).toContain("60%");
      // 进度是顶层最后一块 markdown
      const topEls = elements.filter((e: any) => e.tag === "markdown");
      expect(topEls[topEls.length - 1].content).toContain("**📊 进度**");
    });

    it("有专属群时「进入专属群」链接仍顶层可见", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ perTaskChatId: "oc_test_group" }),
        ...makeTimeline(),
      });
      expect(topMarkdown(card)).toContain("进入专属群");
    });

    it("空时间线 → 顶层不出现两条相邻 hr（视觉双分割线）", () => {
      // ★ xval MINOR-1：详情面板后的 hr + 进度前的 hr 会紧挨着 →
      //   飞书渲染成两条分割线。修复：进度前的 hr 只在上一元素不是 hr 时才加。
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
      });
      const tags = card.body.elements.map((e: any) => e.tag);
      for (let i = 1; i < tags.length; i++) {
        expect(tags[i] === "hr" && tags[i - 1] === "hr").toBe(false);
      }
    });

    it("有执行动态面板时顶层也不出现两条相邻 hr", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
      });
      const tags = card.body.elements.map((e: any) => e.tag);
      for (let i = 1; i < tags.length; i++) {
        expect(tags[i] === "hr" && tags[i - 1] === "hr").toBe(false);
      }
    });
  });

  describe("面板 schema 守卫（xval MINOR-6）", () => {
    it("collapsible_panel 结构符合飞书卡片 2.0 约束", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
      });

      const ps = panels(card);
      expect(ps.length).toBe(2);

      const seenIds = new Set<string>();
      for (const p of ps) {
        expect(p.tag).toBe("collapsible_panel");
        expect(typeof p.expanded).toBe("boolean");
        expect(p.header?.title?.tag).toBe("markdown");
        expect(typeof p.header?.title?.content).toBe("string");
        expect(Array.isArray(p.elements)).toBe(true);

        // element_id：字母开头、[A-Za-z0-9_]、≤20 字符、同卡内唯一
        const id = p.element_id;
        expect(typeof id).toBe("string");
        expect(id!).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
        expect(id!.length).toBeLessThanOrEqual(20);
        expect(seenIds.has(id!)).toBe(false);
        seenIds.add(id!);
      }
    });

    it("task 卡片与 workflow 卡片的 element_id 不冲突", () => {
      const taskCard = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        ...makeTimeline(),
      });
      const wfCard = buildWorkflowCard({
        status: "running",
        meta: { workflowName: "flow", runId: "wf_1" },
        ...makeTimeline(),
      });
      const taskIds = panels(taskCard).map((p: any) => p.element_id);
      const wfIds = panels(wfCard).map((p: any) => p.element_id);
      for (const id of taskIds) expect(wfIds).not.toContain(id);
    });

    it("workflow 卡片的两个面板也满足 schema 约束", () => {
      // ★ xval MINOR-5：schema 守卫不能只覆盖 task 卡（workflow 侧同样要合规）
      const card = buildWorkflowCard({
        status: "running",
        meta: { workflowName: "flow", runId: "wf_1" },
        ...makeTimeline(),
      });
      const ps = panels(card);
      expect(ps.length).toBe(2);
      const seenIds = new Set<string>();
      for (const p of ps) {
        expect(p.tag).toBe("collapsible_panel");
        expect(typeof p.expanded).toBe("boolean");
        expect(p.header?.title?.tag).toBe("markdown");
        expect(Array.isArray(p.elements)).toBe(true);
        const id = p.element_id;
        expect(typeof id).toBe("string");
        expect(id!).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
        expect(id!.length).toBeLessThanOrEqual(20);
        expect(seenIds.has(id!)).toBe(false);
        seenIds.add(id!);
      }
    });

    it("该有的分割线没有丢（appendHr 去重不是无脑删 hr）", () => {
      // ★ xval MINOR-6：正向断言 —— 完整卡片（按钮 + 群链接 + 详情面板
      //   + 执行动态面板 + 进度）必须有 3 条分割线，不能因为去重而少。
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ perTaskChatId: "oc_g" }),
        ...makeTimeline(),
        progress: 50,
      });
      const hrs = card.body.elements.filter((e: any) => e.tag === "hr");
      expect(hrs.length).toBe(3);
    });
  });

  describe("buildWorkflowCard", () => {
    it("workflow 卡片同样折叠：详情+执行动态面板默认收起，进度顶层", () => {
      const card = buildWorkflowCard({
        status: "running",
        meta: { workflowName: "test-flow", runId: "wf_001" },
        ...makeTimeline(),
        completedNodes: 1,
        totalNodes: 3,
      });

      const detail = panelByTitle(card, "运行详情");
      const timeline = panelByTitle(card, "执行动态");
      expect(detail).toBeDefined();
      expect(detail.expanded).toBe(false);
      expect(timeline).toBeDefined();
      expect(timeline.expanded).toBe(false);
      expect(panelMarkdown(timeline)).toContain("Task 创建");

      const top = topMarkdown(card);
      expect(top).not.toContain("Task 创建");
      expect(top).toContain("**📊 进度**");
    });

    it("workflow 终态：执行动态面板展开", () => {
      const card = buildWorkflowCard({
        status: "completed",
        meta: { workflowName: "test-flow", runId: "wf_001" },
        ...makeTimeline(),
      });
      expect(panelByTitle(card, "执行动态").expanded).toBe(true);
      expect(panelByTitle(card, "运行详情").expanded).toBe(false);
    });

    it("workflow 卡片详情面板标题是「运行详情」而非「任务详情」", () => {
      // ★ xval MINOR-4：workflow 卡里装的是工作流/RunID/节点进度，
      //   叫「任务详情」会让用户以为看错了卡。
      const card = buildWorkflowCard({
        status: "running",
        meta: { workflowName: "test-flow", runId: "wf_001" },
        ...makeTimeline(),
      });
      expect(panelByTitle(card, "运行详情")).toBeDefined();
      expect(panelByTitle(card, "任务详情")).toBeUndefined();
    });
  });
});
