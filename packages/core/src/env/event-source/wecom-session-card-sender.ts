/**
 * @fileoverview Task #5360 —— 企微 **session 卡发送器**（无 task 的 sub-session）
 *
 * ## 用户需求
 *
 * > 「企微也是这个逻辑哈」（22:32）+「以 sub-session 为基底」（22:37）
 *
 * ## 为什么单独一个模块（不复用 lark 的 sessionCardSender）
 *
 * 飞书发卡是 `lark-cli im +messages-send --msg-type interactive`（spawn 子进程）；
 * 企微发卡是 WS `aibot_send_msg`（长连接帧）。两条完全不同的传输通道，
 * 混在一个 sender 里只会靠 if/else 分支，且会把「渠道 guard」的责任
 * 推给运行时的字符串比较 —— 那正是 R4 抓出的错渠道风险。
 *
 * ⇒ 明确分成两个 sender，各自由**渠道自己的**事件路径调用。
 *
 * ## 设计（纯函数 + 端口注入，便于单测）
 *
 * | 关注点 | 谁负责 |
 * |--------|--------|
 * | 卡片长什么样 | `buildWecomSessionCard`（wecom-card-builder，已测） |
 * | 发到哪 | 本模块的 `resolveWecomSendTarget`（从 event 取 chatId/chatType/sourceId） |
 * | 怎么发 | `sendCard` 端口（生产接 `sendWecomTemplateCard`） |
 *
 * ## 全链路 best-effort
 *
 * 任何一步失败（无 chatId / 无 sourceId / 发送报错）都只 log，**绝不抛** ——
 * 生命周期事件是 fire-and-forget，抛出去会污染事件消费循环。
 */

import type { EnvEvent } from "../types";
import {
  buildWecomSessionCard,
  type WecomSessionLifecycle,
  type WecomMilestoneLite,
} from "./wecom-card-builder";
import {
  createMemoryWecomSessionCardStore,
  type WecomSessionCardStore,
  type WecomSessionCardLifecycle,
  type WecomSessionMilestone,
} from "../task/plugins/wecom-session-card-store";

// ============================================================================
// 发送目标解析（纯函数）
// ============================================================================

/** 企微发送目标 */
export interface WecomSessionCardTarget {
  /** 事件源 ID（WS 实例反查用） */
  sourceId: string;
  /** 单聊 = userid；群聊 = 群 chatid */
  chatId: string;
  chatType: "single" | "group";
}

/**
 * 从事件里解析企微发送目标。
 *
 * ## 渠道判定（为什么这里要显式判断）
 *
 * 本 sender 只处理**企微**事件。若把飞书事件的 chatId（`oc_xxx`）当企微
 * userid 发，WS 会静默丢弃（或报错）—— 与 R4 抓出的「错渠道发送」同一类问题，
 * 只是方向相反。所以这里要求 `replyChannel.type === "wecom-cli"`，
 * 判不出来就返回 `undefined`（调用方丢弃，不猜）。
 *
 * ## chatType 判定
 *
 * 优先 `params.chatType`（`buildWecomReplyChannel` 写入的权威值）；
 * 缺省时看 `params.wecomChatId` 是否存在 —— 有原始 group chatid ⇒ group。
 * 都没有 ⇒ `single`（企微单聊的 chatId 就是 userid，官方语义）。
 */
export function resolveWecomSessionCardTarget(
  event: EnvEvent,
): WecomSessionCardTarget | undefined {
  const metadata = event?.metadata as Record<string, unknown> | undefined;
  const rc = metadata?.replyChannel as
    | {
        type?: string;
        chatId?: string;
        params?: {
          chatType?: string;
          wecomChatId?: string;
          sourceId?: string;
        };
      }
    | undefined;

  // 只处理企微事件（错渠道宁可丢弃）
  if (rc?.type !== "wecom-cli") return undefined;

  const chatId = typeof rc.chatId === "string" && rc.chatId.trim() ? rc.chatId : undefined;
  if (!chatId) return undefined;

  // sourceId：replyChannel.params 优先（#5311 写入），其次 metadata.sourceId
  const sourceId =
    (typeof rc.params?.sourceId === "string" && rc.params.sourceId) ||
    (typeof metadata?.sourceId === "string" ? (metadata.sourceId as string) : undefined);
  if (!sourceId) return undefined;

  const chatType: "single" | "group" =
    rc.params?.chatType === "group" || rc.params?.chatType === "single"
      ? rc.params.chatType
      : rc.params?.wecomChatId
        ? "group"
        : "single";

  return { sourceId, chatId, chatType };
}

// ============================================================================
// payload 解析（纯函数）
// ============================================================================

/** 从事件 payload 里取 session 卡需要的信息 */
export interface WecomSessionCardPayload {
  sessionId: string;
  lifecycle: WecomSessionLifecycle;
  title?: string;
  agentType?: string;
  startedAt?: string;
}

const LIFECYCLES: ReadonlySet<string> = new Set<WecomSessionLifecycle>([
  "running",
  "completed",
  "timeout",
  "failed",
  "stopped",
]);

/** lifecycle → 里程碑标题片段（与 builder 的状态文案同源，避免两处漂移） */
const LIFECYCLE_MILESTONE_PHRASE: Record<WecomSessionLifecycle, string> = {
  running: "运行中",
  completed: "已完成",
  timeout: "已超时",
  failed: "已失败",
  stopped: "已停止",
};

/**
 * 解析 `task.background.session_started` 的 payload。
 *
 * 缺 `subSessionId` ⇒ `undefined`（没有主键，无从发卡）。
 * `lifecycle` 非法/缺失 ⇒ `running`（乐观：宁可显示在跑，也不凭空宣布结束）。
 */
export function parseWecomSessionCardPayload(
  event: EnvEvent,
): WecomSessionCardPayload | undefined {
  const p = (event?.payload ?? {}) as Record<string, unknown>;
  const sessionId =
    typeof p.subSessionId === "string" && p.subSessionId.trim()
      ? p.subSessionId
      : undefined;
  if (!sessionId) return undefined;

  const lifecycle: WecomSessionLifecycle =
    typeof p.lifecycle === "string" && LIFECYCLES.has(p.lifecycle)
      ? (p.lifecycle as WecomSessionLifecycle)
      : "running";

  return {
    sessionId,
    lifecycle,
    ...(typeof p.description === "string" && p.description
      ? { title: p.description }
      : {}),
    ...(typeof p.subagentType === "string" && p.subagentType
      ? { agentType: p.subagentType }
      : {}),
    ...(typeof p.startedAt === "number"
      ? { startedAt: new Date(p.startedAt).toISOString() }
      : {}),
  };
}

// ============================================================================
// 组合：sender 工厂（生产接线用）
// ============================================================================

/** sender 依赖的最小端口集（全部可选 ⇒ 缺了只降级） */
export interface WecomSessionCardSenderPorts {
  /**
   * ★ Task #5364：session 卡持久层（**B 方案的核心**）。
   *
   * 一个 session 生命周期内只发一张卡 ⇒ 后续 lifecycle 必须落在这里，
   * 刷新时才有数据可渲染。不注入 ⇒ 内部用内存实现兜底（同实例内仍只发
   * 一次；进程重启会重发一张，属于可接受的降级）。
   */
  store?: WecomSessionCardStore;
  /**
   * 发卡（生产：`sendWecomTemplateCard`）。
   *
   * `card` 是 `buildWecomSessionCard` 的输出，原样传给 WS 帧构造。
   */
  sendCard?: (input: {
    sourceId: string;
    chatId: string;
    chatType: "single" | "group";
    card: Record<string, unknown>;
    /** ★ sessionId（供实现方记录 sessionId→公开消息定位，便于后续 patch/诊断） */
    sessionId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** 日志（测试可注入；缺省 console） */
  warn?: (msg: string) => void;
  /** 时间基准（注入便于测试；缺省 Date.now()） */
  now?: () => number;
}

/** 从事件 payload 里取 `associatedTaskId`（有 task 时的增强信息） */
function parseAssociatedTaskId(event: EnvEvent): number | undefined {
  const p = (event?.payload ?? {}) as Record<string, unknown>;
  const raw = p.associatedTaskId;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : undefined;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * 造一个 `(event) => Promise<void>` 的企微 session 卡 sender。
 *
 * **永不抛**：这是 fire-and-forget 生命周期事件的投递路径。
 *
 * ## ★ Task #5364 语义变更（用户 2026-11-12 08:34 拍板 B）
 *
 * > 「企微改成**只维护一张卡 + 靠按钮触发更新**」
 *
 * | 事件 | 旧行为（#5360，被用户否掉） | 新行为（B 方案） |
 * |------|---------------------------|------------------|
 * | 首次 lifecycle | 发一张卡 | 发一张卡 + 落库 |
 * | 后续 lifecycle | **再发一张卡**（刷屏 + 重复 pin） | **不发**，只更新持久层 |
 * | 用户点「刷新」 | 只刷活性 | 从持久层 + 实时活性重建**整张卡** |
 *
 * ## 为什么这是唯一可行的形态（协议硬约束，不是偷懒）
 *
 * `aibot_respond_update_msg` 必须在 `template_card_event` 回调的 5 秒窗口内、
 * 用回调带回的 `req_id` 发（#5203 已真网取证）。生命周期事件不是回调、
 * 没有 req_id ⇒ **根本发不出 update 帧**。所以「主动 patch」这条路在企微
 * 上不存在；要「一张卡」只能把更新的机会押在用户点按钮那一刻。
 *
 * 反过来：**如果我们仍然每条 lifecycle 都发卡，就不是一张卡** —— 这正是
 * 用户否掉的形态。所以「后续不发」是本模块最重要的不变量，有测试断言
 * `sendCard` 调用次数恒为 1。
 *
 * ## 发卡失败不落库（重要）
 *
 * 否则后续事件会以为「已经有卡了」而永不再发 ⇒ 用户真的一张卡都看不到。
 * 失败就让它下次事件再试（最多多发一张，也好过零张）。
 */
export function createWecomSessionCardSender(
  ports: WecomSessionCardSenderPorts,
): (event: EnvEvent) => Promise<void> {
  const warn = ports.warn ?? ((m: string) => console.warn(m));
  const store = ports.store ?? createMemoryWecomSessionCardStore();
  const nowFn = ports.now ?? Date.now;

  return async (event: EnvEvent): Promise<void> => {
    try {
      const target = resolveWecomSessionCardTarget(event);
      if (!target) return; // 非企微事件 / 缺 chatId / 缺 sourceId ⇒ 静默丢弃

      const payload = parseWecomSessionCardPayload(event);
      if (!payload) return; // 无 sessionId ⇒ 没有主键

      const existing = store.get(payload.sessionId);
      const at = nowFn();
      const milestone: WecomSessionMilestone = {
        title: LIFECYCLE_MILESTONE_PHRASE[payload.lifecycle],
        timestamp: new Date(at).toISOString(),
      };
      // 累积时间线：把本次状态追加到历史（刷新时才能看到完整轨迹）
      const prevMilestones: WecomSessionMilestone[] = (() => {
        if (!existing?.milestones) return [];
        try {
          const arr = JSON.parse(existing.milestones);
          return Array.isArray(arr) ? (arr as WecomSessionMilestone[]) : [];
        } catch {
          return [];
        }
      })();
      const milestones = [...prevMilestones, milestone];
      const associatedTaskId =
        parseAssociatedTaskId(event) ?? existing?.associatedTaskId;
      const terminal = payload.lifecycle !== "running";

      /** 落库（首次建 / 后续更新同一入口，避免两处字段漂移） */
      const persist = (over: Partial<import("../task/plugins/wecom-session-card-store").WecomSessionCardState> = {}) => {
        try {
          store.upsert({
            sessionId: payload.sessionId,
            chatId: target.chatId,
            chatType: target.chatType,
            sourceId: target.sourceId,
            cardTaskId: existing?.cardTaskId ?? "",
            lifecycle: payload.lifecycle as WecomSessionCardLifecycle,
            // ★ DS review R1 MAJOR-1：这四个字段必须 **carry forward**。
            //
            // 生产 payload 的形状不一致：只有 running(started) 那条带
            // `startedAt` / `description` / `subagentType`（delegate-tool.ts:1526），
            // 而 completed / timeout / failed / stopped **只带 executionTimeMs**
            // （:1671 / :1859 / :1890 / :1827）。
            //
            // 旧写法 `...(payload.X ? {X: payload.X} : {})` 会让终态事件把
            // 这些字段从 upsert 里整条省略 —— 而 SQLite 侧是
            // `ON CONFLICT DO UPDATE SET started_at = excluded.started_at`，
            // 省略即写 NULL。结果：会话一结束，卡片上的「已运行」行就消失。
            // 这正是用户明令「原有信息一个不少」的反例。
            //
            // ⇒ 新值优先，缺席则沿用已有值（不是「保持不变」，而是显式覆盖
            //   成同一个值，避免依赖 upsert 的省略语义）。
            ...(payload.title || existing?.title
              ? { title: payload.title ?? existing!.title }
              : {}),
            ...(payload.agentType || existing?.agentType
              ? { agentType: payload.agentType ?? existing!.agentType }
              : {}),
            ...(payload.startedAt || existing?.startedAt
              ? { startedAt: payload.startedAt ?? existing!.startedAt }
              : {}),
            ...(associatedTaskId !== undefined ? { associatedTaskId } : {}),
            milestones: JSON.stringify(milestones),
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
            ...(terminal ? { closedAt: at } : {}),
            ...over,
          });
        } catch (err) {
          warn(
            `[wecom-session-card] store upsert failed for ${payload.sessionId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // ---- 首次（无记录）⇒ 发卡 ----
      if (!existing) {
        if (!ports.sendCard) return; // 端口未注入 ⇒ 丢弃（不抛）

        const card = buildWecomSessionCard({
          sessionId: payload.sessionId,
          lifecycle: payload.lifecycle,
          ...(payload.title ? { title: payload.title } : {}),
          ...(payload.agentType ? { agentType: payload.agentType } : {}),
          ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
        });

        const r = await ports.sendCard({
          sourceId: target.sourceId,
          chatId: target.chatId,
          chatType: target.chatType,
          card: card as unknown as Record<string, unknown>,
          sessionId: payload.sessionId,
        });

        if (!r?.ok) {
          warn(
            `[wecom-session-card] send failed for ${payload.sessionId}: ` +
              `${r?.error ?? "unknown"}`,
          );
          // ★ 发卡失败**不落库**（见函数头注释）
          return;
        }

        // 记住 cardTaskId（刷新帧必须原样回填，协议硬约束）
        persist({
          cardTaskId: String(
            (card as unknown as { task_id?: string }).task_id ?? payload.sessionId,
          ),
        });
        return;
      }

      // ---- 后续事件 ⇒ **只更新持久层，不发卡**（B 方案不变量）----
      persist();
    } catch (err) {
      // fire-and-forget：绝不污染事件消费循环
      warn(
        `[wecom-session-card] sender threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}
