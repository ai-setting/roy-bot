/**
 * @fileoverview TDD (RED) — ask_user 工具在「无 TTY / 有 IM 渠道」场景下的直连投递
 *
 * ## 背景（Task #4983，traceId 01a1a68652ee79c9c6508579b504e662）
 *
 * 生产日志铁证（2026-11-04 20:55:38 → 20:56:09，飞书 p2p oc_9406ee…）：
 *
 *   20:55:38.788  [BackgroundTaskManager] Event published: task.background.ask_user
 *                  （triggerEventId + replyChannel 都齐 ✅ —— #3147 的 notify 链路是好的）
 *   20:55:38.790  cli.query-executor.execute enter: "[通知] ❓ 后台子代理「…」请求用户输入 …"
 *   20:56:09.513  [agent:component] Iteration 1 error
 *                  {runId:"unknown", nodeId:"unknown", type:"ask-user", name:"AskUserError"}
 *   20:56:09.517  cli.query-executor.execute error: __ASK_USER_ERROR__:{…}
 *   ⇒ 此后该 traceId **0 次** lark messages-send / messages-reply
 *
 * 根因链：
 *   1. ask_user 工具只「抛 AskUserError」当作中断信号（ask-user-tool.ts:70）
 *   2. 交互层（REPL + readline）在守护进程里是死的（无 TTY）
 *   3. headless 下没人接这个异常 ⇒ 直接冒泡终止整次查询
 *   4. query-executor.ts:491 `isAskUserError → return` + error-reply.ts:446
 *      `ask_user` 规则 `notify:false` ⇒ 双重静默，连失败兜底都不发
 *
 * ⇒ **问题正文从未离开进程，用户零感知**（就是用户说的「被淹没」）。
 *
 * ## 本文件的修复契约（路线 A）
 *
 * `ask_user` 工具在抛 AskUserError **之前**，若当前上下文存在可用的 IM 投递目标，
 * 就**自己把问题（含选项）投递过去**，让用户真正看到并能答复。
 *
 * 契约要点：
 *   - C1 无投递目标时 → 行为不变（抛 AskUserError，交给 TTY 交互层）
 *   - C2 有投递目标时 → 先投递，再抛 AskUserError（中断信号保留，agent 本轮终止）
 *   - C3 投递失败 → **绝不抛**（不能让投递故障掩盖原始中断语义），且必须留痕
 *   - C4 投递内容必须含问题正文 + 选项（用户要能选）
 *   - C5 投递目标从 EnvContext 取（replyChannel / envEvent.metadata.replyChannel）
 *
 * ## 测试范围
 *
 *   RED-1  无 replyChannel → 抛 AskUserError，且**不**尝试投递
 *   RED-2  有 replyChannel(chatId) → 投递一次 + 抛 AskUserError
 *   RED-3  投递内容含问题正文与全部选项
 *   RED-4  投递抛错 → 仍然抛 AskUserError（不吞、不替换），且错误被记录
 *   RED-5  只有 envEvent.metadata.replyChannel（无顶层 replyChannel）→ 也能投递
 *   RED-6  replyChannel 无 chatId → 视为无目标，不投递
 *   RED-7  runId/nodeId 从 metadata 正确解析（不再是 'unknown'）—— B1 修复
 *   RED-8  metadata 缺失时仍能抛（向后兼容，runId/nodeId 回落 'unknown'）
 */

import { describe, it, expect, vi, beforeEach, afterEach, mock } from "vitest";
import { AskUserError } from "../types/workflow-hil";

// ============================================================================
// Mocks（必须在 import 目标模块**之前**声明）
// ============================================================================

const sendMarkdownMock = vi.fn();
const replyMock = vi.fn();
const sendTextMock = vi.fn();

const replyChannelMock = {
  type: "lark-cli",
  chatId: "oc_test_chat",
  messageId: "om_test_msg",
  profile: "tongzhuli",
  sendMarkdown: sendMarkdownMock,
  sendText: sendTextMock,
  reply: replyMock,
};

let envContextValue: any = undefined;

// 用 bun 的 mock.module 覆盖 context 模块的 getEnvContext。
// ⚠️ 必须**整体**提供 getEnvContext / getEnvContextOrEmpty —— 被测模块只 import
// 这两个符号，但 mock.module 是整模块替换，漏一个会变成 undefined 导出。
mock.module("../../context", () => ({
  getEnvContext: () => envContextValue,
  getEnvContextOrEmpty: () => envContextValue ?? {},
}));

// ★ error-reply 的裸快照直发路径（spawn lark-cli）—— mock 掉，
//   避免测试真的 spawn 子进程。
const deliverAskUserMessageMock = vi.fn(async () => ({ sent: true }));
mock.module("../../error-reply", () => ({
  deliverAskUserMessage: deliverAskUserMessageMock,
}));

// ============================================================================
// 被测模块（mock 之后再 import，保证 mock 生效）
// ============================================================================

import { askUserTool } from "./ask-user-tool";

// ============================================================================
// 测试脚手架
// ============================================================================

function makeToolContext(overrides: Record<string, unknown> = {}): any {
  return {
    session_id: "session_main",
    message_id: "om_x",
    abort: undefined,
    metadata: {},
    ...overrides,
  };
}

describe("ask_user 工具 —— 无 TTY 场景的 IM 直连投递（Task #4983）", () => {
  beforeEach(() => {
    envContextValue = undefined;
    sendMarkdownMock.mockReset();
    replyMock.mockReset();
    sendTextMock.mockReset();
    deliverAskUserMessageMock.mockReset();
    sendMarkdownMock.mockResolvedValue(undefined);
    replyMock.mockResolvedValue(undefined);
    sendTextMock.mockResolvedValue(undefined);
    deliverAskUserMessageMock.mockResolvedValue({ sent: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // RED-1：无投递目标 → 行为不变（抛 AskUserError，不投递）
  // ------------------------------------------------------------------
  it("RED-1: 无 replyChannel 时抛 AskUserError 且不尝试投递", async () => {
    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "请确认是否继续？" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);

    expect(sendMarkdownMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // RED-2：有 replyChannel → 先投递，再抛 AskUserError
  // ------------------------------------------------------------------
  it("RED-2: 有 replyChannel 时投递问题后再抛 AskUserError", async () => {
    envContextValue = { replyChannel: replyChannelMock };

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "请确认是否继续？" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);

    // 恰好投递一次
    const totalCalls =
      sendMarkdownMock.mock.calls.length +
      replyMock.mock.calls.length +
      sendTextMock.mock.calls.length;
    expect(totalCalls).toBe(1);
  });

  // ------------------------------------------------------------------
  // RED-3：投递内容含问题正文 + 全部选项
  // ------------------------------------------------------------------
  it("RED-3: 投递内容含问题正文与全部选项", async () => {
    envContextValue = { replyChannel: replyChannelMock };

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute(
        {
          query: "请选择要执行的方案",
          options: ["方案 A", "方案 B", "方案 C"],
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AskUserError);

    const allArgs = [
      ...sendMarkdownMock.mock.calls,
      ...replyMock.mock.calls,
      ...sendTextMock.mock.calls,
    ].flat();
    const payload = allArgs.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join("\n");

    expect(payload).toContain("请选择要执行的方案");
    expect(payload).toContain("方案 A");
    expect(payload).toContain("方案 B");
    expect(payload).toContain("方案 C");
  });

  // ------------------------------------------------------------------
  // RED-4：投递失败 → 仍然抛 AskUserError（不让投递故障掩盖中断语义）
  // ------------------------------------------------------------------
  it("RED-4: 投递抛错时仍然抛 AskUserError（原始中断语义不被掩盖）", async () => {
    envContextValue = { replyChannel: replyChannelMock };
    sendMarkdownMock.mockRejectedValue(new Error("lark-cli exit 1"));
    replyMock.mockRejectedValue(new Error("lark-cli exit 1"));
    sendTextMock.mockRejectedValue(new Error("lark-cli exit 1"));

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "投递会失败的问题" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);
  });

  // ------------------------------------------------------------------
  // RED-5：只有 envEvent.metadata.replyChannel（裸快照，无发送实现）
  //        → 走 spawn lark-cli 那条路（deliverAskUserMessage）
  //
  // ⚠️ envEvent.type **不能**是 task.background.ask_user —— 那是「主 agent
  //    转发」那一轮（RED-9 覆盖），问题已由 sub-agent 投递过。
  //    本例是「sub-agent 自己在原始触发事件上下文里问用户」的真实形态：
  //    envEvent = 原始 lark 用户消息（event-source.event.lark-cli），
  //    replyChannel 只以**裸快照**形式存在于 metadata 里。
  // ------------------------------------------------------------------
  it("RED-5: 仅 envEvent.metadata.replyChannel（裸快照）存在时也投递（走 lark-cli 直发）", async () => {
    envContextValue = {
      envEvent: {
        id: "id_lark_user_msg",
        type: "event-source.event.lark-cli",
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_from_env_event",
            messageId: "om_from_env_event",
            profile: "tongzhuli",
          },
        },
      },
    };

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "来自 envEvent 的问题" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);

    // 裸快照没有 sendMarkdown ⇒ 必须走 deliverAskUserMessage（spawn lark-cli）
    expect(deliverAskUserMessageMock).toHaveBeenCalledTimes(1);
    const arg = deliverAskUserMessageMock.mock.calls[0][0] as any;
    expect(arg.chatId).toBe("oc_from_env_event");
    expect(arg.messageId).toBe("om_from_env_event");
    expect(arg.profile).toBe("tongzhuli");
    expect(arg.content).toContain("来自 envEvent 的问题");
  });

  // ------------------------------------------------------------------
  // RED-6：replyChannel 无 chatId → 视为无目标，不投递
  // ------------------------------------------------------------------
  it("RED-6: replyChannel 无 chatId 时不投递（无有效目标）", async () => {
    envContextValue = {
      replyChannel: { type: "lark-cli", messageId: "om_only" },
    };

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "没有 chatId 的问题" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);

    const totalCalls =
      sendMarkdownMock.mock.calls.length +
      replyMock.mock.calls.length +
      sendTextMock.mock.calls.length;
    expect(totalCalls).toBe(0);
  });

  // ------------------------------------------------------------------
  // RED-7：runId / nodeId 从 metadata 正确解析（B1 修复：不再是 'unknown'）
  // ------------------------------------------------------------------
  it("RED-7: metadata 里的 runId / nodeId 被正确解析（错误前缀不再是 unknown）", async () => {
    const ctx = makeToolContext({
      metadata: {
        runId: "default:run_abc123",
        nodeId: "node_xyz",
        sessionId: "oc_xxxxxxxxxxxxxxxx",
      },
    });

    const err = await askUserTool
      .execute({ query: "解析问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    expect((err as AskUserError).runId).toBe("default:run_abc123");
    expect((err as AskUserError).nodeId).toBe("node_xyz");
    expect((err as AskUserError).message).not.toContain("[agent:unknown]");
  });

  // ------------------------------------------------------------------
  // RED-8：metadata 完全缺失时仍抛（向后兼容）
  // ------------------------------------------------------------------
  it("RED-8: metadata 缺失时仍抛 AskUserError（runId/nodeId 回落 unknown，向后兼容）", async () => {
    const ctx = makeToolContext({ metadata: undefined });

    const err = await askUserTool
      .execute({ query: "老路径问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    expect((err as AskUserError).runId).toBe("unknown");
    expect((err as AskUserError).nodeId).toBe("unknown");
  });

  // ------------------------------------------------------------------
  // RED-9：防重复投递 —— 主 agent 处理 ask_user 事件那一轮**不**再投递
  //        （问题已经由 sub-agent 投递过，用户会收到两条）
  // ------------------------------------------------------------------
  it("RED-9: 主 agent 处理 ask_user 事件那一轮不再重复投递", async () => {
    envContextValue = {
      // ★ 生产日志实测：主 agent 那一轮的 envEvent.type 就是 task.background.ask_user
      //   payload.delivered=true = 生产事件必带（delegate-tool.ts:1593
      //   透传子 agent 工具层的投递结果）；投成 ⇒ 本轮跳过。
      envEvent: {
        id: "id_mw24ds83_5myr3wcfr",
        type: "task.background.ask_user",
        payload: { delivered: true },
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_test_chat",
            messageId: "om_test_msg",
            profile: "tongzhuli",
          },
        },
      },
      replyChannel: replyChannelMock,
    };

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "主 agent 转发的问题" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);

    // 一次都不许发（否则用户收到两条）
    const totalCalls =
      sendMarkdownMock.mock.calls.length +
      replyMock.mock.calls.length +
      sendTextMock.mock.calls.length +
      deliverAskUserMessageMock.mock.calls.length;
    expect(totalCalls).toBe(0);
  });

  // ------------------------------------------------------------------
  // RED-11：通道直调挂起 → 15s 硬顶兜住，仍抛 AskUserError
  //          （防 lark-cli 卡死把中断语义拖成 120s 工具超时）
  //
  // 挂起的 promise 本身不可测（要真等 15s），这里测**可观测语义**：
  // withDeliveryTimeout 对「立即失败」的通道返回 null ⇒ delivered=false
  // ⇒ AskUserError.delivered=false ⇒ 兜底层会补投（正是超时后应有的行为）。
  // 「真挂起 15s 后返回 null」由 withDeliveryTimeout 的实现保证
  // （setTimeout + settled flag，单点逻辑，肉眼可审）。
  // ------------------------------------------------------------------
  it("RED-11: 通道投递失败 → delivered=false（超时/失败同路径），AskUserError 可被兜底层补投", async () => {
    envContextValue = { replyChannel: replyChannelMock };
    sendMarkdownMock.mockRejectedValue(new Error("lark-cli hang simulated"));

    const ctx = makeToolContext();

    const err = await askUserTool
      .execute({ query: "挂起通道的问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    // delivered=false ⇒ CLI 兜底层会补投（超时场景用户仍能看到问题）
    expect((err as AskUserError).delivered).toBe(false);
    // 恢复 mock 行为
    sendMarkdownMock.mockResolvedValue(undefined);
  });

  // ------------------------------------------------------------------
  // RED-10：主 agent 在**全新用户请求**里主动问用户 → **仍然要投递**
  //          （envEvent 是 lark 用户消息，不是 ask_user 事件）
  // ------------------------------------------------------------------
  it("RED-10: 主 agent 在全新用户请求里主动问用户时仍然投递", async () => {
    envContextValue = {
      envEvent: {
        id: "id_lark_user_msg",
        type: "event-source.event.lark-cli",
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_test_chat",
            messageId: "om_test_msg",
            profile: "tongzhuli",
          },
        },
      },
      replyChannel: replyChannelMock,
    };

    const ctx = makeToolContext();

    await expect(
      askUserTool.execute({ query: "全新请求里问的问题" }, ctx),
    ).rejects.toBeInstanceOf(AskUserError);

    const totalCalls =
      sendMarkdownMock.mock.calls.length +
      replyMock.mock.calls.length +
      sendTextMock.mock.calls.length;
    expect(totalCalls).toBe(1);
  });

  // ------------------------------------------------------------------
  // RED-12（Task #4983 R4，MAJOR-1）：guard 命中 ⇒ delivered=true
  //
  // 生产链路（traceId 01a1a686…）：
  //   sub-agent 投第 1 条 → 发布 task.background.ask_user →
  //   主 agent 轮（envEvent.type === 'task.background.ask_user'）→
  //   guard 命中跳过工具层投递 ⇒ 旧实现 delivered=false ⇒
  //   CLI 兜底层补投第 2 条 ⇒ 用户收到两条（正是本任务要消灭的）。
  //
  // 修复后语义：guard 命中 = 「本轮不该由我投」= **视为已投递**
  // （delivered=true）⇒ CLI 兜底层不会再投。
  //
  // 端到端断言（不是只断言「没 spawn」）：
  //   1. AskUserError.delivered === true
  //   2. agent-component 编码 → CLI parseAskUserErrorPayload 还原
  //      delivered === true ⇒ 兜底层跳过
  // ------------------------------------------------------------------
  it("RED-12: 主 agent 转发轮（guard 命中）⇒ AskUserError.delivered=true ⇒ CLI 兜底不补投", async () => {
    envContextValue = {
      envEvent: {
        id: "id_mw24ds83_5myr3wcfr",
        type: "task.background.ask_user",
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_test_chat",
            messageId: "om_test_msg",
            profile: "tongzhuli",
          },
        },
      },
      replyChannel: replyChannelMock,
    };

    const ctx = makeToolContext();

    const err = await askUserTool
      .execute({ query: "主 agent 转发的问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    // ★ 核心断言：guard 命中 ⇒ 视为已投递（delivered=true）
    expect((err as AskUserError).delivered).toBe(true);

    // 端到端：agent-component 的编码形态 → CLI parseAskUserErrorPayload
    // 还原后 delivered 仍为 true ⇒ query-executor 的 notifyAskUserIfNeeded
    // 读到 true ⇒ 跳过兜底投递（防双发闭环）。
    const { parseAskUserErrorPayload } = await import(
      "../../../../../cli/src/commands/shared/query-executor"
    );
    const encoded = new Error(
      `__ASK_USER_ERROR__:${JSON.stringify({
        query: (err as AskUserError).query,
        sessionId: (err as AskUserError).sessionId,
        nodeId: (err as AskUserError).nodeId,
        nodeType: (err as AskUserError).nodeType,
        agentSessionId: (err as AskUserError).agentSessionId,
        delivered: (err as AskUserError).delivered === true,
      })}`,
    );
    const parsed = parseAskUserErrorPayload(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.delivered).toBe(true);
    // MINOR-3（R4 review）：只 import 纯函数 parseAskUserErrorPayload。
    // vi.mock 已经在该文件顶部把 query-executor 的副作用隔断了？
    // 没有 —— cli 模块较重。这里仅用其导出的纯解析函数，
    // 不做任何 IO；目录层级变化由 bun workspace 解析兜底。
  });

  // ------------------------------------------------------------------
  // RED-13（Task #4983 R5，DS R4 review MAJOR-1）：guard 命中时
  //   **读事件 payload.delivered**，不能无条件置 true。
  //
  // 场景：sub-agent 那一轮工具层投递**失败**（通道挂起/15s 超时，
  // RED-11 已建模）→ BackgroundTaskManager 把
  // delivered: false 写进 task.background.ask_user 事件 payload
  // （delegate-tool.ts:1593，权威信号）。
  // 主 agent 转发轮 guard 命中时：
  //   - payload.delivered === true（子代理已投成）→ 跳过（delivered=true）
  //   - payload.delivered === false / 缺失（投递失败或旧事件）
  //       → **不吞**：本轮仍然尝试投递（有 replyChannel 就直投/
  //         spawn），投不成则 delivered=false ⇒ CLI 兜底层补投
  //       ⇒ 用户至少收到一条，绝不静默。
  // ------------------------------------------------------------------
  it("RED-13: guard 命中但 payload.delivered=false ⇒ 本轮仍投递，失败则 delivered=false（CLI 兜底可补投）", async () => {
    envContextValue = {
      envEvent: {
        id: "id_mw24ds83_5myr3wcfr",
        type: "task.background.ask_user",
        payload: { delivered: false }, // 子 agent 那一轮投递失败
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_test_chat",
            messageId: "om_test_msg",
            profile: "tongzhuli",
          },
        },
      },
      replyChannel: replyChannelMock,
    };

    const ctx = makeToolContext();

    const err = await askUserTool
      .execute({ query: "投递失败后转发的问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    // ★ 本轮确实尝试了投递（不吞）：工具层直调一次
    expect(sendMarkdownMock).toHaveBeenCalledTimes(1);
    // 回投成功 ⇒ delivered=true ⇒ 用户看到（本轮投的），CLI 兜底不补投
    // （无双发：CLI 只在 delivered=false 时补投）
    expect((err as AskUserError).delivered).toBe(true);
  });

  // ------------------------------------------------------------------
  // RED-13c：guard 命中 + payload.delivered=false + 本轮回投**也失败**
  //   ⇒ delivered=false ⇒ CLI 兜底层补投（最后一张网，绝不静默）
  // ------------------------------------------------------------------
  it("RED-13c: guard 命中 + payload.delivered=false + 回投失败 ⇒ delivered=false（CLI 可补投）", async () => {
    envContextValue = {
      envEvent: {
        id: "id_mw24ds83_5myr3wcfr",
        type: "task.background.ask_user",
        payload: { delivered: false }, // 子 agent 那一轮投递失败
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_test_chat",
            messageId: "om_test_msg",
            profile: "tongzhuli",
          },
        },
      },
      replyChannel: replyChannelMock,
    };
    sendMarkdownMock.mockRejectedValue(new Error("lark-cli exit 1"));

    const ctx = makeToolContext();

    const err = await askUserTool
      .execute({ query: "两轮都失败的问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    // 回投失败 ⇒ delivered=false ⇒ CLI 兜底层会补投
    expect((err as AskUserError).delivered).toBe(false);
    // 恢复 mock
    sendMarkdownMock.mockResolvedValue(undefined);
  });

  it("RED-13b: guard 命中且 payload.delivered=true ⇒ 跳过投递且 delivered=true", async () => {
    envContextValue = {
      envEvent: {
        id: "id_x",
        type: "task.background.ask_user",
        payload: { delivered: true }, // 子 agent 已投成
        metadata: { replyChannel: { chatId: "oc_x" } },
      },
      replyChannel: replyChannelMock,
    };

    const ctx = makeToolContext();

    const err = await askUserTool
      .execute({ query: "投递成功后转发的问题" }, ctx)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    expect((err as AskUserError).delivered).toBe(true);
    // 不重复投
    const totalCalls =
      sendMarkdownMock.mock.calls.length +
      replyMock.mock.calls.length +
      sendTextMock.mock.calls.length;
    expect(totalCalls).toBe(0);
  });
});