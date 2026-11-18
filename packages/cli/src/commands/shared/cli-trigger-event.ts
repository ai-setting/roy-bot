/**
 * @fileoverview Task #4568 — CLI 入口 emit trigger event（把 CLI 变成 EventSource）
 *
 * ## 解决的断点（设计文档 §4 断点 A / B / C）
 *
 * 改造前 CLI 路径：
 * ```
 * 用户输入 → onExecute(message, traceId, agentContext)
 *          → agentContext 只有 model / systemPrompt / defaultAgentName
 *          → EnvContext.envEvent = undefined  ⇒ 断点 A
 *          → EnvContext.replyChannel = undefined ⇒ 断点 B
 *          → delegate_task 里 deriveTriggerEventIdFromEnvContext() = undefined ⇒ 断点 C
 *          → 后台 notify event 无 triggerEventId / 无 replyChannel
 *          → resolveNoticeTarget() 三级全 miss → 规则通知静默丢弃
 * ```
 *
 * 改造后：
 * ```
 * 用户输入 → emitCliTriggerEvent()  ⇒ triggerEventId + replyChannel
 *          → toCliEnvEvent() 造出 EnvEvent（含 metadata.triggerEventId + replyChannel）
 *          → 注入 agentContext.envEvent
 *          → 下游 EnvContext 全链路拿到 ⇒ 断点 A/B/C 同时修复
 * ```
 *
 * ## 三条硬契约（都有测试锁）
 *
 * 1. **永不抛** —— 落库失败返回 `null`。CLI 主流程（用户提问 → 得到回答）
 *    绝不能因为"可观测性"挂掉。这是与 `emitTriggerEvent` 内部错误的分界。
 * 2. `replyChannel.chatId` 永不为空（`cli:<sessionId>`），否则
 *    `_captureReplyChannelSnapshot()` 整份丢弃。
 * 3. `toCliEnvEvent()` 产出的形状必须被 `deriveTriggerEventIdFromEnvContext()`
 *    识别 —— 它读 `envEvent.metadata.triggerEventId`（`delegate-tool.ts:2628`）。
 *
 * ## 为什么不 emit 到 `env.pushEnvEvent`
 *
 * CLI 的 query 是**同步进入 agent** 的（不像 lark 消息要先入 lane），
 * 往事件总线 push 一条 `event-source.event.cli` 会让 EventHandler 再跑一轮
 * agent（**自己触发自己**，无限套娃）。所以我们只做"落库 + 注入 EnvContext"。
 */

import {
  cliCommandHandler,
  buildCliReplyChannel,
  CLI_SESSION_CHAT_ID_PREFIX,
  type CliReplyChannel,
} from "@ai-setting/roy-bot-core/env/event-source/cli-command-handler";
import { getSharedEventStore } from "@ai-setting/roy-bot-core/env/event-source/event-store";

import { getOrCreateEventStore, createDefaultEventStoreDbPath } from "./event-handler-wiring";

/** CLI triggerEventId 回显前缀（用户 2026-10-27 拍板 ④） */
export const CLI_TRIGGER_ECHO_PREFIX = "[Trigger]";

/** 落库的 query 文本上限（防止单行撑爆 event_store） */
const MAX_TEXT_CHARS = 4000;

/** `rawEvent` 里保存的 query 摘要上限（rawEvent 只是留档，不必全文） */
const MAX_RAW_QUERY_CHARS = 2000;

export interface EmitCliTriggerOptions {
  /**
   * 入口命令名。
   *
   * - `run`         = REPL（常驻）
   * - `interactive` = Ink TUI（常驻）
   * - `chat`        = 一次性命令（Task #4576 接入 EventHandler 后也需要 trigger
   *                   event，否则 delegate 的 replyChannel 快照为 undefined，
   *                   通知目标解析三级全 miss ⇒ 通知静默丢弃）
   *
   * 只影响落库的 `rawEvent.command`（人肉排查用的留档字段），不影响语义。
   */
  command: "run" | "interactive" | "chat";
  /** 用户原始 query */
  query: string;
  /** 当前 CLI session id */
  sessionId: string;
  /** 工作目录（默认 `process.cwd()`） */
  cwd?: string;
  /** 原始 argv（默认 `process.argv.slice(2)`） */
  argv?: string[];
  /**
   * EventStore 路径（默认 `~/.roy-bot/event-store.db`，与 lark 共用同一个库）。
   * 测试传 tmpDir。
   */
  dbPath?: string;
}

export interface EmitCliTriggerResult {
  triggerEventId: string;
  replyChannel: CliReplyChannel;
}

/**
 * 取得 CLI 用的 EventStore。
 *
 * 默认走 `getOrCreateEventStore()` 单例（与 lark 路径同一个 db、同一个实例），
 * 这样 `delegate_task` 的 `getSharedEventStore()` 校验分支能用同一个 store
 * 反查到我们刚写的 trigger event。
 *
 * ⚠️ 传了 `dbPath` 时也走同一个单例工厂 —— 它按路径缓存，不会重复打开。
 */
function resolveStore(dbPath?: string) {
  return dbPath
    ? getOrCreateEventStore(dbPath)
    : getOrCreateEventStore(createDefaultEventStoreDbPath());
}

/**
 * 把一个 CLI query 落成 trigger event，返回 `triggerEventId` + `replyChannel`。
 *
 * @returns 落库成功 → `{ triggerEventId, replyChannel }`；任何失败 → `null`（不抛）
 */
export async function emitCliTriggerEvent(
  opts: EmitCliTriggerOptions,
): Promise<EmitCliTriggerResult | null> {
  try {
    const replyChannel = buildCliReplyChannel({ sessionId: opts.sessionId });
    const store = resolveStore(opts.dbPath);

    const cwd = opts.cwd ?? process.cwd();
    const argv = opts.argv ?? process.argv.slice(2);

    const triggerEventId = await cliCommandHandler.emitTriggerEvent!(
      {
        // 没有真实 IM sender：用「cli:<user>:<pid>」表达"本机这个进程"
        senderId: `cli:${process.env.USER ?? process.env.USERNAME ?? "unknown"}:${process.pid}`,
        // text 截断：event_store.text 只用于人肉排查，不需要全文
        text: opts.query.slice(0, MAX_TEXT_CHARS),
        metadata: {
          eventType: "cli.query",
          sessionId: opts.sessionId,
          cwd,
          pid: process.pid,
          // ★ 这三个字段让 `targetFromTriggerEvent()` 反查也能命中
          chatId: replyChannel.chatId,
          replyChannel,
          sink: replyChannel.params.sink,
        },
        rawEvent: {
          command: opts.command,
          argv,
          cwd,
          query: opts.query.slice(0, MAX_RAW_QUERY_CHARS),
          sessionId: opts.sessionId,
          pid: process.pid,
        },
      },
      store,
    );

    return { triggerEventId, replyChannel };
  } catch (err) {
    // ★ 永不抛：CLI 主流程优先于可观测性
    console.error(
      `[cli-trigger-event] emit failed (ignored): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * 把 emit 结果包成 `EnvEvent`，供注入 `agentContext.envEvent`。
 *
 * 形状刻意与 `LarkCliInstance.handleEvent` 造的 event 对齐（`metadata` 里
 * 同时有 `triggerEventId` / `replyChannel` / `source` / `sourceType`），
 * 这样下游（`buildRunEnvContext` / `deriveTriggerEventIdFromEnvContext` /
 * `captureReplyChannelSnapshot`）**零改动**就能工作。
 *
 * ⚠️ 不 push 到事件总线（见文件头注释：会自己触发自己）。
 */
export function toCliEnvEvent(result: EmitCliTriggerResult, query: string) {
  return {
    id: result.triggerEventId,
    type: "event-source.event.cli",
    timestamp: Date.now(),
    metadata: {
      source: "cli-command",
      sourceId: "cli",
      sourceType: "cli-command",
      triggerEventId: result.triggerEventId,
      replyChannel: result.replyChannel,
      // 冗余一份 chatId：部分老代码路径直接读 metadata.chatId
      chatId: result.replyChannel.chatId,
    },
    payload: { query },
  };
}

/**
 * 生成 `[Trigger] evt_xxx` 回显行。
 *
 * @returns 需要打印时返回字符串；quiet / 空 ID → `null`（调用方据此跳过打印）
 *
 * 为什么放在这里而不是各入口自己拼：两个入口（REPL / TUI）都要一致的格式，
 * 且测试可以只测纯函数而不用起 REPL。
 */
export function formatTriggerEcho(
  triggerEventId: string | null | undefined,
  opts: { quiet: boolean },
): string | null {
  if (opts.quiet) return null;
  if (!triggerEventId) return null;
  return `${CLI_TRIGGER_ECHO_PREFIX} ${triggerEventId}`;
}

export { CLI_SESSION_CHAT_ID_PREFIX };

/**
 * 把 `[Trigger] evt_xxx` 输出到终端。
 *
 * ## 为什么需要这个包装（真机验证发现的 bug）
 *
 * 首版直接在入口 `console.log(echo)`，实测在 **Ink 模式**下：
 *   `[Trigger] evt_...` 被打在了 `/exit`（退出欢迎语）**之后** ——
 *   Ink 独占终端做整帧重绘，运行期的裸 `console.log` 会被排队/错序。
 *
 * 处理策略：
 *   - TTY（Ink 接管终端）→ 写 **stderr**：不进 Ink 的帧缓冲，不破坏布局，
 *     且 `2>/dev/null` 可静默，`> file` 不污染 stdout 的答案正文。
 *   - 非 TTY（管道 / 重定向 / CI）→ 写 **stdout**：便于 `| grep`。
 *
 * 与用户拍板 ④ 一致：只在 `--no-quiet` 时有这一行，默认（quiet）完全静默。
 */
export function writeTriggerEcho(line: string): void {
  const isTTY = process.stdout.isTTY === true;
  if (isTTY) {
    process.stderr.write(`\x1b[2m${line}\x1b[0m\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}
