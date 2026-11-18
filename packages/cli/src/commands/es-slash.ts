/**
 * @fileoverview Task #5302 — `roy-bot es-slash` CLI 子命令
 *
 * CLI 是 command 子系统的**文本前端**（与 `##command##:` 飞书卡片前端、
 * interactive TUI 平级）：业务逻辑只有 core 一份（es-command.ts），
 * 这里只负责把 yargs 参数翻译成 command 调用并打印结果。
 *
 * ## 为什么不叫 `es`
 *
 * `es` 已是 `roy-bot eventsource` 的**别名**（Task #2129，走完整
 * EventSourceComponent 组件链路，会真正 start/stop 子进程）。
 * 本命令是**轻量磁盘配置面**（改 event-sources.json，重启后生效），
 * 两者语义不同，故用独立名字 `es-slash`，避免抢占 `es` 别名。
 *
 * ## 用法
 *
 * ```bash
 * roy-bot es-slash list
 * roy-bot es-slash add wecom-x wecom-cli
 * roy-bot es-slash del wecom-x
 * roy-bot es-slash mod wecom-x enabled=false
 * ```
 */

import { CommandModule } from "yargs";
import { getGlobalCommandRegistry } from "@ai-setting/roy-bot-core";

export interface EsSlashOptions {
  /** 配置文件路径（用于推导同目录的 event-sources.json） */
  config?: string;
}

async function runEsCommand(args: string[], config?: string): Promise<void> {
  const registry = getGlobalCommandRegistry();
  const result = await registry.dispatch("es", args, {
    configPath: config,
    rawText: `roy-bot es-slash ${args.join(" ")}`,
  });

  if (!result.ok) {
    console.error(`❌ ${result.error ?? "命令执行失败"}`);
    process.exit(1);
    return;
  }
  console.log(result.output?.text ?? "（无输出）");
}

/** es-slash list */
export const esSlashList: CommandModule<object, EsSlashOptions> = {
  command: "list",
  describe: "列出所有事件源（磁盘配置）",
  builder: (y) =>
    y.option("config", {
      type: "string",
      describe: "配置文件路径（推导同目录 event-sources.json）",
    }),
  async handler(argv) {
    await runEsCommand(["list"], argv.config);
  },
};

/** es-slash add */
export const esSlashAdd: CommandModule<object, EsSlashOptions> = {
  command: "add <name> <type>",
  describe: "新增事件源（enabled=true）",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true, describe: "事件源名称" })
      .positional("type", { type: "string", demandOption: true, describe: "类型（lark-cli/wecom-cli/timer/...）" })
      .option("config", { type: "string", describe: "配置文件路径" }),
  async handler(argv) {
    const a = argv as unknown as { name: string; type: string; config?: string };
    await runEsCommand(["add", a.name, a.type], a.config);
  },
};

/** es-slash del */
export const esSlashDel: CommandModule<object, EsSlashOptions> = {
  command: "del <nameOrId>",
  describe: "删除事件源",
  builder: (y) =>
    y
      .positional("nameOrId", { type: "string", demandOption: true, describe: "名称或 id" })
      .option("config", { type: "string", describe: "配置文件路径" }),
  async handler(argv) {
    const a = argv as unknown as { nameOrId: string; config?: string };
    await runEsCommand(["del", a.nameOrId], a.config);
  },
};

/** es-slash mod */
export const esSlashMod: CommandModule<object, EsSlashOptions> = {
  command: "mod <nameOrId> [pairs..]",
  describe: "修改事件源字段（k=v，如 enabled=false）",
  builder: (y) =>
    y
      .positional("nameOrId", { type: "string", demandOption: true, describe: "名称或 id" })
      .positional("pairs", { type: "string", array: true, describe: "k=v 列表" })
      .option("config", { type: "string", describe: "配置文件路径" }),
  async handler(argv) {
    const a = argv as unknown as { nameOrId: string; pairs?: string[]; config?: string };
    await runEsCommand(["mod", a.nameOrId, ...(a.pairs ?? [])], a.config);
  },
};

/** es-slash 命令组 */
export const EsSlashCommand: CommandModule = {
  command: "es-slash",
  describe: "事件源磁盘配置管理（list/add/del/mod，重启后生效）",
  builder: (yargs) =>
    yargs
      .command(esSlashList)
      .command(esSlashAdd)
      .command(esSlashDel)
      .command(esSlashMod)
      .demandCommand()
      .help(),
  handler: () => {
    /* yargs 显示帮助 */
  },
};
