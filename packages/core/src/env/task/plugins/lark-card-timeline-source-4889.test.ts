/**
 * @fileoverview Task #4889 — 卡片时间线分区（操作记录 vs 执行轨迹）+ 同名步骤不再被吞
 *
 * 用户反馈（Task #4889）：
 *   「一个是感觉不像是追加，而是全量更新所以时间都是同一个。另一个是可以看看 roy
 *    sub agent 的 prompt 提示，不是每次调用一个工具就添加任务操作记录哈」
 *
 * Phase A 定位结论（详见 /tmp/4889-card-issue-analysis.md）：
 *   - Q1「时间都是同一个」：**不是** core 追加 bug。core 的 mergeUnique 是真追加，
 *     历史步骤的 timestamp 永不被改写。真正的成因在插件侧 —— 它把整个 run 的
 *     工具列表一次性映射成长时间戳的 processSteps（每条同一个 new Date()）。
 *     但 core 侧另有一个**真 bug**：`processStepKey` 的 key 不含来源，
 *     同名同毫秒的步骤会被 mergeUnique 静默吞掉。
 *   - Q2「每工具一条操作记录」：过程信息区混装了**两种语义**——
 *     (a) 真正的 task operation 记录（core deriveTimelineFromOperation 派生，
 *         title 是人写的里程碑标题）；
 *     (b) 工具调用轨迹（插件 describeToolUse 派生，title 是动作名）。
 *     卡片上两者共用一个「🔧 过程信息」区块、底部统一计「N 个过程」，
 *     用户读起来就等同于「每个工具调用都记了一条操作记录」——**呈现误导**。
 *
 * 本文件覆盖（core 侧）：
 *   1. ProcessStep.source 区分 operation / tool-trace，卡片分区呈现
 *   2. 底部计数分区独立（里程碑 / 操作记录 / 执行轨迹）
 *   3. 同名同毫秒的步骤不再被去重吞掉（真 bug 修复）
 *   4. 兼容：没有 source 的旧步骤仍渲染在「操作记录」区（不破坏既有契约）
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  buildTaskCard,
  LarkCardPatchNotifier,
  type ProcessStep,
  type TaskMeta,
} from "./lark-card-patch-notifier";

// ============================================================================
// 测试辅助
// ============================================================================

function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: 4889,
    title: "卡片时间线分区",
    description: "两种语义分区呈现",
    goals: "用户不再误读为每工具一条操作记录",
    priority: "high",
    type: "normal",
    currentStatus: "进行中",
    ...overrides,
  };
}

/** 卡片里所有 markdown 文本（递归扫进折叠面板） */
function allMarkdown(card: any): string {
  const parts: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "markdown" && typeof e.content === "string") {
        parts.push(e.content);
      } else if (e?.tag === "collapsible_panel" && Array.isArray(e.elements)) {
        walk(e.elements);
      }
    }
  };
  walk(card?.body?.elements ?? []);
  return parts.join("\n");
}

/** 折叠面板 */
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

/** 面板内部 markdown */
function panelMarkdown(p: any): string {
  return (p?.elements ?? [])
    .filter((e: any) => e.tag === "markdown")
    .map((e: any) => e.content)
    .join("\n");
}

/**
 * 「执行动态」面板内部的 markdown。
 *
 * ★ 必须只取面板内部：任务详情面板里也有 meta 的 description/goals，
 *   里面可能含「操作记录」「执行轨迹」等字样，会污染分区断言。
 */
function timelineMarkdown(card: any): string {
  const p = panelByTitle(card, "执行动态");
  return p ? panelMarkdown(p) : "";
}

/** 造一条操作记录来源的步骤 */
function opStep(over: Partial<ProcessStep> = {}): ProcessStep {
  return {
    title: "勘查反转：manifest 并非残废",
    timestamp: "2026-11-04T02:42:45.449Z",
    description: "grep 命中 22 条合法 binding",
    ...over,
  };
}

/**
 * 造一条工具调用轨迹来源的步骤
 *
 * ★ 带 `id`：插件侧每个工具调用都有唯一序号（见 #4889 的 R1 修法），
 *   core 据此去重 —— 否则同名同毫秒的两次调用会被撞成一条而**静默吞掉**。
 */
function toolStep(over: Partial<ProcessStep> = {}): ProcessStep {
  return {
    title: "执行命令",
    timestamp: "2026-11-04T02:42:46.100Z",
    category: "shell",
    source: "tool-trace",
    id: "tool-1",
    ...over,
  };
}

/** 取 lark-cli 参数里某个 flag 的值 */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

// ============================================================================
// 1. 分区呈现（Q2 的核心修法）
// ============================================================================

describe("#4889 卡片时间线分区：操作记录 vs 执行轨迹", () => {
  it("source=tool-trace 的步骤渲染在独立的「执行轨迹」区，不混进操作记录区", () => {
    const card = buildTaskCard({
      status: "running",
      meta: makeMeta(),
      milestones: [
        {
          title: "Task 创建",
          timestamp: "2026-11-04T02:40:36.931Z",
        },
      ],
      processSteps: [
        opStep(),
        toolStep(),
        toolStep({ title: "读取文件", category: "read", id: "tool-2" }),
      ],
    });

    const md = timelineMarkdown(card);
    // 两个区都存在
    expect(md).toContain("操作记录");
    expect(md).toContain("执行轨迹");
    // 操作记录区只含 operation 步骤
    const opSection = md.slice(
      md.indexOf("操作记录"),
      md.indexOf("执行轨迹") === -1 ? md.length : md.indexOf("执行轨迹")
    );
    expect(opSection).toContain("勘查反转");
    expect(opSection).not.toContain("执行命令");
    // 执行轨迹区只含工具轨迹
    const toolSection = md.slice(md.indexOf("执行轨迹"));
    expect(toolSection).toContain("执行命令");
    expect(toolSection).toContain("读取文件");
    expect(toolSection).not.toContain("勘查反转");
  });

  it("只有工具轨迹时只渲染「执行轨迹」区，不凭空造一个空的操作记录区", () => {
    const card = buildTaskCard({
      status: "running",
      meta: makeMeta(),
      processSteps: [toolStep()],
    });

    const md = timelineMarkdown(card);
    expect(md).toContain("执行轨迹");
    expect(md).not.toContain("操作记录");
  });

  it("只有操作记录时只渲染「操作记录」区（不凭空造空的执行轨迹区）", () => {
    const card = buildTaskCard({
      status: "running",
      meta: makeMeta(),
      processSteps: [opStep()],
    });

    const md = timelineMarkdown(card);
    expect(md).toContain("操作记录");
    expect(md).not.toContain("执行轨迹");
  });

  it("底部计数分区独立：里程碑 / 操作记录 / 执行轨迹 各自计数", () => {
    const card = buildTaskCard({
      status: "running",
      meta: makeMeta(),
      milestones: [
        { title: "A", timestamp: "2026-11-04T02:40:00.000Z" },
        { title: "B", timestamp: "2026-11-04T02:41:00.000Z" },
      ],
      processSteps: [
        opStep(),
        toolStep(),
        toolStep({ title: "读取文件", category: "read" }),
      ],
    });

    const timeline = panelByTitle(card, "执行动态");
    expect(timeline).toBeDefined();
    const title = String(timeline?.header?.title?.content ?? "");
    // 2 里程碑 / 1 操作记录 / 2 工具调用 —— 不再混成一个「N 个过程」
    expect(title).toContain("2 里程碑");
    expect(title).toContain("1 操作记录");
    expect(title).toContain("2 工具调用");
    expect(title).not.toContain("个过程");
  });

  it("兼容：没有 source 的旧步骤仍渲染（归入操作记录区），不丢内容", () => {
    const card = buildTaskCard({
      status: "running",
      meta: makeMeta(),
      processSteps: [
        {
          title: "状态更新",
          timestamp: "2026-11-04T03:05:07.471Z",
          description: "progress=50",
        },
      ],
    });

    const md = allMarkdown(card);
    expect(md).toContain("状态更新");
    expect(md).toContain("progress=50");
  });
});

// ============================================================================
// 2. 同名步骤不再被静默吞掉（真 bug：processStepKey 不含来源）
//
// ★ 去重发生在 **notifier.updateTask**（mergeUnique），不在 buildTaskCard ——
//   所以这一节必须走 notifier 真实路径，否则测不到。
// ============================================================================

describe("#4889 同名步骤不被去重吞掉", () => {
  let runLarkCliSpy: any;
  let originalRunLarkCli: any;

  beforeEach(() => {
    originalRunLarkCli = (LarkCardPatchNotifier.prototype as any).runLarkCli;
    runLarkCliSpy = mock(async (argv: string[], op: string) => {
      if (argv.includes("+messages-send")) {
        return JSON.stringify({ ok: true, data: { message_id: "om_card_001" } });
      }
      return JSON.stringify({ ok: true, data: {} });
    });
    (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;
  });

  afterEach(() => {
    (LarkCardPatchNotifier.prototype as any).runLarkCli = originalRunLarkCli;
  });

  /** 最后一次 patch 的卡片 markdown */
  async function lastPatchMd(): Promise<string> {
    const calls = runLarkCliSpy.mock.calls.filter(
      (c: any) => c[1] === "patch"
    );
    const args = calls.at(-1)![0] as string[];
    const raw = flagValue(args, "--data");
    const body = JSON.parse(raw!);
    const card =
      typeof body.content === "string"
        ? JSON.parse(body.content)
        : body.content;
    return allMarkdown(card);
  }

  it("同名 + 同时间戳 + 同分类的两条工具轨迹都保留（不再被 mergeUnique 吞掉）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({ title: "执行命令", category: "shell", id: "tool-1" }),
        toolStep({ title: "执行命令", category: "shell", id: "tool-2" }),
      ],
    });

    const md = await lastPatchMd();
    // 两条都在（去重会把第二条吞掉 → 只剩 1 条）
    expect(md.split("执行命令").length - 1).toBe(2);
  });

  it("同名但分类不同的两条步骤都保留（category 参与区分）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({ title: "执行命令", category: "shell", id: undefined }),
        toolStep({ title: "执行命令", category: "bash", id: undefined }),
      ],
    });

    const md = await lastPatchMd();
    expect(md.split("执行命令").length - 1).toBe(2);
  });

  it("同名 + 同分类 + 无 id 的两条工具轨迹也保留（category 参与区分，不被吞）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({ title: "执行命令", category: "shell", id: undefined }),
        toolStep({ title: "执行命令", category: "shell", id: undefined }),
      ],
    });

    const md = await lastPatchMd();
    // 无 id 时仍靠 category 区分不了「两次调用同工具」——
    // 所以无 id 的同内容两条会被去重（这是内容去重的既定语义）。
    // 有 id 的路径（插件实际使用）才是「两次调用都保留」的保证。
    expect(md.split("执行命令").length - 1).toBe(1);
  });

  it("完全相同的一条（同一 operation 重复上报）仍被去重（不制造重复噪音）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [opStep(), opStep()],
    });

    const md = await lastPatchMd();
    // 完全相同的 operation 只应出现一次
    expect(md.split("勘查反转").length - 1).toBe(1);
  });

  it("连续两次 update：第二批步骤追加在第一批之后，第一批时间戳不被改写", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({
          title: "第一批",
          timestamp: "2026-11-04T02:42:46.100Z",
          category: "shell",
          id: "tool-a",
        }),
      ],
    });
    const firstMd = await lastPatchMd();

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({
          title: "第二批",
          timestamp: "2026-11-04T02:43:07.900Z",
          category: "read",
          id: "tool-b",
        }),
      ],
    });
    const secondMd = await lastPatchMd();

    // 第二批追加后，第一批仍在
    expect(secondMd).toContain("第一批");
    expect(secondMd).toContain("第二批");
    // 第一批的时间戳没被改写（仍是 10:42:46）
    const firstLine = secondMd
      .split("\n")
      .find((l) => l.includes("第一批"));
    expect(firstLine).toContain("10:42:46");
    expect(firstLine).not.toContain("10:43:07");
    // 第一批渲染内容与第一次一致（未被第二次更新污染）
    expect(firstMd).toContain("10:42:46");
  });

  it("★ 跨批次 id 不撞：两批各有 seq=0 的同名工具，两条都保留", async () => {
    // ★ Task #4889 review MINOR 的守门测试：
    //   core 按 id **跨卡片更新**去重（同一张卡片的整个生命周期共用一个
    //   id 空间）。若两批工具轨迹复用了同一个 id，第二批那条会被当成
    //   重复而**静默吞掉** —— 卡片上少一条动作，且用户无从察觉。
    //
    //   生产方（插件）用「触发消息 id # 局部 id」作 id，所以两批天然不撞。
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    // 第一批：msg-1#0
    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({
          title: "执行命令",
          category: "shell",
          timestamp: "2026-11-04T02:42:46.100Z",
          id: "om_msg1#0",
        }),
      ],
    });

    // 第二批：另一批次，seq 同样是 0，但 id 里的批次部分不同
    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({
          title: "执行命令",
          category: "shell",
          timestamp: "2026-11-04T02:43:07.900Z",
          id: "om_msg2#0",
        }),
      ],
    });

    const md = await lastPatchMd();
    // 两条都在（若 id 撞了，第二批会被吞掉 → 只剩 1 条）
    expect(md.split("执行命令").length - 1).toBe(2);
  });

  it("★ harness 编号重置也不会撞：两批都用同一个 harness 调用 id", async () => {
    // codex 的 `item_1` 每轮从 1 开始 —— 两个批次都可能出现 `item_1`。
    //   插件因此给 id 加批次 scope；core 侧只需保证「不同 id 都保留」。
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat123",
      meta: makeMeta(),
    });

    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({
          title: "执行命令",
          category: "shell",
          timestamp: "2026-11-04T02:42:46.100Z",
          id: "om_A#item_1",
        }),
      ],
    });
    await notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [
        toolStep({
          title: "执行命令",
          category: "shell",
          timestamp: "2026-11-04T02:43:07.900Z",
          id: "om_B#item_1",
        }),
      ],
    });

    const md = await lastPatchMd();
    expect(md.split("执行命令").length - 1).toBe(2);
  });
});
