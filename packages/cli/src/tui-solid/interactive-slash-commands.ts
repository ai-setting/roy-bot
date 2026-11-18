/**
 * @fileoverview Task #5109 P7 —— interactive TUI 的**斜杠命令集**（注册表实例）。
 *
 * ## 与 `slash.ts`（run REPL）的关系
 *
 * `packages/cli/src/slash.ts`（Task #2610）是 run REPL 的 switch-case 分发器，
 * **继续服务 run REPL**（本轮不动它）。
 *
 * 本模块是 **interactive TUI** 的注册表实例：结构化元数据 + handler，
 * 供补全面板渲染 + 命令执行共用。
 *
 * ## 首版命令集
 *
 * | 命令      | 别名          | 说明                         |
 * |-----------|---------------|------------------------------|
 * | `/help`   | —             | 列出可用斜杠命令             |
 * | `/exit`   | `/quit`, `/q` | 退出 interactive             |
 * | `/clear`  | —             | 清空会话历史                 |
 * | `/model`  | —             | 罗列模型 + 选 default（P7.1）|
 * | `/connect`| —             | provider 列表 + 添加（P7.1） |
 * | `/theme`  | —             | 切换 dark/light 主题（运行时）|
 *
 * ## /connect 语义（P7.1 已实现）
 *
 * opencode 的 `/connect` 是 `DialogIntegration`（provider 认证/集成接入）。
 * 用户 2026-11-06 澄清 roy-bot 的 /connect = **本机 auth.json 配置弹窗**
 * （provider 列表 + 添加表单，持久化 ~/.roy-bot/auth.json），
 * 详见 docs/task-5116-p71-config-dialogs.md。
 */

import { setTuiThemeMode, getTuiThemeMode, resolveSolidTheme } from "./theme.js";
import type { SlashCommandSpec } from "./slash-registry.js";
import { CLEAR_SENTINEL } from "../slash.js";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

export interface InteractiveSlashContext {
  /** 当前模型标识（props.model）。 */
  model?: string;
  /**
   * ★ Task #5302：配置目录解析器（RunScreen 的 `props.homeDir` 同源）。
   *
   * /es 子命令读 `event-sources.json` 与 `config.jsonc` 同目录 ——
   * 用 homeDir 推导可保证 interactive（含 `--home` 自定义目录）与
   * CLI 读到同一份配置，而不是硬依赖 shell PATH + 默认 HOME。
   */
  homeDir?: () => string;
}

/**
 * interactive TUI 的斜杠命令集。
 *
 * **注意**：handler 是**同步**的（`SlashResult` 语义）。需要异步副作用的
 * （如退出进程）由 `RunScreen.handleSubmit` 按 `result.kind` 分支处理。
 */
/**
 * ★ Task #5302 —— `/es` 子命令执行器（interactive TUI 版）。
 *
 * TUI 的 handler 是**同步**的（`SlashResult` 语义），而 es 命令读写
 * event-sources.json 是 I/O。这里用 `spawnSync` 调 CLI 前端
 * `roy-bot es-slash ...`（与飞书 `##command##: es ...`、CLI 共用
 * core 的 es-command.ts 一份实现），把 stdout/stderr 原样回显。
 *
 * 为什么不用 fs 直读：interactive 进程与 es daemon 可能同时写
 * event-sources.json，走同一个 CLI 入口便于后续加锁/审计。
 */
function runEsSubcommand(
  rest: string,
  homeDir?: () => string
): { kind: "handled" | "unknown"; message: string } {
  const sub = rest.trim();
  if (!sub) {
    return {
      kind: "handled",
      message: [
        "Usage: /es <list|add|del|mod> [args]",
        "  /es list                       List event sources",
        "  /es add <name> <type>          Add a source (enabled)",
        "  /es del <name|id>              Delete a source",
        "  /es mod <name|id> k=v          Modify fields (e.g. enabled=false)",
      ].join("\n"),
    };
  }
  const args = sub.split(/\s+/).filter(Boolean);
  // ★ DS review MINOR-1：透传 --config，避免 interactive 用 -C 启动时读错配置
  const cliArgs = ["es-slash", ...args];
  if (homeDir) {
    // ★ DS review MINOR-1：透传配置目录（event-sources.json 与 config.jsonc 同目录）
    cliArgs.push("--config", path.join(homeDir(), "config.jsonc"));
  }
  const res = spawnSync("roy-bot", cliArgs, {
    encoding: "utf-8",
    timeout: 15000,
  });
  if (res.error) {
    return { kind: "unknown", message: `/es failed: ${res.error.message}` };
  }
  const out = (res.stdout ?? "").trim();
  const err = (res.stderr ?? "").trim();
  if (res.status !== 0) {
    return { kind: "unknown", message: err || out || `exit ${res.status}` };
  }
  return { kind: "handled", message: out || err || "(no output)" };
}

export function interactiveSlashCommands(ctx: InteractiveSlashContext): SlashCommandSpec[] {
  return [
    {
      name: "help",
      description: "List available slash commands",
      group: "System",
      run: () => ({
        kind: "handled",
        message: [
          "Available slash commands:",
          "  /help          List available slash commands",
          "  /exit          Exit interactive (aliases: /quit, /q)",
          "  /clear         Clear conversation history",
          "  /connect       Show providers and add a new one (auth.json)",
          "  /model         List models and pick a default one",
          "  /theme         Switch dark/light theme (runtime)",
          "  /es            Manage event sources (list/add/del/mod)",
          // ★ Task #5109 P7（DS r4 MINOR-4）：legacy 三条**能用但不在面板**，
          // 不列出来就完全不可发现 ⇒ 在 help 里补一行。
          "Also: /history /workdir /max-lines N (legacy)",
        ].join("\n"),
      }),
    },
    {
      name: "exit",
      aliases: ["quit", "q"],
      description: "Exit interactive",
      group: "System",
      run: () => ({ kind: "exit" }),
    },
    {
      name: "clear",
      description: "Clear conversation history",
      group: "Session",
      run: () => ({ kind: "handled", message: CLEAR_SENTINEL }),
    },
    {
      name: "model",
      description: "List models and pick a default one",
      group: "Agent",
      // ★ Task #5116 P7.1 —— 替换 P7 的只读实现：改为打开模型选择弹窗
      //（罗列 config.jsonc 模型 + 选择 default，持久化回 config.jsonc）。
      run: () => ({ kind: "open-dialog", dialog: "model" }),
    },
    {
      name: "connect",
      description: "Show providers and add a new one (auth.json)",
      group: "Agent",
      // ★ Task #5116 P7.1 —— opencode DialogIntegration 的 roy-bot 对应物：
      // 展示 auth.json providers + 添加 provider/apiKey 表单。
      run: () => ({ kind: "open-dialog", dialog: "connect" }),
    },
    {
      name: "theme",
      description: "Switch dark/light theme (runtime)",
      group: "System",
      run: (args) => {
        const target = args.trim().toLowerCase();
        if (target !== "dark" && target !== "light") {
          return {
            kind: "unknown",
            message: `Usage: /theme dark|light  (current: ${getTuiThemeMode()})`,
          };
        }
        setTuiThemeMode(target);
        // ★ Task #5109 P7（DS r4 MINOR-2）—— NO_COLOR / TERM=dumb 是
        // **环境级硬降级**（theme.ts 的 resolveSolidTheme 先判 env），
        // 运行时 mode 会被吃掉 ⇒ 颜色不会变。
        // ⇒ 此时必须**如实告知**，不能报「切换成功」（假成功）。
        if (resolveSolidTheme().mode === "noColor") {
          return {
            kind: "handled",
            message:
              `⚠ Theme is hard-downgraded by NO_COLOR/TERM=dumb — runtime switching has no effect.`,
          };
        }
        return { kind: "handled", message: `Theme switched to ${target}` };
      },
    },
    {
      // ★ Task #5302：事件源管理（与飞书 ##command##: es ... 同一份 core 实现）
      name: "es",
      description: "Manage event sources (list/add/del/mod)",
      group: "EventSource",
      run: (args) => runEsSubcommand(args, ctx.homeDir),
    },
  ];
}
