/**
 * @fileoverview Task #5109 P7 —— TUI 斜杠命令**注册表**。
 *
 * ## 定位
 *
 * 纯函数、无 I/O、无渲染 —— 它是「命令面」的唯一真相源：
 * 补全面板渲染它、命令执行走它、帮助文本也由它生成。
 *
 * ## 为什么不是 `packages/cli/src/slash.ts`
 *
 * `slash.ts`（Task #2610）是 run REPL 的 switch-case 分发器：
 *   - 命令写死在 switch 里 ⇒ 没法渲染成面板列表；
 *   - 别名是另一个 case ⇒ 面板无法显示「/quit = /exit」。
 *
 * P7 注册表把「命令元数据」和「执行结果」分开：
 *   - `SlashCommandSpec` = 元数据（name/aliases/description/group）+ handler；
 *   - `SlashCommandOutcome` = handler 的返回（复用 `slash.ts` 的 kind 形状）。
 *
 * 两者的语义保持一致：`slash.ts` 继续服务 run REPL，P7 注册表服务 interactive
 * 的补全面板 + 执行。**本轮不删除 slash.ts**（run REPL 仍依赖它）。
 *
 * ## 匹配规则（对齐 opencode `parseSlashCommand`）
 *
 *   - 只匹配**完整**的名字或别名（`/hel` ≠ `/help`）——
 *     补全面板里用户可能只敲了半截，回车不该误执行；
 *   - 大小写不敏感（opencode 的 `command.toLowerCase()` 同款）；
 *   - 名字之后的**全部空白**都是 args（`/help now please` → args="now please"）。
 */

import type { SlashResult } from "../slash.js";

export type { SlashResult };

/** handler 的执行结果：复用 run REPL 的 `SlashResult` 形状（SlashResult.kind）。 */
// ★ Task #5116 P7.1 —— 配置弹窗：handler 只声明**意图**（要开哪个弹窗），
// 渲染由 RunScreen 落地（与 kind:"exit" 由 handleSubmit 分支处理同构）。
// 注：成员前置 `|` 的 union 续行 Bun transpiler 不识别（构建炸 38:2），
// 必须把成员写在 `=` 后第一个位置。
export type SlashCommandOutcome =
  | SlashResult
  | { kind: "open-dialog"; dialog: "connect" | "model" };

/**
 * 一条斜杠命令的完整定义。
 *
 * - `name` —— 主名（**不含** 前导 `/`）；
 * - `aliases` —— 别名（**不含** `/`）；opencode 同款（app.tsx:1180 `/exit` → quit/q）；
 * - `description` —— 补全面板里的一行说明；
 * - `group` —— 分组（面板可按组渲染）；
 * - `run` —— handler；`args` 是命令名之后的原始文本。
 */
export interface SlashCommandSpec {
  name: string;
  aliases?: string[];
  description: string;
  group?: string;
  run: (args: string) => SlashCommandOutcome;
}

/** 面板用的展示视图（在 spec 上补上 `/` 前缀与别名提示）。 */
export interface SlashCommandView {
  name: string;
  display: string;
  aliases: string[];
  description: string;
  group?: string;
}

/** 命令匹配结果。 */
export interface SlashCommandMatch {
  spec: SlashCommandSpec;
  /** 命令名之后的参数文本（已 trim）。 */
  args: string;
}

/**
 * 从 `/name [args...]` 解析出命令名与参数。
 *
 * 解析失败（非斜杠开头 / 名字为空）⇒ 返回 null。
 */
export function parseSlashInput(raw: string): { name: string; args: string } | null {
  const text = raw.trim();
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  if (!body) return null;
  const spaceIdx = body.search(/\s/);
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  if (!name) return null;
  const args = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
  return { name, args };
}

/**
 * 在注册表里按名字/别名找命令。
 *
 * 命中规则：完整匹配（不匹配前缀），大小写不敏感。
 */
export function findSlashCommand(
  specs: readonly SlashCommandSpec[],
  raw: string,
): SlashCommandMatch | null {
  const parsed = parseSlashInput(raw);
  if (!parsed) return null;
  for (const spec of specs) {
    const candidates = [spec.name, ...(spec.aliases ?? [])].map((c) => c.toLowerCase());
    if (candidates.includes(parsed.name)) {
      return { spec, args: parsed.args };
    }
  }
  return null;
}

/**
 * 过滤结果项：附带**匹配方式**。
 *
 * ## 为什么需要 match 字段（DS r3 MAJOR-1）
 *
 * 面板过滤有两条路径：
 *   - **name 命中**（`/he` → `/help`）—— 用户在敲命令名，Enter 应该执行它；
 *   - **description 命中**（`/history` → `/clear`，因为描述里有 "history"）
 *     —— 用户敲的是**别的**命令（`slash.ts` 的 `/history`），
 *     此时执行 `/clear` 会**静默清空会话历史**（语义完全相反）。
 *
 * ⇒ 调用方（TextInput 的 Enter 判定）必须区分这两者：
 * 只有 name 命中的高亮项才可执行；description 命中的 ⇒ 提交原文。
 */
export interface SlashCommandMatchEntry {
  spec: SlashCommandSpec;
  match: "name" | "description";
}

/**
 * 面板过滤（带匹配方式）。
 *
 * 排序规则：**名字/别名命中在前**，描述命中在后；同档保持注册表原序
 * （注册表顺序 = 面板默认顺序 = 「常用命令在前」的人工编排顺序）。
 */
export function matchSlashCommands(
  specs: readonly SlashCommandSpec[],
  query: string,
): SlashCommandMatchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return specs.map((spec) => ({ spec, match: "name" as const }));
  const nameHits: SlashCommandMatchEntry[] = [];
  const descHits: SlashCommandMatchEntry[] = [];
  for (const spec of specs) {
    const candidates = [spec.name, ...(spec.aliases ?? [])].map((c) => c.toLowerCase());
    if (candidates.some((c) => c.startsWith(q))) {
      nameHits.push({ spec, match: "name" });
      continue;
    }
    if (spec.description.toLowerCase().includes(q)) {
      descHits.push({ spec, match: "description" });
    }
  }
  return [...nameHits, ...descHits];
}

/**
 * 面板过滤：按 query 过滤命令。
 *
 * 排序规则：**名字/别名命中在前**，描述命中在后；同档保持注册表原序
 * （注册表顺序 = 面板默认顺序 = 「常用命令在前」的人工编排顺序）。
 */
export function filterSlashCommands(
  specs: readonly SlashCommandSpec[],
  query: string,
): SlashCommandSpec[] {
  return matchSlashCommands(specs, query).map((e) => e.spec);
}

/** 面板展示视图列表。 */
export function listSlashCommands(specs: readonly SlashCommandSpec[]): SlashCommandView[] {
  return specs.map((spec) => ({
    name: spec.name,
    display: `/${spec.name}`,
    aliases: [...(spec.aliases ?? [])],
    description: spec.description,
    group: spec.group,
  }));
}
