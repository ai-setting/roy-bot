/**
 * @fileoverview larkCardPatchNotifier Tests（Task #4230 v2 — 用户验收样式）
 *
 * 覆盖：
 * 1. **lark-cli 参数契约**（本次修复的核心）
 *    - send:  `im +messages-send --msg-type interactive --content <card JSON> --as bot`
 *    - patch: `im messages patch --message-id <id> --data '{"content":"<card JSON 字符串>"}' --as bot`
 *             ❌ 绝不能再出现 `--content`（unknown flag → 卡片永远不更新）
 *    - pin:   `im pins create --data '{"message_id":"om_xxx"}' --as bot`
 *             ❌ 绝不能再出现 `--chat-id`（unknown flag → pin 永远失败）
 *    - unpin: `im pins delete --message-id <id> --yes --as bot`
 * 2. **卡片结构（用户验收顺序）**：
 *    任务栏位（ID/标题/描述/目标/父任务/优先级/context） → 🎯 里程碑序列 →
 *    🔧 过程信息 → 📊 进度百分比
 * 3. **内容必须是可读 markdown（绝不出现 JSON 原文）**
 * 4. 单卡片语义：updateTask/finishTask 只 patch 同一 messageId
 * 5. 生命周期：startTask → pin；finishTask → 终态 patch + unpin
 * 6. 状态自持：里程碑/过程 append + 去重、更新次数递增、spinner 轮换
 * 7. 错误处理：pin 失败非致命、patch 失败抛错、并发串行化
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  LarkCardPatchNotifier,
  formatTimestampForDisplay,
  resolveTaskTitleForDisplay,
  renderProgressBar,
  renderMilestones,
  renderProcessSteps,
  renderTaskInfoLines,
  renderContextAsLines,
  humanizeValue,
  sanitizeInlineText,
  buildChatAppLink,
  DEFAULT_APP_LINK_BASE,
  formatDateTimeForDisplay,
  buildTaskCard,
  type StartTaskResult,
  type TaskMeta,
} from "./lark-card-patch-notifier";

// ============================================================================
// 测试辅助
// ============================================================================

/** 从 args 序列取某 flag 的值 */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

/** 解析 send 路径的卡片 JSON（--content 直接是 card JSON） */
function parseSendCard(args: string[]): any {
  const raw = flagValue(args, "--content");
  return raw ? JSON.parse(raw) : undefined;
}

/** 解析 patch 路径的卡片 JSON（--data = {"content": "<card JSON 字符串>"}） */
function parsePatchCard(args: string[]): any {
  const raw = flagValue(args, "--data");
  if (!raw) return undefined;
  const body = JSON.parse(raw);
  return typeof body.content === "string" ? JSON.parse(body.content) : body.content;
}

/**
 * 收集卡片里所有 markdown 段落文本
 *
 * ★ Task #4845：卡片内容现在收在 `collapsible_panel` 里，
 *   这里**递归**扫进面板内部（否则既有用例会因"看不见折叠内容"而假失败）。
 */
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

/** 取某类操作（send/patch/pin/unpin）的 argv 序列（避免依赖调用下标） */
function callsOf(spy: any, op: string): string[][] {
  return spy.mock.calls
    .filter((c: any) => c[1] === op)
    .map((c: any) => c[0]);
}

/** 造一个完整 TaskMeta */
function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: 4223,
    title: "验证置顶 + 可更新卡片",
    description: "E2E 测试任务",
    goals: "输出 E2E 报告",
    parentTaskId: 4116,
    priority: "high",
    type: "normal",
    projectPath: "~/proj",
    context: JSON.stringify({
      worktree_path: "~/proj/.worktrees/feat-x",
      branch: "feature/lark-card",
      created_at: "2026-10-15T01:20:28.000Z",
    }),
    currentStatus: "进行中",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("LarkCardPatchNotifier", () => {
  let runLarkCliSpy: any;
  let originalRunLarkCli: any;
  let ops: string[];

  beforeEach(() => {
    ops = [];
    originalRunLarkCli = (LarkCardPatchNotifier.prototype as any).runLarkCli;
    runLarkCliSpy = mock(async (argv: string[], op: string) => {
      ops.push(op);
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

  // ========================================================================
  // 1. lark-cli 参数契约
  // ========================================================================
  describe("lark-cli args 契约（Task #4230 修复）", () => {
    it("send: 用 +messages-send + interactive + --content card JSON + --as bot", async () => {
      const notifier = new LarkCardPatchNotifier();
      await notifier.startTask({ chatId: "oc_chat123", meta: makeMeta() });

      const args = callsOf(runLarkCliSpy, "send")[0];
      expect(args.slice(0, 2)).toEqual(["im", "+messages-send"]);
      expect(flagValue(args, "--chat-id")).toBe("oc_chat123");
      expect(flagValue(args, "--msg-type")).toBe("interactive");
      expect(flagValue(args, "--as")).toBe("bot");

      const card = parseSendCard(args);
      expect(card.schema).toBe("2.0");
      expect(card.header).toBeDefined();
      expect(card.body.elements.length).toBeGreaterThan(0);
    });

    it("send: 不双重包裹（--content 直接是 card JSON，不是 post 格式）", async () => {
      const notifier = new LarkCardPatchNotifier();
      await notifier.startTask({ chatId: "oc_chat123", meta: makeMeta() });

      const raw = flagValue(callsOf(runLarkCliSpy, "send")[0], "--content")!;
      const parsed = JSON.parse(raw);
      // post 格式会长这样：{"zh_cn":{"content":[...]}} —— 必须不出现
      expect(parsed.zh_cn).toBeUndefined();
      expect(parsed.schema).toBe("2.0");
    });

    it("patch: 必须用 --data（不能是 --content），且 content 是 JSON 字符串", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.updateTask({ messageId, status: "running" });

      const patchArgs = callsOf(runLarkCliSpy, "patch")[0];
      expect(patchArgs.slice(0, 3)).toEqual(["im", "messages", "patch"]);
      expect(flagValue(patchArgs, "--message-id")).toBe(messageId);
      expect(flagValue(patchArgs, "--as")).toBe("bot");
      // ★ 回归保护：--content 对 `im messages patch` 是 unknown flag
      expect(patchArgs).not.toContain("--content");
      expect(patchArgs).toContain("--data");

      // content 必须是"卡片 JSON 的字符串"（双层序列化）
      const body = JSON.parse(flagValue(patchArgs, "--data")!);
      expect(typeof body.content).toBe("string");
      const card = JSON.parse(body.content);
      expect(card.schema).toBe("2.0");
      expect(card.body.elements.length).toBeGreaterThan(0);
    });

    it('pin: 必须用 --data {"message_id"}（不能是 --chat-id/--message-id）', async () => {
      const notifier = new LarkCardPatchNotifier();
      await notifier.startTask({ chatId: "oc_chat123", meta: makeMeta() });

      const pinArgs = callsOf(runLarkCliSpy, "pin")[0];
      expect(pinArgs.slice(0, 3)).toEqual(["im", "pins", "create"]);
      // ★ 回归保护：--chat-id / --message-id 对 pins create 都是 unknown flag
      expect(pinArgs).not.toContain("--chat-id");
      expect(pinArgs).not.toContain("--message-id");
      expect(JSON.parse(flagValue(pinArgs, "--data")!)).toEqual({
        message_id: "om_card_001",
      });
      expect(flagValue(pinArgs, "--as")).toBe("bot");
    });

    it("unpin: 必须带 --yes（high-risk-write）+ --message-id + --as bot（显式开启时）", async () => {
      // ★ Task #5164 R2a：默认不 unpin，本契约测显式 unpinOnFinish=true 的 argv 形态
      const notifier = new LarkCardPatchNotifier({ unpinOnFinish: true });
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.finishTask({ messageId, status: "completed" });

      const unpinArgs = callsOf(runLarkCliSpy, "unpin").at(-1)!;
      expect(unpinArgs.slice(0, 3)).toEqual(["im", "pins", "delete"]);
      expect(flagValue(unpinArgs, "--message-id")).toBe(messageId);
      expect(unpinArgs).toContain("--yes");
      expect(flagValue(unpinArgs, "--as")).toBe("bot");
    });

    it("所有命令都插入 --profile 到 args 头部（多 appId 场景）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        profile: "tongzhuli",
        meta: makeMeta(),
      });
      await notifier.updateTask({ messageId, profile: "tongzhuli", status: "running" });
      await notifier.finishTask({
        messageId,
        profile: "tongzhuli",
        status: "completed",
      });

      for (const argv of runLarkCliSpy.mock.calls.map((c: any) => c[0])) {
        expect(argv[0]).toBe("--profile");
        expect(argv[1]).toBe("tongzhuli");
      }
    });
  });

  // ========================================================================
  // 2. startTask
  // ========================================================================
  describe("startTask", () => {
    it("返回 messageId + pinned=true，并 pin 卡片", async () => {
      const notifier = new LarkCardPatchNotifier();
      const result: StartTaskResult = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      expect(result.messageId).toBe("om_card_001");
      expect(result.pinned).toBe(true);
      expect(ops).toEqual(["send", "pin"]);
    });

    it("send 响应缺 message_id → 抛错（不静默）", async () => {
      runLarkCliSpy = mock(async () => JSON.stringify({ ok: true, data: {} }));
      (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;

      const notifier = new LarkCardPatchNotifier();
      await expect(
        notifier.startTask({ chatId: "oc_chat123", meta: makeMeta() })
      ).rejects.toThrow(/message_id/);
    });

    it("pin 失败 → 非致命（pinned=false + pinError），卡片仍返回", async () => {
      runLarkCliSpy = mock(async (argv: string[], op: string) => {
        ops.push(op);
        if (op === "pin") throw new Error('unknown flag "--chat-id"');
        if (argv.includes("+messages-send")) {
          return JSON.stringify({ ok: true, data: { message_id: "om_card_001" } });
        }
        return "{}";
      });
      (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;

      const notifier = new LarkCardPatchNotifier();
      const result = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      expect(result.pinned).toBe(false);
      expect(result.pinError).toContain("unknown flag");
      expect(result.messageId).toBe("om_card_001");
    });

    it("pinOnStart=false → 不 pin", async () => {
      const notifier = new LarkCardPatchNotifier({ pinOnStart: false });
      const result = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      expect(result.pinned).toBe(false);
      expect(ops).toEqual(["send"]);
    });

    it("初始卡片带「Task 创建」里程碑 + 任务栏位", async () => {
      const notifier = new LarkCardPatchNotifier();
      await notifier.startTask({ chatId: "oc_chat123", meta: makeMeta() });

      const card = parseSendCard(callsOf(runLarkCliSpy, "send")[0]);
      const md = allMarkdown(card);
      expect(md).toContain("Task 创建");
      expect(md).toContain("🆔 任务 ID");
      expect(card.header.title.content).toContain("#4223");
      expect(card.header.subtitle.content).toMatch(/^spinner: '/);
    });
  });

  // ========================================================================
  // 3. 卡片结构（用户验收顺序）+ 无 JSON
  // ========================================================================
  describe("卡片结构与内容（用户验收）", () => {
    it("顺序：任务栏位 → 里程碑序列 → 操作记录 → 进度百分比", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta(),
        milestones: [{ title: "调研启动", timestamp: "2026-10-15T01:00:00.000Z" }],
        processSteps: [
          { title: "扫描 Issues", timestamp: "2026-10-15T01:00:00.000Z" },
        ],
        progress: 60,
        updateCount: 3,
        spinner: "🔄",
      });

      const md = allMarkdown(card);
      const iTask = md.indexOf("🆔 任务 ID");
      const iMilestone = md.indexOf("## 🎯 里程碑序列");
      // ★ Task #4889：过程信息区拆成「操作记录」/「执行轨迹（工具调用）」两区；
      //   本例的步骤无 source（= operation 记录）→ 落在「操作记录」区。
      const iProcess = md.indexOf("## 📝 操作记录");
      const iProgress = md.indexOf("**📊 进度**");

      expect(iTask).toBeGreaterThanOrEqual(0);
      expect(iMilestone).toBeGreaterThan(iTask);
      expect(iProcess).toBeGreaterThan(iMilestone);
      expect(iProgress).toBeGreaterThan(iProcess);
      // 进度是最后一块
      expect(md.indexOf("**📊 进度**")).toBe(md.lastIndexOf("**📊 进度**"));
      expect(md).toContain("60%");
    });

    it("任务栏位包含 id/title/description/goals/parent/priority+type/项目", () => {
      const lines = renderTaskInfoLines(makeMeta()).join("\n");
      expect(lines).toContain("**🆔 任务 ID**：#4223");
      expect(lines).toContain("**📌 标题**：验证置顶 + 可更新卡片");
      expect(lines).toContain("**📝 描述**：E2E 测试任务");
      expect(lines).toContain("**🎯 目标**：输出 E2E 报告");
      expect(lines).toContain("**🔗 父任务**：#4116");
      expect(lines).toContain("**⚡ 优先级 / 类型**：high / normal");
      expect(lines).toContain("**📂 项目**：`~/proj`");
    });

    it("context 展开成可读 bullet（含 worktree/分支/创建时间），且不含 JSON 字符", () => {
      const lines = renderTaskInfoLines(makeMeta()).join("\n");
      expect(lines).toContain("**🌿 Worktree**：~/proj/.worktrees/feat-x");
      expect(lines).toContain("**🌿 分支**：feature/lark-card");
      expect(lines).toContain("**🕐 创建时间**");
      // ★ 不得出现 JSON 原文
      expect(lines).not.toContain("{");
      expect(lines).not.toContain("}");
      expect(lines).not.toContain('"');
    });

    it("context 里的未知字段也渲染成 key：value（仍然不是 JSON）", () => {
      const lines = renderContextAsLines(
        JSON.stringify({ custom_thing: "abc", n: 3, arr: ["a", "b"] })
      ).join("\n");
      expect(lines).toContain("**custom_thing**：abc");
      expect(lines).toContain("**n**：3");
      expect(lines).toContain("**arr**：a、b");
      expect(lines).not.toContain("{");
    });

    it("context 是坏 JSON → 安全跳过（不崩、不输出 JSON）", () => {
      expect(renderContextAsLines("not-json")).toEqual([]);
      expect(renderContextAsLines(undefined)).toEqual([]);
      expect(renderContextAsLines('["array","not object"]')).toEqual([]);
    });

    it("projectPath 为 'unknown' 时不渲染该项目行", () => {
      const lines = renderTaskInfoLines(makeMeta({ projectPath: "unknown" })).join("\n");
      expect(lines).not.toContain("📂 项目");
    });

    it("没有父任务（parentTaskId=0/undefined）时不渲染父任务行", () => {
      const lines = renderTaskInfoLines(makeMeta({ parentTaskId: undefined })).join("\n");
      expect(lines).not.toContain("🔗 父任务");
    });

    it("终态：绿色 + 100% + 🎉 全部完成", () => {
      const card = buildTaskCard({
        status: "completed",
        meta: makeMeta({ id: 4223 }),
      });
      expect(card.header.template).toBe("green");
      expect(card.header.subtitle.content).toContain("🎉 全部完成！");
      expect(allMarkdown(card)).toContain("100%");
    });

    it("失败终态：红色模板", () => {
      const card = buildTaskCard({ status: "failed", meta: makeMeta() });
      expect(card.header.template).toBe("red");
      expect(card.header.subtitle.content).toContain("任务失败");
    });
  });

  // ========================================================================
  // 4. updateTask —— 单卡片 + 状态自持
  // ========================================================================
  describe("updateTask", () => {
    it("只 patch 同一 messageId（绝不新发消息）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      await notifier.updateTask({ messageId, status: "running" });
      await notifier.updateTask({ messageId, status: "running" });

      expect(callsOf(runLarkCliSpy, "send").length).toBe(1);
      expect(callsOf(runLarkCliSpy, "patch").length).toBe(2);
      for (const argv of callsOf(runLarkCliSpy, "patch")) {
        expect(flagValue(argv, "--message-id")).toBe(messageId);
      }
    });

    it("累积里程碑并去重（时间线持续增长，不丢历史）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      await notifier.updateTask({
        messageId,
        status: "running",
        milestones: [{ title: "调研启动", timestamp: "2026-10-15T01:00:00Z" }],
      });
      // 重复传同一条 + 新增一条
      await notifier.updateTask({
        messageId,
        status: "running",
        milestones: [
          { title: "调研启动", timestamp: "2026-10-15T01:00:00Z" },
          { title: "数据收集", timestamp: "2026-10-15T02:00:00Z" },
        ],
      });

      const md = allMarkdown(
        parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!)
      );
      expect(md).toContain("调研启动");
      expect(md).toContain("数据收集");
      expect(md.split("调研启动").length - 1).toBe(1); // 去重
    });

    it("过程信息支持时间区间（HH:mm:ss → 现在）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.updateTask({
        messageId,
        status: "running",
        processSteps: [
          {
            title: "扫描 GitHub Issues",
            timestamp: "2026-10-15T01:00:00Z",
            description: "141 issues",
          },
        ],
      });

      const md = allMarkdown(
        parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!)
      );
      expect(md).toContain("→ 现在");
      expect(md).toContain("扫描 GitHub Issues");
      expect(md).toContain("141 issues");
    });

    it("更新次数递增 + spinner 轮换（持续滚动观感）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      const subtitles: string[] = [];
      for (let i = 0; i < 3; i++) {
        await notifier.updateTask({ messageId, status: "running" });
        const card = parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!);
        subtitles.push(card.header.subtitle.content);
      }

      expect(new Set(subtitles).size).toBeGreaterThan(1); // spinner 轮换
      expect(subtitles.at(-1)).toContain("第 4 次更新");
    });

    it("未知进度时不编造假百分比（只显示进行中）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.updateTask({ messageId, status: "running" });

      const md = allMarkdown(
        parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!)
      );
      expect(md).toContain("**📊 进度**：进行中");
      expect(md).not.toMatch(/\d+%/);
    });

    it("提供真实进度时渲染进度条 + 百分比", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.updateTask({ messageId, status: "running", progress: 60 });

      const md = allMarkdown(
        parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!)
      );
      expect(md).toContain("60%");
      expect(md).toContain("▓");
    });

    it("meta 增量更新（如 goals 变化）合并进栏位，缺省字段沿用 startTask 的", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta({ goals: "旧目标" }),
      });
      await notifier.updateTask({
        messageId,
        status: "running",
        meta: { goals: "新目标" },
      });

      const md = allMarkdown(
        parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!)
      );
      expect(md).toContain("新目标");
      expect(md).not.toContain("旧目标");
      expect(md).toContain("**📌 标题**：验证置顶 + 可更新卡片"); // 沿用
    });

    it("patch 失败 → 抛错（caller 决定降级）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      runLarkCliSpy = mock(async (argv: string[], op: string) => {
        if (op === "patch") throw new Error('unknown flag "--content"');
        if (argv.includes("+messages-send")) {
          return JSON.stringify({ data: { message_id: "om_card_001" } });
        }
        return "{}";
      });
      (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;

      await expect(
        notifier.updateTask({ messageId, status: "running" })
      ).rejects.toThrow(/unknown flag/);
    });

    it("并发 patch 通过 mutex 串行化（同一 messageId 不交错）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      let inFlight = 0;
      let maxInFlight = 0;
      runLarkCliSpy = mock(async (argv: string[], op: string) => {
        if (op === "patch") {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
        }
        if (argv.includes("+messages-send")) {
          return JSON.stringify({ data: { message_id: "om_card_001" } });
        }
        return "{}";
      });
      (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;

      await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          notifier.updateTask({
            messageId,
            status: "running",
            milestones: [{ title: `step-${i}` }],
          })
        )
      );

      expect(maxInFlight).toBe(1);
    });
  });

  // ========================================================================
  // 5. finishTask
  // ========================================================================
  describe("finishTask", () => {
    it("patch 终态（绿色 + 100%）后不自动 unpin（Task #5164 R2a：pin 去留用户决定）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      await notifier.finishTask({ messageId, status: "completed" });

      // ★ Task #5164 R2a：默认不再自动 unpin（用户手动决定 pin 去留）
      expect(ops).toEqual(["send", "pin", "patch"]);
      expect(ops).not.toContain("unpin");

      const card = parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!);
      expect(card.header.template).toBe("green");
      expect(card.header.subtitle.content).toContain("全部完成");
      const md = allMarkdown(card);
      expect(md).toContain("100%");
      expect(md).toContain("Task 完成");
    });

    it("显式 unpinOnFinish=true 时仍自动 unpin（可配置回退）", async () => {
      const notifier = new LarkCardPatchNotifier({ unpinOnFinish: true });
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.finishTask({ messageId, status: "completed" });
      expect(ops).toEqual(["send", "pin", "patch", "unpin"]);
    });

    it("failed 终态用红色模板", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      await notifier.finishTask({ messageId, status: "failed" });

      const card = parsePatchCard(callsOf(runLarkCliSpy, "patch").at(-1)!);
      expect(card.header.template).toBe("red");
      expect(allMarkdown(card)).toContain("Task 失败");
    });

    it("unpin 失败非致命（不抛错）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });

      runLarkCliSpy = mock(async (argv: string[], op: string) => {
        ops.push(op);
        if (op === "unpin") throw new Error("high-risk-write requires --yes");
        if (argv.includes("+messages-send")) {
          return JSON.stringify({ data: { message_id: "om_card_001" } });
        }
        return "{}";
      });
      (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;

      await expect(
        notifier.finishTask({ messageId, status: "completed" })
      ).resolves.toBeUndefined();
    });

    it("完成后清理内部状态（不泄漏）", async () => {
      const notifier = new LarkCardPatchNotifier();
      const { messageId } = await notifier.startTask({
        chatId: "oc_chat123",
        meta: makeMeta(),
      });
      expect(notifier.trackedCardCount()).toBe(1);
      await notifier.finishTask({ messageId, status: "completed" });
      expect(notifier.trackedCardCount()).toBe(0);
    });
  });

  // ========================================================================
  // 6. helpers
  // ========================================================================
  describe("helpers", () => {
    it("humanizeValue：object/array 渲染成可读文本，不是 JSON", () => {
      expect(humanizeValue("abc")).toBe("abc");
      expect(humanizeValue(3)).toBe("3");
      expect(humanizeValue(["a", "b"])).toBe("a、b");
      expect(humanizeValue({ k: "v", n: 2 })).toBe("k: v · n: 2");
      expect(humanizeValue(null)).toBe("");
      expect(
        humanizeValue({ prior: { prev_task: "#2300" } })
      ).toBe("prior: prev_task: #2300");
    });

    it("humanizeValue：ISO 时间转成可读时间（不再是 T/Z 原串）", () => {
      expect(humanizeValue("2026-10-15T01:20:28.000Z")).toBe("2026-10-15 09:20");
      // 非时间字符串不受影响
      expect(humanizeValue("/tmp/demo-wt")).toBe("/tmp/demo-wt");
      expect(humanizeValue("demo/card")).toBe("demo/card");
    });

    it("sanitizeInlineText：压成单行、去 markdown 标记、保留 #123 引用", () => {
      const raw = [
        "## Goals & Expected Deliverables",
        "1. 在 `/tmp/demo-wt` 建 demo 项目",
        "- **任务栏位**：展示 title/id",
        "",
        "第二段",
      ].join("\n");
      const flat = sanitizeInlineText(raw, 500);
      expect(flat).not.toContain("\n");
      expect(flat).not.toContain("##");
      expect(flat).not.toContain("**");
      expect(flat).not.toContain("`");
      expect(flat).toContain("·");
      // ★ 任务引用 #4223 / #2300 不能被当成标题标记吃掉
      expect(sanitizeInlineText("#2300 相关任务")).toContain("#2300");
    });

    it("sanitizeInlineText：超长截断加 …", () => {
      const long = "x".repeat(400);
      const out = sanitizeInlineText(long, 100);
      expect(out.length).toBe(101);
      expect(out.endsWith("…")).toBe(true);
    });

    // Task #5096 —— markdown 图片语法 `![alt](url)` 里的 url（尤其 `@./file.png`
    // 这类本地相对引用）会原样进卡片 markdown，被飞书当成 image key → 230099 拒收整卡。
    it("sanitizeInlineText：剥离 markdown 图片语法（不留 @./ 路径）", () => {
      // 含 caption 的本地引用（本次事故形态：process_description 里的字面图片）
      const out1 = sanitizeInlineText("看这张 ![caption](@./file.png) 说明");
      expect(out1).not.toContain("@./");
      expect(out1).not.toContain("file.png");
      expect(out1).toContain("[图片]");
      // 无 alt 的形态
      const out2 = sanitizeInlineText("前文 ![](img.png) 后文");
      expect(out2).not.toContain("img.png");
      // 空 url 形态
      const out3 = sanitizeInlineText("空图 ![]() 收尾");
      expect(out3).not.toContain("![");
      expect(out3).not.toContain("](");
      // https 图片同样剥掉（卡片 markdown 里任何 ![..](..) 都是隐患）
      const out4 = sanitizeInlineText("远程 ![alt](https://evil.com/x.png)");
      expect(out4).not.toContain("evil.com");
      expect(out4).toContain("[图片]");
      // 多张图一次剥净
      const out5 = sanitizeInlineText(
        "![a](x.png) 中间文本 ![b](@./y.png) 结尾"
      );
      expect(out5).not.toContain("x.png");
      expect(out5).not.toContain("@./y.png");
      expect(out5.split("[图片]").length - 1).toBe(2);
      // 链接语法 [text](url) 是合法超链接，保留不动（不过度清洗）
      const out6 = sanitizeInlineText("[文本](https://feishu.cn/doc) 链接");
      expect(out6).toContain("[文本](https://feishu.cn/doc)");
    });

    it("renderMilestones：description 含图片语法时输出不含 @./（230099 根因）", () => {
      const out = renderMilestones([
        {
          timestamp: "2026-11-06T13:51:00.000Z",
          title: "落盘",
          description: "图片已插入 ![cap](@./file.png)",
        },
      ]);
      expect(out).not.toContain("@./");
      expect(out).not.toContain("![");
      expect(out).toContain("[图片]");
    });

    it("renderProcessSteps：description 含图片语法时输出不含 @./", () => {
      const out = renderProcessSteps([
        {
          title: "截图",
          timestamp: "2026-11-06T13:50:00.000Z",
          description: "![](shot.png) 完成",
        },
      ]);
      expect(out).not.toContain("shot.png");
      expect(out).not.toContain("![");
    });

    it("任务栏位的长描述被压成单行（卡片结构不被 agent 的 markdown 撑坏）", () => {
      const lines = renderTaskInfoLines(
        makeMeta({
          description: "## 标题\n- 第一项\n- 第二项\n正文",
        })
      ).join("\n");
      expect(lines).toContain("**📝 描述**：标题 · 第一项 · 第二项 · 正文");
      expect(lines).not.toContain("## 标题");
    });

    it("renderProgressBar 渲染 20 格进度条", () => {
      expect(renderProgressBar(0)).toContain("0%");
      expect(renderProgressBar(100)).toContain("100%");
      const bar = renderProgressBar(50);
      expect(bar.split("▓").length - 1).toBe(10);
      expect(bar.split("░").length - 1).toBe(10);
    });

    it("renderMilestones/renderProcessSteps 空数组给占位文案", () => {
      expect(renderMilestones([])).toContain("暂无里程碑");
      expect(renderProcessSteps([])).toContain("暂无过程记录");
    });

    it("formatTimestampForDisplay 转成北京时间 HH:mm:ss", () => {
      // 2026-10-15T01:20:28Z = 09:20:28 +08:00
      expect(formatTimestampForDisplay("2026-10-15T01:20:28.000Z")).toBe("09:20:28");
      expect(formatTimestampForDisplay(undefined)).toBe("");
      expect(formatTimestampForDisplay("not-a-date")).toBe("not-a-date");
    });

    it("resolveTaskTitleForDisplay 兜底不暴露 chatId", () => {
      expect(resolveTaskTitleForDisplay({ taskTitle: "真实标题" })).toBe("真实标题");
      expect(resolveTaskTitleForDisplay({ taskId: 4221, title: "标题" })).toBe(
        "#4221 标题"
      );
      expect(resolveTaskTitleForDisplay({ taskId: 4221 })).toBe("#4221");
      expect(resolveTaskTitleForDisplay({})).toBe("Task");
    });
  });

  // ========================================================================
  // 群链接格式（Task #4230 follow-up / Task #4394）
  //
  // ★ Task #4394：`buildRedirectCard`（「已改投专属群」指路卡）已删除。
  //   `buildChatAppLink` 保留 —— 卡片顶部「进入专属群」链接仍在用它。
  // ========================================================================
  describe("buildChatAppLink", () => {
    it("app link 用飞书格式（applink.feishu.cn/client/chat/open?openChatId=）", () => {
      const link = buildChatAppLink("oc_abc123");
      expect(link).toBe("https://applink.feishu.cn/client/chat/open?openChatId=oc_abc123");
      expect(DEFAULT_APP_LINK_BASE).toBe("https://applink.feishu.cn");
    });

    it("不再使用 Lark 国际版域名 + 老 chatDetail 路径（用户实测点不开）", () => {
      const link = buildChatAppLink("oc_abc123");
      expect(link).not.toContain("larkoffice.com");
      expect(link).not.toContain("chatDetail");
      expect(link).toContain("/client/chat/open");
    });

    it("★ Task #4394：整个文件里不再存在「已改投专属群」这类文案构造器", async () => {
      const mod = await import("./lark-card-patch-notifier");
      expect(
        (mod as unknown as Record<string, unknown>)["buildRedirectCard"]
      ).toBeUndefined();
    });
  });

  // ========================================================================
  // Task #4331: 卡片顶部按钮（建/解散专属群） + 下方链接（进入群）
  // ========================================================================
  describe("buildTaskCard / Task #4331 按钮 + 链接", () => {
    function findButton(card: any): any | undefined {
      return card.body.elements.find((e: any) => e.tag === "button");
    }

    it("无 perTaskChatId → 渲染「为这个任务建群」按钮 + 不显示下方链接", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ perTaskChatId: undefined }),
        milestones: [],
        processSteps: [],
        updateCount: 1,
      });

      const btn = findButton(card);
      expect(btn).toBeDefined();
      expect(btn.text.content).toBe("为这个任务建群");
      expect(btn.type).toBe("primary");
      expect(btn.value).toEqual({
        action: "create_group",
        taskId: "4223",
      });

      // 下方链接不应存在
      const linkMd = allMarkdown(card);
      expect(linkMd).not.toContain("进入专属群");
      expect(linkMd).not.toContain("applink.feishu.cn");
    });

    it("有 perTaskChatId → 渲染「解散该群」按钮 + 显示飞书 applink「进入群」", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({
          perTaskChatId: "oc_per_task_xxx",
          perTaskChatName: "Task 4223 - 验证专属群",
        }),
        milestones: [],
        processSteps: [],
        updateCount: 1,
      });

      const btn = findButton(card);
      expect(btn).toBeDefined();
      expect(btn.text.content).toBe("解散该群");
      expect(btn.type).toBe("danger");
      expect(btn.value).toEqual({
        action: "disband_group",
        taskId: "4223",
      });

      // 下方链接应该存在 + applink 正确格式
      const linkMd = allMarkdown(card);
      expect(linkMd).toContain("进入专属群");
      expect(linkMd).toContain(
        "https://applink.feishu.cn/client/chat/open?openChatId=oc_per_task_xxx"
      );
    });

    it("有 perTaskChatId 但无群名 → 链接文本回退「进入专属群」", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ perTaskChatId: "oc_y", perTaskChatName: undefined }),
        milestones: [],
        processSteps: [],
        updateCount: 1,
      });

      const linkMd = allMarkdown(card);
      expect(linkMd).toContain("[📨 进入专属群](https://applink.feishu.cn/client/chat/open?openChatId=oc_y)");
    });

    it("空字符串 perTaskChatId 视为无群（按钮显示建群）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ perTaskChatId: "" }),
        milestones: [],
        processSteps: [],
        updateCount: 1,
      });

      const btn = findButton(card);
      expect(btn.text.content).toBe("为这个任务建群");
      expect(btn.type).toBe("primary");
    });

    it("按钮位于 elements 第一个（最上方）", () => {
      const card = buildTaskCard({
        status: "running",
        meta: makeMeta({ perTaskChatId: "oc_z" }),
        milestones: [{ title: "M1", timestamp: "2026-10-15T01:00:00.000Z" }],
        processSteps: [{ title: "P1", timestamp: "2026-10-15T01:00:00.000Z" }],
        updateCount: 1,
      });

      expect(card.body.elements[0].tag).toBe("button");
    });
  });
});
