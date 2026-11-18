/**
 * @fileoverview Task #4722 — command 子系统（`##command##:` 前缀分流）
 *
 * ## 用户需求
 *
 * 在飞书输入 `##command##: list model` → 不走 agent 处理链路，
 * 直接执行 command 并用卡片消息回显。command 子系统是**纯核心层
 * 能力**，不耦合任何 es 逻辑；es 只是它的一个交互前端。
 *
 * ## 架构
 *
 *   ┌──────────┐   ##command##: xxx   ┌──────────────────┐
 *   │ es 前端  │ ──────────────────→  │ CommandRegistry  │
 *   │ (lark)   │ ←──────────────────  │  (本文件)         │
 *   └──────────┘   CommandResult      └──────────────────┘
 *        │              (text/card)           │
 *        │ 普通消息 → 走 agent                │ 注册
 *        ↓                                    ↓
 *   eventHandler(evt)                  各 command 实现
 *                                      (fallback-model 等)
 *
 * ## 前缀语法
 *
 *   ##command##: <subcommand> [args...]
 *
 * - 前缀 token 精确匹配 `##command##:`，但**大小写不敏感**
 *   （`##COMMAND##:` / `##Command##:` 同样识别；`##` 包裹 + 尾随冒号
 *   已足够特异，不会与正文强调词混淆）
 * - 允许前导空白；`##command##:` 与命令之间可有任意空白
 * - 容忍开头的 @-提及（`<at user_id="ou_x"></at>` / `@_user_1`）——
 *   群里 @bot 的典型形态
 * - 全角冒号 `：` 不识别（用户手滑时按普通消息走 agent，agent 会引导）
 */

import { createLogger } from "../log-trace/logger";
// ★ Task #4722 round2（MINOR-5）：静态 import 替代 runtime require()。
//   fallback-model-command.ts 对本文件只用 `import type`（编译期擦除）→ 无循环依赖。
import { fallbackModelCommand, listCommand } from "./fallback-model-command";
import { resetCommand } from "./reset-command";
// ★ Task #5302：eventsource 管理命令（/es add|list|del|mod）
import { esCommand } from "./es-command";

const logger = createLogger("command-registry");

/** 命令前缀（token 本身精确，但**匹配时大小写不敏感**） */
export const COMMAND_PREFIX = "##command##:";

/** 前缀的规范化形式（小写，用于大小写不敏感比较） */
const COMMAND_PREFIX_LOWER = COMMAND_PREFIX.toLowerCase();

/**
 * 剥离消息开头的 @-提及标记。
 *
 * ★ Task #4722 round2（交叉验证 MINOR-3）：飞书群里 @bot 时，消息正文形如
 *   `<at user_id="ou_bot"></at> ##command##: list model`
 * 或旧式 `@_user_1 ##command##: list model`。
 *   这些前缀会让 `##command##:` 不在开头 → 命令被静默丢给 agent 链路。
 *
 * 支持的形态：
 * - `<at user_id="ou_x"></at>` / `<at user_id="ou_x">名字</at>` / `<at user_id="ou_x"/>`
 * - `@_user_1` / `@_all`
 *
 * 只剥离**开头连续**的提及标记（正文中间的提及不动）。
 */
export function stripLeadingMentions(text: string): string {
  let rest = text;

  // ① 飞书标准 <at ...> 标记（开闭两态 + 自闭合）
  const atTagRe = /^\s*<at\s+user_id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)\s*(?:\/>|>\s*<\/at\s*>|>[^<]*<\/at\s*>)/i;
  for (;;) {
    const m = rest.match(atTagRe);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }

  // ② 旧式 @_user_1 / @_all（可连续多个）
  const legacyAtRe = /^\s*@_(?:user_\d+|all)\b/i;
  for (;;) {
    const m = rest.match(legacyAtRe);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }

  return rest;
}

/**
 * 判断消息是否是 command 消息（以 `##command##:` 开头，允许前导空白）。
 *
 * **大小写不敏感**：`##command##:` / `##COMMAND##:` / `##Command##:` 都识别。
 * （用户需求要「前缀识别鲁棒性」；大小写变体不会与正文强调词混淆，
 * 因为 `##` 包裹 + 尾随冒号已经足够特异。）
 *
 * **容忍 @-提及前缀**：`<at user_id="ou_bot"></at> ##command##: ...` 也识别。
 */
export function isCommandMessage(text: string): boolean {
  return stripLeadingMentions(text)
    .trimStart()
    .toLowerCase()
    .startsWith(COMMAND_PREFIX_LOWER);
}

/** 一条命令的调用（解析结果） */
export interface CommandInvocation {
  /** 子命令名，如 "list" / "fallback-model"；空命令为 "" */
  subcommand: string;
  /** 参数列表 */
  args: string[];
}

/**
 * 从消息中提取命令调用。
 *
 * 非命令消息返回 null；`##command##:` 后为空时 subcommand 为 ""。
 */
export function extractCommandInvocation(text: string): CommandInvocation | null {
  // ★ 容忍 @-提及前缀（群里 @bot 的典型形态）
  const trimmed = stripLeadingMentions(text).trimStart();
  if (!trimmed.toLowerCase().startsWith(COMMAND_PREFIX_LOWER)) return null;

  const rest = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (!rest) {
    return { subcommand: "", args: [] };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  return { subcommand: tokens[0], args: tokens.slice(1) };
}

// =============================================================================
// Command 注册表
// =============================================================================

/** command 执行上下文 */
export interface CommandContext {
  /** 子命令参数 */
  args: string[];
  /**
   * 配置文件路径（读写 ~/.roy-bot/config.jsonc 之类）。
   * 测试注入临时路径；生产由 es 前端传入。
   */
  configPath?: string;
  /** 原始消息文本 */
  rawText: string;
}

/**
 * 结构化输出：**双形态**（text 必填 + card 可选）。
 *
 * 为什么要双形态而不是互斥联合（`{kind:"text"} | {kind:"card"}`）：
 * command 子系统是**多前端共享**的（es 飞书卡片前端 + CLI 文本前端），
 * 互斥联合会导致每个前端只能看到一种形态，CLI 侧被迫把业务逻辑
 * 复制一遍（违背「可复用已有 command 逻辑」的原始需求）。
 *
 * - `text`：**恒为字符串**。任何前端都能渲染（CLI 直接打印，
 *   飞书侧也可退化成 markdown 文本）。
 * - `card`：**可选**。es 前端优先用它发 interactive 卡片；
 *   没有 card 时前端自动降级到 text。
 *
 * 兼容：旧的 `{kind:"text", text}` / `{kind:"card", card}` 仍然可构造
 * （kind 字段保留为可选标记），但新代码应只用 text + card 两个字段。
 */
export interface CommandOutput {
  /** 纯文本形态（恒存在） */
  text: string;
  /** 飞书 interactive 卡片形态（可选） */
  card?: Record<string, unknown>;
  /**
   * 形态标记（可选，保留向后兼容）。
   * - "card"：card 字段可用
   * - "text"：仅 text 可用
   */
  kind?: "text" | "card";
}

/** 兼容旧名：纯文本输出 */
export interface CommandTextOutput extends CommandOutput {
  kind?: "text";
}

/** 兼容旧名：卡片输出 */
export interface CommandCardOutput extends CommandOutput {
  kind?: "card";
  card: Record<string, unknown>;
}

/** command 执行结果 */
export interface CommandResult {
  ok: boolean;
  /** 成功时的结构化输出 */
  output?: CommandOutput;
  /** 失败时的错误说明（面向用户，可含用法提示） */
  error?: string;
}

/** 单个 command 的定义 */
export interface CommandDefinition {
  /** 命令名（如 "fallback-model" / "list"） */
  name: string;
  description: string;
  /** 用法说明（出错时展示给用户） */
  usage: string;
  execute(ctx: CommandContext): Promise<CommandResult>;
}

/**
 * Command 注册表。
 *
 * 类似 event-source-handlers.ts 的 builtInHandlers 模式：
 * 各 command 自注册，es 前端只管分发与渲染。
 */
export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();

  /** 注册 command；重名抛错（防止静默覆盖） */
  register(def: CommandDefinition): void {
    if (this.commands.has(def.name)) {
      throw new Error(`command "${def.name}" already registered`);
    }
    this.commands.set(def.name, def);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  list(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /**
   * 分发执行。
   *
   * - 未知命令 / 空命令 → ok=false + 可用命令列表
   * - execute 抛异常 → ok=false + error（不向上抛，es 前端可安全渲染）
   */
  async dispatch(subcommand: string, args: string[], extra?: Partial<CommandContext>): Promise<CommandResult> {
    if (!subcommand) {
      return {
        ok: false,
        error: this.renderHelp(),
      };
    }

    const def = this.commands.get(subcommand);
    if (!def) {
      return {
        ok: false,
        error: `未知命令「${subcommand}」。\n${this.renderHelp()}`,
      };
    }

    try {
      return await def.execute({
        args,
        rawText: extra?.rawText ?? "",
        configPath: extra?.configPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[CommandRegistry] command "${subcommand}" failed: ${msg}`);
      return { ok: false, error: `命令执行失败：${msg}` };
    }
  }

  /** 帮助文本（列出所有命令） */
  private renderHelp(): string {
    const lines = this.list().map(
      (c) => `  ${c.usage.padEnd(40)} ${c.description}`
    );
    return (
      `可用命令：\n${lines.join("\n")}\n` +
      `（通过「##command##: <命令> [参数]」调用）`
    );
  }
}

// =============================================================================
// 全局注册表 + es 入口
// =============================================================================

/**
 * 全局 command 注册表（懒初始化，内建命令在此注册）。
 *
 * 未来扩展：新增 command 只需在此追加，es 前端零改动。
 */
export function getGlobalCommandRegistry(): CommandRegistry {
  // 延迟注册避免循环依赖（fallback-model-command 引 command-cards）
  const g = globalThis as unknown as {
    __royCommandRegistry?: CommandRegistry;
  };
  if (!g.__royCommandRegistry) {
    const registry = new CommandRegistry();
    // ★ Task #4722 round2（交叉验证 MINOR-5）：改用**静态 import**。
    //   原来用 runtime `require()` 是为了「避免循环依赖」，但
    //   fallback-model-command.ts 对本文件只用了 `import type`
    //   （类型在编译期擦除 → 运行时无环），所以静态 import 是安全的。
    //   ESM-only 的包里 runtime require() 是移植隐患（bun/bunup 能跑，
    //   但换打包器或换 node 版本可能炸）。
    registry.register(fallbackModelCommand);
    registry.register(listCommand);
    // ★ Task #4896: reset command — asks deamon-for-roy to respawn this process
    registry.register(resetCommand);
    // ★ Task #5302: es command — eventsource 管理（list/add/del/mod）
    registry.register(esCommand);
    g.__royCommandRegistry = registry;
  }
  return g.__royCommandRegistry;
}

/**
 * es 前端入口：处理一条消息。
 *
 * - 命令消息 → 执行并返回 CommandResult（es 前端负责渲染 text/card）
 * - 普通消息 → 返回 null（es 前端继续走 agent 链路）
 *
 * @param text 消息文本
 * @param opts.configPath 配置文件路径（传给 command ctx）
 * @param opts.registry 测试注入用注册表；缺省用全局注册表
 */
export async function handleCommandMessage(
  text: string,
  opts: {
    configPath?: string;
    registry?: CommandRegistry;
  } = {}
): Promise<CommandResult | null> {
  if (!isCommandMessage(text)) return null;

  const invocation = extractCommandInvocation(text);
  if (!invocation) return null;

  const registry = opts.registry ?? getGlobalCommandRegistry();
  logger.info(
    `[handleCommandMessage] dispatching "${invocation.subcommand}" args=${JSON.stringify(invocation.args)}`
  );
  return registry.dispatch(invocation.subcommand, invocation.args, {
    rawText: text,
    configPath: opts.configPath,
  });
}
