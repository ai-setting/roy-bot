/**
 * @fileoverview Task #4722 — `fallback-model` command
 *
 * 管理 `~/.roy-bot/config.jsonc` 里的兜底模型列表：
 *
 *   "llm": {
 *     "fallbackModels": ["a/M1", "b/M2"]   // 有序 = 优先级，index 0 最高
 *   }
 *
 * ## 与 Task #4623/#4682 的关系
 *
 * 现有 fallback 机制读 `llm.fallbackModel`（单字符串，见
 * agent-component.ts 的 resolveFallbackModel）。本 command 引入
 * `llm.fallbackModels` **数组**（有序列表），并保持向后兼容：
 *
 * - list：fallbackModels 数组优先；无数组时回落 fallbackModel 单值
 * - add：单值 → 自动迁移成数组
 *
 * agent 侧消费数组的接线（resolveFallbackModel 读数组首项）是
 * 后续 commit，本文件先保证 command 层读写正确。
 *
 * ## JSONC 注释保留
 *
 * config.jsonc 有用户注释，不能 parse→stringify 整文件重写
 * （注释会丢）。用 jsonc-parser 的 modify + applyEdits 做
 * **最小编辑**，注释原样保留。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { modify, applyEdits, parse as parseJSONCInternal } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

import type { CommandContext, CommandDefinition, CommandResult } from "./command-registry";
import { renderFallbackModelCard } from "./command-cards";
import { guardConfigWrite } from "../../config/config-protection";

/**
 * 默认配置路径（生产环境）
 *
 * ★ Task #4722 round3（交叉验证第 2 轮 MINOR m7）：用 `os.homedir()` 而不是
 *   `process.env.HOME ?? process.env.HOMEPATH ?? "~"` ——
 *   后者在 HOME 未设置时会退化成**相对路径** `~/.roy-bot/config.jsonc`，
 *   读写会落到当前工作目录（行为不可预期）。
 */
export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".roy-bot",
  "config.jsonc"
);

// =============================================================================
// config.jsonc 读写（注释保留）
// =============================================================================

/** 读 config.jsonc（JSONC → object）；文件不存在返回 {} */
function readConfigFile(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const text = fs.readFileSync(configPath, "utf-8");
  const errors: ParseError[] = [];
  const parsed = parseJSONCInternal(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 && parsed === undefined) {
    throw new Error(`config.jsonc 解析失败：${configPath}`);
  }
  return (parsed ?? {}) as Record<string, unknown>;
}

/**
 * 校验 dotPath 的父节点是对象（jsonc-parser 的 modify 对非对象父节点会抛
 * `Can not add index to parent of type string` 这类裸英文错误，用户看不懂）。
 *
 * ★ Task #4722 round2（交叉验证 MINOR-1）：提前给出人类可读的中文错误。
 */
function assertObjectParent(
  configPath: string,
  parsed: Record<string, unknown>,
  dotPath: string[]
): void {
  // 逐级下降到「最后一个 key 的父节点」，检查它是不是对象
  let cursor: unknown = parsed;
  for (let i = 0; i < dotPath.length - 1; i++) {
    if (cursor === undefined || cursor === null) {
      // 缺失的中间层 → jsonc-parser 会自己创建，无需检查
      return;
    }
    if (typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new Error(
        `config.jsonc 的「${dotPath.slice(0, i + 1).join(".")}」不是对象，` +
          `无法写入 ${dotPath.join(".")}（${configPath}）`
      );
    }
    cursor = (cursor as Record<string, unknown>)[dotPath[i]];
  }

  // 最终父节点（dotPath 最后一个 key 的容器）必须是对象
  if (cursor === undefined) return; // 缺失 → jsonc-parser 会自己创建
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new Error(
      `config.jsonc 的「${dotPath.slice(0, -1).join(".")}」不是对象，` +
        `无法写入 ${dotPath.join(".")}（${configPath}）`
    );
  }
}

/**
 * 用 jsonc modify 最小编辑写回，保留注释与格式。
 *
 * jsonc-parser 的 modify 返回 edits，applyEdits 应用到原文。
 * 失败（原文非法 JSONC）时抛错，不静默重写。
 */
function writeConfigPath(
  configPath: string,
  dotPath: string[],
  value: unknown
): void {
  let text: string;
  let parsedForCheck: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    text = fs.readFileSync(configPath, "utf-8");
    // 原文必须可解析才做最小编辑（否则注释位置不可信）
    const errors: ParseError[] = [];
    const parsed = parseJSONCInternal(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new Error(`config.jsonc 已损坏（解析失败），拒绝写入：${configPath}`);
    }
    parsedForCheck = (parsed ?? {}) as Record<string, unknown>;
  } else {
    // 新文件：确保目录存在
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    text = "{}";
  }

  // ★ Task #4722 round2（MINOR-1）：父节点不是对象时提前给出可读错误，
  //   而不是让 jsonc-parser 抛「Can not add index to parent of type string」。
  assertObjectParent(configPath, parsedForCheck, dotPath);

  const edits = modify(text, dotPath, value, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
    },
  });
  const result = applyEdits(text, edits);
  // ★ Task #5194 MAJOR-1 修复：config.jsonc 写入走护栏
  //   （写前快照 + 审计）。configDir = configPath 所在目录。
  const configDir = path.dirname(configPath);
  const ok = guardConfigWrite(configDir, path.basename(configPath), () => {
    fs.writeFileSync(configPath, result, "utf-8");
  });
  if (!ok) {
    throw new Error(`config.jsonc 写入失败（护栏记录见 audit.log）：${configPath}`);
  }
}

/**
 * 读 fallback 模型列表（有序 = 优先级）。
 *
 * 兼容两种存量形态：
 * - `llm.fallbackModels`: string[]（新）
 * - `llm.fallbackModel`: string（旧，单值）
 *
 * ★ Task #4722 round2（交叉验证 MINOR-6）：数组里的**非字符串 / 空串条目**
 *   会被过滤掉（展示层要的是有效模型名），但这会造成「展示索引」与
 *   「存储数组」的下标错位 —— 首次写入时那些无效条目会被静默删掉。
 *   为避免这种意外数据丢失，读取时**保留原始条目位置**：
 *   非字符串条目用空串占位（数量不变 → 下标对齐），
 *   命令层再把空串当作「无效项」跳过。
 */
export function readFallbackModelList(configPath: string): string[] {
  const config = readConfigFile(configPath);
  const llm = (config.llm ?? {}) as Record<string, unknown>;

  const arr = llm.fallbackModels;
  if (Array.isArray(arr)) {
    // ★ MINOR-6：保持**长度**与下标对齐，但保留非字符串条目的**原始值**。
    //   （本函数返回 string[]，非字符串条目在读取时无法保留原类型 ——
    //   真正的原始数组由 rawFallbackModelArray 读取，写回时用它。）
    return arr.map((m) => (typeof m === "string" ? m.trim() : ""));
  }

  const single = llm.fallbackModel;
  if (typeof single === "string" && single.trim() !== "") {
    return [single.trim()];
  }

  return [];
}

/**
 * 读取**原始** fallbackModels 数组（不做任何过滤/归一化）。
 *
 * ★ Task #4722 round2（MINOR-6）：写回时用它，保证用户手写的异常条目
 *   （非字符串 / 空串）**原样保留**，不会被一次 add/remove 静默删掉。
 */
export function readRawFallbackModelArray(configPath: string): unknown[] {
  const config = readConfigFile(configPath);
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  const arr = llm.fallbackModels;
  if (Array.isArray(arr)) return [...arr];

  // ★ 兼容旧形态：只有 `llm.fallbackModel` 单值时，原始数组 = [该值]
  //   （否则 add 会把旧单值丢掉，破坏向后兼容的迁移语义）
  const single = llm.fallbackModel;
  if (typeof single === "string" && single.trim() !== "") {
    return [single.trim()];
  }

  return [];
}

/**
 * 写回 fallback 模型列表（有序 = 优先级）。
 *
 * 走 jsonc modify → **保留用户注释**（config.jsonc 是用户手写的，
 * parse→stringify 重写会丢注释）。
 *
 * ★ Task #4722 round3（交叉验证第 2 轮 MINOR m5）：这个公开 API 与
 *   命令层的「原始条目保留」保证保持一致 —— 写入时保留原有数组里
 *   非字符串条目的**位置**（空串占位），不会把用户手写的异常条目删掉。
 *   （与 add/remove/reorder 走同一条 raw 数组路径）
 */
export function writeFallbackModelList(
  configPath: string,
  list: string[]
): void {
  const raw = readRawFallbackModelArray(configPath);
  // 已有条目数 ≤ 新列表长度 → 逐位覆盖（保留非字符串条目的原值类型）
  const next: unknown[] = raw.slice(0, list.length);
  for (let i = 0; i < list.length; i++) {
    const existing = next[i];
    // 原位置是非字符串 → 保留原值（不覆盖成字符串）
    if (typeof existing !== "string" && existing !== undefined) continue;
    next[i] = list[i];
  }
  while (next.length < list.length) next.push(list[next.length]);
  writeConfigPath(configPath, ["llm", "fallbackModels"], next);
}

// =============================================================================
// 子命令实现
// =============================================================================

/** 用法文本 */
const USAGE = [
  "用法：##command##: fallback-model <子命令> [参数]",
  "",
  "子命令：",
  "  list                     查看兜底模型列表（顺序 = 优先级）",
  "  add <provider/model>     新增到列表末尾（最低优先级）",
  "  remove <序号>            按序号删除（1-based）",
  "  reorder <原序号> <新序号> 调整优先级（1-based）",
  "  move <模型标识> <up|down>  按模型标识上下移动（卡片按钮用）",
].join("\n");

/**
 * 取**有效**条目（过滤空串占位）。
 *
 * ★ Task #4722 round2（MINOR-6）：readFallbackModelList 保留空串占位以对齐下标，
 *   但展示与操作（add/remove/reorder）只应面对有效模型名。
 */
function effectiveList(configPath: string): string[] {
  return readFallbackModelList(configPath).filter((m) => m !== "");
}

/**
 * 有效条目索引 → 原始数组索引 的映射。
 *
 * ★ Task #4722 round2（MINOR-6）：remove/reorder/move 在**原始数组**上操作，
 *   用户看到的序号是「有效条目序号」，需要映射回原始位置 ——
 *   这样无效条目（空串占位）在编辑后依然留在文件里，不会被静默删掉。
 *
 * @returns raw 原始数组 + map[i] = 第 i 个有效条目（0-based）在 raw 中的下标
 */
function rawWithIndexMap(configPath: string): {
  raw: unknown[];
  map: number[];
} {
  // ★ 用**原始数组**（保留非字符串条目），而不是归一化后的 string[]
  const raw = readRawFallbackModelArray(configPath);
  const map: number[] = [];
  raw.forEach((m, i) => {
    if (typeof m === "string" && m.trim() !== "") map.push(i);
  });
  return { raw, map };
}

/**
 * 在**原始数组**上把一个有效条目移动到另一个有效条目的位置（move 语义）。
 *
 * ★ Task #4722 round2（MINOR-6）：move 语义（非 swap）——
 *   「把第 3 项移到第 1 位」是**移动**（[a,b,c] → [c,a,b]），不是交换。
 *   在原始数组上操作 → 用户手写的无效条目不会被静默删除。
 *
 * @param fromEff 源条目的**有效序号**（0-based）
 * @param toEff   目标条目的**有效序号**（0-based）
 */
function moveInRaw(
  raw: unknown[],
  map: number[],
  fromEff: number,
  toEff: number
): void {
  const rawFrom = map[fromEff];
  const [moved] = raw.splice(rawFrom, 1);

  // 移除后，目标条目的原始下标：
  //  - 目标在源之前 → 下标不变
  //  - 目标在源之后 → 下标左移一位
  const rawTo = map[toEff] > rawFrom ? map[toEff] - 1 : map[toEff];
  raw.splice(rawTo, 0, moved);
}

/**
 * 构造「文本 + 卡片」双形态输出。
 *
 * command 子系统是多前端共享的（es 飞书卡片前端 + CLI 文本前端）：
 * 同一份业务逻辑同时产出两种形态，前端各取所需，**不复制逻辑**。
 */
function dualResult(text: string, configPath: string): CommandResult {
  const list = effectiveList(configPath);
  const config = readConfigFile(configPath);
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  const primary =
    typeof llm.defaultModel === "string" ? llm.defaultModel : undefined;

  return {
    ok: true,
    output: {
      kind: "card",
      text,
      card: renderFallbackModelCard(list, primary),
    },
  };
}

function parsePositiveIndex(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

async function executeFallbackModel(ctx: CommandContext): Promise<CommandResult> {
  const configPath = ctx.configPath ?? DEFAULT_CONFIG_PATH;
  const [sub, ...rest] = ctx.args;

  switch (sub) {
    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------
    case "list":
    case "show": {
      const list = effectiveList(configPath);
      const config = readConfigFile(configPath);
      const llm = (config.llm ?? {}) as Record<string, unknown>;
      const primary =
        typeof llm.defaultModel === "string" ? llm.defaultModel : undefined;

      // 双形态输出：text（CLI 直接打印）+ card（es 发飞书卡片）
      const text = list.length
        ? `📋 兜底模型列表（顺序 = 优先级，1 最高）：\n${list
            .map((m, i) => `   ${i + 1}. ${m}`)
            .join("\n")}`
        : "⚠️ 兜底模型列表未配置（主模型失败时不会自动降级）";

      return {
        ok: true,
        output: {
          kind: "card",
          text,
          card: renderFallbackModelCard(list, primary),
        },
      };
    }

    // ------------------------------------------------------------------
    // add <provider/model>
    // ------------------------------------------------------------------
    case "add": {
      const model = rest[0]?.trim();
      if (!model) {
        return { ok: false, error: `用法：##command##: fallback-model add <provider/model>\n${USAGE}` };
      }

      const list = effectiveList(configPath);
      // 归一化比较（忽略 provider 前缀差异由后续 agent 层处理；这里精确匹配）
      if (list.some((m) => m === model)) {
        return { ok: false, error: `「${model}」已在 fallback 列表中（重复添加被拒绝）` };
      }

      // ★ Task #4722 round2（MINOR-6）：写入时**保留原有的无效条目**，
      //   不因为一次 add 就把用户手写的异常条目静默删掉。
      //   （用原始数组；新项追加到末尾）
      const raw = readRawFallbackModelArray(configPath);
      const next = [...raw, model];
      writeConfigPath(configPath, ["llm", "fallbackModels"], next);
      return dualResult(
        `✅ 已添加「${model}」到 fallback 列表末尾（当前 ${list.length + 1} 项：${list.join(" → ")} → ${model}）`,
        configPath
      );
    }

    // ------------------------------------------------------------------
    // remove <序号>
    // ------------------------------------------------------------------
    case "remove":
    case "rm": {
      const idx = rest[0] !== undefined ? parsePositiveIndex(rest[0]) : null;
      if (idx === null) {
        return { ok: false, error: `用法：##command##: fallback-model remove <序号>（1-based）\n${USAGE}` };
      }

      const list = effectiveList(configPath);
      if (idx > list.length) {
        return {
          ok: false,
          error: `序号 ${idx} 越界（当前列表 ${list.length} 项：${list.map((m, i) => `${i + 1}.${m}`).join("，") || "空"}）`,
        };
      }

      // ★ MINOR-6：在**原始数组**上删除（保留其余无效条目），有效序号 → 原始下标
      const { raw, map } = rawWithIndexMap(configPath);
      const rawIdx = map[idx - 1];
      const removed = list[idx - 1];
      raw.splice(rawIdx, 1);
      writeConfigPath(configPath, ["llm", "fallbackModels"], raw);
      return dualResult(
        `✅ 已删除「${removed}」（剩余 ${list.length - 1} 项${list.length > 1 ? `：${list.filter((_, i) => i !== idx - 1).join(" → ")}` : ""}）`,
        configPath
      );
    }

    // ------------------------------------------------------------------
    // move <模型标识> <up|down>
    //
    // ★ Task #4722 round2（交叉验证 MINOR-2）：卡片回调按**模型标识 + 方向**移动，
    //   而不是按位置索引 —— 卡片渲染之后配置可能已被别人改动
    //   （别人用 CLI 加了项 / 另一张卡片点了删除），索引会漂移导致移错项。
    //   方向（up/down）是**意图**，在执行时按当前配置解析 → 永远正确。
    //   文本指令仍用 reorder <原序号> <新序号>（用户看到的就是序号）。
    // ------------------------------------------------------------------
    case "move": {
      const model = rest[0]?.trim();
      const direction = rest[1]?.trim().toLowerCase();
      if (!model || (direction !== "up" && direction !== "down")) {
        return {
          ok: false,
          error: `用法：##command##: fallback-model move <模型标识> <up|down>\n${USAGE}`,
        };
      }

      const list = effectiveList(configPath);
      const idx = list.findIndex((m) => m === model); // 0-based；找不到 → -1
      if (idx < 0) {
        return {
          ok: false,
          error: `列表中找不到「${model}」（当前：${list.map((m, i) => `${i + 1}.${m}`).join("，") || "空"}）`,
        };
      }

      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) {
        return {
          ok: false,
          error: `「${model}」已经在${direction === "up" ? "第 1 位" : "最后一位"}，无法再${direction === "up" ? "上移" : "下移"}`,
        };
      }

      // ★ MINOR-6：在原始数组上**移动**（无效条目保持在原处，不被静默删除）
      const { raw, map } = rawWithIndexMap(configPath);
      moveInRaw(raw, map, idx, targetIdx);

      writeConfigPath(configPath, ["llm", "fallbackModels"], raw);
      const nextOrder = effectiveList(configPath);
      return dualResult(
        `✅ 已把「${model}」移到第 ${targetIdx + 1} 位（当前顺序：${nextOrder.join(" → ")}）`,
        configPath
      );
    }

    // ------------------------------------------------------------------
    // reorder <原序号> <新序号>
    // ------------------------------------------------------------------
    case "reorder":
    case "move-index": {
      const from = rest[0] !== undefined ? parsePositiveIndex(rest[0]) : null;
      const to = rest[1] !== undefined ? parsePositiveIndex(rest[1]) : null;
      if (from === null || to === null) {
        return {
          ok: false,
          error: `用法：##command##: fallback-model reorder <原序号> <新序号>（1-based）\n${USAGE}`,
        };
      }

      const list = effectiveList(configPath);
      if (from > list.length || to > list.length) {
        return {
          ok: false,
          error: `序号越界（当前列表 ${list.length} 项：${list.map((m, i) => `${i + 1}.${m}`).join("，") || "空"}）`,
        };
      }

      // ★ MINOR-6：在原始数组上**移动**（move 语义，非交换；无效条目保留）
      const { raw, map } = rawWithIndexMap(configPath);
      const moved = raw[map[from - 1]];
      moveInRaw(raw, map, from - 1, to - 1);

      writeConfigPath(configPath, ["llm", "fallbackModels"], raw);
      const nextOrder = effectiveList(configPath);
      return dualResult(
        `✅ 已把「${moved}」移到第 ${to} 位（当前顺序：${nextOrder.join(" → ")}）`,
        configPath
      );
    }

    case undefined:
      return { ok: false, error: USAGE };

    default:
      return { ok: false, error: `未知子命令「${sub}」。\n${USAGE}` };
  }
}

/** fallback-model command 定义（注册进 CommandRegistry） */
export const fallbackModelCommand: CommandDefinition = {
  name: "fallback-model",
  description: "管理兜底模型列表（llm.fallbackModels，顺序 = 优先级）",
  usage: "fallback-model list|add|remove|reorder [参数]",
  execute: executeFallbackModel,
};

// =============================================================================
// `list model` 别名（用户需求原话：##command##: list model）
// =============================================================================

/**
 * `list` command：`list model` → fallback-model list 的快捷方式。
 *
 * 用户需求示例消息是 `##command##: list model`，注册这个别名
 * 让示例开箱即用。未来可扩展 `list <其他资源>`。
 */
export const listCommand: CommandDefinition = {
  name: "list",
  description: "查看资源列表（list model = fallback-model list）",
  usage: "list model",
  execute: async (ctx: CommandContext) => {
    const resource = ctx.args[0];
    if (resource === "model") {
      return executeFallbackModel({ ...ctx, args: ["list"] });
    }
    return {
      ok: false,
      error: `未知资源「${resource ?? "(空)"}」。可用：list model`,
    };
  },
};
