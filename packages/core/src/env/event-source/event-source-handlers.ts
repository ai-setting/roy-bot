/**
 * 内置 EventSourceHandler 实现
 * 
 * 提供 lark-cli 事件源类型的 Handler 实现
 * 支持通过 handleRule.plugins 加载外部 Plugin
 */

import { ChildProcess, spawn, exec as execSync } from "child_process";
import { promisify } from "node:util";
const execAsync = promisify(execSync);
import type {
  EventSourceConfig,
  EventSourceHandler,
  EventSourceInstance,
  EventSourceStatus,
  EventSourceEvent,
  EventSourceEventHandler,
  EventMetadata,
  ReplyChannel,
  RecommendedAction,
  TriggerEventInput,
  PersistedEvent,
  ReplyContext,
  ReplyMessageInput,
  ReplyMessageResult,
  BuildNotifyHandlePromptInput,
  BuildNotifyHandlePromptResult,
  RuleNoticeInfo,
  LarkCliRunner,
  EventStore,
} from "./types";
import { defaultLarkCliRunner } from "./types";
import { getSharedEventStore } from "./event-store";
import { globalHookManager } from "../hook/global-hook-manager";
import { TracedAs, getTracerProvider, wrapFunction, type SpanContext } from "../log-trace";
import {
  createEnvContext,
  runWithEnvContext,
  normalizeParentTaskId,
  normalizeToolEnv,
  type ReplyChannel as EnvReplyChannel,
} from "../context";
// ★ Task #5193：插件工厂表迁到 es-plugins.ts（wecom handler 也要用）
import { BUILT_IN_PLUGIN_FACTORIES } from "./es-plugins";
import {
  handleCardAction,
  createGroupChatViaLarkCli,
  deleteGroupChatViaLarkCli,
} from "../task/plugins/lark-card-action-handler";
import {
  LarkCardPatchNotifier,
  getSharedLarkCardNotifier,
} from "../task/plugins/lark-card-patch-notifier";
// ★ Task #5364：持久层（按 taskId 反查 sessionId 用）
import { getSharedLarkCardStateStore } from "../task/plugins/lark-card-state-store";
// ★ Task #5360：sub-session 活性 probe（飞书/企微共用同一实现）
// ★ Task #5364 返工（BLOCKER-1）：`createSessionActivityProbe` 真注入
import {
  createActivityProbe,
  createSessionActivityProbe,
  toActivityMessage,
  mapBgTaskStatusToSessionLifecycle,
  extractToolCallsFromMessages,
  RECENT_MESSAGE_LIMIT,
} from "../task/plugins/sub-session-activity";
import { timerHandler } from "./timer-handler";
import { bountyIMHandler } from "./bounty-im-handler";
import { bountyCliHandler } from "./bounty-cli-handler";
// ★ Task #4568：CLI 命令行事件源（隐式，不消费外部流）
import { cliCommandHandler } from "./cli-command-handler";
// ★ Task #5142：企业微信 EventSource（官方 CLI `wecom-cli`）
import { wecomCliHandler } from "./wecom-cli-handler";
import { isCommandMessage, handleCommandMessage as dispatchCommand, getGlobalCommandRegistry } from "./command-registry";
import { renderTextCard } from "./command-cards";
import { isCommandCardAction, handleCommandCardAction } from "./command-card-action";
import { createLogger } from "../log-trace/logger";
import { normalizeLarkAtMentions } from "../lark-mention-utils";
// Task #4418: event-source 自身的处理失败也要回触发方（不能沉默）
import { notifyReactFailure } from "../error-reply";

const logger = createLogger("lark-cli:event-source");

/**
 * ★ Task #4339：等待 consume 子进程打出 `[event] ready` 的最长时间。
 *
 * 旧实现是盲等固定 1000ms（`setTimeout`），既不能确认真的 ready，也无法暴露
 * "配置错误 → 立即 exit 2"。改为监听 stderr 的 ready marker + 本超时兜底。
 */
const CHILD_READY_TIMEOUT_MS = 5000;

/**
 * ★ Task #4339：stop() 等待子进程优雅退出的最长时间。
 * 超过后 SIGKILL。
 */
const GRACEFUL_STOP_TIMEOUT_MS = 5000;

/**
 * 卡片交互事件的 EventKey（lark-cli 的 key 与 payload.type 同名）。
 */
const CARD_ACTION_EVENT_TYPE = "card.action.trigger";

/**
 * 子进程是否仍然存活（`killed` 只表示"SIGTERM 已发出"，不代表进程已死）。
 */
function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * 是否启用 plugin debug 日志（与 PerTaskGroupChatPlugin 一致的环境变量）
 */
function isPluginDebugEnabled(): boolean {
  return process.env.ROY_TASK_NOTIFY_DEBUG === "1" || process.env.ROY_TRACE_DEBUG === "1";
}

// =============================================================================
// 内置 Plugin 工厂注册表
// =============================================================================
// ★ Task #5193：工厂表已迁到 es-plugins.ts（wecom-cli-handler 也要用）。
// 凡是 workspace 内部的 plugin，统一在 es-plugins.ts 的
// BUILT_IN_PLUGIN_FACTORIES 登记；本文件只 re-export 引用。
// =============================================================================



// =============================================================================
// 工具函数
// =============================================================================

/**
 * 生成符合 OTel 格式的 traceId（32 字符 16 进制）
 */
function generateTraceId(): string {
  const chars = "0123456789abcdef";
  let traceId = "";
  for (let i = 0; i < 32; i++) {
    traceId += chars[Math.floor(Math.random() * chars.length)];
  }
  return traceId;
}

/**
 * 事件类型匹配（支持通配符）
 */
function matchEventType(eventType: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (eventType.startsWith(prefix + ".") || eventType === prefix) return true;
    }
    if (eventType === pattern) return true;
  }
  return false;
}

/**
 * 格式化事件消息
 */
function formatEventMessage(sourceType: string, rawEvent: unknown, eventType?: string): string {
  const event = rawEvent as Record<string, unknown>;
  
  const larkEvent = event as Record<string, unknown>;
  const larkInnerEvent = larkEvent.event as Record<string, unknown> | undefined;
  const larkMessage = (larkInnerEvent?.message || larkEvent.message) as Record<string, unknown> | undefined;
  const larkSender = (larkInnerEvent?.sender || larkEvent.sender) as Record<string, unknown> | undefined;
  const senderId = larkSender?.sender_id as Record<string, unknown> | undefined;
  
  if (larkMessage) {
    const openId = senderId?.open_id as string || 
                   senderId?.user_id as string ||
                   senderId?.email as string ||
                   senderId?.union_id as string ||
                   "未知用户";
    
    let content = "无消息内容";
    if (larkMessage.content) {
      try {
        const contentObj = JSON.parse(larkMessage.content as string);
        content = contentObj.text || contentObj.content || larkMessage.content as string;
      } catch {
        content = larkMessage.content as string;
      }
    }
    
    return `[飞书消息] ${openId}: ${content}`;
  }
  return `[飞书事件] ${eventType || larkEvent.schema || "unknown"}`;
}

/**
 * ★ Task #5473：从原始 event 提取 agent 回复必需的精简字段。
 *
 * 保留：chat_id / message_id / sender_id / chat_type / content / mentions
 * 删除：createTime / updateTime / type / event_id / timestamp / id /
 *       message_type / sender_type（及其他所有冗余栏位）
 *
 * 支持两种格式：
 * - 简化格式（lark-cli consume）：顶层 chat_id / message_id / sender_id
 * - 嵌套格式（webhook）：event.message.* / event.sender.sender_id.*
 *
 * 纯函数：不修改 rawEvent 本身（payload.rawEvent 仍持有完整原始 event）。
 */
export function buildSlimRawData(rawEvent: unknown): Record<string, unknown> {
  const event = (rawEvent ?? {}) as Record<string, unknown>;
  const innerEvent = event.event as Record<string, unknown> | undefined;
  const message = (innerEvent?.message ?? event.message) as
    | Record<string, unknown>
    | undefined;
  const sender = (innerEvent?.sender ?? event.sender) as
    | Record<string, unknown>
    | undefined;

  const slim: Record<string, unknown> = {};

  const chatId = (message?.chat_id ?? event.chat_id) as string | undefined;
  if (chatId !== undefined) slim.chat_id = chatId;

  const messageId = (message?.message_id ??
    event.message_id ??
    event.id) as string | undefined;
  if (messageId !== undefined) slim.message_id = messageId;

  // sender_id：简化格式顶层字符串；嵌套格式 sender_id 对象（取 open_id 优先）
  const rawSenderId = sender?.sender_id ?? event.sender_id;
  let senderId: string | undefined;
  if (typeof rawSenderId === "string") {
    senderId = rawSenderId;
  } else if (rawSenderId && typeof rawSenderId === "object") {
    const obj = rawSenderId as Record<string, unknown>;
    senderId = (obj.open_id ?? obj.user_id ?? obj.union_id) as
      | string
      | undefined;
  }
  if (senderId !== undefined) slim.sender_id = senderId;

  const chatType = (message?.chat_type ?? event.chat_type) as string | undefined;
  if (chatType !== undefined) slim.chat_type = chatType;

  const content = (message?.content ?? event.content) as unknown;
  if (content !== undefined) slim.content = content;

  const mentions = (message?.mentions ?? event.mentions) as unknown;
  if (mentions !== undefined) slim.mentions = mentions;

  return slim;
}

/**
 * 构建 Lark `im.message.receive_v1` 事件推荐动作 prompt (Task #2185 / #4137 / #4242)
 *
 * 现状：飞书回复统一走 **单条结构化 post content**（`--msg-type post --content`）。
 *   - @mention 用结构化 at 节点 `{"tag":"at","user_id":"ou_xxx"}`，飞书会回填 mentions
 *     （真实 @）；正文用 `{"tag":"md","text":"..."}` 节点，仍支持标题/表格/加粗。
 *   - 历史上的 `--markdown` + 正文内联 `<at>` 已废弃：LLM 常写坏标签
 *     （自闭合 `<at/>` 会让整条 Markdown 解析失败、@ 退化成纯文本）。
 *   - 用 mktemp + trap + `jq --rawfile` 安全构造 content（jq 自动转义换行）。
 *
 * 设计要点：
 *   1. 推荐路径：先写临时 .md 文件（正文），再用 jq 组装结构化 content，
 *      最后 `lark-cli ... --msg-type post --content "$content"` 调用。
 *   2. 显式禁止：--text / --msg-type text / --markdown / 正文内联 <at> 标签 /
 *      字面反斜杠+n / ANSI-C 引号 —— 这些都会导致坏 Markdown 或 @ 失效。
 *   3. 必须使用下方 recommendedAction.replyTo 给定的 profile / chatId / messageId
 *      / --as bot，禁止 LLM 凭印象自己填。
 *   4. replyTo 既有结构（appId / profile / chatId / messageId）保持不变，老 consumer
 *      仍能解析。
 *   5. prompt 自身 JSON/日志转义干净：警示用 words 描述字面反斜杠+n，避免把 0x0A
 *      控制字符混进示例字符串里。
 *   6. **#4242 + #4243 合并修复**：禁止 sub-agent 把回复拆成多条循环 send
 *      （综合 #4137 webhook 重复通知 + #4171 msg 进 thread 折叠丢失 +
 *      #4241 review 暴露 sub-agent 自行拼 flag）。整次回复**只发一条**结构化 post
 *      （「发送类」命令只调一次），全部内容写进单个 md 节点；超长压缩正文或用附件区。
 *      长度上限用**官方 30 KB 请求体**（飞书错误码 230025），不是早期误写的
 *      "4096 字符"——那个数字没有出处，还会被 agent 当成分段阈值。
 *   7. **单一来源（去重）**：#4242 的「关键 0」与 #4243 的「关键 4」讲的是同一条规则，
 *      两个并行 task 各自 merge 后重复了三遍、占 prompt 38% 字符，且给出的"照抄模板"
 *      互相矛盾（send --chat-id vs reply --message-id）。现合并为「关键 0」单一章节，
 *      `--reply-in-thread` 全文只出现一次；由
 *      `single-message-reply-prompt.test.ts` 的 (A)/(D)/(G) 组守护，防止再次重复。
 *   8. **指令优先级**：lark-im skill 建议 `--markdown` / ANSI-C 引号，与本 prompt 冲突；
 *      故在「关键 0」顶部显式声明"以本 prompt 为准"，避免 sub-agent 自行揉合两套指令
 *      （#4241 的偏移指令语义根因）。
 *
 * 注意：本 prompt 字符串会在 console.log / JSON 序列化链路里往返多次，
 * 不要在示例里出现字面换行（0x0A 控制字符）与 bash ANSI-C 引号（dollar 符号紧跟单引号），
 * 否则就是新的字面陷阱。
 */
export function buildLarkRecommendedAction(opts: {
  profile?: string;
  chatType?: string;
  appId?: string;
  chatId?: string;
  messageId?: string;
  senderId?: string;
}): RecommendedAction {
  const { profile, chatType, appId, chatId, messageId, senderId } = opts;
  const profileFlag = profile ? `--profile ${profile} ` : "";
  const profileWarn = profile
    ? `（⚠️ 必须用 profile="${profile}" 调 lark-cli；openId per-app 隔离，换 profile 会失败）`
    : "";
  const isGroup = chatType === "group";
  // ★ at-mention 一律用结构化 at 节点 {"tag":"at","user_id":"ou_xxx"}（见下方 action）。
  // 不要再往正文里写 <at> 文本标签：自闭合 <at .../> 与空闭合 <at ...></at> 都不稳，
  // 飞书只把「结构化 at 节点」识别为真实 @（会回填 mentions）。LLM 走 bash 直接调
  // lark-cli 的路径绕开了 normalizeLarkAtMentions，所以必须在 prompt 源头教会正确做法。
  // ★ Task #5472 延续：senderId 动态注入（不用占位符）。
  //   trace 实测 prompt 里 `--arg uid "<senderId>"` 占位符导致 agent 行为
  //   不稳定（有时替换对、有时 @ 自己、有时照抄字面）。现在把真实
  //   open_id 直接写进 prompt；缺失时回退占位符（不注入空值）。
  const senderIdForPrompt = senderId || "<senderId>";
  const scopeHint = isGroup
    ? `群聊消息；回复到 replyTo.chatId。如需 @发件人，用结构化 at 节点 {"tag":"at","user_id":"${senderIdForPrompt}"}（不要写 <at> 文本标签）`
    : "p2p 私聊消息；回复到 replyTo.chatId";
  const scopeWord = isGroup ? "群聊" : "p2p 私聊";

  // 设计演进（本 prompt 会被 console.log / JSON 序列化多次往返，禁令用 words 描述，
  // 避免安全示例本身变成新的字面陷阱；唯一保留的字面警示是反斜杠+n）：
  //   - 早期：--markdown + 正文内联 <at>，但 LLM 常写坏标签（自闭合 / 空闭合），
  //     导致 @ 退化成纯文本、甚至整条 Markdown 解析失败。
  //   - 现在：统一走 post 的 --msg-type post --content 结构化 JSON，
  //     @mention 用 {"tag":"at","user_id":"ou_xxx"} 节点，正文用 {"tag":"md","text":"..."} 节点。
  //     实测结构化 at 节点会被飞书回填 mentions（真实 @），且 md 节点仍支持标题/表格。
  //   - 用 mktemp + trap + jq --rawfile 安全构造 content（jq 自动把换行转义为 \n）。
  //
  // ★ ES-M1（Task #5144）：静态规则行改为与 buildLarkChannelSystemPrompt
  //   共享的 larkStaticRuleLines()（单一来源）；本函数（legacy 模板）输出
  //   字节级不变。
  const action = [
    `处理飞书 ${scopeWord}消息并以机器人身份回复${profileWarn}。`,
    `scope: ${scopeHint}。`,
    ``,
    ...larkStaticRuleLines(profileFlag, senderIdForPrompt),
    ``,
    `## 必须使用 replyTo 里给定的值`,
    `profile / chatId / messageId / --as bot 必须原样取自 recommendedAction.replyTo；不要凭印象自己拼接。`,
  ].join("\n");

  // ★ Task #5212：引用消息上下文章节 —— legacy 模板与 lean 渠道
  //   systemPrompt 共享同一份文本（larkReplyContextSection），
  //   两条路径（buildLarkRecommendedAction / buildLarkChannelSystemPrompt）
  //   都能看到，避免「切换模板后 agent 丢引用上下文」。
  const actionWithReplyContext = [
    action,
    larkReplyContextSection(profileFlag),
  ].join("\n");

  return {
    action: actionWithReplyContext,
    replyTo: {
      appId,
      profile,
      chatId,
      messageId,
    },
  };
}

// =============================================================================
// 渠道级 system prompt（ES-M1，Task #5144 / 方案 Task #5139 §5.1）
// =============================================================================
//
// 设计（§3 拆分规则 / §4.1 cache 保持策略）：
//   - 渠道级「共通静态规则」（回复命令模板、结构约定、禁令）一次性
//     注入 systemPrompt，随 session-scope cacheSnapshot 冻结；
//   - per-event 动态部分（profile 之外的 chatId/messageId/senderId、
//     消息正文）只留 user message（动态小卡片）；
//   - **单点构造**：渠道静态 prompt 只在 resolveLarkChannelSystemPrompt
//     一个函数里构造，构造入参只来自 config，不来自事件
//     （**渠道 prompt 构造函数禁止读 event/rawEvent**，否则字节漂移
//     破坏 LLM prompt cache 前缀一致性）；
//   - 双保险：即使实例层重算，AgentComponent 的 cacheSnapshot
//     （Task #2744）也保证同 session 内字节级复用。
//
// **单一来源**：下面的静态规则行与 buildLarkRecommendedAction 共享
// 同一份行数组（larkStaticRuleLines），规则文本全仓只写一次；
// lean 模式下 recommendedAction.action 压缩为动态小卡片，规则文本
// 只出现在本 system prompt（lark-channel-system-prompt.test.ts 守护）。

/**
 * 渠道静态规则章节标题（system prompt 与 lean 卡片互相指认的锚点）
 */
export const LARK_CHANNEL_PROMPT_SECTION_TITLE = "⭐ 飞书回复规范（system prompt 注入版）";

/**
 * ★ Task #5212（DS review MINOR-3）：飞书 prompt 长度**防御性上限**（单一来源）。
 *
 * 两个出口共用同一预算：
 *   - lean 渠道 system prompt（buildLarkChannelSystemPrompt）
 *   - legacy recommendedAction.action（buildLarkRecommendedAction）
 *
 * ⚠️ 这是**防御性上限**，不是编辑预算：正常小幅扩写仍有余量，
 * 但「各加一节」式回归会立刻超。改动相关章节前先量长度，
 * 改完必须跑 lark-channel-system-prompt.test.ts (G) 组守护测试。
 * （历史：旧 action 模板 ~4486 → profile=tongzhuli 时 4745 → #5164 追加
 *  文档交付规范段后 4991 → #5212 追加引用上下文段后 5287 →
 *  #5472 关键 1 追加群聊 @ sender 可跑示例后 5808，预算 5300→5900。）
 */
export const LARK_PROMPT_LENGTH_BUDGET = 5900;

/**
 * ★ Task #5212：引用消息上下文章节（legacy 模板与 lean 渠道
 * systemPrompt 共享同一份文本，单一来源）。
 *
 * 插值只有 profileFlag（渠道配置，非事件属性），与
 * larkStaticRuleLines 同一约束：不读 event，保证字节级稳定。
 *
 * ⚠️ 文案必须指向 agent **真实能看到**的位置（recommendedAction.replyContext），
 * 不能指向 metadata.replyContext —— agent 的 user message
 * = {rawData, recommendedAction}，不含 metadata 键（DS review MINOR-1）。
 *
 * ⚠️ 长度纪律（DS review MAJOR-1）：本章节会进 lean 渠道 system prompt，
 * 该 prompt 有 <= 5300 字符的防膨胀硬上限（lark-channel-system-prompt.test.ts
 * (G) 组）。改动本章节前先量长度，改完必须跑那条守护测试。
 */
function larkReplyContextSection(profileFlag: string): string {
  return [
    ``,
    `## 引用消息上下文 replyContext`,
    `recommendedAction.replyContext 存在 = 本条是对 parentId 的回复。`,
    `- 取原文：lark-cli ${profileFlag}im +messages-mget --message-ids <parentId> --as bot（best-effort）`,
  ].join("\n");
}
/**
 * buildLarkRecommendedAction 的**静态规则行**（与事件无关，插值只有
 * profileFlag —— profile 是渠道配置不是事件属性）。
 *
 * 供两个出口共用（字节级同一份文本）：
 *   1. buildLarkRecommendedAction（legacy 长模板）
 *   2. buildLarkChannelSystemPrompt（lean 渠道 system prompt）
 */
function larkStaticRuleLines(profileFlag: string, senderIdForPrompt: string): string[] {
  return [
    // ★ 关键 0（#4242 与 #4243 合并去重后的**单一来源**）— 整次回复只发一条结构化 post。
    //   放最前是因为 sub-agent 会先决定"怎么发"再决定"发什么"：先钉死"只发一条"，
    //   后面所有内容编排自然走压缩正文，而不是拆段循环 send。
    //   ⚠️ 同一条规则**只允许在这里写一次**（原「关键 4」已删除）：
    //   single-message-reply-prompt.test.ts (A) 组守护"仅 1 个章节谈分段、
    //   --reply-in-thread 全文仅 1 次"，(G) 组守护总长度上限。
    `## ⭐ 关键 0：整次回复只发一条结构化 post（禁分段）`,
    `> 指令优先级：本 prompt 与 lark-* skill 文档冲突时**以本 prompt 为准**`,
    `> （例：lark-im skill 建议 --markdown / ANSI-C 引号，本项目一律走下面模板）。`,
    ``,
    `把全部**正文**写进**同一份** post content 的**单个** md 节点里（超长内容另挂附件区，`,
    `见「关键 2」），写完整条即结束。`,
    ``,
    `- **发送动作只调一次**：整次回复只调一次「发送类」命令（+messages-reply / +messages-send）`,
    `  - 上传 / 查询等**非发送类**命令不受此限`,
    `    （例：先 \`im files create\` 拿 file_key，再发一条带附件的 post，发送仍然只有一次）`,
    `- "只 send 一次" = 只 send **一条回复内容**；失败时用同一 idempotency-key 重发同一内容`,
    `  仍算"只 send 一次"（飞书层面幂等去重，key 最长 50 字符），不是分段、不是拆段`,
    `- **禁止分段**：不要把回复拆成多条消息循环 send（2 / 3 / 5 / 若干条都不行），`,
    `  禁止在 for / while 循环里多次调发送命令，禁止每条只发一部分"待续"`,
    `- **禁止"陆续更新"**：子任务结束后不要再补发第 2 条更新；禁止先发占位帖再发完整版`,
    `  - 违规识别口径：同一 sub-agent 在群里连续刷 5 条以上消息，即为违规`,
    `- 单条上限是飞书的**远端硬限制**：post 请求体 ≤ **30 KB**（UTF-8 字节，含 JSON 转义开销，`,
    `  量级参考：约 1 万汉字）。**它不是你的分段阈值**——不要为了"卡上限"去数字数/算字节，`,
    `  正常回复远低于它；真触发会报 **230025**（消息体长度超出限制，别当成路径错去换 flag），`,
    `  处理方式是**压缩正文**或改用附件区（见「关键 2」）——**绝不拆成多条**`,
    `- 拆段循环 send 的代价（历史故障，不要重演）：webhook 重复通知（#4137）／`,
    `  消息进 thread 后主聊天流丢失（#4171）／sub-agent 自拼 flag 偏移（#4241）`,
    `- **绝不能加 --reply-in-thread**：会被路由进 thread，主聊天流看不到（#4171）`,
    ``,
    `## ⭐ 关键 1：飞书回复必须用结构化 post content（--msg-type post --content）`,
    `lark-cli 默认把消息当 plain text；而 @mention 只有在**结构化 at 节点**里才会被`,
    `飞书识别为真实 @。所以回复统一走 post 的 --content JSON：`,
    ``,
    `  {"zh_cn":{"content":[`,
    `    [ {"tag":"at","user_id":"ou_xxx"} ],                            // @某人：结构化节点（可多个/多段）`,
    `    [ {"tag":"md","text":"正文 Markdown"} ]  // 正文：单个 md 节点（整条回复的正文都放这里）`,
    `  ]}}`,
    ``,
    `- @mention：用 {"tag":"at","user_id":"ou_xxx"}（user_id 填对方 open_id；@所有人填 "all"）`,
`- **群聊必须 @ sender**：若接收的消息是 \`chat_type: group\`，回复时 content **必须**保留结构化 at 节点 @ 发送者（user_id 填 senderId，即消息发送者的 open_id）；**禁止只用引用回复**（quote/reply 不算 @，群聊里对方收不到提醒）；私聊（p2p）不需要。群聊可跑示例（照抄，--arg uid 填消息发送者 open_id）：`,
    `  body_file="$(mktemp /tmp/lark-ask.XXXXXX.md)"`,
    `  cat > "$body_file" <<'EOF2'`,
    `  回复正文……`,
    `  EOF2`,
    `  content="$(jq -nc --rawfile md "$body_file" --arg uid "${senderIdForPrompt}" '{zh_cn:{content:[[{tag:"at",user_id:$uid}],[{tag:"md",text:$md}]]}}')"`,
    `  lark-cli ${profileFlag}im +messages-reply --message-id <replyTo.messageId> --as bot --msg-type post --content "$content"`,
    `- 正文：全部放进 {"tag":"md","text":"..."} 这一个节点里`,
    `- 不需要 @ 时，content 里只放 md 节点：{"zh_cn":{"content":[[{"tag":"md","text":"..."}]]}}`,
    `- md 节点支持 CommonMark 0.31 + GFM：ATX 标题（#~######）/ 表格 / 任务列表 / 加粗 / 围栏代码块 / 超链接`,
    `- 表格**前后**、引用块**之后**接其他内容，都**必须空一行**（只写一个换行会被当成表格续行）`,
    `**严禁**: 用 --text（plain text，Markdown 全部失效）`,
    `          用 --markdown（无法携带结构化 at 节点，@ 会退化成普通文本）`,
    `          在正文里写 <at user_id="ou_xxx"/> 或 <at user_id="ou_xxx"></at> 文本标签`,
    `          （飞书不识别文本标签，只认结构化 at 节点；写文本标签会显示成原始字符）`,
    ``,
    `## ⭐ 关键 2：安全构造 content（照抄，避免 JSON 转义地狱）`,
    `把 Markdown 正文写进临时文件，再用 jq 组装（jq 会自动把换行转义为反斜杠+n）：`,
    ``,
    `  body_file="$(mktemp /tmp/lark-reply.XXXXXX.md)"`,
    `  trap 'rm -f "$body_file"' EXIT`,
    `  cat > "$body_file" <<'LARK_REPLY_EOF'`,
    `  ...（回复的 Markdown 正文，可多行 / 含表格 / 含特殊字符；不要写 <at> 标签）`,
    `  LARK_REPLY_EOF`,
    `  content="$(jq -nc --rawfile md "$body_file" --arg uid "${senderIdForPrompt}" '{zh_cn:{content:[[{tag:"at",user_id:$uid}],[{tag:"md",text:$md}]]}}')"`,
    `  lark-cli ${profileFlag}im +messages-reply --message-id <取自 replyTo.messageId> --as bot --msg-type post --content "$content"`,
    ``,
    `不需要 @ 某人时，把 jq 表达式换成 '{zh_cn:{content:[[{tag:"md",text:$md}]]}}'。`,
    ``,
    `**长内容怎么放（仍然是单条消息）**：`,
    `- 首选压缩正文；上限见「关键 0」（30 KB 请求体 = 单条消息，不是分段总和）`,
    `- 要带完整日志 / trace 时用 post 的**附件区**（发送仍然只有一次）：`,
    `  lark-cli ${profileFlag}im files create --file <path> --as bot --data '{"file_name":"<报告名>.md","file_type":"stream"}'`,
    `  拿到 file_key 后在发送命令末尾加 --attachment <file_key>（.md/.log/.txt 用 file_type=stream）`,
    `- \`--attachment\` 不能与已含 files 数组的 --content 同用（附件区只能声明一次）`,
    `- 不要用 HTML 折叠标签往单条里"塞"长内容：飞书 post 的 md 节点**不支持** raw HTML，`,
    `  写了只会让用户看到原始标签`,
    ``,
    `## 禁止`,
    `- 禁止 --text / --msg-type text（plain text，Markdown 全部失效）`,
    `- 禁止 --markdown（无法携带结构化 at 节点）`,
    `- 禁止在正文里写 <at user_id=".."/> 或 <at user_id=".."></at> 文本标签`,
    `- 禁止把多行 Markdown 直接拼进 --content 参数（必须走上面的 jq --rawfile）`,
    `- 禁止字面反斜杠+n（即 \\n 两个字符，不是 0x0A 控制字符）`,
    `- 禁止 bash ANSI-C 引号语法（dollar 符号紧跟单引号）`,
    ``,
    // ★ Task #4137 P0 — 强制 --as bot + 警告 api POST 是 user-identity 路径（自我回灌根因）
    `## ⭐ 关键 3：出站必须显式 --as bot，禁止走 api POST`,
    `所有出站命令**照抄下面模板**（--as bot 已写死在命令里，不要自己重写、不要省 flag）：`,
    ``,
    `  # 回复某条消息（有 replyTo.messageId 时）`,
    `  lark-cli ${profileFlag}im +messages-reply --message-id <取自 replyTo.messageId> --as bot --msg-type post --content "$content"`,
    ``,
    `  # 发到会话（无 messageId，只有 chatId 时）`,
    `  lark-cli ${profileFlag}im +messages-send --chat-id <取自 replyTo.chatId> --as bot --msg-type post --content "$content"`,
    ``,
    `- 两条模板都必须满足：显式 --as bot、带对应 profile、--content 是结构化 post JSON`,
    `- 出站身份必须是 bot；以 user 身份发出 → 飞书又把消息回灌给自己 → 形成持续回声`,
    `- 禁止使用 \`lark-cli api POST /open-apis/im/v1/messages\` 直接发消息`,
    `  - api POST 路径默认 identity=user（即 user-identity 路径）→ 自我回灌`,
    `- 如果 lark-cli 报 99992402 字段校验错误，**不要换路径**，而应检查 --content JSON 结构（必须用 --msg-type post + 结构化 content）`,
    `- 出口处判定发送成功**只看 exit code**（见下方"成功判定"），不要 parse stdout JSON`,
    ``,
    `## 成功判定：只看退出码，禁止 parse stdout JSON`,
    `- \`lark-cli … ; rc=$?; [ $rc -eq 0 ] || echo "FAIL rc=$rc"\``,
    `- 禁止用 \`python json.load\` / \`python json.tool\` / \`jq\` 解析 lark-cli 发送响应`,
    `  - 飞书消息正文里常含裸 \`"\`、\`|\`、Markdown 表格分隔符 → json.load 会报 \`Expecting ',' delimiter\` 假失败`,
    `  - 假失败 → 重发 → 形成 3 份相同消息`,
    `- 重试建议：固定 idempotency-key（飞书层面去重，**最长 50 字符**），不要靠内容 hash 自检`,
    ``,
    // ★ Task #5164 需求 1：文档类产出物的交付规范
    `## 文档交付规范：产出物存飞书云盘，云盘链接交付`,
    `- 本渠道触发的**文档类生成**（调研文档 / PPT / doc 等）必须用**飞书云盘**存储产出物`,
    `  （\`lark-cli docs +create --title <标题> --markdown @<本地md>\`，用完即弃）`,
    `- 交付时只给**云盘链接**（https://my.feishu.cn/...），**不落本地路径**交付`,
    `  - 本地路径只作中转（生成 md → 上传云盘 → 回复里贴云盘链接），不作为交付物`,
  ];
}

/**
 * 构建飞书渠道级 system prompt（ES-M1 lean 模式核心）。
 *
 * 内容 = 渠道静态规则（关键 0/1/2/3 + 禁止 + 成功判定，与旧
 * recommendedAction 长模板字节级同源）+ profile 渠道约定（开头 2-3 行）。
 *
 * **禁止读事件**：入参只有 profile（渠道配置）；同一渠道多次调用
 * 逐字节一致，这是 LLM prompt cache 前缀稳定的根基。
 *
 * 静态规则中的定位占位（replyTo.messageId / replyTo.chatId）语义不变：
 * system prompt 里写明「具体值取自 recommendedAction.replyTo」。
 */
export function buildLarkChannelSystemPrompt(opts: { profile?: string }): string {
  const { profile } = opts;
  const profileFlag = profile ? `--profile ${profile} ` : "";
  const profileWarn = profile
    ? `（⚠️ 必须用 profile="${profile}" 调 lark-cli；openId per-app 隔离，换 profile 会失败）`
    : "";

  const header = [
    `# ${LARK_CHANNEL_PROMPT_SECTION_TITLE}`,
    ``,
    `本节是飞书渠道的**回复规范**（静态规则，随 system prompt 注入）。`,
    `每条飞书事件的 \`recommendedAction\` 只带动态定位（replyTo 四元组），`,
    `profile / chatId / messageId 是本轮唯一权威定位，其余回复规则全部在此。`,
    profile
      ? `本渠道 profile：${profile}${profileWarn}`
      : `本渠道未配置 profile（使用 lark-cli active profile）。`,
    ``,
  ].join("\n");

  const footer = [
    ``,
    `## 必须使用 replyTo 里给定的值`,
    `profile / chatId / messageId / --as bot 必须原样取自 recommendedAction.replyTo；不要凭印象自己拼接。`,
    // ★ Task #5212：引用消息上下文章节（与 legacy 模板共享同一份文本）
    larkReplyContextSection(profileFlag),
  ].join("\n");

  // ★ Task #5472 延续：渠道 system prompt 是**静态**的（cache 前缀一致性），
  //   不读 event，所以这里必须用占位符；真实 senderId 由 lean 动态卡片
  //   （buildLarkLeanAction）按事件注入。
  return header + larkStaticRuleLines(profileFlag, "<senderId>").join("\n") + footer;
}

/**
 * 渠道 system prompt 的**动态卡片**形态：legacy 长模板里与事件无关
 * 的插值只有 profile（渠道级），与事件相关的只有 chatType
 * （决定 p2p/群差异 scopeHint/scopeWord）。
 *
 * lean 模式下 recommendedAction.action 压缩为动态小卡片：
 * 一句话指回 system prompt「飞书回复规范」章节 + chatType 语义。
 * 规则文本（mktemp 模板 / 30KB / 禁分段…）一律不再进卡片。
 */
function buildLarkLeanAction(chatType?: string, senderId?: string): string {
  const isGroup = chatType === "group";
  // ★ Task #5472 延续：动态卡片按事件注入真实 senderId（缺失回退占位符）
  const senderIdForPrompt = senderId || "<senderId>";
  const scopeHint = isGroup
    ? `群聊消息；回复到 replyTo.chatId。如需 @发件人，用结构化 at 节点 {"tag":"at","user_id":"${senderIdForPrompt}"}（不要写 <at> 文本标签）`
    : "p2p 私聊消息；回复到 replyTo.chatId";
  return [
    `处理飞书${isGroup ? "群聊" : "p2p 私聊"}消息并回复。回复规范见 system prompt「${LARK_CHANNEL_PROMPT_SECTION_TITLE}」章节。`,
    `scope: ${scopeHint}。`,
    `replyTo 的 profile/chatId/messageId 是本轮唯一权威定位；其余回复规则（发送命令模板、长度上限、发送纪律等）全部见 system prompt 上述章节。`,
  ].join("\n");
}

/**
 * 解析 lark-cli 渠道的 systemPrompt（单点构造，只读 config）。
 *
 * - lean（默认）：config.systemPrompt（用户配置，若有）+ 渠道静态 prompt；
 * - legacy（per-source 可回退）：返回 config.systemPrompt 原值
 *   （未设置则 undefined，与旧版行为一致）。
 *
 * 同一 config 多次调用逐字节一致（测试守护）。
 */
export function resolveLarkChannelSystemPrompt(
  config: EventSourceConfig,
): string | undefined {
  const mode =
    (config as { channelPromptMode?: string }).channelPromptMode ?? "lean";

  if (mode === "legacy") {
    return config.systemPrompt;
  }

  const channelPrompt = buildLarkChannelSystemPrompt({
    profile: config.profile,
  });
  return config.systemPrompt
    ? config.systemPrompt + "\n\n" + channelPrompt
    : channelPrompt;
}

/**
 * 提取事件元信息
 * 
 * 支持两种事件格式：
 * 1. 简化格式（lark-cli 推送）：顶层有 message_id, chat_id, content 等
 * 2. 嵌套格式：event.message, header.event_type 等
 */
// =============================================================================
// Lark Event Metadata Extraction
// =============================================================================

/**
 * 从 rawEvent 中提取 EventMetadata + ReplyChannel + RecommendedAction
 *
 * 【导出】原文件 default 为 internal,Task #2326 lark-messageid-context 集成测试需要直接调用。
 * 处理两种事件格式：
 * - 嵌套格式: { event: { message: { message_id, chat_id }, sender: {...} } }
 * - 简化格式: { message_id, chat_id, sender_id }
 */
export function extractMetadata(rawEvent: unknown, eventType?: string): {
  metadata: EventMetadata;
  replyChannel?: ReplyChannel;
  recommendedAction?: RecommendedAction;
} {
  const event = rawEvent as Record<string, unknown>;
  const metadata: EventMetadata = {};

  // 尝试从嵌套格式中提取
  const larkInnerEvent = event.event as Record<string, unknown> | undefined;
  const header = (larkInnerEvent?.header || event.header) as Record<string, unknown> | undefined;
  const sender = (larkInnerEvent?.sender || event.sender) as Record<string, unknown> | undefined;
  let senderId = sender?.sender_id as Record<string, unknown> | string | undefined;

  // ★ Bug 修复（Task #3987 后续）：lark-cli `event consume` 实际吐出的是**简化格式**，
  //   顶层有 `sender_id: "ou_xxx"`（字符串），不是嵌套的 `event.sender.sender_id.open_id`。
  //   之前漏处理导致 replyChannel.params.userId 永远是 undefined，
  //   PerTaskGroupChatPlugin 用 ["sender"] 推导时拿不到 userId，
  //   → 群聊创建后没人入群。
  if (!senderId && typeof event.sender_id === "string") {
    senderId = event.sender_id;
  }

  // 提取 message - 支持两种格式
  // 简化格式: event.message_id, event.chat_id 直接在顶层
  // 嵌套格式: event.event.message.chat_id
  let messageData: Record<string, unknown> | undefined;

  if (larkInnerEvent?.message) {
    // 嵌套格式
    messageData = larkInnerEvent.message as Record<string, unknown>;
  } else if (typeof event.message === "object" && event.message !== null) {
    // 也是嵌套格式的 message 对象
    messageData = event.message as Record<string, unknown>;
  } else {
    // 简化格式：从顶层直接提取
    messageData = {
      message_id: event.message_id || event.id,
      chat_id: event.chat_id,
      chat_type: event.chat_type,
      message_type: event.message_type,
      content: event.content,
    };
  }

  if (header) {
    metadata.eventType = header.event_type as string;
    metadata.appId = header.app_id as string;
    metadata.tenantKey = header.tenant_key as string;
  }
  if (messageData) {
    metadata.chatId = messageData.chat_id as string;
    metadata.chatType = messageData.chat_type as string;
    metadata.messageId = messageData.message_id as string;
    metadata.messageType = messageData.message_type as string;

    // ★ Task #5212：lark 引用消息上下文（replyContext）。
    //   lark-cli event consume 简化格式顶层带 root_id / reply_to /
    //   thread_id；嵌套格式（event.message）带 root_id / parent_id /
    //   thread_id。此前全部被丢弃，agent 不知道当前消息是对哪条
    //   消息的回复。reply_to（简化）与 parent_id（嵌套）是同一
    //   语义（直接回复的父消息 id），统一归一为 parentId。
    //   无任何引用字段时不产生 replyContext（保持 undefined）。
    const rootId = (messageData.root_id ?? event.root_id) as string | undefined;
    const parentId = (messageData.parent_id ?? event.reply_to ?? event.parent_id) as string | undefined;
    const threadId = (messageData.thread_id ?? event.thread_id) as string | undefined;
    if (rootId || parentId || threadId) {
      const replyContext: Record<string, string> = {};
      if (rootId) replyContext.rootId = rootId;
      if (parentId) replyContext.parentId = parentId;
      if (threadId) replyContext.threadId = threadId;
      metadata.replyContext = replyContext;
    }
  }
  // ★ Task #3987 后续修复：同时兼容嵌套格式（object）和简化格式（顶层字符串）
  if (typeof senderId === "string") {
    metadata.senderId = senderId;
  } else if (senderId) {
    metadata.senderId = senderId.open_id as string || senderId.user_id as string || senderId.union_id as string;
  }

  // 推荐动作 (Task #2185: prompt 内容由 buildLarkRecommendedAction 集中生成，
  // 原 inline 字符串会让 LLM 在多行 Markdown 时把内容塞进 $'...' ANSI-C 引号，
  // 导致飞书收到字面 $ 和字面反斜杠+n。helper 强制走"先写 .md 再 cat"路径。)
  let recommendedAction: RecommendedAction | undefined;
  if (eventType === "im.message.receive_v1" || event.type === "im.message.receive_v1") {
    // profile 注入 (#1637): 飞书 openId 是 per-app 隔离的,不同 appId 的
    // event-source 必须用对应 profile 调用 lark-cli 才能回复成功。
    const profile = (event as any).profile as string | undefined;

    // ★ ES-M1（Task #5144 / 方案 Task #5139 §3）：channelPromptMode 开关。
    //   lean（默认）：静态规则前置到渠道 system prompt（由
    //   LarkCliInstance.getChannelSystemPrompt 注入 metadata.systemPrompt），
    //   这里的 recommendedAction 压缩为**动态小卡片**
    //   （action 一句话指回规则章节 + replyTo 四元组原结构）。
    //   legacy：per-source 回退，行为与旧版完全一致（4.4KB 长模板）。
    //   卡片形态经 rawEvent 的 channelPromptMode 传递（handleEvent 从
    //   this.config 读取后 enrich 进 rawEvent，与 profile 同路径），
    //   保证 extractMetadata 保持纯函数（不持有实例状态）。
    const promptMode = (event as any).channelPromptMode as string | undefined
      ?? "lean";

    if (promptMode === "legacy") {
      recommendedAction = buildLarkRecommendedAction({
        profile,
        chatType: metadata.chatType,
        appId: metadata.appId,
        chatId: metadata.chatId,
        messageId: metadata.messageId,
        senderId: metadata.senderId,
      });
    } else {
      recommendedAction = {
        action: buildLarkLeanAction(metadata.chatType, metadata.senderId),
        replyTo: {
          appId: metadata.appId,
          profile,
          chatId: metadata.chatId,
          messageId: metadata.messageId,
        },
        // ★ ES-M1：标记静态规则已前置 system prompt（types.ts
        //   RecommendedAction.staticRulesInSystemPrompt）
        staticRulesInSystemPrompt: true,
      };
    }

    // ★ Task #5212（DS review MAJOR-2）：把引用上下文挂到 recommendedAction
    //   —— agent 的 user message（payload.message）只含
    //   {rawData, recommendedAction}，**不含 metadata**；只写进
    //   evt.metadata 的话 agent 读不到 parentId → 需求（「让 agent LLM
    //   看到是对某消息 id 的回复」）不闭环。lean / legacy 两条路径都挂，
    //   保证 agent 无论走哪个模板都能看到引用定位。
    if (metadata.replyContext) {
      recommendedAction = {
        ...recommendedAction,
        replyContext: metadata.replyContext,
      };
    }
  }

  // 反馈通道 - 使用 messageData 中的值
  const profile = (event as any).profile as string | undefined;
  // ★ Task #3987 后续修复：senderId 在简化格式下是字符串（ou_xxx），嵌套格式下是对象
  const senderOpenId: string | undefined =
    typeof senderId === "string"
      ? senderId
      : senderId?.open_id as string | undefined;
  const replyChannel: ReplyChannel = {
    type: "lark-cli",
    appId: metadata.appId,
    profile,
    chatId: messageData?.chat_id as string,
    messageId: messageData?.message_id as string,
    // ★ P1 修复：把 sender open_id 注入 replyChannel.params.userId，
    // 让 plugin（如 PerTaskGroupChatPlugin 建群时能通过 --users <userId> 把 user 拉入群聊），
    // 否则群聊创建后只有 bot 在群里，user 看不到。
    params: {
      userId: senderOpenId,
      // ★ Task #5360（补充需求）：状态通知开关随快照带下去。
      //
      // 为什么**显式写 false** 而不是省略：省略会让「源上显式 false」与
      // 「源上没这个字段」在快照里不可区分，未来想加「三级继承
      // （ES → 全局默认）」时会失去信息。写入布尔原值，不做省略。
      //
      // 严格 === true：手改 JSON 写出 "true"/1/null 一律当 false。
      statusNotifications: event.statusNotifications === true,
    },
  };

  return { metadata, replyChannel, recommendedAction };
}

// =============================================================================
// LarkCliHandler
// =============================================================================

/**
 * Plugin 信息（用于加载/卸载跟踪）
 */
interface LoadedPlugin {
  name: string;
  hooks: Array<{ point: string; name: string }>;
}

/**
 * LarkCli EventSourceInstance 实现
 * 支持通过 handleRule.plugins 加载外部 Plugin
 * 
 * 进程启动逻辑参考 bash-effect.ts：
 * - 使用 shell: true + stdio: ["pipe", "pipe", "pipe"]
 * - stdin 保持打开直到进程结束
 */
export class LarkCliInstance implements EventSourceInstance {
  private config: EventSourceConfig;
  private status: EventSourceStatus = "created";
  /**
   * ★ Task #4339：所有 consume 子进程（**一个 EventKey 一个进程**）。
   *
   * lark-cli 硬约束（1.0.98 实测）：`event consume` 只接受**恰好一个** EventKey；
   * 逗号多 key（`k1,k2`）和通配符（`im.*`）都会 `unknown EventKey` 直接 exit 2。
   * 所以"同时监听 im.message.receive_v1 + card.action.trigger"必须拆成两个
   * 子进程 —— 它们共享同一个 bus daemon（UDS），互不干扰。
   *
   * 详见 reports/2026-10-19-lark-cli-multi-event-consume-research.md
   */
  private children: ChildProcess[] = [];
  /** 默认 stream 行缓冲（processStream 兼容入口用；每个子进程用自己的 buffer） */
  private buffer: string = "";
  /** ★ Task #4339：start() 并发保护 */
  private starting = false;
  private eventHandler?: EventSourceEventHandler;

  /**
   * ★ Task #4230 follow-up：卡片路由端口（lookup/getTask 侧）
   *
   * ★ Task #4394：只剩 `getTask`（无触发群时 lineage 上溯兜底用）。
   */
  private cardRoutingPorts?: {
    /** task 查询（无触发群时找 lineage 上最近的专属群兜底） */
    getTask?: (id: number) => Promise<any>;
  };

  /** ★ Task #4230 follow-up：已加载插件实例（收尾 cross-wire 用） */
  private pluginInstances: Map<string, any> = new Map();

  /**
   * ★ Task #4331：卡片按钮 callback 端口（注入 getTask/updateTaskContext/createGroupChat/deleteGroupChat/notifier）。
   * 由外部（一般是 loadPlugins 末尾的 cross-wire 或 CLI 启动器）注入。
   * 未注入时 handleCardActionEvent 会 warn 并 skip（不影响其他事件处理）。
   */
  private cardActionPorts?: import("../task/plugins/lark-card-action-handler").CardActionPorts;

  /**
   * ★ Task #4331：注入卡片按钮 callback 端口（由 caller/loadPlugins 调用）
   */
  setCardActionPorts(
    ports: import("../task/plugins/lark-card-action-handler").CardActionPorts
  ): void {
    this.cardActionPorts = ports;
    if (typeof logger !== "undefined" && logger?.debug) {
      logger.debug(
        `[LarkCliInstance] CardActionPorts injected: ` +
          `getTask=${typeof ports.getTask}, updateTaskContext=${typeof ports.updateTaskContext}, ` +
          `createGroupChat=${typeof ports.createGroupChat}, deleteGroupChat=${typeof ports.deleteGroupChat}, ` +
          `notifier=${typeof ports.notifier}`
      );
    }
  }

  /** 诊断：端口是否注入 */
  hasCardActionPorts(): boolean {
    return this.cardActionPorts !== undefined;
  }

  /**
   * ★ Task #3977/3978 修复：去重最近处理的 event_id
   *
   * 根因：lark-cli event consume 偶尔会把同一条 JSON 事件写到 stdout 和 stderr
   * 两路（race condition），导致 processStream 被调用两次 → 同一个飞书事件被
   * dispatch 两次 → 主 agent 和 sub-agent 都创建同名 task（bug 表现：一次
   * 用户委托产生 2 个 task）。
   *
   * 防御性做法：在 handleEvent 内根据 event_id 做 LRU 去重，避免重复 dispatch。
   * - 用 Map 记录最近 100 个 event_id + 处理时间
   * - 同一 instance 内 60s 内相同 event_id 视为重复，跳过
   *
   * ★ Task #4137 升级为跨实例共享 SHARED_SEEN（module-level Map）：
   * - 多 LarkCliInstance 共享去重表，避免"实例 A 处理过、实例 B 又处理一次"
   * - key = event_id（共享窗口）
   *
   * 注意：这里**不做** self-echo（自回灌）检测。回灌的根因是出站身份，
   * 已在源头解决——所有出站一律 `--as bot`（见 buildLarkRecommendedAction），
   * bot 自己发出的消息不会被本 app 的事件订阅回投。
   * 不要再引入"记录已发送 message_id 再在入口拦截"的兜底：它依赖 parse lark-cli
   * stdout（正文含裸引号会 PARSE FAIL，拿不到 id 就形同虚设），收益/复杂度不成正比。
   */
  private static SHARED_SEEN: Map<string, number> = new Map();
  private static SHARED_MSG_TTL_MS = 10 * 60 * 1000; // 10 分钟（覆盖完整 batch 重发窗口）
  private static SHARED_MSG_MAX = 1000;

  /**
   * 测试钩子：重置 SHARED_SEEN 静态状态。
   * 仅供单测在 beforeEach 里调用，生产路径禁止调用。
   */
  static __resetDedupForTest(): void {
    LarkCliInstance.SHARED_SEEN.clear();
  }

  // 兼容旧字段名（保留 instance-level 字段供旧测试 / 调试用）
  private recentEventIds: Map<string, number> = new Map();
  private readonly DEDUP_WINDOW_MS = 60_000;
  private readonly DEDUP_MAX_SIZE = 100;

  /**
   * ★ ES-M1（Task #5144）：渠道 system prompt 的**实例级缓存**。
   *
   * resolveLarkChannelSystemPrompt(config) 只读 config（渠道配置），
   * 输出对同一渠道是恒定的 —— 缓存到实例字段后：
   *   1. 每条事件不再重复构造（字符串拼接成本省掉）；
   *   2. 更重要的是**杜绝字节漂移**：构造函数禁止读 event/rawEvent，
   *      缓存值天然跨事件逐字节一致 → LLM prompt cache 前缀稳定
   *      （方案 §4.1 的"单点构造"规则）。
   * legacy 模式下该字段是 config.systemPrompt（可能 undefined），
   * 同样缓存一次。
   */
  private cachedChannelSystemPrompt?: string | undefined;
  private channelSystemPromptResolved = false;

  /**
   * 获取本渠道的 systemPrompt（ES-M1，Task #5144）。
   *
   * lean 模式（默认）：config.systemPrompt（用户配置，若有）+ 渠道静态 prompt；
   * legacy 模式：config.systemPrompt 原值（未设置则 undefined）。
   *
   * 结果缓存在实例字段（构造一次），供 handleEvent 注入
   * metadata.systemPrompt → query-executor → AgentComponent 追加。
   */
  getChannelSystemPrompt(): string | undefined {
    if (!this.channelSystemPromptResolved) {
      this.cachedChannelSystemPrompt = resolveLarkChannelSystemPrompt(this.config);
      this.channelSystemPromptResolved = true;
    }
    return this.cachedChannelSystemPrompt;
  }

  /**
   * Environment 引用（由 EventSourceComponent.startSource 调用 setEnvironment 注入）
   *
   * 用于在 registerPluginHooks 时通过 env.getComponent('task') 拿到 taskComponent，
   * 给支持 setTaskUpdater 的 plugin（如 PerTaskGroupChatPlugin）注入 DB 持久化回调。
   * 未注入时（如第三方 handler）所有 plugin 都不会拿到 taskUpdater，行为与之前一致。
   */
  private environment?: { getComponent?: (name: string) => unknown };

  /** 已加载的 plugins */
  private loadedPlugins: LoadedPlugin[] = [];

  constructor(config: EventSourceConfig) {
    this.config = config;
  }

  /**
   * 注入 Environment 引用（实现 EventSourceInstance.setEnvironment）
   *
   * 调用时机：EventSourceComponent.startSource 在 instance.start() 之前调用。
   * 必须先于 loadPlugins()，否则 plugin 拿不到 taskComponent。
   */
  setEnvironment(env: unknown): void {
    this.environment = env as { getComponent?: (name: string) => unknown };
  }

  async start(): Promise<void> {
    if (this.status === "running") return;
    // ★ Task #4339：并发 start() 保护（原来只有 running 判断，两次并发调用会
    //   各 spawn 一套子进程 → 重复消费者）
    if (this.starting) {
      logger.warn(`[LarkCliInstance] start() 已在执行中，忽略重复调用`);
      return;
    }
    this.starting = true;

    try {
      // 加载 plugins
      await this.loadPlugins();

      // ★ Task #4339：plugins 全部加载完之后再做 cross-wire（顺序敏感）
      // ★ Task #4394：`wireCardRoutingGroupProvider()` 已删除
      //   —— 卡片不再自动建专属群，建群改由用户点卡片按钮触发
      this.wireCardActionPorts();

      // ★ Task #4339：解析要 spawn 的命令列表（一个 EventKey 一个子进程）
      const commands = this.buildConsumeCommands();

      // 配置自检：card.action.trigger 被 eventTypes 过滤掉 / 被别的 consumer 占用
      this.warnOnCardActionConfigTraps(commands);
      // best-effort，**不阻塞启动**（内部有 5s timeout 的 lark-cli 调用）
      void this.warnOnConsumeConflict(commands);

      this.status = "starting";

      const readyTrackers: Promise<void>[] = [];
      for (const command of commands) {
        // 使用 exec 来保持 stdin 打开
        // exec 命令会替换 shell 进程，所以 stdin 会保持打开
        // 注意：spawn 的 stdio: ["pipe", "pipe", "pipe"] 需要 stdin 是 pipe
        // 而 exec 会保持 stdin 打开
        const child = this.spawnConsumeChild(command);
        this.children.push(child);
        readyTrackers.push(this.wireChildStreams(child, command));
      }

      // 等待每个子进程 ready（或超时 / 退出），避免读到半截启动状态
      await Promise.all(readyTrackers);

      if ((this.status as EventSourceStatus) !== "error") {
        this.status = "running";
      }
    } finally {
      this.starting = false;
    }
  }

  /**
   * ★ Task #4339：配置自检 —— 两个"静默失效"陷阱，必须在启动时喊出来。
   *
   * ① `eventKeys` 里包含 card.action.trigger，但 `eventTypes` 过滤器不含它：
   *    `handleEvent` 会先过 eventTypes 再分流，卡片点击会被**静默丢弃**。
   * ② `eventKeys` 里包含 card.action.trigger，但飞书后台没开"回调配置"：
   *    consumer 能 ready，事件永远不来（lark-cli 无 preflight 检查，我们查不到，
   *    只能提示）。
   */
  private warnOnCardActionConfigTraps(commands: string[]): void {
    const consumesCardAction = commands.some((c) =>
      c.includes(CARD_ACTION_EVENT_TYPE)
    );
    if (!consumesCardAction) return;

    if (
      this.config.eventTypes?.length &&
      !matchEventType(CARD_ACTION_EVENT_TYPE, this.config.eventTypes)
    ) {
      logger.warn(
        `[LarkCliInstance] eventKeys 含 ${CARD_ACTION_EVENT_TYPE}，但 eventTypes=` +
          `${JSON.stringify(this.config.eventTypes)} 不含它 → 卡片点击会被**静默丢弃**。` +
          `请把 ${CARD_ACTION_EVENT_TYPE} 加进 eventTypes，或清空 eventTypes。`
      );
    }

    logger.info(
      `[LarkCliInstance] 已监听 ${CARD_ACTION_EVENT_TYPE}。` +
        `⚠️ 若点击卡片无反应，先确认飞书开发者后台「事件与回调 → 回调配置」已开启该事件。`
    );
  }

  /**
   * ★ Task #4339：spawn 一个 consume 子进程。
   *
   * 抽成 protected 方法是为了让单测注入"假子进程"（否则测试会真的去连
   * lark-cli bus，污染真实事件订阅）。
   */
  protected spawnConsumeChild(command: string): ChildProcess {
    return spawn("exec " + command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  /**
   * ★ Task #4339：解析要消费的 EventKey 列表。
   *
   * lark-cli 的硬约束（1.0.98 实测）：
   *   - `event consume` 只接受**恰好一个** EventKey；
   *   - 逗号多 key / 通配符都会 `unknown EventKey` 直接 exit 2；
   *   - 所以"同时监听 receive + card action"必须是**多个子进程**，
   *     它们共享同一个 bus daemon（UDS），互不干扰。
   *
   * 配置来源优先级：
   *   1. `config.eventKeys`（推荐：显式多 key，例：["im.message.receive_v1","card.action.trigger"]）
   *   2. `config.command`（用户自定义单命令，原样保留 / 注入 --profile）
   *   3. 默认 `["im.message.receive_v1"]`
   */
  resolveConsumeEventKeys(): string[] {
    const explicit = this.config.eventKeys;
    if (Array.isArray(explicit) && explicit.length > 0) {
      return explicit
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
    }
    return [];
  }

  /**
   * ★ Task #4339：构造本实例要 spawn 的完整命令列表（已注入 --profile）。
   */
  buildConsumeCommands(): string[] {
    const profile = this.config.profile;
    const profileFlag = profile ? `--profile ${profile} ` : "";

    const keys = this.resolveConsumeEventKeys();
    if (keys.length > 0) {
      return keys.map((k) => `lark-cli ${profileFlag}event consume ${k} --as bot`);
    }

    if (this.config.command) {
      // 用户自定义 command: 在第一个 lark-cli subcommand 前插入 --profile
      // 例如: "lark-cli event consume im.message.receive_v1 --as bot"
      //   → "lark-cli --profile zhishitong event consume im.message.receive_v1 --as bot"
      return [
        this.config.command.replace(
          /^(lark-cli)(\s+|$)/,
          (_, head, tail) => `${head} ${profileFlag.trim()}${tail}`
        ),
      ];
    }

    return [`lark-cli ${profileFlag}event consume im.message.receive_v1 --as bot`];
  }

  /**
   * ★ Task #4339：启动前 best-effort 冲突检查。
   *
   * lark-cli 一个 EventKey 只允许一个 consumer；若已有 orphan consumer 占着，
   * 我们新起的进程会立刻 `failed_precondition` exit 2，整个 event-source 变 error。
   * 这里提前查一次 `lark-cli event status --json` 并打 warn，让排障有据可依。
   *
   * 完全 best-effort：lark-cli 不存在 / 输出不是 JSON / 超时 → 静默跳过。
   */
  private async warnOnConsumeConflict(commands: string[]): Promise<void> {
    const keys = commands
      .map((c) => c.match(/event consume\s+(\S+)/)?.[1])
      .filter((k): k is string => !!k);
    if (keys.length === 0) return;

    const busy = await this.probeBusyEventKeys();
    if (busy.size === 0) return;

    const conflicts = keys.filter((k) => busy.has(k));
    if (conflicts.length > 0) {
      const profile = this.config.profile;
      logger.warn(
        `[LarkCliInstance] eventKey 已被其它 consumer 占用（lark-cli 一个 key 只允许一个 consumer）：` +
          `${conflicts.join(", ")}。本 event-source 启动后可能 exit 2。` +
          `用 \`lark-cli${profile ? ` --profile ${profile}` : ""} event status\` 查看，必要时 \`event stop\`。`
      );
    }
  }

  /**
   * ★ Task #4339：查询当前 bus 上已被占用的 EventKey 集合。
   *
   * 完全 best-effort：lark-cli 不存在 / 输出不是 JSON / 超时 → 返回空集合。
   * protected 是为了让单测覆盖成 no-op（避免真的 spawn lark-cli）。
   */
  protected async probeBusyEventKeys(): Promise<Set<string>> {
    const profile = this.config.profile;
    const profileFlag = profile ? `--profile ${profile} ` : "";
    try {
      const { stdout } = await execAsync(`lark-cli ${profileFlag}event status --json`, {
        timeout: 5000,
      });
      const parsed = JSON.parse(stdout) as {
        apps?: Array<{ consumers?: Array<{ event_key?: string }> }>;
      };
      const busy = new Set<string>();
      for (const app of parsed.apps ?? []) {
        for (const c of app.consumers ?? []) {
          if (c.event_key) busy.add(c.event_key);
        }
      }
      return busy;
    } catch {
      return new Set<string>();
    }
  }

  /**
   * ★ Task #4339：挂接单个 consume 子进程的 stdio。
   *
   * 每个子进程持有**自己的行缓冲**（避免两个进程的 NDJSON 切片互相错拼）。
   *
   * @returns 收到 `[event] ready event_key=` 时 resolve；5s 内没收到 ready
   *          （或进程直接退出，例如配置错误 exit 2）也会 resolve —— 避免
   *          start() 永久卡住，但此时 status 已被置为 error。
   */
  private wireChildStreams(child: ChildProcess, command: string): Promise<void> {
    const stdoutBuffer = { value: "" };
    const stderrBuffer = { value: "" };

    let settled = false;
    let resolveReady!: () => void;
    const ready = new Promise<void>((res) => {
      resolveReady = res;
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveReady();
    };

    child.stdout?.on("data", (data: Buffer) => {
      // stdout 中可能有 JSON 事件（NDJSON）
      this.processStreamWith(data.toString(), stdoutBuffer);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      // lark-cli 的状态行 / ready marker 都在 stderr
      if (output.includes("[event] ready")) settle();

      if (output.includes('"ok": false')) {
        this.status = "error";
      }

      // stderr 里除了 [event] 状态行，偶尔也会夹带裸 JSON 事件
      // （Task #3977/3978：lark-cli 偶发 stdout/stderr 双发）
      //
      // ★ 必须按**行**累积后再判断：JSON 事件可能跨 chunk 到达
      //   （chunk1 = '{"type":'  chunk2 = '"x"}\n'），
      //   逐 chunk 判断 startsWith("{") 会把后半截直接丢掉 → 事件静默丢失。
      this.processStreamWith(output, stderrBuffer, { jsonLinesOnly: true });
    });

    const handleExit = (code: number | null, source: string) => {
      if (code !== 0 && code !== null) {
        logger.warn(
          `[LarkCliInstance] consume 子进程异常退出 code=${code} (${source}) cmd="${command}"`
        );
        this.status = "error";
      } else {
        logger.info(
          `[LarkCliInstance] consume 子进程已退出 code=${code} (${source}) cmd="${command}"`
        );
      }
      settle();

      // ★ 所有子进程都退出后，本实例其实已经不在监听任何事件了 ——
      //   不能继续对外报 running（否则上游不会重启/告警）。
      queueMicrotask(() => {
        if (this.children.length > 0 && this.children.every((c) => !isChildAlive(c))) {
          if (this.status !== "error") {
            logger.warn(
              `[LarkCliInstance] 所有 consume 子进程都已退出，状态从 running 改为 stopped`
            );
            this.status = "stopped";
          }
        }
      });
    };

    // 监听进程退出
    child.on("exit", (code) => handleExit(code, "exit"));
    // ★ 'close' 兜底：stdio 也关闭之后才触发；某些包装/测试桩只发 close 不发 exit
    child.on("close", (code) => handleExit(code, "close"));

    child.on("error", (error) => {
      logger.error(`[LarkCliInstance] consume 子进程 error: ${error.message}`);
      this.status = "error";
      settle();
    });

    const timer = setTimeout(() => {
      logger.warn(
        `[LarkCliInstance] consume 子进程 ${CHILD_READY_TIMEOUT_MS}ms 内未见 ready marker: cmd="${command}"`
      );
      settle();
    }, CHILD_READY_TIMEOUT_MS);
    void ready.then(() => clearTimeout(timer));

    return ready;
  }

  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "created") return;

    // 卸载 plugins
    this.unloadPlugins();

    const children = this.children;
    this.children = [];

    if (children.length === 0) {
      this.buffer = "";
      this.status = "stopped";
      return;
    }

    // 优雅关闭：所有子进程 SIGTERM
    for (const child of children) {
      if (!child || !child.pid) continue;
      try {
        child.kill("SIGTERM");
      } catch (error) {
        logger.warn(`[LarkCliInstance] Error sending SIGTERM to ${child.pid}: ${error}`);
      }
    }

    // ★ Task #4339：等所有子进程**真的退出**（最多 5s），而不是无脑 sleep 5s
    //   —— 旧实现让每次 stop 固定慢 5s（测试里尤其致命）。
    const allExited = Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (isChildAlive(child) === false) return resolve();
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          })
      )
    );
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, GRACEFUL_STOP_TIMEOUT_MS)
    );
    await Promise.race([allExited, timeout]);

    // 仍然活着的强制杀掉
    for (const child of children) {
      if (isChildAlive(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }

    this.buffer = "";
    this.status = "stopped";
  }

  getStatus(): EventSourceStatus {
    return this.status;
  }

  onEvent(handler: EventSourceEventHandler): void {
    this.eventHandler = handler;
  }

  offEvent(): void {
    this.eventHandler = undefined;
  }

  /**
   * 加载 handleRule.plugins 中指定的 plugins
   *
   * ★ 必须先调用 setEnvironment()，否则 plugin.setTaskUpdater 不会注入。
   */
  @TracedAs("lark-cli.loadPlugins", { recordParams: true, log: true })
  private async loadPlugins(): Promise<void> {
    const plugins = this.config.handleRule?.plugins || [];

    if (plugins.length === 0) {
      console.debug(
        `[LarkCliInstance] No plugins configured in handleRule.plugins ` +
        `(sourceId=${this.config.id}). Skipping plugin loading.`
      );
      return;
    }

    console.debug(
      `[LarkCliInstance] Loading ${plugins.length} plugin(s) for sourceId=${this.config.id}: ` +
      `[${plugins.join(", ")}]; env injected=${!!this.environment}`
    );

    for (const pluginName of plugins) {
      const plugin = await this.importPlugin(pluginName);
      if (plugin) {
        this.pluginInstances.set(pluginName, plugin);
        const hookPoints = this.getPluginHookPoints(plugin);
        this.registerPluginHooks(plugin);
        // 记录已加载的插件信息
        this.loadedPlugins.push({
          name: pluginName,
          hooks: hookPoints.map(h => ({ point: h, name: `${pluginName}:${h}` })),
        });
        console.debug(
          `[LarkCliInstance] Loaded plugin "${pluginName}" with ${hookPoints.length} hook(s): ` +
          `[${hookPoints.join(", ")}]; setTaskUpdater=${typeof plugin.setTaskUpdater === "function"}, ` +
          `taskUpdaterInjected=${typeof plugin.hasTaskUpdater === "function" ? plugin.hasTaskUpdater() : "n/a"}`
        );
      } else {
        console.error(
          `[LarkCliInstance] Failed to import plugin "${pluginName}". ` +
          `plugin name=${pluginName} 不在 BUILT_IN_PLUGIN_FACTORIES 注册表里`
        );
      }
    }

    // ★ Task #4230 follow-up / #4339：cross-wire 已挪到 start()（loadPlugins 之后），
    //   这样即使 handleRule.plugins 为空（本函数提前 return）也照样接线 ——
    //   card.action.trigger 不应依赖"配了插件"。
  }

  /**
   * ★ Task #4339：把 `card.action.trigger` 的真实端口接到本实例上。
   *
   * 为什么必须有这一步：`card.action.trigger` 走的是「直接回调」而不是 Agent ——
   * `handleEvent` 分流后调 `handleCardActionEvent`，而它**依赖
   * `this.cardActionPorts` 已注入**；未注入时只打一条 warn 然后 return。
   * Task #4331 实现了这套机制但**一直没接线**（生产链路是死代码，只有单测 +
   * 手工 bridge 脚本在跑）。
   *
   * 依赖：
   *   - getTask / updateTaskContext   ← env.getComponent("task")
   *   - createGroupChat / deleteGroupChat ← lark-card-action-handler 的 lark-cli 实现
   *   - notifier ← pluginInstances 里插件共享的 LarkCardPatchNotifier
   *     （共享实例才知道这张卡片已累积的里程碑/过程历史；找不到就新建一个，
   *      `updateMetaAndBuildCard` 会返回 undefined，handler 自动走 fallback）
   *
   * 任意一环缺失（如没配 task component）→ 不注入，行为与之前一致（warn + skip）。
   */
  private wireCardActionPorts(): void {
    // 外部（embedder / 单测）已经显式注入过端口 → 尊重它，不覆盖
    if (this.cardActionPorts) {
      logger.debug(
        "[LarkCliInstance] cardActionPorts 已由外部注入，跳过默认 cross-wire"
      );
      return;
    }

    const taskComponent = this.environment?.getComponent?.("task") as
      | {
          getTask?: (id: number) => Promise<any>;
          updateTask?: (id: number, options: { context?: string }) => Promise<unknown>;
          /**
           * ★ Task #5580：按 session 反查该会话关联的**全部** task。
           *
           * 用途：session 卡的「🗂️ 任务列表」面板（一个 sub session 复用多次
           * 时会有多个 task 生命周期）。缺失 ⇒ 面板不渲染（降级，不影响其它按钮）。
           */
          getTaskIdsBySessionId?: (sessionId: string) => Promise<number[]>;
          /**
           * ★ Task #5580：读某个 task 的操作记录（渲染「📌 任务里程碑」区）。
           * 缺失 ⇒ 里程碑区显示「（该任务暂无里程碑）」。
           */
          listOperations?: (opts: {
            taskId: number;
            limit?: number;
          }) => Promise<any[] | undefined>;
          /**
           * ★ Task #5360：BackgroundTaskManager 访问器（Task #2245 加的 public typed
           * accessor，见 task-component.ts）。刷新活性要用它反查
           * `taskId → backgroundTaskId → subSessionId`。
           * 缺失（manager 未初始化 / 已 dispose）⇒ probe 返回 undefined ⇒ 卡片
           * 渲染「暂无数据」，不影响其它按钮。
           */
          getBackgroundTaskManager?: () => {
            listTasks?: () => Array<{
              id: string;
              subSessionId: string;
              associatedTaskId?: number;
            }>;
            getSubSessionActivity?: (
              bgProcessId: string,
            ) => Promise<{ messageCount: number; updatedAt: number } | undefined>;
          } | undefined;
        }
      | undefined;

    if (!taskComponent?.getTask || !taskComponent?.updateTask) {
      logger.debug(
        `[LarkCliInstance] card.action.trigger 端口未注入：taskComponent 不可用` +
          `（getTask=${typeof taskComponent?.getTask}, updateTask=${typeof taskComponent?.updateTask}）。` +
          `卡片按钮点击会被跳过。`
      );
      return;
    }

    // 优先复用插件那份共享 notifier（卡片状态 / 里程碑历史在它手里）
    //
    // ★ Task #5364 返工（BLOCKER-4）：再加一层**进程单例兜底**。
    //
    // 插件实例上的 notifier 在生产上就是 `getSharedLarkCardNotifier()` 返回的
    // 那一个（见 LarkCliTaskNotifyHook 构造）；但如果插件未配置 / 未加载
    // （某些 ES 只跑 card.action.trigger），这里会拿不到 —— 上一版就落
    // `new LarkCardPatchNotifier()`，与 sessionCardSender 那份不是同一实例
    // ⇒ 刷新永远 fallback 重建，且发卡数量翻倍。
    // 走同一个单例 ⇒ 无论插件在不在，卡片状态都是连续的。
    const sharedNotifier =
      this.pluginInstances.get("LarkCliTaskNotifyPlugin")?.cardNotifier ??
      this.pluginInstances.get("PerTaskGroupChatPlugin")?.cardNotifier ??
      getSharedLarkCardNotifier();

    this.setCardActionPorts({
      // ★ 必须做字段适配：taskComponent.getTask 返回的是 core `Task` 实体，
      //   目标字段叫 `goals_and_expected_deliverables`；handler 的端口约定是 `goals`。
      //   直接透传会导致卡片上的「🎯 目标」永远缺失（静默丢字段）。
      getTask: async (id: number) => {
        const t = await taskComponent.getTask!(id);
        if (!t) return undefined;
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          goals: t.goals_and_expected_deliverables ?? t.goals,
          priority: t.priority,
          type: t.type,
          project_path: t.project_path,
          parent_task_id: t.parent_task_id ?? null,
          current_status: t.current_status,
          context: t.context,
          // ★ Task #5581：session_id 透传（meta.sessionId → 按钮主键）。
          // core Task 实体无该字段 → 不写键（不猜）。
          ...(typeof (t as { session_id?: string | null }).session_id ===
            "string" && (t as { session_id?: string }).session_id
            ? { session_id: (t as { session_id?: string }).session_id }
            : {}),
        };
      },
      updateTaskContext: async (taskId: number, context: string) => {
        await taskComponent.updateTask!(taskId, { context });
      },
      createGroupChat: (opts) => createGroupChatViaLarkCli(opts),
      deleteGroupChat: (chatId, profile) => deleteGroupChatViaLarkCli(chatId, profile),
      notifier: sharedNotifier ?? getSharedLarkCardNotifier(),

      // ★ Task #5364 返工（BLOCKER-3）：把「旧 task 卡只有 taskId」的按钮补成
      //   标准 `{sessionId, taskId}` subject。上一版这里**没有注入**该端口
      //   （dist bundle grep = 0）⇒ 真机点旧卡刷新直接报
      //   `No card subject: sessionId is required`。
      //
      //   反查优先用 notifier 的 task→session 索引（本进程刚发过卡），
      //   再退到 task_operation 表（子会话建 task 时写过 session_id）。
      resolveSessionIdByTask: async (taskId: number) => {
        const fromNotifier = sharedNotifier?.getSessionIdByTask?.(taskId);
        if (fromNotifier) return fromNotifier;
        const tc = taskComponent as unknown as {
          getTaskIdBySessionId?: (sid: string) => Promise<number | undefined>;
        };
        // 反向用不上（接口是 session→task）：直接查持久层记录
        try {
          const rec = getSharedLarkCardStateStore().get(taskId);
          if (rec?.sessionId) return rec.sessionId;
        } catch {
          /* 持久层不可用 → 放弃反查（不猜） */
        }
        void tc;
        return undefined;
      },

      // ★ Task #5364 返工（BLOCKER-1）：**session-only 活性端口真注入**。
      //
      // 上一版 `createSessionActivityProbe` 全仓库零生产调用（只有单测注入）
      // ⇒ 用户在真机上点「🔄 刷新活性」恒显「❔ 暂无数据」。
      //
      // 数据源（真实 session store，非 mock）：
      // - `sessionComponent.get(sessionId)` → messageCount / updatedAt
      // - `sessionComponent.getMessages(id, {offset:-1,limit:1})` → 最近一条
      // - 生命周期：`BackgroundTaskManager.listTasks()` 里 subSessionId 命中
      loadSessionActivity: createSessionActivityProbe({
        getSession: async (sessionId: string) => {
          const sc = this.environment?.getComponent?.("session") as
            | {
                get?: (id: string) => Promise<
                  { messageCount?: number; updatedAt?: number } | undefined
                >;
              }
            | undefined;
          if (!sc?.get) return undefined;
          const s = await sc.get(sessionId);
          if (!s) return undefined;
          return {
            ...(typeof s.messageCount === "number"
              ? { messageCount: s.messageCount }
              : {}),
            ...(typeof s.updatedAt === "number" ? { updatedAt: s.updatedAt } : {}),
          };
        },
        getLastMessage: async (sessionId: string) => {
          const sc = this.environment?.getComponent?.("session") as
            | {
                getMessages?: (
                  id: string,
                  opts?: { offset?: number; limit?: number },
                ) => Promise<
                  Array<{ role?: string; content?: string; timestamp?: number }>
                >;
              }
            | undefined;
          if (!sc?.getMessages) return undefined;
          const tail = await sc.getMessages(sessionId, { offset: -1, limit: 1 });
          return toActivityMessage(tail?.[tail.length - 1]);
        },
        getLifecycle: (sessionId: string) => {
          const bgTasks =
            taskComponent.getBackgroundTaskManager?.()?.listTasks?.() ?? [];
          const hit = bgTasks.find(
            (t: { subSessionId?: string }) => t?.subSessionId === sessionId,
          ) as { status?: string } | undefined;
          return mapBgTaskStatusToSessionLifecycle(hit?.status);
        },
      }),
      // ★ Task #5360：sub-session 活性 probe（「🔄 刷新活性」按钮用）
      //
      // 与企微侧 `wecom-cli-handler.ts` 用**同一个工厂** `createActivityProbe`，
      // 避免两套渠道的 liveness 阈值 / 截断规则漂移。
      loadSubSessionActivity: createActivityProbe({
        listBackgroundTasks: () => taskComponent.getBackgroundTaskManager?.()?.listTasks?.(),
        getSubSessionActivity: (bgId) =>
          taskComponent.getBackgroundTaskManager?.()?.getSubSessionActivity?.(bgId),
        getLastMessage: async (subSessionId) => {
          const sessionComponent = this.environment?.getComponent?.("session") as
            | {
                getMessages?: (
                  id: string,
                  opts?: { offset?: number; limit?: number },
                ) => Promise<Array<{ role?: string; content?: string; timestamp?: number }>>;
              }
            | undefined;
          if (!sessionComponent?.getMessages) return undefined;
          // ★ 负 offset = 从尾部取（sqlite 实现在 getMessages 里把 -1 折算成
          //   total-1，见 packages/core/src/env/session/storage/sqlite.ts）
          const tail = await sessionComponent.getMessages(subSessionId, {
            offset: -1,
            limit: 1,
          });
          return toActivityMessage(tail?.[tail.length - 1]);
        },
        isTerminalTask: async (taskId: number) => {
          const t = await taskComponent.getTask?.(taskId);
          const status = (t as { status?: string } | undefined)?.status;
          return (
            status === "completed" ||
            status === "cancelled" ||
            status === "failed" ||
            status === "archived"
          );
        },
      }),
      // ★ Task #5420：「💬 会话查看」—— 尾部 N 条消息。
      //
      // ⚠️ CV BLOCKER-1 返工：必须放在 `setCardActionPorts` 的**顶层**
      //   （与 loadSessionActivity 平级）。此前误放进
      //   `createSessionActivityProbe({...})` 的入参 —— probe 只消费
      //   getSession/getLastMessage/getLifecycle，多余字段被**静默丢弃**
      //   ⇒ 生产 wiring 永远拿不到该端口，面板永不出现。
      //
      //   ⚠️ sqlite 负 offset 语义 = total + offset*limit：
      //   offset:-1, limit:5 → 最新 5 条（不是 offset:-5！
      //   那会取倒数 25~21 条）。
      loadSessionMessages: async (sessionId: string, limit?: number) => {
        const sc = this.environment?.getComponent?.("session") as
          | {
              getMessages?: (
                id: string,
                opts?: { offset?: number; limit?: number },
              ) => Promise<
                Array<{
                  role?: string;
                  content?: string;
                  timestamp?: number;
                  parts?: Array<Record<string, unknown>>;
                }>
              >;
            }
          | undefined;
        if (!sc?.getMessages) return undefined;
        const n =
          typeof limit === "number" && limit > 0 ? limit : RECENT_MESSAGE_LIMIT;
        // ⚠️ 返工（#5420，2026-11-13 08:21）：面板要展示**最近 5 条
        //   工具调用**（工具名 + arguments.reason）。工具调用藏在
        //   assistant 消息的 parts 里（一条消息可能含多个 tool-call），
        //   所以多取几倍消息再提取（5 条调用 ≈ 最多 15 条消息的量），
        //   提取后截到 limit。
        const tail = await sc.getMessages(sessionId, {
          offset: -1,
          limit: n * 3,
        });
        // ★ CV MAJOR-1（#5420 返工）：getMessages 是 ASC（旧→新），
        //   提取后必须取**尾部** n 条（最近的调用），不是头部
        //   —— slice(0,n) 会把「最近 5 条」变成「窗口内最早 5 条」。
        const calls = extractToolCallsFromMessages(tail);
        return calls.slice(-n);
      },
      // ★ Task #5580：「🗂️ 任务列表」—— 该 session 关联的全部 task（最近优先）。
      //
      // 数据源：`taskComponent.getTaskIdsBySessionId(sessionId)`（按
      // task_operation.session_id 反查，Task #5081 提供的 optional 能力），
      // 再逐个 getTask 取摘要。
      //
      // 排序：按 `updatedAt` 降序（**最近优先**），与卡片的「最近 5 个」语义
      // 对齐；updatedAt 缺失时退到 id 降序（新任务 id 更大）。
      //
      // best-effort：任何一环失败 → 返回 []（面板不渲染），绝不阻断发卡。
      loadSessionTasks: async (sessionId: string) => {
        try {
          const ids = await taskComponent.getTaskIdsBySessionId?.(sessionId);
          if (!Array.isArray(ids) || ids.length === 0) return [];
          // ★ CV P6（#5580）：**N+1 查询收敛**。一个 session 复用多次会积累
          // 上百个 task，而卡片只展示最近 5 个 —— 逐个 getTask 全量拉取在
          // 每次 create/update/终态 patch 都要重跑一遍（IO 放大明显）。
          // 裁决：先按 id 降序取**前 20 个**（给 updatedAt 重排留余量，因为
          // id 序未必等于 updatedAt 序），只有这部分取详情；总数信息由
          // `ids.length` 隐含（渲染层拿不到被截断的余量时按 tasks.length 计）。
          const SESSION_TASK_DETAIL_LIMIT = 20;
          const recentIds = [...ids].sort((a, b) => b - a).slice(0, SESSION_TASK_DETAIL_LIMIT);
          const items: Array<{
            id: number;
            title?: string;
            status?: string;
            progress?: number;
            /** 排序用（不传给渲染层，渲染只看 id/title/status/progress） */
            _ts: number;
          }> = [];
          const ts = (v: unknown): number => {
            if (typeof v !== "string") return 0;
            const n = Date.parse(v);
            return Number.isFinite(n) ? n : 0;
          };
          for (const id of recentIds) {
            try {
              const t = await taskComponent.getTask!(id);
              if (!t?.id) continue;
              const updatedAt =
                (t as { updatedAt?: string }).updatedAt ??
                (t as { updated_at?: string }).updated_at;
              items.push({
                id: t.id,
                ...(t.title ? { title: t.title } : {}),
                ...(t.status ? { status: String(t.status) } : {}),
                ...(typeof t.progress === "number" ? { progress: t.progress } : {}),
                _ts: ts(updatedAt),
              });
            } catch {
              /* 单个 task 读失败 → 跳过（不整块失败） */
            }
          }
          // **最近优先**：updatedAt 降序，同值时 id 降序（新任务 id 更大）
          items.sort((a, b) => (b._ts - a._ts) || (b.id - a.id));
          // ★ CV P6 配套：把**真实总数**一并回传（详情只取了前 20 个，
          //   渲染层的「共 N 个任务」不能退化成「共 20 个」）。
          return {
            tasks: items.map(({ _ts: _ignored, ...rest }) => rest),
            total: ids.length,
          };
        } catch (err) {
          logger.warn(
            `loadSessionTasks(${sessionId}) 失败（任务列表面板降级为空）: ` +
              `${(err as Error).message}`,
          );
          return [];
        }
      },
      // ★ Task #5580：「📌 任务里程碑」—— 选中 task 的操作记录（milestone 形态）。
      //
      // 与 loadTaskEnrichment 的 milestones 同源（listOperations → milestone
      // 字段映射），但这里是**按 taskId 现取**，供 select_task 切换时使用。
      loadTaskMilestones: async (taskId: number) => {
        try {
          // ★ CV P10（已知取舍，#5580）：limit 50 是**展示上限**，不是全量。
          //   与 loadTaskEnrichment（#5390/#5420）保持同一数据形态；
          //   超活跃任务（大量 progress 记录）早期里程碑可能被挤出窗口 ——
          //   属既有行为，改进方向是下推 milestoneType 过滤或专用接口。
          const ops = await taskComponent.listOperations?.({ taskId, limit: 50 });
          if (!Array.isArray(ops) || ops.length === 0) return [];
          return ops
            .map((op) => {
              const o = op as {
                milestoneTitle?: string;
                actionTitle?: string;
                milestoneDescription?: string;
                actionDescription?: string;
                timestamp?: string;
              };
              const title = o.milestoneTitle ?? o.actionTitle;
              if (!title) return undefined;
              return {
                title,
                timestamp: o.timestamp ?? new Date().toISOString(),
                ...(o.milestoneDescription ?? o.actionDescription
                  ? { description: o.milestoneDescription ?? o.actionDescription }
                  : {}),
              };
            })
            .filter(
              (m): m is { title: string; timestamp: string; description?: string } =>
                m !== undefined,
            );
        } catch (err) {
          logger.warn(
            `loadTaskMilestones(${taskId}) 失败（里程碑区降级为空）: ` +
              `${(err as Error).message}`,
          );
          return [];
        }
      },
      // ★ Task #5403：建群 → 初始化群 session（**关联建群**，取代已废弃的 alias）。
      //   这是**生产注入点**：没有它卡片上的 attachGroupSession 端口永远是
      //   undefined，群会话就是没有背景提示的裸会话。
      //
      //   语义：群 session 是**独立会话**（不共享历史），只注入 1 条 user role
      //   事件说明「本群由 session X 关联建群，需要背景时用
      //   `roy-bot sessions messages X` 按需读取」。关联关系写 metadata。
      attachGroupSession: async (args: {
        chatId: string;
        originSessionId: string;
        title?: string;
      }) => {
        const sessionComponent = this.environment?.getComponent?.("session") as
          | {
              attachGroupSession?: (a: {
                chatId: string;
                originSessionId: string;
                title?: string;
              }) => Promise<unknown>;
            }
          | undefined;

        if (typeof sessionComponent?.attachGroupSession !== "function") {
          logger.warn(
            `[LarkCliInstance] attachGroupSession 跳过：sessionComponent.attachGroupSession 不可用`
          );
          return;
        }

        await sessionComponent.attachGroupSession(args);
        logger.info(
          `[LarkCliInstance] 群 session 已初始化：${args.chatId} ← ${args.originSessionId}` +
            `（独立会话 + 1 条 user 事件背景提示）`
        );
      },
      // ★ Task #5397 / #5403：**会话 → 群** 反向端口（无 task 也能建群的三根支柱之一）。
      //
      //   语义等价 `task.context.larkPerTaskChatId`，但挂在 session 维度。
      //   Task #5403 起实现改为扫 metadata `linkedFromSessionId`（不再走 linked_to）。
      //
      //   没有它：session-only 建群会失去重复保护（每点一次建一个群），
      //   且解绑时找不到要解散哪个群。
      findGroupChatForSession: async (sessionId: string) => {
        const sessionComponent = this.environment?.getComponent?.("session") as
          | {
              findGroupChatForSession?: (
                sid: string
              ) => Promise<{ chatId: string; aliasSessionId?: string } | undefined>;
            }
          | undefined;

        if (typeof sessionComponent?.findGroupChatForSession !== "function") {
          logger.warn(
            `[LarkCliInstance] findGroupChatForSession 跳过：sessionComponent 不支持`
          );
          return undefined;
        }
        return await sessionComponent.findGroupChatForSession(sessionId);
      },
      // ★ Task #5403：解绑端口（disband_group 调用）—— 标记群 session 已解散。
      detachGroupSession: async (chatId: string) => {
        const sessionComponent = this.environment?.getComponent?.("session") as
          | { detachGroupSession?: (id: string) => Promise<{ ok: boolean }> }
          | undefined;

        if (typeof sessionComponent?.detachGroupSession !== "function") {
          logger.warn(
            `[LarkCliInstance] detachGroupSession 跳过：sessionComponent.detachGroupSession 不可用`
          );
          return;
        }
        const r = await sessionComponent.detachGroupSession(chatId);
        if (!r.ok) {
          logger.warn(`[LarkCliInstance] detachGroupSession 失败: ${chatId}`);
          return;
        }
        logger.info(`[LarkCliInstance] 群 session 已标记解散：${chatId}`);
      },
      // ★ Task #5397：会话标题（session-only 建群时生成群名用）。
      getSessionTitle: async (sessionId: string) => {
        const sessionComponent = this.environment?.getComponent?.("session") as
          | { get?: (id: string) => Promise<{ title?: string } | undefined> }
          | undefined;
        if (typeof sessionComponent?.get !== "function") return undefined;
        try {
          const s = await sessionComponent.get(sessionId);
          return typeof s?.title === "string" && s.title.trim() ? s.title.trim() : undefined;
        } catch {
          return undefined;
        }
      },
    });

    logger.info(
      `[LarkCliInstance] card.action.trigger 端口已注入` +
        `（notifier ${sharedNotifier ? "复用插件共享实例" : "新建实例"}）`
    );
  }

  /**
   * 获取插件的 hook 点列表
   */
  private getPluginHookPoints(plugin: any): string[] {
    // TaskPlugin 兼容模式：plugin.hooks 是数组
    if (Array.isArray(plugin.hooks)) {
      return plugin.hooks.map((h: any) => h.point || h);
    }

    // 显式声明 hookPoints 的插件（如 LarkCliWorkflowNotifyHook 的 4 个 workflow 点）
    // ★ Part 2：优先读 plugin.hookPoints，避免被下面的 task 硬编码兜底吞掉。
    if (Array.isArray(plugin.hookPoints)) {
      return plugin.hookPoints.map((h: any) => h.point || h);
    }

    // 新版 Hook 模式：直接有 execute 方法和 hookPoint
    if (typeof plugin.execute === "function" && plugin.hookPoint) {
      return [plugin.hookPoint];
    }
    
    // LarkCliTaskNotifyHook 等，按配置的 hook 点注册
    // ★ Task #3957: 必须包含 task:after.complete，否则 PerTaskGroupChatPlugin.onAfterComplete()
    //   （任务完成摘要）永远不会被触发
    //
    // ★ Task #4540: 必须包含 task:after.delete。
    //
    //   用户真机反馈：「我测试创建了一个任务，然后又取消了他。但是这个卡片消息
    //   没有变化，然后这个 pin 也没有取消。」
    //
    //   根因就是这里：用户点「取消」走的是 `TaskComponent.deleteTask()`（**硬删除**，
    //   不是 `updateTask(status="cancelled")`），所以只 fire `task:after.delete`。
    //   白名单里没有这个点 → 卡片插件永远收不到 → 卡片停在"进行中"、pin 一直挂着。
    //
    //   影响面（已逐个核对，见 Task #4540）：
    //   - 走本兜底分支的只有 `LarkCliTaskNotifyHook`（`PerTaskGroupChatPlugin`）。
    //     `PerTaskGroupChatPlugin.execute()` 的 switch 有 `default:` 分支
    //     → `logger.debug("unhandled hookPoint=..., skip")`，收到 delete 无副作用。
    //   - `LarkCliWorkflowNotifyHook` / `TaskTagPlugin` 不经过这里：
    //     前者显式声明 `hookPoints`（上面已优先 return），后者是 BasePlugin
    //     （走 `plugin.init()` 自己 `registerHook`）。
    if (plugin.name && typeof plugin.execute === "function") {
      return [
        "task:after.create",
        "task:after.update",
        "task:operation:after.create",
        "task:after.complete",
        // ★ Task #4540：取消（硬删除）后卡片收尾 + unpin
        "task:after.delete",
      ];
    }
    
    return [];
  }

  /**
   * 实例化内置 Plugin
   *
   * 早期版本是按字符串名走动态 import，会因为 bundler 把 workspace 内的 core
   * 同时识别为「内联源码」+「外部包」而产生两份 module（导致 tracer 单例分裂、
   * traceId 跨 plugin 边界丢失）。现在改成顶层静态 import + factory 注册表，
   * 让 bundler 直接看到依赖关系并完成内联。
   */
  private async importPlugin(name: string): Promise<any> {
    const factory = BUILT_IN_PLUGIN_FACTORIES[name];
    if (!factory) {
      console.error(`[LarkCliInstance] Unknown plugin: ${name}`);
      return null;
    }

    try {
      // ★ Per-plugin config（用户可在 handleRule.pluginConfig.<name> 配置）
      const pluginConfig = this.config.handleRule?.pluginConfig?.[name] ?? {};
      return factory({
        sourceId: this.config.id,
        pluginName: name,
        ...pluginConfig,
      });
    } catch (error) {
      console.error(`[LarkCliInstance] Failed to instantiate plugin ${name}:`, error);
      return null;
    }
  }

  /**
   * 注册 Plugin hooks 到 globalHookManager
   *
   * 支持三种模式：
   * 1. BasePlugin 模式：继承 BasePlugin，需要调用 init(env)
   * 2. TaskPlugin 模式：plugin.hooks 是 [{ point, priority }]
   * 3. Hook 模式：plugin.execute 是函数
   *
   * ★ Task #XXXX P0 修复：检测 plugin.setTaskUpdater 存在性，自动绑定 taskComponent.updateTask 包装。
   *   - PerTaskGroupChatPlugin 依赖 setTaskUpdater 把 larkPerTaskChatId 持久化到 DB
   *   - 未注入时：plugin 在 attachChatIdToTask 阶段只更新 in-memory，DB 没持久化 → 后续
   *     AFTER_UPDATE 从 DB 加载 task 时 getTaskChatId() 返回 undefined，所有通知 silently skip。
   *   - 修复链路：EventSourceComponent.startSource → instance.setEnvironment(env) →
   *     registerPluginHooks → env.getComponent('task').updateTask → plugin.setTaskUpdater
   */
  @TracedAs("lark-cli.registerPluginHooks", { recordParams: true, log: true })
  private registerPluginHooks(plugin: any): void {
    const pluginName = plugin.name || "unknown";

    // ★ P0 修复：自动注入 setTaskUpdater（如果 plugin 支持）
    this.injectTaskUpdater(plugin);

    // ★ Task #4039 C 项：自动注入 setTaskGetter（如果 plugin 支持）
    this.injectTaskGetter(plugin);

    // ★ Task #4023：自动注入 setSessionComponent（如果 plugin 支持）
    this.injectSessionComponent(plugin);

    // ★ Task #4230 follow-up：自动注入卡片路由端口（如果 plugin 支持）
    this.injectCardRoutingPorts(plugin);

    // BasePlugin 模式：调用 init(env) 注册 hooks
    if (typeof plugin.init === "function") {
      const pluginEnv = {
        getComponent: () => null,
        registerAgent: () => {},
        registerTool: () => {},
        registerHook: (hook: any) => {
          globalHookManager.register(hook.point, {
            name: `${pluginName}:${hook.point}`,
            priority: hook.priority ?? 0,
            pluginName,
            sourceId: this.config.id,
            execute: hook.handler,
          });
        },
        logger: {
          debug: (...args: any[]) => console.debug(`[plugin:${pluginName}]`, ...args),
          info: (...args: any[]) => console.info(`[plugin:${pluginName}]`, ...args),
          warn: (...args: any[]) => console.warn(`[plugin:${pluginName}]`, ...args),
          error: (...args: any[]) => console.error(`[plugin:${pluginName}]`, ...args),
        },
      };

      plugin.init(pluginEnv);
      return;
    }

    // 新版 Hook 模式
    if (typeof plugin.execute === "function") {
      if (plugin.hookPoint) {
        globalHookManager.register(plugin.hookPoint, {
          name: `${pluginName}:${plugin.hookPoint}`,
          priority: plugin.priority ?? 0,
          pluginName,
          sourceId: this.config.id,
          execute: plugin.execute,
        });
      } else {
        // LarkCliTaskNotifyHook 等 Hook 实例，只有 execute 方法没有 hookPoint
        const hookPoints = this.getPluginHookPoints(plugin);
        for (const hookPoint of hookPoints) {
          globalHookManager.register(hookPoint, {
            name: `${pluginName}:${hookPoint}`,
            priority: plugin.priority ?? 0,
            pluginName,
            sourceId: this.config.id,
            execute: plugin.execute.bind(plugin),
          });
        }
      }
      return;
    }

    // TaskPlugin 兼容模式
    if (Array.isArray(plugin.hooks)) {
      for (const hook of plugin.hooks) {
        const hookPoint = hook.point || hook;
        const priority = hook.priority ?? 0;

        globalHookManager.register(hookPoint, {
          name: `${pluginName}:${hookPoint}`,
          priority,
          pluginName,
          sourceId: this.config.id,
          execute: async (ctx: any) => {
            await plugin.execute(ctx);
          },
        });
      }
      return;
    }
  }

  /**
   * ★ P0 修复：如果 plugin 支持 setTaskUpdater，自动注入 taskComponent.updateTask 包装
   *
   * 链路：
   * EventSourceComponent.startSource → instance.setEnvironment(env) →
   * loadPlugins → registerPluginHooks → injectTaskUpdater(plugin) →
   * env.getComponent('task') → taskComponent.updateTask → plugin.setTaskUpdater
   *
   * 行为：
   * - plugin.setTaskUpdater 存在 && env 已注入 && taskComponent 存在 → 注入成功
   * - 任意一环缺失 → 跳过注入，plugin 走 fallback（in-memory only）
   * - 已注入（plugin.hasTaskUpdater() === true）→ 跳过，避免重复
   *
   * 日志：注入成功/失败都有 debug 日志，方便排查为什么 plugin 拿不到 DB 写权限
   */
  private injectTaskUpdater(plugin: any): void {
    if (typeof plugin.setTaskUpdater !== "function") {
      return;
    }

    // 避免重复注入
    if (typeof plugin.hasTaskUpdater === "function" && plugin.hasTaskUpdater()) {
      return;
    }

    if (!this.environment?.getComponent) {
      console.debug(
        `[LarkCliInstance] ${plugin.name || "plugin"} has setTaskUpdater but ` +
        `environment not injected (setEnvironment not called). ` +
        `chat_id 持久化将只在 in-memory，DB 不会写入。`
      );
      return;
    }

    const taskComponent = this.environment.getComponent("task") as
      | { updateTask?: (id: number, options: { context?: string }) => Promise<unknown> }
      | undefined;

    if (!taskComponent?.updateTask) {
      console.debug(
        `[LarkCliInstance] ${plugin.name || "plugin"} has setTaskUpdater but ` +
        `taskComponent or updateTask method not found. ` +
        `chat_id 持久化将只在 in-memory，DB 不会写入。`
      );
      return;
    }

    // 包装 updateTask：plugin 只需要传 context，但 taskComponent.updateTask 需要 UpdateTaskOptions
    const taskUpdater = async (taskId: number, context: string): Promise<void> => {
      await taskComponent.updateTask!(taskId, { context });
    };

    plugin.setTaskUpdater(taskUpdater);
  }

  /**
   * ★ Task #4039 C 项：如果 plugin 支持 setTaskGetter，自动注入 taskComponent.getTask。
   *
   * 用途：PerTaskGroupChatPlugin 的更新/完成/操作通知在"任务自身无群"时沿
   * `parent_task_id` 上溯祖先群，与 CLI notify 路径（resolveNotifyChatIds）统一。
   * 未注入时退化为只读自身 context（向后兼容）。
   */
  private injectTaskGetter(plugin: any): void {
    if (typeof plugin.setTaskGetter !== "function") {
      return;
    }
    if (typeof plugin.hasTaskGetter === "function" && plugin.hasTaskGetter()) {
      return;
    }
    if (!this.environment?.getComponent) {
      return;
    }
    const taskComponent = this.environment.getComponent("task") as
      | {
          getTask?: (id: number) => Promise<
            { context?: string; parent_task_id?: number | null } | undefined
          >;
        }
      | undefined;
    if (!taskComponent?.getTask) {
      if (isPluginDebugEnabled()) {
        console.debug(
          `[LarkCliInstance] ${plugin.name || "plugin"} has setTaskGetter but ` +
          `taskComponent or getTask method not found. ` +
          `sub-task 上溯祖先群将不可用。`
        );
      }
      return;
    }
    plugin.setTaskGetter((id: number) => taskComponent.getTask!(id));
  }

  /**
   * ★ Task #4230 follow-up / ★ Task #4394 精简：注入「卡片路由端口」
   *
   * ★ Task #4394 删除：`lookupChatOwnership` + `lookupChatName` + `chatNameCache`
   *   —— 卡片不再判定"触发群是不是别 task 的专属群"，因此整套群归属反查
   *   （session chat↔task 绑定 + `findTasksByContextValue` DB LIKE + lark-cli
   *   查群名）都不再需要。这同时省掉了每张卡一次 DB 查询 + 一次 lark-cli 调用。
   *
   * 保留 `getTask(id)`：无触发群时，仍需要沿 lineage 上溯找本 task / 祖先
   * 已有的专属群兜底（卡片不能丢）。
   */
  private injectCardRoutingPorts(plugin: any): void {
    if (typeof plugin.setCardRoutingPorts !== "function") return;

    const taskComponent = this.environment?.getComponent?.("task") as
      | { getTask?: (id: number) => Promise<any> }
      | undefined;

    this.cardRoutingPorts = {
      getTask: taskComponent?.getTask
        ? (id: number) => taskComponent.getTask!(id)
        : undefined,
    };
    plugin.setCardRoutingPorts({ ...this.cardRoutingPorts });

    // ★ Task #5417：给 task hook 注入「群 session 反查」端口，
    //   让 task 进展能双写到关联群 session 的卡（方案 A）。
    //   未注入 ⇒ task 侧双写退化为 no-op。
    if (
      typeof plugin === "object" &&
      "syncGroupCardFromOriginFn" in plugin
    ) {
      const sessionComponent = this.environment?.getComponent?.("session") as
        | {
            findGroupChatForSession?: (
              sid: string,
            ) => Promise<{ chatId: string; aliasSessionId?: string } | undefined>;
          }
        | undefined;
      if (typeof sessionComponent?.findGroupChatForSession === "function") {
        plugin.syncGroupCardFromOriginFn = (sid: string) =>
          sessionComponent.findGroupChatForSession!(sid);
      }
    }
  }

  /**
   * ★ Task #4023：如果 plugin 支持 setSessionComponent，自动注入 SessionComponent 引用
   *
   * 链路：
   * EventSourceComponent.startSource → instance.setEnvironment(env) →
   * registerPluginHooks → env.getComponent('session') → plugin.setSessionComponent
   *
   * 未注入时：PerTaskGroupChatPlugin 不会写 chat↔task 绑定，群消息 handler 拿不到
   *           parentTaskId 注入。task.context.larkPerTaskChatId 仍正常工作。
   */
  private injectSessionComponent(plugin: any): void {
    if (typeof plugin.setSessionComponent !== "function") {
      return;
    }

    // ★ Task #4023+#4025 OC track #5/#6：幂等检查（避免重复注入 / 覆盖既有引用）
    if (
      typeof plugin.hasSessionComponent === "function" &&
      plugin.hasSessionComponent()
    ) {
      return;
    }

    if (!this.environment?.getComponent) {
      if (isPluginDebugEnabled()) {
        console.debug(
          `[LarkCliInstance] ${plugin.name || "plugin"} has setSessionComponent but ` +
          `environment not injected (setEnvironment not called). ` +
          `chat↔task 绑定将不会写入。`
        );
      }
      return;
    }

    // ★ Task #4023+#4025 OC track #6：duck-typing 检查
    // 不依赖 SessionComponent 具体类导入，降低模块耦合；只要求
    // sessionComponent 有 upsertChatTaskBinding 方法（plugin 实际会用到的）
    const sessionComponent = this.environment.getComponent("session") as
      | { upsertChatTaskBinding?: (...args: unknown[]) => Promise<unknown> }
      | undefined;

    if (!sessionComponent?.upsertChatTaskBinding) {
      if (isPluginDebugEnabled()) {
        console.debug(
          `[LarkCliInstance] ${plugin.name || "plugin"} has setSessionComponent but ` +
          `sessionComponent or upsertChatTaskBinding not found via env.getComponent('session'). ` +
          `chat↔task 绑定将不会写入。`
        );
      }
      return;
    }

    plugin.setSessionComponent(sessionComponent);

    if (isPluginDebugEnabled()) {
      console.debug(
        `[LarkCliInstance] SessionComponent injected for plugin ${plugin.name || "unknown"} ` +
        `(sourceId=${this.config.id})`
      );
    }
  }

  /**
   * ★ Task #4023 + #4025 OC track #3 改进：查询 chat_id → task_id 绑定
   *
   * 缓存策略：依赖 SessionComponent.getChatTaskBinding 内置 LRU+TTL 缓存，
   * 这里不再重复缓存（避免失效传播问题）。
   *
   * 设计选择（采纳 OC track B 的设计哲学）：
   * - duck-typing 检查 sessionComponent.getChatTaskBinding（不依赖具体类）
   * - 仅当 binding.status === "ready" 且 taskId 是正数时才返回
   *   （保留 A 的 0/负数 fail-fast 哲学；不让 caller 处理无效 taskId）
   * - 错误 / 缺失一律 graceful 返回 null（event dispatch 不被阻塞）
   *
   * @returns taskId（如有 ready 绑定）；null 表示无绑定、缺 sessionComponent 或抛错
   */
  @TracedAs("lark-cli.resolveChatTaskBinding", {
    recordParams: true,
    recordResult: false,
    // 只暴露诊断所需的命名属性（chatId → resolvedTaskId），便于
    // `debug trace` / `debug span` 直接验证读侧是否解析到父任务。
    paramFilter: (args) => ({ chatId: args[0] }),
    flattenParamFilter: true,
    resultFilter: (taskId: number | null) => ({ resolvedTaskId: taskId }),
  })
  private async resolveChatTaskBinding(chatId: string | undefined): Promise<number | null> {
    if (!chatId) return null;
    const sessionComponent = this.environment?.getComponent?.("session") as
      | { getChatTaskBinding?: (id: string) => Promise<unknown> }
      | undefined;
    if (!sessionComponent?.getChatTaskBinding) return null;
    try {
      const binding = (await sessionComponent.getChatTaskBinding(chatId)) as
        | { taskId?: unknown; status?: string }
        | null
        | undefined;
      if (
        binding &&
        binding.status === "ready" &&
        typeof binding.taskId === "number" &&
        binding.taskId > 0
      ) {
        return binding.taskId;
      }
      return null;
    } catch (err) {
      logger.warn(
        `[LarkCliInstance] resolveChatTaskBinding failed for chatId=${chatId}: ${err}. ` +
        `群消息将不会注入 parentTaskId。`
      );
      return null;
    }
  }

  /**
   * 卸载所有已加载的 plugins
   */
  private unloadPlugins(): void {
    for (const plugin of this.loadedPlugins) {
      for (const hook of plugin.hooks) {
        globalHookManager.unregister(hook.point, `${plugin.name}:${hook.point}`);
      }
    }
    this.loadedPlugins = [];
  }

  /**
   * 把一段流文本按行切分并 dispatch（默认共享 buffer 版本，兼容旧调用/测试）
   */
  private processStream(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    this.dispatchLines(lines);
  }

  /**
   * ★ Task #4339：带**独立行缓冲**的流处理。
   *
   * 每个 consume 子进程持有自己的 buffer holder —— 两个进程的 NDJSON 切片
   * 若共用一个 buffer，会在 chunk 边界上互相错拼出坏行。
   *
   * @param opts.jsonLinesOnly true 时只 dispatch `{` 开头的完整行（stderr 用，
   *        该流里混着 `[event] ...` 状态信息）。注意判断是在**拼完整行之后**做的，
   *        所以跨 chunk 的 JSON 也能正确还原。
   */
  private processStreamWith(
    data: string,
    buffer: { value: string },
    opts: { jsonLinesOnly?: boolean } = {}
  ): void {
    buffer.value += data;
    // 防御：理论上不会发生（lark-cli 的行都以 \n 结尾），但别让坏流撑爆内存
    if (buffer.value.length > 2 * 1024 * 1024) {
      logger.warn(
        `[LarkCliInstance] stream 行缓冲超过 2MB 仍无换行，丢弃（疑似非 NDJSON 输出）`
      );
      buffer.value = "";
      return;
    }

    const lines = buffer.value.split("\n");
    buffer.value = lines.pop() || "";

    const selected = opts.jsonLinesOnly
      ? lines.filter((l) => l.trimStart().startsWith("{"))
      : lines;
    this.dispatchLines(selected);
  }

  /**
   * 逐行 dispatch。handleEvent 是 async（Task #4023 注入 parentTaskId 需要
   * await binding 查询），但这里不能阻塞 stream 读取 —— fire-and-forget，
   * 错误由 handleEvent 自己的 try/catch + span.end() 兜底。
   *
   * ★ Task #4519 (V3 修复)：**每条事件一个隔离作用域**。
   *
   *   背景（#4518 E2E 实测）：`processStreamWith` 在**单个 chunk 内同步**
   *   dispatch 多行，而 ES 层当时用进程级 `setGlobalContext()` 传递 trace
   *   上下文 —— 多行依次写入同一个单槽，**后写者赢**，于是所有下游 run 都
   *   读到最后一行 context，`debug trace` 把多个 chat 混成一棵树。
   *
   *   判据：`ROY_AGENT_MAX_CONCURRENT_SESSIONS=1` 完全串行时**依然**共用
   *   traceId ⇒ 是**状态残留**不是并发竞争 ⇒ 必须去掉进程级单槽依赖，
   *   加锁 / 串行化都治不了。
   *
   *   这里做两件事（缺一不可，都实测过）：
   *   1. `runInGlobalContextSync(undefined, ...)` —— 开一个**丢弃式**作用域，
   *      屏蔽进程级 `globalContext`（否则上一条事件读到的值会漏进来）。
   *   2. 作用域内 `setCurrentContext(undefined)` —— 清掉 tracer 级残留。
   *
   *   ⚠️ 只做第 1 步**不够**：`withGlobalContext()` 会用
   *   `new Map(this.tracerContexts)` **播种**作用域，且
   *   `getTracerCurrentContext()` 在作用域内 miss 时回落进程级表 ——
   *   所以 tracer 级残留能穿透 ALS（实测：只清 global 槽仍然串味）。
   *
   *   作用域内的写入全部落在**随后丢弃**的那张 map 里，因此 dispatch 结束后
   *   不污染进程级状态（下一条事件 / 下一轮 run 不受影响）。
   *
   *   真正的 trace 上下文由 handleEvent 放进事件载荷
   *   （`evt.metadata.traceContext`）显式下传，不再走进程级单槽 ——
   *   这才是隔离性的真正来源。
   */
  private dispatchLines(lines: string[]): void {
    const provider = getTracerProvider();
    for (const line of lines) {
      if (!line.trim()) continue;
      // 每条事件独立作用域：仍 fire-and-forget（不阻塞 stream 读取），但
      // **创建 span 的同步段**落在隔离作用域内。这已足够——trace 上下文随后
      // 通过事件载荷显式传递，不依赖 ALS 跨 await 存活（lane 延迟执行会断开）。
      void provider.runInGlobalContextSync(undefined, () => {
        // 清**所有** tracer 的 currentContext（不只 "roy-tracer"）：进程级表是
        // `instanceId → context`，只清一个名字会漏掉其它名字留下的父上下文。
        provider.clearAllTracerCurrentContexts();
        return this.handleEvent(line);
      }).catch((err) => {
        // handleEvent 内部已做 console.error + 失败回执；这里只兜住 promise，
        // 避免变成 unhandledRejection 把进程带崩（stream 读取不能被单条事件拖垮）。
        console.error(`[LarkCliInstance] handleEvent rejected: ${err}`);
      });
    }
  }

  @TracedAs("lark-cli.handleEvent", { recordParams: true, log: true })
  private async handleEvent(rawData: string): Promise<void> {
    // ★ Task #3977/3978 修复：去重
    // 先尝试解析 event_id，若 60s 内同一 instance 已处理过同一 event_id → 跳过
    // 防御 lark-cli event consume 偶发的 stdout/stderr 双发或 race 重发

    let dedupKey: string | undefined;
    try {
      const parsed = JSON.parse(rawData);
      const eid =
        (parsed as { event_id?: string }).event_id ??
        (parsed as { header?: { event_id?: string } }).header?.event_id ??
        (parsed as { id?: string }).id;
      if (typeof eid === "string" && eid.length > 0) {
        dedupKey = eid;
      }
    } catch {
      // 非 JSON（已 fallback 处理）— 不做去重
    }
    if (dedupKey) {
      const now = Date.now();
      // ★ Task #4137 P2：跨实例共享 SHARED_SEEN（同进程内多个 LarkCliInstance 共享）
      const lastShared = LarkCliInstance.SHARED_SEEN.get(dedupKey);
      if (lastShared !== undefined && now - lastShared < LarkCliInstance.SHARED_MSG_TTL_MS) {
        logger.warn(
          `[LarkCliInstance] duplicate lark-cli event suppressed across instances (event_id=${dedupKey}, ` +
          `lastSeen=${now - lastShared}ms ago). ` +
          `Task #4137: SHARED_SEEN 跨实例去重。`
        );
        return;
      }
      // 兼容旧字段（instance-level）— 保留旧行为供回退
      const last = this.recentEventIds.get(dedupKey);
      if (last !== undefined && now - last < this.DEDUP_WINDOW_MS) {
        logger.warn(
          `[LarkCliInstance] duplicate lark-cli event suppressed (event_id=${dedupKey}, ` +
          `lastSeen=${now - last}ms ago). ` +
          `Task #3977/3978: 防止同一飞书事件触发两次任务创建。`
        );
        return;
      }
      // 记录 + 清理过期（共享 + instance 双写）
      LarkCliInstance.SHARED_SEEN.set(dedupKey, now);
      this.recentEventIds.set(dedupKey, now);
      if (LarkCliInstance.SHARED_SEEN.size > LarkCliInstance.SHARED_MSG_MAX) {
        const cutoff = now - LarkCliInstance.SHARED_MSG_TTL_MS;
        for (const [k, t] of LarkCliInstance.SHARED_SEEN) {
          if (t < cutoff) LarkCliInstance.SHARED_SEEN.delete(k);
        }
      }
      if (this.recentEventIds.size > this.DEDUP_MAX_SIZE) {
        const cutoff = now - this.DEDUP_WINDOW_MS;
        for (const [k, t] of this.recentEventIds) {
          if (t < cutoff) this.recentEventIds.delete(k);
        }
      }
    }

    // 创建根 span，并把它作为**本次事件的 trace 上下文**放进事件载荷下传。
    //
    // ★ Task #4519 (V3 修复)：这里改了三件关键的事。
    //
    //  (1) **不再 `provider.setGlobalContext(...)`**。
    //      那是进程级单槽：`processStreamWith` 在一个 chunk 内同步 dispatch 多行
    //      时，多次写入依次覆盖、**后写者赢** → 所有下游 run 读到最后一行的
    //      context，多个 chat 的 span 被合并进同一个 traceId（#4518 E2E 实测）。
    //      现在改为把 context 放进 `evt.metadata.traceContext` 显式传给下游，
    //      `interactive.executeInternal` 从载荷里读 —— 天然 per-event 隔离。
    //
    //  (2) **不再手工 `startSpan("lark-cli.handleEvent")`**（去掉双重插桩）。
    //      本方法已被 `@TracedAs("lark-cli.handleEvent")` 装饰 → 装饰器**已经**
    //      建了一个同名 span。旧代码再手工建一个 → 同一 traceId 下两个同名
    //      handleEvent span，父指针链错乱，是 orphan 的来源之一。
    //      现在直接复用装饰器那个 span（= 本事件的根），只插桩一次，
    //      span 名对 `debug trace` 过滤保持兼容（仍然只有 1 个同名 span）。
    //
    //  (3) **不再伪造 `rootContext` 再 `startSpan({ context })`**。
    //      旧写法先造一个 `rootSpanId` 当"父"，而 `startSpan` 的「情况1」会把
    //      `injectedContext.spanId` 赋给新 span 的 `parentSpanId` —— 于是这个
    //      根 span 的父指针指向一个**从未作为真实 span 存在**的 id，
    //      每个事件必然产出 1 个 orphan（`debug span` 显示
    //      `Parent: <不在库里>`）。这正是 #4518 观测到的 7–8 个 orphan 的根因。
    //
    //  装饰器 span 的父由 `dispatchLines` 的隔离作用域保证是 undefined
    //  （它在作用域内 `setCurrentContext(undefined)` 之后再进入本方法）。
    const provider = getTracerProvider();
    const tracer = provider.getTracer("roy-tracer");

    // 装饰器 `@TracedAs("lark-cli.handleEvent")` 已在进入本方法前建好本事件的
    // 根 span，其 spanContext 就是 tracer 的 currentContext。直接复用，
    // 不再手工建第二个 span（双插桩会让同一 traceId 下出现两个同名 span）。
    const decoratorContext = tracer.getCurrentContext();

    // 本次事件的 trace 上下文（下游 run 靠它挂父子关系）。
    //
    // 兜底（极罕见：装饰器建 span 时抛错被 decorator.ts 吞掉）**不能再伪造**
    // traceId/spanId —— 伪造出的 spanId 从未落库，下游把它当 parent 就又造出
    // orphan（正是本次要修的病）。改为真建一个 span：它在 `dispatchLines` 的
    // 隔离作用域内，`parentSpanId` 会是 undefined，且会真实落库。
    let eventTraceContext: SpanContext;
    if (decoratorContext) {
      eventTraceContext = decoratorContext;
    } else {
      const fallbackSpan = tracer.startSpan("lark-cli.handleEvent", { parent: undefined });
      eventTraceContext = fallbackSpan.spanContext;
      fallbackSpan.end();
    }

    // ★ Task #4418：一旦解析出 replyChannel 就存到外层，catch 里用它给触发方
    // 回一条失败说明 —— event-source 层自己失败（解析 / 落库 / 分发）时，
    // 飞书侧以前只会永远等不到回复。
    let failureReplyChannel: ReplyChannel | undefined;

    try {
      let rawEvent: unknown;
      try {
        rawEvent = JSON.parse(rawData);
      } catch {
        rawEvent = { event: "message", data: { content: { type: "text", body: rawData } } };
      }

      const event = rawEvent as Record<string, unknown>;
      let eventType: string;
      const eventHeader = event.header as { event_type?: string } | undefined;
      if (eventHeader?.event_type) {
        eventType = eventHeader.event_type;
      } else if (event.schema) {
        eventType = `lark.${event.schema}`;
      } else if (event.type) {
        eventType = event.type as string;
      } else {
        eventType = "unknown";
      }

      // ★ Task #4339：card.action.trigger 走"直接回调"而不是 Agent，所以
      //   下面两件只对 Agent 链路有意义的事**全部跳过**，让卡片点击的关键路径
      //   上不留任何 DB 操作（也就不会被上一条消息的 agent 回合/DB 写锁牵连）：
      //     1) resolveChatTaskBinding（chat→task 反查，用于注入 parentTaskId）
      //     2) emitTriggerEvent（落库 trigger event，用于 delegate_task 反查回复目标）
      const isCardAction = eventType === CARD_ACTION_EVENT_TYPE;

      // 检查事件类型过滤（card.action.trigger 若被 eventTypes 挡掉会在 start() 里 warn）
      if (this.config.eventTypes?.length && !matchEventType(eventType, this.config.eventTypes)) {
        return;
      }

      // profile 注入 (#1637): 把 config 上的 profile 和 eventSourceId 注入 rawEvent,
      // 让 extractMetadata 构建的 recommendedAction 和 replyChannel 携带 profile,
      // 供 LLM 和 sendLarkMessage 知道要用哪个 profile 调用 lark-cli。
      const enrichedEvent = {
        ...(rawEvent as Record<string, unknown>),
        profile: this.config.profile,
        eventSourceId: this.config.id,
        // ★ ES-M1（Task #5144）：channelPromptMode 传给 extractMetadata，
        //   决定 recommendedAction 用 lean 动态卡片还是 legacy 长模板。
        channelPromptMode: this.config.channelPromptMode ?? "lean",
        // ★ Task #5360（补充需求）：状态通知开关随快照带下去
        //   （extractMetadata 的 replyChannel.params 读这个字段）。
        statusNotifications: this.config.statusNotifications === true,
      } as Record<string, unknown>;

      const { metadata, replyChannel, recommendedAction } = extractMetadata(enrichedEvent, eventType);

      // ★ ES-M1（Task #5144）：lean 模式下把渠道 system prompt 注入
      //   metadata.systemPrompt（仿 bounty-im），由 run.ts:1213 /
      //   run-headless-dispatch.ts:198 透传 query-executor →
      //   AgentComponent._run 追加到 LLM system message，
      //   并随 session-scope cacheSnapshot（Task #2744）字节级冻结。
      const channelSystemPrompt = this.getChannelSystemPrompt();
      if (channelSystemPrompt !== undefined) {
        metadata.systemPrompt = channelSystemPrompt;
      }

      // ★ Task #5333：ES config extendTools → metadata.extendTools
      //   （渠道专用工具放行名单）。未配置时不写该键 —— 保证 default agent
      //   在飞书 / 交互式会话里看不到 channelOnly 工具（行为不变）。
      //   下游：run.ts / run-headless-dispatch.ts → AgentContext.extendTools
      //   → AgentComponent.getAvailableTools 放行 channelOnly 工具。
      if (this.config.extendTools?.length) {
        metadata.extendTools = [...this.config.extendTools];
      }

      // ★ Task #5659：ES config toolEnv → metadata.toolEnv
      //   （工具子进程 env，解决 #5654 跨组织泄漏）。未配置时不写
      //   该键 —— 行为不变。下游：createEnvContext /
      //   buildRunEnvContext → EnvContext.toolEnv → spawn 合并。
      const esToolEnv = normalizeToolEnv(this.config.toolEnv);
      if (esToolEnv) {
        metadata.toolEnv = esToolEnv;
      }

      // Task #4418：留给 catch 的失败回执通道（后续步骤失败也能回触发方）
      failureReplyChannel = replyChannel;

      // ★ Task #4722：识别 `##command##:` 前缀消息 → 走 command 子系统（不走 Agent）。
      //   只处理纯文本消息（message_type=text / 无富文本节点）。
      //   ⚠️ 用**局部变量**而非实例字段：dispatchLines 是 fire-and-forget，
      //   两条消息可能交错处理，实例字段会互相覆盖。
      const commandText = isCardAction
        ? undefined
        : extractCommandText(enrichedEvent);

      // ★ Task #4023: 查询 chat_id → task_id 反向绑定，把 taskId 注入到 evt metadata
      // 与 env-context，让下游 task_create tool 复用为 parent_task_id。
      // （card action 不走 Agent → 不需要）
      const parentTaskId = isCardAction
        ? null
        : await this.resolveChatTaskBinding(metadata?.chatId);

      // 从 rawEvent 中提取 userId
      const userId = this.extractUserId(rawEvent);

      // ★ ESPlugin v2 (Task #4042) — P0 fix: 生产端落库 trigger event。
      //
      // 之前 emitTriggerEvent 只有测试调用，生产链路不产生 triggerEventId，
      // 导致 delegate_task 的 triggerEventId 参数永远拿不到值，#4035/#4038/#4039
      // 的 v2 修复在生产上 unreachable。
      //
      // 这里每次收到 lark 消息时，只要进程内注册了共享 EventStore，就把原始
      // event 落库拿 triggerEventId，并注入到 message / evt.metadata / evt.payload，
      // 让主 agent 能看到并透传给 delegate_task。
      //
      // ★ Task #4339：card.action.trigger **不落库** —— 它不触发 Agent，也就不会有
      //   delegate_task 需要反查回复目标；而卡片原始事件带 card_content（可能几十 KB），
      //   每次点击都写一遍既浪费又会拖慢响应。
      let triggerEventId: string | undefined;
      const sharedStore = isCardAction ? undefined : getSharedEventStore();
      if (sharedStore && larkCliHandler.emitTriggerEvent) {
        try {
          triggerEventId = await larkCliHandler.emitTriggerEvent(
            {
              senderId: userId,
              // 原始文本在 rawEvent 里，这里不重复解析（text 可选，留档用）
              text: undefined,
              metadata: {
                eventType,
                appId: metadata?.appId,
                chatId: metadata?.chatId,
                chatType: metadata?.chatType,
                messageId: metadata?.messageId,
                messageType: metadata?.messageType,
                senderId: userId,
                tenantKey: metadata?.tenantKey,
                profile: this.config.profile,
              },
              rawEvent,
            },
            sharedStore,
          );
        } catch (err) {
          // 落库失败不阻塞事件处理（向后兼容：无 triggerEventId 时走老回复路径）
          console.error(
            `[LarkCliInstance] emitTriggerEvent failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ★ Task #5473：精简 agent 可见信封 —— rawData 只保留必要字段。
      //
      // 之前 rawData 是完整原始 event JSON（含 createTime / updateTime /
      // type / event_id / timestamp / id / message_type / sender_type
      // 等冗余栏位），白白消耗 agent token。现在只保留 agent 回复真正
      // 需要的：chat_id / message_id / sender_id / chat_type / content /
      // mentions（@ 收件人）。
      //
      // ⚠️ 下游不受影响：self-echo filter / dedup / extractMetadata 读的
      // 是 evt.payload.rawEvent（完整原始 event，见下方 payload 构造），
      // 不是 prompt 文本。
      const slimRawData = buildSlimRawData(rawEvent);
      // message 包含原始数据和推荐动作，用于指导 Agent 反馈
      const message = JSON.stringify({
        rawData: slimRawData,
        recommendedAction,
        // ★ ESPlugin v2: 让主 agent 看到 triggerEventId，delegate_task 时透传
        ...(triggerEventId ? { triggerEventId } : {}),
      });
      const timestamp = Date.now();

      // 构建 pluginEnabled
      const plugins = this.config.handleRule?.plugins || [];
      const pluginEnabled: Record<string, boolean> = {};
      for (const pluginName of plugins) {
        pluginEnabled[`${this.config.id}:${pluginName}`] = true;
      }

      // 提取 handleRule.agent（事件处理时使用的 agent 名称）
      const agent = this.config.handleRule?.agent;

      // 构建符合 EnvEvent 结构的 EventSourceEvent
      const evt: EventSourceEvent = {
        id: `es-${this.config.id}-${timestamp}`,
        type: "event-source.event.lark-cli",
        timestamp,
        metadata: {
          source: "event-source",
          sourceId: this.config.id,
          sourceMessageType: eventType,
          plugins,
          pluginEnabled,
          replyChannel,
          agent,
          // ★ ES-M1（Task #5144）：渠道 systemPrompt 注入（lean 模式），
          //   由 run.ts:1213 / run-headless-dispatch.ts:198 透传
          //   query-executor → AgentComponent._run 追加到 LLM system
          //   message，并随 session-scope cacheSnapshot 字节级冻结。
          //   （payload.metadata 是 extractMetadata 的对象副本，
          //   两处都要注入。）
          ...(channelSystemPrompt !== undefined
            ? { systemPrompt: channelSystemPrompt }
            : {}),
          // ★ Task #5333：渠道专用工具放行名单（ES config extendTools）。
          //   未配置时不写该键 —— default agent 在飞书 / 交互式会话里
          //   看不到 channelOnly 工具（行为不变）。
          ...(this.config.extendTools?.length
            ? { extendTools: [...this.config.extendTools] }
            : {}),
          // ★ Task #5659：工具子进程 env（ES config toolEnv）。
          //   未配置时不写该键 —— 行为不变。
          ...(esToolEnv ? { toolEnv: esToolEnv } : {}),
          // ★ Task #4023: 群绑定的 taskId（如有），供 task_create tool 复用为 parent_task_id
          parentTaskId: parentTaskId ?? undefined,
          // ★ ESPlugin v2: triggerEventId 注入 event metadata，供 delegate_task 透传
          ...(triggerEventId ? { triggerEventId } : {}),
          // ★ Task #4519 (V3): 本次事件的 trace 上下文**随载荷下传**，
          //   取代原来的进程级 `setGlobalContext()` 单槽。
          //   下游 `interactive.executeInternal` 从 `envEvent.metadata.traceContext`
          //   读取 → 每个事件各自挂在**自己**的根 span 下，天然隔离。
          traceContext: eventTraceContext,
        },
        payload: {
          sourceId: this.config.id,
          sourceType: "lark-cli",
          rawEvent,
          message,
          metadata,
          replyChannel,
          recommendedAction,
          timestamp,
          // ★ Task #4023: 同上，payload 副本方便直接消费
          parentTaskId: parentTaskId ?? undefined,
          // ★ ESPlugin v2: triggerEventId 副本，供下游直接消费
          ...(triggerEventId ? { triggerEventId } : {}),
        },
      };

      // 构建 ReplyChannel
      const envReplyChannel = this.buildReplyChannel(replyChannel);

      // 创建 EnvContext 并注入
      // ★ Task #2326: 把 messageId 显式传入 createEnvContext,
      // 让子 Agent（delegate_task 派生的 sub-session）通过
      // getEnvContext()?.messageId 拿到原 user query 的 messageId,
      // 使其飞书回复优先用 +messages-reply 关联回原 query。
      //
      // ★ Task #2331: 改为注入 EventEnvelope 通用 event 容器
      // 之前是 larkEvent 字段 (lark 专属), 现在是 event (EventEnvelope).
      // source='lark' + payload=rawEvent + id=messageId, 让 plugin 自己做类型转换.
      const larkMessageId = replyChannel?.messageId ?? metadata?.messageId;
      const envContext = createEnvContext({
        envEvent: evt,
        sourceId: this.config.id,
        userId,
        messageId: larkMessageId,
        event: larkMessageId
          ? {
              source: "lark",
              id: larkMessageId,
              receivedAt: new Date(timestamp).toISOString(),
              payload: rawEvent,
              metadata: {
                chatId: metadata?.chatId,
                userId,
                chatType: metadata?.chatType,
                profile: replyChannel?.profile,
                appId: metadata?.appId,
              },
            }
          : undefined,
        replyChannel: envReplyChannel,
        pluginEnabled,
        plugins,
        // ★ Task #4023 修复：把 chat↔task 绑定解析出的 parentTaskId 真正写进
        // EnvContext（此前只写进 evt.metadata / evt.payload，EnvContext 永远是
        // undefined，导致 task_create 的 env 继承分支永不生效）。
        // 仅注入合法正整数，其余（0 / 负数 / 非数字 / undefined）一律省略。
        parentTaskId: normalizeParentTaskId(parentTaskId),
      });

      // 在 EnvContext 中执行事件处理
      runWithEnvContext(envContext, () => {
        // ★ Task #4331：card.action.trigger 事件走专属 callback handler（不走 Agent）
        //   用户在卡片顶部点"建群/解散"按钮 → 飞书推 card.action.trigger
        //   → 这里直接调 handleCardAction（建/解散群 + patch 卡片）
        //   → 不需要 Agent 处理（不调用 eventHandler）
        if (eventType === CARD_ACTION_EVENT_TYPE) {
          void this.handleCardActionEvent(rawEvent, envReplyChannel?.profile);
          return;
        }

        // ★ Task #4722：`##command##:` 开头的消息 → 走 command 子系统（不走 Agent）
        //   用户在飞书输入「##command##: list model」→ 直接执行 command，
        //   用卡片消息回显，**不启动 agent 回合**（省 token、响应更快）。
        //   与 card.action.trigger 同级：都是"确定性动作"，不需要 LLM 参与。
        if (commandText !== undefined) {
          void this.handleCommandMessage(
            commandText,
            envReplyChannel?.profile,
            replyChannel?.messageId,
            replyChannel?.chatId
          );
          return;
        }

        this.eventHandler?.(evt);
      });
    } catch (error) {
      console.error(`[LarkCliInstance] Error handling event: ${error}`);

      // ★ Task #4519：不再手工 `rootSpan.end()`。
      //
      //   本方法由 `@TracedAs("lark-cli.handleEvent")` 装饰 → 装饰器自己会 end
      //   那个 span。旧代码手工 end 的是**另一个**（重复插桩出来的）span，
      //   两个同名 span 同 trace 是 orphan 的帮凶之一；现在只保留装饰器那份。
      //
      //   ⚠️ 错误可见性：本 catch 末尾会 **rethrow**，让装饰器把 span 标成 error。
      //   （旧代码是因为自己 end 手工 span 才能顺手 setAttribute；现在删了手工
      //   span，若继续吞异常，ES 层失败会在 `debug trace` 里显示 ok ——
      //   那正是 #4515 记录过的「静默失败几周才发现」类问题。）
      //   stream 读取不会被拖垮：`dispatchLines` 对该 promise 做了 `.catch()`。


      // ★ Task #4418：不允许沉默。
      // 这里是 event-source 自己的失败（解析 / replyChannel 提取 / 落库 / 分发），
      // 触发方在飞书里只会一直等。best-effort 回一条失败说明；绝不 await（不能
      // 阻塞 stream 读取），也绝不抛（notifyReactFailure 自身已保证不抛）。
      void notifyReactFailure({
        error,
        replyChannel: failureReplyChannel,
      }).catch(() => {
        /* 兜底 reply 永不影响主流程 */
      });

      // ★ Task #4519：**重新抛出**，让 @TracedAs 装饰器把该 span 标成 error
      //   （否则 ES 层失败在 `debug trace` 里仍显示 ok）。调用方 `dispatchLines`
      //   已经 `.catch()` 兜住，不会变成 unhandledRejection，也不会影响其它事件。
      throw error;
    }
  }

  /**
   * 处理 card.action.trigger 事件（Task #4331）
   *
   * 流程：
   *   1. 解析 event.action_value（JSON 字符串）拿到 { action, taskId }
   *   2. 调 handleCardAction（建群/解散群 + 写 task.context + 渲染新卡片）
   *   3. 用 event.token 调 lark-cli api POST /open-apis/interactive/v1/card/update patch 原卡片
   *      （飞书要求用 token 即时 patch，30min 有效）
   *
   * ★★ 如何真正收到 card.action.trigger（Task #4339 修正）★★
   *
   * 旧注释写的是「把 command 改成
   * `lark-cli event consume 'im.message.receive_v1,card.action.trigger' --as bot`」
   * —— 这是**错的**：lark-cli `event consume` 只接受恰好一个 EventKey，
   * 逗号形式会 `unknown EventKey` 并 **exit 2**，整个 event-source 变 error。
   *
   * 正确做法：在 EventSource config 里配置 `eventKeys` 数组
   * （一个 key 一个子进程，共享同一个 bus daemon）：
   *
   *   {
   *     "type": "lark-cli",
   *     "profile": "tongzhuli",
   *     "eventKeys": ["im.message.receive_v1", "card.action.trigger"]
   *   }
   *
   * 且必须先在飞书开发者后台「事件与回调 → 回调配置」里开启 card.action.trigger，
   * 否则 consumer 能 ready 但永远收不到事件。
   * 详见 reports/2026-10-19-lark-cli-multi-event-consume-research.md
   */
  private async handleCardActionEvent(
    rawEvent: unknown,
    profile: string | undefined
  ): Promise<void> {
    try {
      const event = rawEvent as Record<string, unknown>;
      // ★ Task #4722 收口：**command 卡片**的回调（fbmodel_* 动作）分流到
      //   command 子系统（改 fallback 列表），与 task 卡片的建群/解散群
      //   是两套完全不同的语义 → 独立处理路径。
      if (this.isCommandCardActionEvent(event)) {
        await this.handleCommandCardActionEvent(event, profile);
        return;
      }

      // ★ lark-cli event consume 的 card.action.trigger 字段（看 lark-cli event schema）
      const actionValueStr = (event.action_value as string) || "{}";
      const actionValue = JSON.parse(actionValueStr);
      const token = (event.token as string) || "";
      const messageId = (event.message_id as string) || "";
      const chatId = (event.chat_id as string) || "";
      const operatorId = (event.operator_id as Record<string, string>)?.open_id
        ?? (event.operator_id as string)
        ?? undefined;

      if (!token || !messageId || !chatId) {
        logger.warn(
          `[LarkCliInstance] handleCardActionEvent: missing token/messageId/chatId, skip`
        );
        return;
      }

      // ★ Task #4331：ports 未注入时直接 skip（不阻塞已有事件处理）
      if (!this.cardActionPorts) {
        logger.warn(
          `[LarkCliInstance] handleCardActionEvent: cardActionPorts 未注入，` +
            `card.action.trigger 事件被跳过。` +
            `调 instance.setCardActionPorts({getTask, updateTaskContext, createGroupChat, deleteGroupChat, notifier}) 注入。`
        );
        return;
      }

      const result = await handleCardAction(
        {
          actionValue,
          chatId,
          messageId,
          token,
          operatorId,
          profile,
        },
        this.cardActionPorts  // 完整 ports 对象（包含 notifier）
      );

      // ★ 用飞书 token patch 卡片（30min 有效，最多 2 次）
      if (result.ok && result.cardUpdate) {
        const patch = this.cardActionPorts.patchByToken ?? patchCardByLarkCli;
        // ★ Task #5414：patch 成功时原本静默 → 排查「建群后卡片没更新」时
        //   无法确证 patch 是否真的发出。补一条 INFO（含 messageId + action）。
        try {
          await patch(token, result.cardUpdate, profile);
          logger.info(
            `[LarkCliInstance] 卡片 patch 成功: messageId=${messageId} action=${String(result.action)} chatId=${chatId}`
          );
        } catch (patchErr) {
          logger.warn(
            `[LarkCliInstance] 卡片 patch 失败: messageId=${messageId} ` +
              `action=${String(result.action)} error=${(patchErr as Error).message}` +
              `（token 30min 有效，过期即失败——需用新卡重试）`
          );
        }
      } else {
        logger.warn(
          `[LarkCliInstance] handleCardActionEvent failed: ${result.error ?? "unknown"}`
        );
      }
    } catch (err) {
      logger.error(
        `[LarkCliInstance] handleCardActionEvent error: ${(err as Error).message}`
      );
    }
  }

  /**
   * ★ Task #4722：处理 `##command##:` 命令消息（**不走 Agent 链路**）
   *
   * 流程：
   *   1. 交给 command 子系统分发（command-registry.ts）
   *   2. 结果是 card → 用 `lark-cli im +messages-reply --msg-type interactive` 发卡片
   *   3. 结果是 text → 用 `--markdown` 发文本
   *   4. 失败 → 发错误回执（不静默）
   *
   * 与 card.action.trigger 的共同点：**确定性动作，不需要 LLM 参与**。
   * 差异：card.action.trigger 是「飞书推的卡片点击」，这里是「用户敲的命令」。
   */

  /**
   * ★ Task #4722 收口：判断一个 card.action.trigger 事件是不是 **command 卡片**回调。
   *
   * command 卡片用 `fbmodel_*` 动作命名空间（见 command-cards.ts），
   * 与 task 卡片的 `create_group` / `disband_group` 区分开。
   */
  private isCommandCardActionEvent(event: Record<string, unknown>): boolean {
    let actionValue: Record<string, unknown> | undefined;
    const raw = event.action_value;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          actionValue = parsed as Record<string, unknown>;
        }
      } catch {
        actionValue = undefined;
      }
    } else if (raw && typeof raw === "object") {
      actionValue = raw as Record<string, unknown>;
    }

    let formValue: Record<string, unknown> | undefined;
    const rawForm = event.form_value;
    if (typeof rawForm === "string") {
      try {
        const parsed = JSON.parse(rawForm) as unknown;
        if (parsed && typeof parsed === "object") {
          formValue = parsed as Record<string, unknown>;
        }
      } catch {
        formValue = undefined;
      }
    } else if (rawForm && typeof rawForm === "object") {
      formValue = rawForm as Record<string, unknown>;
    }

    return isCommandCardAction({
      actionValue,
      actionName: typeof event.action_name === "string" ? event.action_name : undefined,
    });
  }

  /**
   * ★ Task #4722 收口：处理 command 卡片按钮回调（改 fallback 列表）。
   *
   * 流程：
   *   1. 翻译成 command 调用（reorder / add）
   *   2. 交给 command 子系统执行
   *   3. 用飞书 token（30min / 2 次）patch 原卡片 → 用户看到最新列表
   *
   * 失败 → 回一条文本消息告诉用户（不静默）。
   */
  private async handleCommandCardActionEvent(
    event: Record<string, unknown>,
    profile: string | undefined
  ): Promise<void> {
    let actionValue: Record<string, unknown> | undefined;
    try {
      actionValue =
        typeof event.action_value === "string"
          ? (JSON.parse(event.action_value) as Record<string, unknown>)
          : (event.action_value as Record<string, unknown>);
    } catch {
      actionValue = undefined;
    }

    let formValue: Record<string, unknown> | undefined;
    try {
      formValue =
        typeof event.form_value === "string"
          ? (JSON.parse(event.form_value) as Record<string, unknown>)
          : (event.form_value as Record<string, unknown>);
    } catch {
      formValue = undefined;
    }

    const result = await handleCommandCardAction(
      {
        actionValue,
        formValue,
        actionName:
          typeof event.action_name === "string" ? event.action_name : undefined,
        chatId: typeof event.chat_id === "string" ? event.chat_id : undefined,
        messageId:
          typeof event.message_id === "string" ? event.message_id : undefined,
        token: typeof event.token === "string" ? event.token : undefined,
        profile,
      },
      {
        executeCommand: async (subcommand, args, extra) => {
          const registry = getGlobalCommandRegistry();
          return registry.dispatch(subcommand, args, {
            rawText: `##command##: ${subcommand} ${args.join(" ")}`,
            configPath: extra?.configPath ?? this.resolveCommandConfigPath(),
          });
        },
        configPath: this.resolveCommandConfigPath(),
        patchCard: async (token, card, prof) => {
          await patchCardByLarkCli(token, card, prof);
        },
      }
    );

    if (!result.ok) {
      // 失败回执：回一条 markdown 文本（不静默）
      const text = `⚠️ 命令卡片操作失败：${result.error ?? "未知错误"}`;
      const messageId =
        typeof event.message_id === "string" ? event.message_id : undefined;
      const chatId =
        typeof event.chat_id === "string" ? event.chat_id : undefined;
      try {
        await this.sendLarkText(text, profile, messageId, chatId);
      } catch {
        /* 回执失败只记日志，不影响 es 主循环 */
      }
      return;
    }

    // ★ Task #4722 round3（MINOR m1）：业务动作成功但**卡片刷新失败** →
    //   给用户回执（否则卡片静默停在旧状态，用户以为没生效）。
    if (result.patchError) {
      const text =
        `⚠️ 操作已生效（${result.executed ?? "命令"}），但卡片刷新失败：` +
        `${result.patchError}\n` +
        `（飞书卡片 token 有效期 30 分钟、最多刷新 2 次；可用 ` +
        `「##command##: list model」重新获取一张新卡片）`;
      const messageId =
        typeof event.message_id === "string" ? event.message_id : undefined;
      const chatId =
        typeof event.chat_id === "string" ? event.chat_id : undefined;
      try {
        await this.sendLarkText(text, profile, messageId, chatId);
      } catch {
        /* 回执失败只记日志，不影响 es 主循环 */
      }
    }
  }

  private async handleCommandMessage(
    text: string,
    profile?: string,
    messageId?: string,
    chatId?: string
  ): Promise<void> {
    try {
      const configPath = this.resolveCommandConfigPath();
      const result = await dispatchCommand(text, { configPath });

      if (!result) {
        // 不是 command 消息 —— 理论上不会走到这（调用方已用 isCommandMessage 过滤）。
        // ★ Task #4722 round2（交叉验证 MINOR-4）：**绝不**把 undefined 喂给 agent 链路
        //   （旧代码 `this.eventHandler?.(undefined as any)` 是地雷：
        //   agent 侧会拿到 undefined 事件再崩）。改为回一张错误卡片。
        const card = renderTextCard(
          "⚠️ 命令无法识别",
          "这条消息没有被识别为有效命令。请用「##command##: <命令> [参数]」格式。"
        );
        await this.sendLarkCard(card, profile, messageId, chatId);
        return;
      }

      if (!result.ok) {
        // 失败：把错误与用法回执给用户
        const card = renderTextCard("⚠️ 命令执行失败", result.error ?? "未知错误");
        await this.sendLarkCard(card, profile, messageId, chatId);
        return;
      }

      const output = result.output;
      if (!output) {
        const card = renderTextCard("⚠️ 命令无输出", "命令执行成功但没有产生任何输出。");
        await this.sendLarkCard(card, profile, messageId, chatId);
        return;
      }

      // ★ Task #4722 收口：CommandOutput 是**双形态**（text 必填 + card 可选）。
      //   优先发飞书 interactive 卡片；没有 card 时降级为 markdown 文本。
      if (output.card) {
        await this.sendLarkCard(output.card, profile, messageId, chatId);
        return;
      }

      // text 输出 → 用 markdown 文本回执
      await this.sendLarkText(output.text, profile, messageId, chatId);
    } catch (err) {
      logger.error(
        `[LarkCliInstance] handleCommandMessage error: ${(err as Error).message}`
      );
      try {
        const card = renderTextCard(
          "⚠️ 命令执行异常",
          `命令处理时发生异常：${(err as Error).message}`
        );
        await this.sendLarkCard(card, profile, messageId, chatId);
      } catch {
        // 回执也失败 → 只能记日志（不抛，避免影响 es 主循环）
      }
    }
  }

  /**
   * 解析 command 用的配置文件路径。
   *
   * 优先 event-source 配置里的 `options.configPath`（测试可注入临时路径），
   * 否则用默认 `~/.roy-bot/config.jsonc`。
   */
  private resolveCommandConfigPath(): string | undefined {
    const configured = this.config?.options?.configPath;
    return typeof configured === "string" ? configured : undefined;
  }

  /**
   * 发送飞书 interactive 卡片。
   *
   * 用 `lark-cli im +messages-reply --msg-type interactive --content '<json>'`。
   * 优先 reply 原消息（带 messageId），否则发到 chatId。
   */
  private async sendLarkCard(
    card: Record<string, unknown>,
    profile?: string,
    messageId?: string,
    chatId?: string
  ): Promise<void> {
    const content = JSON.stringify(card);
    await this.spawnLarkCli(["im"], profile, messageId, chatId, [
      "--msg-type",
      "interactive",
      "--content",
      content,
    ]);
  }

  /** 发送飞书 markdown 文本 */
  private async sendLarkText(
    text: string,
    profile?: string,
    messageId?: string,
    chatId?: string
  ): Promise<void> {
    await this.spawnLarkCli(["im"], profile, messageId, chatId, ["--markdown", text]);
  }

  /**
   * 统一的 lark-cli 发消息调用。
   *
   * 身份固定 `bot`（Task #4557：非 bot 会被 event consume 回灌）。
   */
  private async spawnLarkCli(
    baseArgs: string[],
    profile: string | undefined,
    messageId: string | undefined,
    chatId: string | undefined,
    contentArgs: string[]
  ): Promise<void> {
    const args: string[] = [...baseArgs];
    if (messageId) {
      args.push("+messages-reply", "--message-id", messageId, "--as", "bot");
    } else if (chatId) {
      args.push("+messages-send", "--chat-id", chatId, "--as", "bot");
    } else {
      throw new Error("No target specified for sending message");
    }
    args.push(...contentArgs);
    if (profile) {
      args.unshift("--profile", profile);
    }

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("lark-cli", args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`lark-cli exited with code ${code}: ${stderr}`));
      });
      proc.on("error", reject);
    });
  }

  /**
   * 用飞书 token 直接 patch 卡片（30min 有效，最多 2 次）
   *
   * 飞书 API: POST /open-apis/interactive/v1/card/update
   *
   * ★ Task #4337 Bug B fix + refactor：
   *   - 抽出为 module-level exported function `patchCardByLarkCli`（可独立测试 cmd 字符串）
   *   - 删掉 `--yes`（lark-cli 1.0.96 `api` 子命令不支持 `unknown flag "--yes"`）
   */
  private async patchCardByToken(
    token: string,
    card: any,
    profile?: string
  ): Promise<void> {
    return patchCardByLarkCli(token, card, profile);
  }

  /**
   * 从 rawEvent 中提取 userId
   *
   * ★ Task #3987 后续修复：兼容 lark-cli `event consume` 的简化格式
   *   - 嵌套格式: event.event.sender.sender_id.open_id
   *   - 简化格式: event.sender_id（顶层字符串）
   */
  private extractUserId(rawEvent: unknown): string {
    const event = rawEvent as Record<string, unknown>;
    const innerEvent = event.event as Record<string, unknown> | undefined;
    const message = (innerEvent?.message || event.message) as Record<string, unknown> | undefined;
    const sender = (innerEvent?.sender || event.sender || message?.sender) as Record<string, unknown> | undefined;
    const senderId = sender?.sender_id as Record<string, unknown> | string | undefined;

    // ★ 简化格式优先：顶层 sender_id 是字符串 "ou_xxx"
    if (typeof event.sender_id === "string") {
      return event.sender_id;
    }
    if (typeof senderId === "string") {
      return senderId;
    }
    return (senderId?.open_id as string) ||
           (senderId?.user_id as string) ||
           (senderId?.union_id as string) ||
           "unknown";
  }

  /**
   * 构建 EnvReplyChannel
   */
  private buildReplyChannel(replyChannel?: ReplyChannel): EnvReplyChannel | undefined {
    // 如果没有 replyChannel，返回 undefined
    if (!replyChannel || (!replyChannel.chatId && !replyChannel.messageId)) {
      return undefined;
    }

    // profile 注入 (#1637): 用对应 event-source 的 lark-cli profile 发送消息,
    // 避免飞书 openId 跨 app 错误 (99992361)。
    const profile = replyChannel.profile;

    return {
      type: replyChannel.type,
      messageId: replyChannel.messageId,
      chatId: replyChannel.chatId,
      userId: replyChannel.params?.userId as string | undefined,
      // ★ P0 修复：把 appId 从 event-source ReplyChannel 透传给 env-context replyChannel，
      // 让 plugin（如 PerTaskGroupChatPlugin）能从中拿到当前 event 的接收 bot，
      // 在新建群聊时通过 --bots 把它自动拉入。
      appId: replyChannel.appId,
      profile,
      identity: "bot",
      sendText: async (text: string) => {
        await this.sendLarkMessage({
          chatId: replyChannel.chatId,
          userId: replyChannel.params?.userId as string | undefined,
          content: text,
          profile,
        });
      },
      sendMarkdown: async (markdown: string) => {
        await this.sendLarkMessage({
          chatId: replyChannel.chatId,
          userId: replyChannel.params?.userId as string | undefined,
          content: markdown,
          format: "markdown",
          profile,
        });
      },
      sendMessage: async (content: unknown) => {
        await this.sendLarkMessage({
          chatId: replyChannel.chatId,
          userId: replyChannel.params?.userId as string | undefined,
          content: JSON.stringify(content),
          profile,
        });
      },
      reply: async (content: unknown) => {
        if (replyChannel.messageId) {
          await this.sendLarkMessage({
            messageId: replyChannel.messageId,
            content: JSON.stringify(content),
            profile,
          });
        }
      },
    };
  }

  /**
   * 使用 lark-cli 发送消息
   */
  private async sendLarkMessage(options: {
    chatId?: string;
    userId?: string;
    messageId?: string;
    content: string;
    format?: "text" | "markdown";
    /**
     * lark-cli profile（多 appId 场景用）
     *
     * 传值时 spawn `lark-cli --profile <name> ...` 调用对应 app 的 lark-cli。
     * 不传时使用 lark-cli 的 active profile（默认行为）。
     */
    profile?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const { chatId, userId, messageId, content, format = "text", profile } = options;

      // ★ Task #3993：规范化 @-mention 语法（自闭合 → 空闭合），触发实际通知
      const normalizedContent = normalizeLarkAtMentions(content);

      const contentFlag = format === "markdown" ? "--markdown" : "--text";
      // ★ Task #2326 修复: 之前 args 初始值固定为 ["im", "+messages-send", "--as", <身份>],
      // messageId 路径再 push "+messages-reply" → lark-cli 同时收到两个冲突命令.
      // 正确做法: 根据目标类型选择单一命令 (+messages-reply | +messages-send).
      //
      // ★ Task #4557：身份从「调用方传的 as 参数（"bot" | "user" 变量）」收窄为
      //   **写死的字面量 "bot"**。原因：不带 --as bot 时 lark-cli 用默认身份 =
      //   user（真人账号）发出 → `lark-cli event consume im.message.receive_v1`
      //   只看「是不是 user 发的」→ bot 自己的消息被同一个 consumer 当用户消息
      //   回灌 → 又跑一次完整 agent run（Task #4552 实测回灌率 5/11 = 45%，
      //   补 flag 后 0/5 = 0%）。
      //
      //   收窄前 `as` 是变量，一致性测试只能断言「调用点传了什么」，断言不到
      //   「变量真的被拼进 args」—— identity 被改成 "user" 或 `--as` 被整段删掉，
      //   测试都不会红（交叉验证实测发现）。收窄后 args 里的身份是字面量，
      //   跨文件扫描测试能直接盯住，白名单也可以整块删掉。
      //
      //   4 个调用点本来就全传 "bot"、"user" 分支零使用，所以行为不变。
      const args: string[] = ["im"];

      if (messageId) {
        // 回复消息
        args.push("+messages-reply", "--message-id", messageId, "--as", "bot", contentFlag, normalizedContent);
      } else if (chatId) {
        args.push("+messages-send", "--chat-id", chatId, "--as", "bot", contentFlag, normalizedContent);
      } else if (userId) {
        args.push("+messages-send", "--user-id", userId, "--as", "bot", contentFlag, normalizedContent);
      } else {
        reject(new Error("No target specified for sending message"));
        return;
      }

      // profile 注入 (#1637): 在 args 头部插入 --profile <name>
      if (profile) {
        args.unshift("--profile", profile);
      }

      const proc = spawn("lark-cli", args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`lark-cli exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", reject);
    });
  }
}

/**
 * notify 事件终态类型（Bug A / #4105 修复）。
 *
 * 只有终态结果事件才引导主 agent 回复用户；
 * started/progress 中间态、ask_user 交互态只做状态同步
 * （见 buildNotifyHandlePrompt）。
 */
const NOTIFY_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "task.background.completed",
  "task.background.failed",
  "task.background.timeout",
  "task.background.stopped",
]);

/**
 * 按 notify 事件子类型生成标题句（Bug A / #4105 修复）。
 *
 * 历史 bug：buildNotifyHandlePrompt 对一切 task.background.* 硬编码
 * "Sub-agent 完成了…"，导致 started/progress 也被渲染成"完成"，
 * 主 agent 误判并提前回复用户。
 *
 * @returns headline: 标题句；actionable: 是否需要引导主 agent 回复用户
 */
function describeNotifyEvent(
  type: string,
  taskId: number | string,
  desc: string,
): { headline: string; actionable: boolean } {
  const actionable = NOTIFY_TERMINAL_TYPES.has(type);
  switch (type) {
    case "task.background.completed":
      return { headline: `Sub-agent 完成了 Task #${taskId}「${desc}」。`, actionable };
    case "task.background.failed":
      return { headline: `Sub-agent 执行 Task #${taskId}「${desc}」失败。`, actionable };
    case "task.background.timeout":
      return { headline: `Sub-agent 执行 Task #${taskId}「${desc}」超时。`, actionable };
    case "task.background.stopped":
      return { headline: `Sub-agent 已停止 Task #${taskId}「${desc}」。`, actionable };
    case "task.background.ask_user":
      return { headline: `Sub-agent 在 Task #${taskId}「${desc}」中请求用户输入。`, actionable };
    case "task.background.started":
      return { headline: `Sub-agent 已启动 Task #${taskId}「${desc}」（后台运行中）。`, actionable };
    case "task.background.progress":
      return { headline: `Sub-agent 仍在执行 Task #${taskId}「${desc}」（进行中）。`, actionable };
    default:
      return { headline: `Sub-agent 更新了 Task #${taskId}「${desc}」。`, actionable };
  }
}

/**
 * 渲染「系统回执」小节 —— 告诉主 agent：群里**已经**看到了什么。
 *
 * 三种状态必须分开，否则 agent 会二选一地犯两种错：
 *   - 已送达却把「已超时」再讲一遍 → 重复刷屏
 *   - 未送达却以为发了 → 用户永远不知道任务结束了（正是 #4561 的现场）
 *
 * @param headline 事件标题句（未送达时要求 agent 自己讲清这个事实）
 */
export function renderRuleNoticeSection(
  ruleNotice: RuleNoticeInfo | undefined,
  headline: string,
): string {
  if (!ruleNotice || !ruleNotice.attempted) {
    return (
      `（本事件不直发规则回执）\n` +
      `→ 你的回复要把结果讲**完整**（用户只能从你这条消息知道结论）。`
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
      `✅ 系统已于 ${when || "刚才"} 把下面这条发到群里${sent}\n` +
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
 * 渲染「### 👉 你要做什么」小节 —— 按通知子类型给出**本轮的具体动作**。
 *
 * ★ Task #5054（真根因修复）：notify prompt 是**本轮 task-specific 的即时指令**，
 *   它会**压过** system prompt 里的「任务验收职责」章节。旧版这一小节只要求
 *   「总结 + 给选项 + 发消息」，**完全没提 `task_complete`、没提验收** ——
 *   于是 default agent 收到 sub-agent 完成通知后**从不**调用 `task_complete`，
 *   任务永远挂在 active（Task #5042 现场：progress=100 / status=active）。
 *
 *   ⇒ 必须把「验收 + `task_complete`」写成**显式动作**，并带上**具体 task id**，
 *     不让 agent 自己猜任务号。
 *
 * ⚠️ 中间态（started / progress）**不会**走到这里 —— 它们不是 actionable，
 *    不渲染本小节（#4105 回归边界：中间态绝不能出现 `task_complete`）。
 *
 * @param notifyType 通知子类型（completed / failed / timeout / stopped）
 * @param taskId     业务任务号；"?" 表示后台任务没有业务任务号
 * @param scopeWord  渠道称呼（群聊 / 私聊 / 会话）
 */
function renderActionSection(
  notifyType: string,
  taskId: number | string,
  scopeWord: string,
): string {
  // task id 缺失（后台任务没有业务任务号）→ 让 agent 自己用 task_search 找回
  // ★ Task #5073 — task_complete 精简为纯验收落定：不再带 deliverable 参数
  //   （交付物在 sub-agent 的 task_pre_complete 已提交）。
  const completeCall =
    taskId !== "?"
      ? `task_complete(task_id=${taskId})`
      : `task_complete(task_id=<用 task_search 找回的任务号>)`;

  if (notifyType === "task.background.completed") {
    return `**第一步 —— 验收（⚠️ 不可跳过）**：Task #${taskId} 的最终验收由**你**（default agent）负责 —— sub-agent 只负责干完活并调 task_pre_complete 提交待验证（status=to_validate），**判定权在你**（Task #5073 两阶段验收）。
1. \`task_get(task_id=${taskId})\` **核对实际产出**：读 goal / delivery / 操作记录链（交付物在 \`context.deliverable_storage_path\` 和 operation 的 Deliverable 行里），再对照真实产出（文件是否存在、测试是否通过、review 结论是什么）。⚠️ **不接受 sub-agent 的自述作为验收依据** —— 它说"做完了"不算，产出在才算。
2. **逐条对照 goals 的编号子项**（文件断言 / 进程断言 / 测试断言 / 状态断言），一条一条核。
3. 全部达成 → **必须实际调用** \`${completeCall}\` 把任务落终态（completed）。
   ⚠️ **只回消息不算完成** —— 任务会一直挂在 \`to_validate\`，下游（任务卡片 / goal 检查 / 进度统计）都读不到最终状态。
   ⚠️ 本工具**不带**交付物参数（交付物通道 = task_pre_complete）—— 若发现交付物缺失，重新委托补做，不要在这一步补传。
4. 有差距 → 用 \`delegate_task(sub_session_id=...)\` 续跑或重新委托；**不要**因为"验收不通过"就 \`task_cancel\`（\`task_cancel\` 仅限**用户明令**）。

**第二步 —— 汇报**
5. 用 2~5 行总结：这次完成了什么 / 卡在哪（依据上面的输出与子 session）
6. 给出 1~3 个下一步选项（继续推进 / 拆小 / 放弃），并**问用户选哪个**
7. 用 lark-cli 把回复发到上面的${scopeWord}（见下）`;
  }

  return `**第一步 —— 找根因 → 继续推进（不要甩尾放弃）**
1. **先找根因**：读上面的输出与子 session，判断这次失败/超时/停止的真实原因（sub-agent 没做完？环境问题？指令不清？超时其实是工具撞硬超时但后台仍在跑？）。
2. **继续推进**：能用 \`delegate_task(sub_session_id=...)\` 续跑就续跑（继承子 session 历史，不必从零重来）；不能续跑就按根因重新委托。
3. ⚠️ **不要**用 \`task_cancel\` 结束这个任务 —— \`task_cancel\` 仅限**用户明令**。确实推不动（外部依赖挂了 / 用户另有安排）就如实告诉用户「卡在哪 + 需要用户做什么决定」，等用户决定。

**第二步 —— 汇报**
4. 用 2~5 行总结：这次完成了什么 / 卡在哪（依据上面的输出与子 session）
5. 给出 1~3 个下一步选项（继续推进 / 拆小 / 放弃），并**问用户选哪个**
6. 用 lark-cli 把回复发到上面的${scopeWord}（见下）`;
}

/**
 * 提取消息文本（仅纯文本消息）。
 *
 * ★ Task #4722：`##command##:` 分流需要拿到**用户实际输入的文本**。
 * lark-cli 的 content 形态有多种：
 *   - 简化格式：顶层 `content: "{\"text\":\"...\"}"`（字符串 JSON）
 *   - 简化格式：顶层 `content: { "text": "..." }`（对象）
 *   - 嵌套格式：`event.message.content`
 *
 * 富文本消息（content 是 `[{tag:"md",text:...}]` 数组）不做 command 处理
 * —— 数组形式不是用户输入的纯指令，交给 agent 正常处理更安全。
 */
export function extractCommandText(rawEvent: unknown): string | undefined {
  const event = rawEvent as Record<string, unknown>;
  const innerEvent = event.event as Record<string, unknown> | undefined;
  const message = (innerEvent?.message || event.message) as
    | Record<string, unknown>
    | undefined;

  const rawContent = message?.content ?? event.content;
  if (rawContent === undefined || rawContent === null) return undefined;

  let contentText: string | undefined;
  if (typeof rawContent === "string") {
    try {
      const parsed = JSON.parse(rawContent) as unknown;
      if (typeof parsed === "string") {
        contentText = parsed;
      } else if (parsed && typeof parsed === "object" && "text" in parsed) {
        const t = (parsed as { text?: unknown }).text;
        contentText = typeof t === "string" ? t : undefined;
      }
    } catch {
      // 不是 JSON → 当作纯文本
      contentText = rawContent;
    }
  } else if (typeof rawContent === "object" && "text" in rawContent) {
    const t = (rawContent as { text?: unknown }).text;
    contentText = typeof t === "string" ? t : undefined;
  }

  if (!contentText) return undefined;
  // 只有 `##command##:` 前缀的消息才走 command 链路（其余交给 agent）
  return isCommandMessage(contentText) ? contentText : undefined;
}

/**
 * LarkCli Handler
 */
export const larkCliHandler: EventSourceHandler = {
  type: "lark-cli",

  validateConfig(config: EventSourceConfig): string[] {
    const errors: string[] = [];
    // command 可选：未配置时使用默认 lark-cli event consume im.message.receive_v1 --as bot
    // 这是「信息性」的说明而非错误，所以不加入 errors 数组。
    // 之前误把它 push 到 errors 会导致 event-source-component.register() 拒绝注册(#1637 验证阻塞)。
    return errors;
  },

  createInstance(config: EventSourceConfig): EventSourceInstance {
    return new LarkCliInstance(config);
  },

  // ========================================================================
  // ESPlugin v2 (Task #4042 Phase 3) — 4 个新方法
  // ========================================================================

  /**
   * 默认 lark-cli runner（生产环境）。测试时通过 setRunner 替换为 mock。
   * 之所以不放 module-level state，是为了让 handler 本身保持 pure，方便测试
   * 并行隔离。
   */
  // runner state 持有在闭包里（const larkCliRunner）
  // setRunner 在下面定义
  async emitTriggerEvent(
    payload: TriggerEventInput,
    store: EventStore,
  ): Promise<string> {
    const eventId = await store.insertTriggerEvent(payload, "lark-cli");
    logger.info(`[larkCliHandler] emitTriggerEvent: id=${eventId}`, {
      chatId: payload.metadata?.chatId,
      senderId: payload.senderId,
    });
    return eventId;
  },

  async replyMessage(input: ReplyMessageInput): Promise<ReplyMessageResult> {
    const runner: LarkCliRunner = getLarkCliRunner();
    // ★ 关键：lark-cli im +messages-reply 命令拼接
    // 多 appId 场景必须 --profile <name>（错误使用 profile 会导致 99992361
    // "open_id cross app"）。profile 缺失时不加 flag。
    const profileFlag = input.profile ? `--profile ${input.profile} ` : "";
    const msgType = input.msgType ?? "text";
    // 用 single quote 包 content（防 shell 注入），内部 ' 转成 '\''
    const safeContent = input.content.replace(/'/g, `'\\''`);
    const command =
      `lark-cli ${profileFlag}im +messages-reply ` +
      `--message-id ${input.messageId} ` +
      `--chat-id ${input.chatId} ` +
      `--as bot ` +
      `--msg-type ${msgType} ` +
      `--content '${safeContent}'`;

    try {
      const result = await runner.run(command);
      if (result.code !== 0) {
        logger.error(`[larkCliHandler] replyMessage non-zero exit`, {
          code: result.code,
          stderr: result.stderr,
        });
        return { success: false, error: result.stderr || `exit ${result.code}` };
      }
      // 尝试从 stdout 提取 messageId
      let replyMessageId: string | undefined;
      try {
        const parsed = JSON.parse(result.stdout);
        replyMessageId = parsed?.data?.message_id ?? parsed?.message_id;
      } catch {
        // stdout 不是 JSON，老 lark-cli 版本
      }
      return { success: true, messageId: replyMessageId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[larkCliHandler] replyMessage spawn error`, { error: errMsg });
      return { success: false, error: errMsg };
    }
  },

  extractReplyContext(event: PersistedEvent, profile?: string): ReplyContext {
    return {
      esType: "lark-cli",
      chatId: (event.metadata?.chatId as string) ?? "",
      messageId: (event.metadata?.messageId as string) ?? "",
      senderOpenId: (event.metadata?.senderId as string) ?? event.senderId,
      tenantKey: (event.metadata?.tenantKey as string) ?? undefined,
      // profile 优先级：显式传入（来自 EventSourceConfig） > trigger event metadata > undefined。
      // 多 appId 场景必须用对应 profile 调 lark-cli，否则 99992361 open_id cross app。
      profile: profile ?? (event.metadata?.profile as string | undefined) ?? undefined,
    };
  },

  buildNotifyHandlePrompt(
    input: BuildNotifyHandlePromptInput,
  ): BuildNotifyHandlePromptResult {
    const ctx = this.extractReplyContext?.(input.triggerEvent, input.profile) ?? {
      esType: "lark-cli",
      chatId: (input.triggerEvent.metadata?.chatId as string) ?? "",
      messageId: (input.triggerEvent.metadata?.messageId as string) ?? "",
      senderOpenId:
        (input.triggerEvent.metadata?.senderId as string) ?? input.triggerEvent.senderId,
      profile: input.profile,
    };

    // ★ 渠道信息：由 CLI EventHandler 归一化后传入（NotifyChannelInfo）。
    //   直接调 handler 的调用方（测试 / 旧链路）不传时，回落到 triggerEvent
    //   反查结果，保证向后兼容。
    const esType = input.channel?.esType ?? ctx.esType ?? "lark-cli";
    const chatId = input.channel?.chatId || ctx.chatId;
    const messageId = input.channel?.messageId || ctx.messageId;
    const senderId = input.channel?.senderId || ctx.senderOpenId;
    const chatType = input.channel?.chatType ?? "unknown";
    const profile = input.channel?.profile ?? ctx.profile;

    // profile 命令前缀（多 appId 场景需要 --profile <name>）
    const profileFlag = profile ? `--profile ${profile} ` : "";
    const desc = input.notifyEvent.description ?? "(未命名任务)";
    const result = input.subAgentResult.summary ?? input.notifyEvent.result ?? "";
    const notifyType = input.notifyEvent.type;
    const taskId = input.notifyEvent.taskId ?? "?";

    // ★ Bug A 修复（#4105 假通知）：按事件子类型措辞 + 区分是否 actionable。
    //   只有终态事件才引导主 agent 回复用户；started/progress 中间态仅状态同步，
    //   避免主 agent 把"启动/进行中"误当成"完成"提前回复。
    const { headline, actionable } = describeNotifyEvent(notifyType, taskId, desc);

    const chatTypeLabel =
      chatType === "group"
        ? "群聊"
        : chatType === "p2p"
        ? "私聊"
        : "会话类型未知";
    const canReply = Boolean(chatId);

    // 「系统回执」小节：让 agent 知道群里已经看到了什么（见 renderRuleNoticeSection）
    const receiptSection = renderRuleNoticeSection(input.ruleNotice, headline);

    // 「怎么发回去」小节：按渠道渲染，绝不把 lark-cli 模板套到别的渠道上
    const replyCommand = messageId
      ? `lark-cli ${profileFlag}im +messages-reply --message-id ${messageId} --chat-id ${chatId} --as bot --markdown '<你的回复>'`
      : `lark-cli ${profileFlag}im +messages-send --chat-id ${chatId} --as bot --markdown '<你的回复>'`;

    const scopeWord = chatType === "group" ? "群聊" : chatType === "p2p" ? "私聊" : "会话";

    const promptText = actionable
      ? `
## Notify Event: ${notifyType}

${headline}

### 触发渠道（EventSource）
- ES: ${esType}（飞书，${chatTypeLabel}）
- **chatId: ${chatId || "(缺失)"}**  ← 关键！必须发到这里
- **messageId: ${messageId || "(缺失)"}**  ← ${messageId ? "reply 这条，保持话题线索" : "无触发消息，用 +messages-send"}
- sender: ${senderId || "(未知)"}
${input.notifyEvent.subSessionId ? `- 子 session: ${input.notifyEvent.subSessionId}  ← 如需续跑：delegate_task(sub_session_id="${input.notifyEvent.subSessionId}", prompt=<新要求>)\n` : ""}${profile ? `- profile: ${profile}  ← 调用 lark-cli 必须带 --profile\n` : ""}
### 系统回执（rule-based 直发）
${receiptSection}

### Sub-agent 输出
${result}

### 👉 你要做什么
${renderActionSection(notifyType, taskId, scopeWord)}

### 发送方式（渠道 = lark-cli）
${canReply ? `  ${replyCommand}` : `⚠️ 没有可用的 chatId —— 无法投递到触发会话。请在会话内汇报，并说明「未投递」的原因。`}

⚠️ 不要 fallback 到 lastReplyChannel 或 metadata.replyChannel — 那个 chatId
可能跟用户原始消息的 chatId 不一致（参见 #4035/#4038/#4039 bug）。
⚠️ 必须 --as bot（否则会被自己的 lark-cli consumer 当用户消息回灌）；不要用 user 身份。
`
      : `
## Notify Event: ${notifyType}

${headline}

### 触发渠道（EventSource）
- ES: ${esType}（${chatTypeLabel}）
- chatId: ${chatId || "(缺失)"}
- messageId: ${messageId || "(缺失)"}

（这是中间态通知：仅作状态同步，**不要**回复用户，也不要调用 lark-cli 发消息。
等收到 task.background.completed / failed / timeout / stopped 终态通知后再回复。）
`;
    const systemHint = actionable
      ? `回复必须用 lark-cli im +messages-reply（${profileFlag.trim() ? `带 ${profileFlag.trim()}；` : ""}` +
        `chatId=${chatId} / messageId=${messageId} 来自 trigger event（esType=${esType}），不要 fallback。` +
        (input.ruleNotice?.delivered ? "系统回执已送达，只发增量。" : "")
      : `这是 ${notifyType} 中间态通知，不要回复用户；仅等待终态通知。`;
    return { promptText, systemHint };
  },

  setRunner(runner: LarkCliRunner): void {
    setLarkCliRunner(runner);
  },

};

// ============================================================================
// ★ Task #4042: larkCliHandler v2 方法加 trace span
// ============================================================================
//
// larkCliHandler 是对象字面量（非 class），无法用 @TracedAs 装饰器。
// 用 wrapFunction（@TracedAs 的底层实现）包装，等价拿到 span：
//   - extractReplyContext    → span "extractReplyContext"
//   - buildNotifyHandlePrompt → span "buildNotifyHandlePrompt"
// 便于 `roy-bot debug trace` / `roy-bot debug span <id>` 排查 ESPlugin v2 链路。
//
// ★ Task #4230：postProcessNotifyEvent（把内部 notify prompt 以 markdown 镜像到
//   per-task 群）已删除 —— 那是"旧逻辑的普通消息通知"，用户明确不要。
//   任务进展只通过 LarkCardPatchNotifier 的卡片 patch 呈现。
if (larkCliHandler.extractReplyContext) {
  larkCliHandler.extractReplyContext = wrapFunction(
    larkCliHandler.extractReplyContext,
    "extractReplyContext",
    { recordParams: true, recordResult: true, recordError: true },
  );
}
if (larkCliHandler.buildNotifyHandlePrompt) {
  larkCliHandler.buildNotifyHandlePrompt = wrapFunction(
    larkCliHandler.buildNotifyHandlePrompt,
    "buildNotifyHandlePrompt",
    { recordParams: true, recordResult: false, recordError: true },
  );
}

// ============================================================================
// LarkCli Runner state（module-private，避免污染 handler const）
// ============================================================================

let _larkCliRunner: LarkCliRunner = defaultLarkCliRunner;

function getLarkCliRunner(): LarkCliRunner {
  return _larkCliRunner;
}

function setLarkCliRunner(runner: LarkCliRunner): void {
  _larkCliRunner = runner;
}

/**
 * 用飞书 token 直接 patch 卡片（30min 有效，最多 2 次）
 *
 * 飞书 API: POST /open-apis/interactive/v1/card/update
 *
 * ★ Task #4337 Bug B fix：
 *   - 删掉 `--yes`（lark-cli 1.0.96 `api` 子命令不支持，会报 `unknown flag "--yes"`）
 *   - 抽出为 module-level exported function 便于独立测试 cmd 字符串
 *
 * @param token 飞书提供的 30min 有效 token（事件里带的 ctoken_xxx）
 * @param card 新的卡片 payload（来自 buildTaskCard 的输出）
 * @param profile lark-cli profile（可选）
 */
export async function patchCardByLarkCli(
  token: string,
  card: any,
  profile?: string
): Promise<void> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  // ★ 不带 --yes（lark-cli 1.0.96 api 不接受）
  const cmd =
    `lark-cli ${profileFlag}api POST /open-apis/interactive/v1/card/update ` +
    `--data '${JSON.stringify({ token, card }).replace(/'/g, "'\\''")}' --as bot`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: 30_000 });
    logger.debug(`patchCardByLarkCli ok: ${stdout?.slice(0, 200)}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`patchCardByLarkCli failed: ${msg}`);
    // ★ Task #4722 round3（交叉验证第 2 轮 MINOR m1）：
    //   旧实现把错误吞掉 → 调用方（command 卡片回调）以为刷新成功，
    //   用户看到的卡片**静默停在旧状态**（飞书 token 30min/2 次，
    //   用尽后必然发生）。现在**向上抛**，让调用方能给用户回执。
    throw new Error(`卡片刷新失败：${msg}`);
  }
}

// =============================================================================
// 导出所有内置 Handler
// =============================================================================

/**
 * 所有内置 Handler
 */
export const builtInHandlers: EventSourceHandler[] = [
  larkCliHandler,
  timerHandler,
  bountyIMHandler,
  bountyCliHandler,
  // ★ Task #4568：CLI 命令行也是一个 EventSource（隐式，不消费外部流）。
  //   放进来才能被 EventSourceComponent.registerBuiltInHandlers() 注册，
  //   进而让 EventHandler.getHandlerForEsType('cli-command') 命中。
  cliCommandHandler,
  // ★ Task #5142：企业微信（WeCom）事件源。
  //   放进来才能被 EventSourceComponent.registerBuiltInHandlers() 注册，
  //   进而让 getHandlerForEsType('wecom-cli') 命中，
  //   给 agent 一份「用 wecom-cli message aibot send 回复」的 prompt。
  wecomCliHandler,
];

// Re-export timerHandler for external use
export { timerHandler };
export { bountyIMHandler };
export { bountyCliHandler };
export { cliCommandHandler } from "./cli-command-handler";
export { wecomCliHandler } from "./wecom-cli-handler";

/**
 * 根据类型获取内置 Handler
 */
export function getBuiltInHandler(type: string): EventSourceHandler | undefined {
  return builtInHandlers.find(h => h.type === type);
}
