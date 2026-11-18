/**
 * @fileoverview Task #4722 — `roy-bot fallback-model` CLI 子命令
 *
 * CLI 是 command 子系统的**文本前端**（与 es 的卡片前端平级）：
 * 业务逻辑只有 core 一份，这里只负责
 *   1. 把 yargs 参数翻译成 command 子命令 + 参数
 *   2. 调 `getGlobalCommandRegistry().dispatch(...)`
 *   3. 打印结果（成功打印 `output.text`，失败打印 `output.error` 并退出码非 0）
 *
 * ## 为什么不复制 core 的逻辑
 *
 * 早期版本在 CLI 侧把 list/add/remove/reorder 的业务逻辑整份抄了一遍，
 * 结果两处会漂移（core 有 `show` 别名、CLI 没有；错误文案不一致）。
 * ★ Task #4722 收口：CLI 改为**复用 command 注册表**，
 *   与 `##command##:` 前端走**完全相同**的实现。
 *
 * ## 用法
 *
 * ```bash
 * roy-bot fallback-model list                     # 查看列表（顺序 = 优先级）
 * roy-bot fallback-model add tong/GLM-5.3-Flash   # 新增到末尾
 * roy-bot fallback-model remove 2                 # 删除第 2 项
 * roy-bot fallback-model reorder 3 1              # 把第 3 项移到第 1 位
 * ```
 *
 * 配置落在 `~/.roy-bot/config.jsonc` 的 `llm.fallbackModels`（有序数组）。
 * `--config <path>` 可指定其它配置文件（测试 / 多环境）。
 */

import { CommandModule } from "yargs";
import {
  getGlobalCommandRegistry,
  DEFAULT_CONFIG_PATH,
} from "@ai-setting/roy-bot-core";

export interface FallbackModelListOptions {
  /** 配置文件路径（默认 ~/.roy-bot/config.jsonc） */
  config?: string;
}

export interface FallbackModelAddOptions extends FallbackModelListOptions {
  /** 要新增的模型（provider/model） */
  model?: string;
}

export interface FallbackModelRemoveOptions extends FallbackModelListOptions {
  /** 序号（1-based） */
  index?: string;
}

export interface FallbackModelReorderOptions extends FallbackModelListOptions {
  /** 原序号（1-based） */
  from?: string;
  /** 新序号（1-based） */
  to?: string;
}

export interface FallbackModelMoveOptions extends FallbackModelListOptions {
  /** 模型标识（provider/model） */
  model?: string;
  /** 移动方向（up|down） */
  direction?: string;
}

/** 解析配置文件路径 */
function resolveConfigPath(config?: string): string {
  return config ?? DEFAULT_CONFIG_PATH;
}

/**
 * ★ Task #4722 收口：把 CLI 参数翻译成 command 调用并执行。
 *
 * 走 command 注册表 → 与 `##command##:` 前端**同一份实现**。
 * 成功 → 打印 `output.text`（command 的文本形态）。
 * 失败 → 打印 `output.error` 到 stderr 并 `process.exit(1)`。
 */
async function runFallbackModelCommand(
  args: string[],
  config?: string
): Promise<void> {
  const registry = getGlobalCommandRegistry();
  const result = await registry.dispatch("fallback-model", args, {
    configPath: resolveConfigPath(config),
    rawText: `roy-bot fallback-model ${args.join(" ")}`,
  });

  if (!result.ok) {
    console.error(`❌ ${result.error ?? "命令执行失败"}`);
    process.exit(1);
    return;
  }

  console.log(result.output?.text ?? "（无输出）");
}

/**
 * fallback-model list
 */
export const fallbackModelList: CommandModule<object, FallbackModelListOptions> = {
  command: "list",
  describe: "查看兜底模型列表（顺序 = 优先级，1 最高）",

  builder: (yargs) =>
    yargs.option("config", {
      type: "string",
      describe: "配置文件路径（默认 ~/.roy-bot/config.jsonc）",
    }),

  async handler(argv) {
    await runFallbackModelCommand(["list"], argv.config);
  },
};

/**
 * fallback-model add
 */
export const fallbackModelAdd: CommandModule<object, FallbackModelAddOptions> = {
  command: "add <model>",
  describe: "新增兜底模型到列表末尾（最低优先级）",

  builder: (yargs) =>
    yargs
      .positional("model", {
        type: "string",
        describe: "模型标识（provider/model）",
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径（默认 ~/.roy-bot/config.jsonc）",
      }),

  async handler(argv) {
    await runFallbackModelCommand(["add", argv.model ?? ""], argv.config);
  },
};

/**
 * fallback-model remove
 */
export const fallbackModelRemove: CommandModule<
  object,
  FallbackModelRemoveOptions
> = {
  command: "remove <index>",
  describe: "按序号删除兜底模型（1-based）",

  builder: (yargs) =>
    yargs
      .positional("index", {
        type: "string",
        describe: "序号（1-based）",
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径（默认 ~/.roy-bot/config.jsonc）",
      }),

  async handler(argv) {
    await runFallbackModelCommand(["remove", argv.index ?? ""], argv.config);
  },
};

/**
 * fallback-model reorder
 */
export const fallbackModelReorder: CommandModule<
  object,
  FallbackModelReorderOptions
> = {
  command: "reorder <from> <to>",
  describe: "调整兜底模型优先级（1-based，把 from 移到 to 位置）",

  builder: (yargs) =>
    yargs
      .positional("from", {
        type: "string",
        describe: "原序号（1-based）",
      })
      .positional("to", {
        type: "string",
        describe: "新序号（1-based）",
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径（默认 ~/.roy-bot/config.jsonc）",
      }),

  async handler(argv) {
    await runFallbackModelCommand(
      ["reorder", argv.from ?? "", argv.to ?? ""],
      argv.config
    );
  },
};

/**
 * fallback-model show
 *
 * ★ Task #4722 round3（交叉验证第 2 轮 MINOR m9）：core 支持 `show` 别名，
 *   CLI 补上（消除 CLI / core 的子命令漂移 —— 复用重构的目的正是这个）。
 */
export const fallbackModelShow: CommandModule<object, FallbackModelListOptions> = {
  command: "show",
  describe: "查看兜底模型列表（list 的别名）",

  builder: (yargs) =>
    yargs.option("config", {
      type: "string",
      describe: "配置文件路径（默认 ~/.roy-bot/config.jsonc）",
    }),

  async handler(argv) {
    await runFallbackModelCommand(["show"], argv.config);
  },
};

/**
 * fallback-model move
 *
 * 按**模型标识 + 方向**移动（卡片按钮用的就是这套语义），
 * 与 `reorder <原序号> <新序号>`（按序号）等价但不受索引漂移影响。
 */
export const fallbackModelMove: CommandModule<
  object,
  FallbackModelMoveOptions
> = {
  command: "move <model> <direction>",
  describe: "按模型标识上下移动（direction: up|down）",

  builder: (yargs) =>
    yargs
      .positional("model", {
        type: "string",
        describe: "模型标识（provider/model）",
      })
      .positional("direction", {
        type: "string",
        choices: ["up", "down"] as const,
        describe: "移动方向（up=上移一位，down=下移一位）",
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径（默认 ~/.roy-bot/config.jsonc）",
      }),

  async handler(argv) {
    await runFallbackModelCommand(
      ["move", argv.model ?? "", argv.direction ?? ""],
      argv.config
    );
  },
};

/**
 * FallbackModelCommand - 兜底模型管理主命令
 */
export const FallbackModelCommand: CommandModule = {
  command: "fallback-model",
  describe: "管理兜底模型列表（llm.fallbackModels，顺序 = 优先级）",

  builder: (yargs) =>
    yargs
      .command(fallbackModelList)
      .command(fallbackModelShow)
      .command(fallbackModelAdd)
      .command(fallbackModelRemove)
      .command(fallbackModelReorder)
      .command(fallbackModelMove)
      .demandCommand(1, "请指定子命令：list、show、add、remove、reorder、move")
      .help()
      .strict(),

  handler() {
    // 默认显示帮助（由 yargs demandCommand 处理）
  },
};
