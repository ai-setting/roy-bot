/**
 * @fileoverview Task #4568 — `cli-command` EventSource handler
 *
 * ## 为什么需要它
 *
 * 飞书路径的 notify 链路有 5 个环节，CLI 路径**全缺**（设计文档 §4 断点 A~F）：
 *
 * | 环节 | 飞书 | CLI（改造前） |
 * |---|---|---|
 * | 入口产 triggerEventId | `larkCliHandler.emitTriggerEvent` | ❌ 无 |
 * | 落库 esType | `lark-cli` | ❌ 无 |
 * | EnvContext.replyChannel | `{chatId: oc_xxx}` | ❌ 无 |
 * | notify event metadata | `{triggerEventId, replyChannel}` | ❌ 双缺 |
 * | v2 notify prompt | `buildNotifyHandlePrompt` 命中 | ❌ gate 不过 |
 *
 * 本 handler 补上"CLI 也是一个 EventSource"的一半（生产端 + prompt 端）；
 * 另一半（入口接线 + sink 分派）在 cli 包里。
 *
 * ## 三条硬契约（都有测试锁）
 *
 * 1. **落库 esType 必须是 `cli-command`**，不能抄 `lark-cli`。
 *    `getHandlerForEsType(esType)` 是 v2 prompt 的唯一分派 key。写成
 *    `lark-cli` 会让 agent 收到"用 lark-cli 发到 oc_xxx"的 prompt ——
 *    而 CLI 路径根本没有 oc_xxx。见 `cli-command-handler.test.ts` ★ 核心。
 *
 * 2. **`buildCliReplyChannel().chatId` 永不为空**，格式 `cli:<sessionId>`。
 *    `_captureReplyChannelSnapshot()`（delegate-tool.ts:2676）要求
 *    `chatId || messageId` 至少一个非空，否则**整份快照被丢弃** →
 *    notify event 无回复目标 → 规则通知静默丢失（探针 D 实测）。
 *
 * 3. **`params.sink === 'stdout'`**。
 *    `EventHandler` 据此选择「console.log」还是「spawn lark-cli」。
 *    ⚠️ 注意 `targetFromEventMetadata()` 会读 `params.sink`
 *    （Task #4568 的配套修复，见 `telemetry-notice.ts`）—— 它原本丢弃整个 params。
 *
 * ## 与 lark handler 的对照
 *
 * | 能力 | larkCliHandler | cliCommandHandler |
 * |---|---|---|
 * | `emitTriggerEvent` | 落 `lark-cli` | 落 `cli-command` |
 * | `extractReplyContext` | chatId/messageId/profile | chatId=`cli:<sid>` |
 * | `buildNotifyHandlePrompt` | 四段式（含 lark-cli 命令） | 四段式（**明确禁止** lark-cli） |
 * | `createInstance` | 真起 `lark-cli event consume` 子进程 | 哑实例（CLI 不消费外部流） |
 */

import { createLogger } from "../log-trace/logger";
import type {
  EventSourceConfig,
  EventSourceHandler,
  EventSourceInstance,
  BuildNotifyHandlePromptInput,
  BuildNotifyHandlePromptResult,
  ReplyContext,
} from "./types";
import type { EventStore, PersistedEvent, TriggerEventInput } from "./event-store";

const logger = createLogger("cli-command:event-source");

/** CLI 事件源类型名（用户指定，默认启用） */
export const CLI_COMMAND_ES_TYPE = "cli-command";

/**
 * CLI 回复目标的 chatId 前缀：`cli:<sessionId>`。
 *
 * 为什么需要前缀：
 *   - 让 `extractChatId()` / `laneKeyFor()` 能把 CLI 通知放进**按 session
 *     隔离的 lane**（不与真实 `oc_xxx` 群撞车）；
 *   - 让 `resolveSessionForItemUncached()` 能识别"这不是真 chat，别去
 *     `ensureChatSession()` 新建一个 `cli:xxx` 假 session"。
 */
export const CLI_SESSION_CHAT_ID_PREFIX = "cli:";

/** CLI 通知的默认投递方式（用户 2026-10-27 拍板 ①：用 stdout） */
export type CliNoticeSink = "stdout";

/** `buildCliReplyChannel()` 的返回形状（与 `ReplyChannel` 结构兼容） */
export interface CliReplyChannel {
  type: string;
  chatId: string;
  params: { sink: CliNoticeSink; cliSessionId: string };
}

/**
 * 构造 CLI 的「可回复 channel」。
 *
 * @param params.sessionId 当前 CLI session（空值降级成 `default`，绝不返回空 chatId）
 */
export function buildCliReplyChannel(params: {
  sessionId: string;
}): CliReplyChannel {
  // 空 sessionId 降级成 "default"：宁可 chatId 是个占位符，
  // 也不能返回空串 —— 空串会让 `_captureReplyChannelSnapshot()` 整份丢弃。
  const sid = params.sessionId?.trim() ? params.sessionId.trim() : "default";
  return {
    type: CLI_COMMAND_ES_TYPE,
    chatId: `${CLI_SESSION_CHAT_ID_PREFIX}${sid}`,
    params: { sink: "stdout", cliSessionId: sid },
  };
}

/**
 * 从 `cli:<sid>` 反解出 session id。非 CLI 前缀 → undefined。
 *
 * EventHandler 用它判断"要不要走 ensureChatSession()"。
 */
export function parseCliSessionChatId(chatId: string | undefined): string | undefined {
  if (!chatId || !chatId.startsWith(CLI_SESSION_CHAT_ID_PREFIX)) return undefined;
  const sid = chatId.slice(CLI_SESSION_CHAT_ID_PREFIX.length);
  return sid.length > 0 ? sid : undefined;
}

// ============================================================================
// notify prompt 渲染（四段式，与 lark prompt 结构对齐但内容相反）
// ============================================================================

/**
 * notify 事件类型 → （标题句, 是否 actionable）
 *
 * @param taskLabel 已格式化好的任务标签（`Task #4568` / `后台任务 dyvi6vhxx`
 *                  / `后台任务`）—— 这里**不再拼 `Task #`**，避免出现 `Task #Task #1`。
 */
function describeNotifyEvent(
  type: string,
  taskLabel: string,
  desc: string,
): { headline: string; actionable: boolean } {
  const actionable = new Set([
    "task.background.completed",
    "task.background.failed",
    "task.background.timeout",
    "task.background.stopped",
  ]).has(type);

  switch (type) {
    case "task.background.completed":
      return { headline: `Sub-agent 完成了 ${taskLabel}「${desc}」。`, actionable };
    case "task.background.failed":
      return { headline: `Sub-agent 执行 ${taskLabel}「${desc}」失败。`, actionable };
    case "task.background.timeout":
      return { headline: `Sub-agent 执行 ${taskLabel}「${desc}」**超时**（未跑完）。`, actionable };
    case "task.background.stopped":
      return { headline: `Sub-agent 已停止 ${taskLabel}「${desc}」。`, actionable };
    case "task.background.ask_user":
      return { headline: `Sub-agent 在 ${taskLabel}「${desc}」中请求用户输入。`, actionable };
    case "task.background.started":
      return { headline: `Sub-agent 已启动 ${taskLabel}「${desc}」（后台运行中）。`, actionable };
    case "task.background.progress":
      return { headline: `Sub-agent 仍在执行 ${taskLabel}「${desc}」（进行中）。`, actionable };
    default:
      return { headline: `Sub-agent 更新了 ${taskLabel}「${desc}」。`, actionable };
  }
}

/**
 * 渲染「系统回执」小节 —— 告诉 agent 终端用户**已经**看到了什么。
 *
 * 三种状态必须分开（与 lark 版同一套语义，文案针对终端场景重写）：
 *   - 已送达 → 只讲增量，别把回执原文再讲一遍
 *   - 未送达 → 用户还不知道，必须由 agent 讲清楚，且不许假装已通知
 *   - 不在白名单 → 讲完整
 */
function renderRuleNoticeSectionForCli(
  ruleNotice: BuildNotifyHandlePromptInput["ruleNotice"],
  headline: string,
): string {
  if (!ruleNotice || !ruleNotice.attempted) {
    return (
      `（本事件不直发规则回执）\n` +
      `→ 你的回复要把结果讲**完整**（终端用户只能从你这条输出知道结论）。`
    );
  }

  if (ruleNotice.delivered) {
    const when = ruleNotice.sentAt
      ? new Date(ruleNotice.sentAt).toLocaleTimeString("zh-CN", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const sent = ruleNotice.text
      ? `：「${ruleNotice.text.replace(/\s*\n+\s*/g, " ")}」`
      : "";
    return (
      `✅ 系统已于 ${when || "刚才"} 向终端输出过下面这条${sent}\n` +
      `→ 你的回复**只发增量**：不要再重复「任务已结束」这类回执原文，` +
      `直接讲结论/交付 + 下一步选项。`
    );
  }

  return (
    `❌ **回执未送达**（原因：${ruleNotice.error ?? "unknown"}）\n` +
    `→ 用户目前**还不知道**「${headline}」这件事，必须由你在回复里讲清楚，` +
    `并且不要假装系统已经通知过。`
  );
}

/**
 * CLI Command Handler（内置 EventSource）。
 *
 * ⚠️ 它**不消费**任何外部流（不像 lark-cli 要 spawn `event consume`）：
 * CLI 的"事件"就是用户敲下的每一行 query，由 cli 包的
 * `emitCliTriggerEvent()` 主动落库。
 */
export const cliCommandHandler: EventSourceHandler = {
  type: CLI_COMMAND_ES_TYPE,

  /** CLI 是隐式事件源：无配置项，永远合法。 */
  validateConfig(_config: EventSourceConfig): string[] {
    return [];
  },

  /**
   * 哑实例：CLI 没有"事件流"可 start / stop。
   *
   * 保留实现是为了满足 `EventSourceHandler` 接口契约 —— 若将来有人
   * `eventsource add --type cli-command`，注册流程不会炸。
   */
  createInstance(config: EventSourceConfig): EventSourceInstance {
    return {
      config,
      start: async () => {},
      stop: async () => {},
      isRunning: () => false,
      getStatus: () => ({
        id: config.id,
        type: CLI_COMMAND_ES_TYPE,
        running: false,
      }),
    } as unknown as EventSourceInstance;
  },

  // ==========================================================================
  // ESPlugin v2 四方法
  // ==========================================================================

  /**
   * 落库 trigger event，返回 `evt_xxx`。
   *
   * ★ esType 固定 `cli-command`（不是 lark-cli）—— v2 prompt 分派靠它。
   */
  async emitTriggerEvent(
    payload: TriggerEventInput,
    store: EventStore,
  ): Promise<string> {
    const eventId = await store.insertTriggerEvent(payload, CLI_COMMAND_ES_TYPE);
    logger.info(`[cliCommandHandler] emitTriggerEvent: id=${eventId}`, {
      sessionId: (payload.metadata as Record<string, unknown>)?.sessionId,
      cwd: (payload.metadata as Record<string, unknown>)?.cwd,
    });
    return eventId;
  },

  /**
   * 从 trigger event 提取回复上下文。
   *
   * CLI 没有 messageId / senderOpenId 的业务语义，但接口要求这两个字段是
   * string（非 optional），所以填 `""` —— **不能用 undefined**，否则
   * `buildNotifyChannelInfo()` 的 `ctx?.chatId || meta.chatId` 逻辑会走偏。
   */
  extractReplyContext(event: PersistedEvent, profile?: string): ReplyContext {
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    return {
      esType: CLI_COMMAND_ES_TYPE,
      chatId: typeof meta.chatId === "string" ? meta.chatId : "",
      messageId: typeof meta.messageId === "string" ? meta.messageId : "",
      senderOpenId: typeof meta.senderId === "string" ? meta.senderId : "",
      profile:
        profile ?? (typeof meta.profile === "string" ? meta.profile : undefined),
    };
  },

  /**
   * 构造主 agent 处理 notify event 的 prompt（四段式）。
   *
   * ★ 与 lark 版**内容相反**的关键一句：
   *   lark → 「用 `lark-cli im +messages-send --chat-id oc_xxx --as bot` 发出去」
   *   cli  → 「**没有 IM 通道，不要调用 lark-cli**，把结论输出到 stdout」
   *
   * 为什么必须写得这么硬：飞书路径的 prompt 在训练/上下文里已经形成惯性，
   * agent 很容易照抄"发飞书"而编一个 chatId。测试锁定了「禁止/不要」+
   * 「stdout/终端」两组词。
   */
  buildNotifyHandlePrompt(
    input: BuildNotifyHandlePromptInput,
  ): BuildNotifyHandlePromptResult {
    const { notifyEvent, triggerEvent, ruleNotice, subAgentResult, channel } = input;

    // ★ 注意形状：`BuildNotifyHandlePromptInput.notifyEvent` 是 **CLI EventHandler
    //   归一化后的扁平结构**（`{type, taskId, description, result, error, subSessionId}`），
    //   不是 BackgroundTaskManager 原始的 `payload` 信封。读 `notifyEvent.payload.*`
    //   会永远拿到 `Task #?` / `(无结果)` —— TDD 实测抓到的真 bug（见测试
    //   `completed → agent 被调用，且 prompt 是 CLI 专属`）。
    const triggerMeta = (triggerEvent.metadata ?? {}) as Record<string, unknown>;
    // 兼容：真实生产形状是**扁平**的；直接调 handler 的旧调用方可能传
    // BackgroundTaskManager 的 `payload` 信封。两种都读，扁平优先。
    const legacyPayload = ((notifyEvent as { payload?: Record<string, unknown> })
      .payload ?? {}) as Record<string, unknown>;

    // ★ taskId 三级兜底（真机验证发现 `Task #?` 很突兀）：
    //   1. associatedTaskId（sub-agent 自己 task_create 过才有）
    //   2. backgroundTaskId（形如 `process_1793101794979_dyvi6vhxx`，取短片段）
    //   3. `"后台任务"`（连 backgroundTaskId 都没有时，不显示 `#?`）
    const rawTaskId =
      notifyEvent.taskId ??
      (legacyPayload.associatedTaskId as number | undefined);
    const bgId =
      notifyEvent.backgroundTaskId ??
      (legacyPayload.backgroundTaskId as string | undefined);
    // 缩短 `process_1793101794979_dyvi6vhxx` → `dyvi6vhxx`（尾部随机段最有辨识度）
    const shortBgId = bgId ? bgId.split("_").pop() : undefined;
    const taskLabel: string =
      rawTaskId !== undefined
        ? `Task #${rawTaskId}`
        : shortBgId
          ? `后台任务 ${shortBgId}`
          : "后台任务";
    const desc =
      notifyEvent.description ??
      (legacyPayload.description as string | undefined) ??
      "后台任务";
    // 优先用调用方算好的 subAgentResult.summary（与 lark handler 同源），
    // 再回落到 result / error（直接调 handler 的测试 / 旧链路）。
    const result =
      (subAgentResult?.summary && subAgentResult.summary.trim()
        ? subAgentResult.summary
        : undefined) ??
      notifyEvent.result ??
      notifyEvent.error ??
      (legacyPayload.result as string | undefined) ??
      (legacyPayload.error as string | undefined) ??
      "(无结果)";
    const cwd = typeof triggerMeta.cwd === "string" ? triggerMeta.cwd : "(未知)";
    const cliSession =
      typeof triggerMeta.sessionId === "string" ? triggerMeta.sessionId : "(未知)";
    const query =
      typeof triggerEvent.text === "string" && triggerEvent.text
        ? triggerEvent.text
        : "(未记录)";

    const { headline } = describeNotifyEvent(notifyEvent.type, taskLabel, desc);
    // channel 目前只用来自证"确实是 cli-command"（若调用方传的是别的渠道，
    // 说明有人误把 CLI prompt 套到 IM 事件上 —— 记进 prompt 便于排查）。
    const channelLabel = channel?.esType ?? CLI_COMMAND_ES_TYPE;

    return {
      promptText: [
        `# 后台任务通知（渠道：CLI 命令行）`,
        ``,
        `## 触发渠道`,
        `- 渠道类型: \`${channelLabel}\`（用户在**终端**直接输入 query 触发，不是飞书消息）`,
        `- 工作目录: \`${cwd}\``,
        `- CLI session: \`${cliSession}\``,
        `- 用户原始 query: ${query.length > 400 ? query.slice(0, 400) + "…" : query}`,
        `- **回复方式: 直接输出到 stdout（终端）**。`,
        ``,
        `⚠️ **本渠道没有 IM 通道，不要调用 lark-cli**。`,
        `   不要尝试 \`lark-cli im +messages-send\` / \`+messages-reply\`，`,
        `   不要编造 chatId（\`cli:*\` 不是真实飞书会话，发过去必然失败），`,
        `   也不要调用任何飞书相关工具。用户就在终端前等你的文字输出。`,
        ``,
        `## 系统回执`,
        renderRuleNoticeSectionForCli(ruleNotice, headline),
        ``,
        `## 事件`,
        headline,
        ``,
        `## Sub-agent 输出`,
        result,
        ``,
        `## 你要做什么`,
        `1. 把上面 Sub-agent 的结论整理成**给终端用户直接读的一段话**。`,
        `2. **直接输出这段文字**（它就是用户看到的内容），不要包 JSON、不要写文件。`,
        `3. 若「系统回执」显示已送达，只讲**增量**；未送达则把结论讲完整。`,
      ].join("\n"),
    };
  },
};
