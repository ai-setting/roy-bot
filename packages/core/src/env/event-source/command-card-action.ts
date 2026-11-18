/**
 * @fileoverview Task #4722 收口 — command 卡片的按钮回调处理
 *
 * 用户在飞书卡片上点「↑ / ↓ / 新增」按钮 → 飞书推 `card.action.trigger`
 * → es handler 分流到本模块 → **回到 command 子系统**执行 →
 * 用返回的新卡片 patch 原卡片（飞书 token，30min 有效、最多 2 次）。
 *
 * ## 为什么单独一个模块（不塞进 lark-card-action-handler.ts）
 *
 * `lark-card-action-handler.ts` 是 **task 卡片**的处理器，动作语义是
 * 建群/解散群（依赖 taskId + task component）。command 卡片的动作语义是
 * 改 fallback 列表（依赖 config.jsonc 路径），两者数据源完全不同。
 * 混在一起会让 task 侧被迫依赖 command 侧，反之亦然 —— 违背
 * 「command 功能不耦合 es 逻辑」的原则。
 *
 * 本模块是**纯函数 + 端口注入**：
 * - 不依赖 es、不依赖 lark-cli、不直接读配置
 * - 由调用方（es handler）提供「执行 command」和「patch 卡片」两个端口
 *
 * ## 动作映射
 *
 * | 卡片动作 | 触发方式 | 执行的 command |
 * |---|---|---|
 * | `fbmodel_up` | button behaviors[].value.action | `fallback-model reorder <i> <i-1>` |
 * | `fbmodel_down` | button behaviors[].value.action | `fallback-model reorder <i> <i+1>` |
 * | `fbmodel_add` | form 提交（action_name） | `fallback-model add <form_value>` |
 */

import { createLogger } from "../log-trace/logger";
import {
  FALLBACK_MODEL_ACTIONS,
  FALLBACK_MODEL_ACTION_NS,
} from "./command-cards";
import type { CommandResult } from "./command-registry";

const logger = createLogger("command-card-action");

/** 卡片回调事件里 command 侧关心的字段 */
export interface CommandCardActionEvent {
  /** 按钮 callback 的 value（JSON 解析后） */
  actionValue?: Record<string, unknown>;
  /** form 提交的字段值（按组件 name 映射） */
  formValue?: Record<string, unknown>;
  /** 组件的 name（form 内按钮用它标识动作） */
  actionName?: string;
  /** 卡片所在 chat_id */
  chatId?: string;
  /** 被点的卡片 message_id */
  messageId?: string;
  /** 飞书 token（30min 有效，最多 2 次） */
  token?: string;
  /** lark-cli profile */
  profile?: string;
}

/** 端口（由调用方注入，保持本模块纯函数） */
export interface CommandCardActionPorts {
  /**
   * 执行一条 command（返回结构化结果）。
   * 由 es handler 注入 → 内部走 command 注册表。
   */
  executeCommand: (
    subcommand: string,
    args: string[],
    extra?: { configPath?: string }
  ) => Promise<CommandResult>;
  /** command 用的配置文件路径 */
  configPath?: string;
  /**
   * 用飞书 token patch 卡片（把新卡片刷到原卡片上）。
   * 不注入时只回文本，不 patch。
   */
  patchCard?: (token: string, card: unknown, profile?: string) => Promise<void>;
}

/** 处理结果 */
export interface CommandCardActionResult {
  ok: boolean;
  /** 实际执行的 command（描述） */
  executed?: string;
  /** 要 patch 的新卡片（无则不 patch） */
  card?: unknown;
  /**
   * 卡片刷新失败的原因（业务动作成功但卡片没刷新）。
   * ★ Task #4722 round3（MINOR m1）：飞书 token 30min/2 次，用尽后必然发生；
   *   上层据此给用户回执，避免卡片静默停在旧状态。
   */
  patchError?: string;
  /** 错误说明 */
  error?: string;
}

/**
 * 判断一个卡片回调是不是 **command 卡片**的回调。
 *
 * 判定依据（任一命中即可）：
 * - `action_value.action` 以 `fbmodel` 开头（button behaviors 回调）
 * - `action_name` 以 `fbmodel` 开头（form 提交回调）
 */
export function isCommandCardAction(event: {
  actionValue?: unknown;
  actionName?: string;
}): boolean {
  const av = event.actionValue;
  if (av && typeof av === "object") {
    const action = (av as Record<string, unknown>).action;
    if (typeof action === "string" && action.startsWith(FALLBACK_MODEL_ACTION_NS)) {
      return true;
    }
  }
  if (
    typeof event.actionName === "string" &&
    event.actionName.startsWith(FALLBACK_MODEL_ACTION_NS)
  ) {
    return true;
  }
  return false;
}

/**
 * 把卡片回调翻译成 command 调用。
 *
 * @returns command 名 + 参数；无法识别时返回 null
 */
export function translateCardActionToCommand(
  event: CommandCardActionEvent
): { subcommand: string; args: string[] } | null {
  // ---- form 提交：新增 ----
  if (event.actionName === FALLBACK_MODEL_ACTIONS.add) {
    const model = String(
      event.formValue?.["fbmodel_model"] ?? event.formValue?.model ?? ""
    ).trim();
    if (!model) return null;
    return { subcommand: "fallback-model", args: ["add", model] };
  }

  // ---- button callback：上移 / 下移 ----
  const av = event.actionValue;
  if (!av || typeof av !== "object") return null;
  const action = (av as Record<string, unknown>).action;
  const rawIndex = (av as Record<string, unknown>).index;

  if (action !== FALLBACK_MODEL_ACTIONS.up && action !== FALLBACK_MODEL_ACTIONS.down) {
    return null;
  }

  const index = Number.parseInt(String(rawIndex ?? ""), 10);
  if (!Number.isFinite(index) || index < 1) return null;

  // 上移 = 与前一项交换（目标 index-1）；下移 = 与后一项交换（目标 index+1）
  const target = action === FALLBACK_MODEL_ACTIONS.up ? index - 1 : index + 1;
  if (target < 1) return null;

  // ★ Task #4722 round2（交叉验证 MINOR-2）：卡片带 model 标识时**按标识 + 方向移动**。
  //   卡片渲染之后配置可能已被改动（别人用 CLI 加了项 / 另一张卡片点了删除），
  //   此时卡片上的 index 已经漂移，用它会移错模型。
  //   方向（up/down）是**意图**，由 command 执行时按当前配置解析 → 永远正确。
  //   没有 model 字段 → 回退到纯索引形式（向后兼容）。
  const model = (av as Record<string, unknown>).model;
  if (typeof model === "string" && model.trim() !== "") {
    return {
      subcommand: "fallback-model",
      args: [
        "move",
        model.trim(),
        action === FALLBACK_MODEL_ACTIONS.up ? "up" : "down",
      ],
    };
  }

  return {
    subcommand: "fallback-model",
    args: ["reorder", String(index), String(target)],
  };
}

/**
 * 处理 command 卡片的按钮回调。
 *
 * 流程：翻译成 command → 交给 command 子系统执行 → 拿到新卡片 →
 * 用 token patch 原卡片（让用户看到最新列表）。
 */
export async function handleCommandCardAction(
  event: CommandCardActionEvent,
  ports: CommandCardActionPorts
): Promise<CommandCardActionResult> {
  const call = translateCardActionToCommand(event);
  if (!call) {
    return { ok: false, error: "无法识别的 command 卡片动作" };
  }

  const executed = `${call.subcommand} ${call.args.join(" ")}`;
  logger.info(`[handleCommandCardAction] 执行 ${executed}`);

  let result: CommandResult;
  try {
    result = await ports.executeCommand(call.subcommand, call.args, {
      configPath: ports.configPath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[handleCommandCardAction] ${executed} 执行异常：${msg}`);
    return { ok: false, executed, error: `命令执行异常：${msg}` };
  }

  if (!result.ok) {
    return { ok: false, executed, error: result.error ?? "命令执行失败" };
  }

  // 有新卡片 → patch 原卡片
  const card = result.output?.card;
  let patchError: string | undefined;
  if (card && ports.patchCard && event.token) {
    try {
      await ports.patchCard(event.token, card, event.profile);
    } catch (err) {
      // ★ Task #4722 round3（交叉验证第 2 轮 MINOR m1）：patch 失败要**让用户知道** ——
      //   飞书 token 30min/最多 2 次，用尽后卡片会静默停在旧状态。
      //   业务动作本身已成功，所以 ok 仍为 true，但带上 patchError 供上层回执。
      patchError = (err as Error).message;
      logger.error(
        `[handleCommandCardAction] patch 卡片失败：${patchError}`
      );
    }
  }

  return { ok: true, executed, card, patchError };
}
