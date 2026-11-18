/**
 * @fileoverview Task #4467 — task_create 检测的纯函数层（verdict）
 *
 * 契约：/tmp/task-create-verdict-contract-v2.md
 *
 * 本文件只放**纯函数**（无 IO、无网络），便于单测：
 *   - parseSimilarTaskIds   解析 context.similar_task_ids
 *   - deriveActionFromStatus status → reopen / enhance
 *   - buildHintText          生成可执行的 hint 文本
 *   - assertNoLeakage        键名树泄漏断言（**不对值做正则**）
 *   - writeDecisionHint      写 context.decision_hint
 *   - renderCandidate*       #4107 实测的 99 字符候选模板
 */

import type { CreateTaskOptions } from "../types";
// Task #4494 — 核心逻辑 trace 插桩（@TracedAs 不支持 free function，故用 wrapFunction）
import { wrapFunction } from "../../log-trace/decorator";

// ========================================================================
// 常量（数值依据见契约 §9 参数总表）
// ========================================================================

/** `similar_task_ids` 元素上限（P16） */
export const MAX_SIMILAR_TASK_IDS = 20;

/** 候选渲染：key 的 title 截断长度（P13） */
export const CANDIDATE_TITLE_MAX = 40;

/** 候选渲染：value 的 description 截断长度（P14） */
export const CANDIDATE_DESC_MAX = 45;

/** 候选渲染：tags 展示上限（P15） */
export const CANDIDATE_TAGS_MAX = 4;

// ========================================================================
// Types
// ========================================================================

export type DecisionAction = "reopen" | "enhance" | "none";

export type HintScenario = "reuse" | "reopen" | "reopen_enhance" | "remount" | "soft_reuse";

export interface HintInput {
  scenario: HintScenario;
  /** 本次新建出来的任务 id（hint 里回指） */
  newTaskId: number;
  /** 建议复用 / 重开的目标任务 id */
  targetTaskId?: number;
  targetTask?: { title: string; status: string; type: string };
  /** remount 场景：推荐的 root id */
  recommendedRootId?: number;
  recommendedRootTitle?: string;
  /** remount 场景：当前实际传入的 parent */
  currentParentId?: number;
  /** remount 场景：当前 parent 所属的 root 祖先 */
  currentRootAncestorId?: number;
  confidence?: number;
  /** reopen_enhance 场景：是否额外带 goals 参数 */
  includeGoals?: boolean;
}

export interface CandidateRenderInput {
  id: number;
  type: string;
  title: string;
}

/** 泄漏断言的 deny-list（键名匹配，前缀语义） */
export const LEAKAGE_DENY_KEYS = [
  "expected_decision",
  "expected_root",
  "expected_",
  "case_id",
  "category",
  "suggested_",
  "recommended_",
  "best_match",
  "answer",
  "answer_key",
  "label",
  "should_",
  "target",
  "gold",
  "ground_truth",
  "hint",
  "solution",
  "duplicate_of",
  "similar_task_ids",
  "candidate_order",
  "verdict",
  "decision",
] as const;

// ========================================================================
// parseSimilarTaskIds
// ========================================================================

/**
 * 从 context JSON 里解析 `similar_task_ids`。
 *
 * 容错规则（契约 §2.3）：
 *   - context 缺失 / 非 JSON / 非对象 → []
 *   - 字段缺失 / 非数组 → []
 *   - 逐元素校验 `Number.isInteger(id) && id > 0`，非法元素丢弃
 *   - 长度 > MAX_SIMILAR_TASK_IDS → 截断
 *   - 重复 id → 去重（保留首次出现顺序）
 */
function parseSimilarTaskIdsImpl(contextJson: string | undefined): number[] {
  if (!contextJson) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const raw = (parsed as Record<string, unknown>).similar_task_ids;
  if (!Array.isArray(raw)) return [];

  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "number") continue;
    if (!Number.isInteger(item) || item <= 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_SIMILAR_TASK_IDS) break;
  }
  return out;
}

// ========================================================================
// deriveActionFromStatus
// ========================================================================

/**
 * status → 动作派生（纯规则，不需要模型）。
 *
 *   completed / cancelled / paused / archived → reopen
 *   todo / active / 未知                        → enhance
 */
function deriveActionFromStatusImpl(status: string): DecisionAction {
  switch (status) {
    case "completed":
    case "cancelled":
    case "paused":
    case "archived":
      return "reopen";
    case "todo":
    case "active":
    default:
      return "enhance";
  }
}

/**
 * reopen 时目标 status 的派生（契约 §4.5）。
 *   paused                        → active（恢复即继续做）
 *   completed / cancelled / archived → todo（已终结的任务先回未开始）
 */
export function deriveReopenStatus(status: string): "todo" | "active" {
  return status === "paused" ? "active" : "todo";
}

// ========================================================================
// buildHintText
// ========================================================================

const STATUS_LETTER: Record<string, string> = {
  todo: "t",
  active: "a",
  completed: "c",
  paused: "p",
  cancelled: "x",
  archived: "r",
};

/**
 * 新任务 id 的占位符（**裸数字**形态）。
 *
 * ⚠️ hint 是在 `task:before.create` 阶段写入 `context.decision_hint` 的，
 * 此时新任务**还没有 id**。create-tool 在 `:351` 拼 output 时用真实 id 替换本占位符。
 *
 * 形态选择：占位符是**裸数字**（`__NEW_TASK_ID__`），因为它主要出现在
 * `task_update(task_id=__NEW_TASK_ID__, ...)` 这种参数位置；
 * 需要 `#id` 形态的地方（散文里的「本次已创建新任务 #__NEW_TASK_ID__」）由调用方加 `#`。
 */
export const NEW_TASK_ID_PLACEHOLDER = "__NEW_TASK_ID__";

/**
 * 新任务 id 的**带 # 形态**占位符（用于散文语境，如「本次已创建新任务 #__NEW_TASK_ID__」）。
 *
 * 与 {@link NEW_TASK_ID_PLACEHOLDER} 分开的原因：参数位置需要裸数字
 * （`task_update(task_id=__NEW_TASK_ID__)`），散文位置需要 `#id`。
 * 两者由 create-tool 一起替换。
 */
export const NEW_TASK_ID_HASH_PLACEHOLDER = "#__NEW_TASK_ID__";

/**
 * 生成 hint 文本。
 *
 * 每种场景都必须给出**可直接执行的 `task_update` 参数** ——
 * 提示不可执行等于没说（这是 v1 的阻断级缺陷 B3）。
 */
function buildHintTextImpl(input: HintInput): string {
  switch (input.scenario) {
    case "reuse":
      return buildReuseHint(input);
    case "reopen":
      return buildReopenHint(input);
    case "reopen_enhance":
      return buildReopenEnhanceHint(input);
    case "remount":
      return buildRemountHint(input);
    case "soft_reuse":
      return buildSoftReuseHint(input);
  }
}

/** 新任务 id 的渲染文本（裸数字）：未知时用占位符 */
function newTaskRef(input: HintInput): string {
  return input.newTaskId > 0 ? String(input.newTaskId) : NEW_TASK_ID_PLACEHOLDER;
}

/** 新任务 id 的渲染文本（带 #）：未知时用带 # 的占位符 */
function newTaskHashRef(input: HintInput): string {
  return input.newTaskId > 0 ? `#${input.newTaskId}` : NEW_TASK_ID_HASH_PLACEHOLDER;
}

function targetLine(input: HintInput): string {
  const t = input.targetTask;
  if (!t) return "";
  return `#${input.targetTaskId} [${t.type}] ${t.title}\n状态：${t.status}`;
}

function buildReuseHint(input: HintInput): string {
  const goalsPart = input.includeGoals ? ", goals_and_expected_deliverables=<追加本次目标>" : "";
  return [
    "[TASK_CREATE_HINT] 检测到与已有任务高度相似，建议复用而非新建。",
    "",
    targetLine(input),
    "状态：" + (input.targetTask?.status ?? "") + " ｜ 建议动作：enhance（补充目标/描述）",
    "",
    `如需合并到 #${input.targetTaskId}，可执行：`,
    `  task_update(task_id=${input.targetTaskId}, description=<追加本次请求的描述>${goalsPart})`,
    "",
    `说明：本次已创建新任务 ${newTaskHashRef(input)}。若确认应复用 #${input.targetTaskId}，请调用上述 task_update 并按需归档 ${newTaskHashRef(input)}。`,
    "",
    "核实要点：本次请求是否就是 #" + input.targetTaskId + " 的「同一件事」，而不是同主题下新的一步？",
    "  - 若只是同主题的新一步（需要独立跟踪的新子任务），建子任务不算不采纳，但需在回复中说明为何不直接合并。",
    "  - 若确实是同一件事，应采纳 (a) 执行复用。",
    "",
    `⚠️ 你必须核实本提示：先用 task_get(${input.targetTaskId}) 确认目标任务的当前状态与内容是否与本次请求实质相同。`,
    "核实后二选一执行：",
    `(a) 确认实质相同 → 按上面的 task_update(task_id=${input.targetTaskId}, ...) 执行复用，并归档本次新建的任务 ${newTaskHashRef(input)}；`,
    "(b) 确认不相似 → 在本次回复中明确说明不采纳的理由。",
    "不允许无视本提示。",
  ].join("\n");
}

function buildReopenHint(input: HintInput): string {
  const targetStatus = input.targetTask?.status ?? "completed";
  const reopenTo = deriveReopenStatus(targetStatus);
  const goalsPart = input.includeGoals ? ", goals_and_expected_deliverables=<追加本次目标>" : "";
  return [
    "[TASK_CREATE_HINT] 检测到本次请求与已有任务实质相同，建议重开该任务而不是新建。",
    "",
    targetLine(input),
    `状态：${targetStatus} ｜ 建议动作：reopen（恢复为 ${reopenTo}）`,
    "",
    `如需重开并承接本次请求，可执行：`,
    `  task_update(task_id=${input.targetTaskId}, status=${reopenTo}, description=<追加本次请求的描述>${goalsPart})`,
    "",
    `说明：本次已创建新任务 ${newTaskHashRef(input)}。若确认应复用 #${input.targetTaskId}，请调用上述 task_update 并按需归档 ${newTaskHashRef(input)}。`,
    "",
    `核实要点：#${input.targetTaskId} 是否真的已完结（completed / cancelled），但其语义与本次请求仍然相同？`,
    "  - 若已完结但语义仍相同（本次请求是该任务的延续）→ 应采纳 (a) 重开。",
    "  - 若目标已完结且语义不同（只是主题相近）→ 应采纳 (b) 说明不采纳的理由。",
    "",
    `⚠️ 你必须核实本提示：先用 task_get(${input.targetTaskId}) 确认目标任务的当前状态与内容是否与本次请求实质相同。`,
    "核实后二选一执行：",
    `(a) 确认实质相同 → 按上面的 task_update(task_id=${input.targetTaskId}, status=${reopenTo}, ...) 执行重开，并归档本次新建的任务 ${newTaskHashRef(input)}；`,
    "(b) 确认不相似 → 在本次回复中明确说明不采纳的理由。",
    "不允许无视本提示。",
  ].join("\n");
}

function buildReopenEnhanceHint(input: HintInput): string {
  const targetStatus = input.targetTask?.status ?? "completed";
  const reopenTo = deriveReopenStatus(targetStatus);
  return [
    "[TASK_CREATE_HINT] 检测到本次请求与已有任务实质相同，且本次新增了目标，建议重开并增强该任务。",
    "",
    targetLine(input),
    `状态：${targetStatus} ｜ 建议动作：reopen + enhance（恢复为 ${reopenTo} 并追加目标）`,
    "",
    "如需重开并承接本次请求，可执行：",
    `  task_update(task_id=${input.targetTaskId}, status=${reopenTo}, description=<追加本次请求的描述>, goals_and_expected_deliverables=<追加本次目标>)`,
    "",
    `说明：本次已创建新任务 ${newTaskHashRef(input)}。若确认应复用 #${input.targetTaskId}，请调用上述 task_update 并按需归档 ${newTaskHashRef(input)}。`,
    "",
    `核实要点：① #${input.targetTaskId} 是否真的已完结（completed / cancelled）但语义仍与本次请求相同；② 本次新增的目标是否确实属于该任务的范围内？`,
    "  - 两点都成立 → 应采纳 (a) 重开并增强。",
    "  - 新增目标超出原任务范围（是独立的新工作）→ 应采纳 (b) 说明不采纳的理由。",
    "",
    `⚠️ 你必须核实本提示：先用 task_get(${input.targetTaskId}) 确认目标任务的当前状态与内容是否与本次请求实质相同。`,
    "核实后二选一执行：",
    `(a) 确认实质相同 → 按上面的 task_update(task_id=${input.targetTaskId}, status=${reopenTo}, ..., goals_and_expected_deliverables=...) 执行重开并增强，并归档本次新建的任务 ${newTaskHashRef(input)}；`,
    "(b) 确认不相似 → 在本次回复中明确说明不采纳的理由。",
    "不允许无视本提示。",
  ].join("\n");
}

function buildRemountHint(input: HintInput): string {
  return [
    "[TASK_CREATE_HINT] 检测到本次任务的挂载位置可能不合理。",
    "",
    `当前挂载：parent #${input.currentParentId} → root 祖先 #${input.currentRootAncestorId}`,
    `建议归属：root #${input.recommendedRootId} ${input.recommendedRootTitle ?? ""}`.trimEnd(),
    "",
    "如需改挂到建议的 root 下，可执行：",
    `  task_update(task_id=${newTaskRef(input)}, parent_task_id=${input.recommendedRootId})`,
    "",
    `说明：本次已创建新任务 ${newTaskHashRef(input)}，parent 未被自动修改。`,
    "",
    `核实要点：当前 parent #${input.currentParentId} 的 root 祖先 #${input.currentRootAncestorId} 与建议的 root #${input.recommendedRootId}，哪一条才是本次任务的正确归属线？（可参考兄弟任务的主题分布）`,
    "  - 建议的 root 更贴合本次任务主题 → 应采纳 (a) 执行改挂。",
    "  - 当前归属线已正确 → 应采纳 (b) 说明不采纳的理由。",
    "",
    `⚠️ 你必须核实本提示：先用 task_get(${newTaskRef(input)}) 确认本次新建任务的实际 parent，并用 task_get(${input.recommendedRootId})（必要时 task_tree）确认归属线是否真的不对。`,
    "核实后二选一执行：",
    `(a) 确认挂载不合理 → 执行改挂 task_update(task_id=${newTaskRef(input)}, parent_task_id=${input.recommendedRootId})；`,
    "(b) 确认当前挂载合理 → 在本次回复中明确说明不采纳的理由。",
    "不允许无视本提示。",
  ].join("\n");
}

function buildSoftReuseHint(input: HintInput): string {
  const goalsPart = input.includeGoals ? ", goals_and_expected_deliverables=<追加本次目标>" : "";
  return [
    "[TASK_CREATE_HINT] 检测到本次请求可能与已有任务有关联（置信度偏低，仅供参考）。",
    "",
    targetLine(input),
    "",
    "若确认是同一件事，可执行：",
    `  task_update(task_id=${input.targetTaskId}, description=<追加本次请求的描述>${goalsPart})`,
    "",
    `说明：本提示基于较低置信度，可能误判。本次已创建新任务 ${newTaskHashRef(input)}。`,
    "",
    `核实要点：#${input.targetTaskId} 与本次请求是否确为同一件事？（本提示置信度低，核实权重相应降低，但不得跳过表态）`,
    "",
    `⚠️ 你必须核实本提示：先用 task_get(${input.targetTaskId}) 确认目标任务的当前状态与内容是否与本次请求实质相同。`,
    "核实后二选一执行：",
    `(a) 确认实质相同 → 按上面的 task_update(task_id=${input.targetTaskId}, ...) 执行复用，并归档本次新建的任务 ${newTaskHashRef(input)}；`,
    "(b) 确认不相似 → 在本次回复中明确说明不采纳的理由。",
    "不允许无视本提示。",
  ].join("\n");
}

// ========================================================================
// assertNoLeakage
// ========================================================================

function isLeakingKey(key: string): boolean {
  const lower = key.toLowerCase();
  return LEAKAGE_DENY_KEYS.some((deny) =>
    deny.endsWith("_") || deny.endsWith("*") ? lower.startsWith(deny.slice(0, -1)) : lower === deny,
  );
}

/**
 * 泄漏断言：**只 walk 键名树**，绝不对值做正则。
 *
 * 原因（契约 §4.6 + 请求契约 v1 交叉验证第 8 项）：值含用户自由文本
 * （例如用户写「期望的 label 是 xxx」），正则会误杀用户正常输入。
 *
 * @throws Error 当键名树命中 deny-list 时
 */
function assertNoLeakageImpl(state: unknown, questions: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isLeakingKey(key)) {
        throw new Error(`[assertNoLeakage] leakage key detected at ${childPath}: "${key}"`);
      }
      walk(value, childPath);
    }
  };
  walk(state, "state");
  walk(questions, "questions");
}

// ========================================================================
// writeDecisionHint
// ========================================================================

/**
 * 把 hint 写进 `options.context.decision_hint`（JSON 内字段）。
 *
 * @returns true 写成功；false 写失败（context 不是合法 JSON 对象）——
 *          失败时**不修改** context，绝不破坏用户数据。
 */
function writeDecisionHintImpl(options: CreateTaskOptions, hint: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.context);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;

  (parsed as Record<string, unknown>).decision_hint = hint;
  options.context = JSON.stringify(parsed);
  return true;
}

// ========================================================================
// Candidate rendering (#4107 measured, 99 chars/candidate)
// ========================================================================

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** key = `#<id> [<type>] <title 截断>` */
export function renderCandidateKey(c: CandidateRenderInput): string {
  return `#${c.id} [${c.type}] ${truncate(c.title, CANDIDATE_TITLE_MAX)}`;
}

/** value = `<status 首字母>|<相对时间>|<description 截断45> [tags: 前4个]` */
export function renderCandidateValue(c: {
  id: number;
  status: string;
  ago: string;
  description: string;
  tags?: string[];
}): string {
  const letter = STATUS_LETTER[c.status] ?? (c.status.charAt(0) || "t");
  const desc = truncate(c.description, CANDIDATE_DESC_MAX);
  const tags = (c.tags ?? []).slice(0, CANDIDATE_TAGS_MAX);
  const tagsPart = tags.length > 0 ? ` [tags: ${tags.join(",")}]` : "";
  return `${letter}|${c.ago}|${desc}${tagsPart}`;
}

/**
 * 相对时间格式化（P17）：d / h / m；未来时间钳到 `0m`。
 */
export function formatRelativeAge(isoTimestamp: string, now: number = Date.now()): string {
  const ts = Date.parse(isoTimestamp);
  if (Number.isNaN(ts)) return "0m";
  const diffMs = now - ts;
  if (diffMs <= 0) return "0m";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ========================================================================
// Task #4494 — 核心逻辑 trace 插桩（wrapFunction 包装后的对外导出）
// ========================================================================
//
// ⚠️ 为什么用 `wrapFunction` 而不是 `@TracedAs` 装饰器：
//   `@TracedAs` 只适用于 **class 方法**（legacy decorator 三个参数）或
//   TC39 装饰器语法的 class element。TS 的 decorator 语法不允许直接挂在
//   `export function` 声明上（`decorator-tool.ts:928` 有同样的历史结论：
//   "@TracedAs 不支持 free function"），本仓已有 `wrapFunction` 兜底先例
//   （`delegate-tool.ts:930` _detectWorkflowShortcutWrapped）。
//
// span 命名统一 `task.decision.*` 前缀，便于 `debug trace` 里按前缀过滤。

/**
 * 解析 `context.similar_task_ids`。
 *
 * recordParams: 只记 `contextLen` + 原始片段前 80 字（避免整段 context JSON 进 trace）
 * recordResult: 记 id 数组（数量小，可直接看）
 */
export const parseSimilarTaskIds = wrapFunction(
  parseSimilarTaskIdsImpl,
  "task.decision.parseSimilarTaskIds",
  {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => {
      const raw = args[0];
      const ctx = typeof raw === "string" ? raw : "";
      return {
        contextLen: ctx.length,
        contextPreview: ctx.length > 80 ? ctx.slice(0, 80) + "…" : ctx,
      };
    },
    resultFilter: (res: number[]) => ({ count: res.length, ids: res.join(",") }),
  },
);

/**
 * status → 动作派生（纯规则）。
 *
 * 入参是单个 status 字符串，出参是 reopen/enhance/none —— 体积小，全记。
 */
export const deriveActionFromStatus = wrapFunction(
  deriveActionFromStatusImpl,
  "task.decision.deriveActionFromStatus",
  {
    recordParams: true,
    recordResult: true,
    log: false,
  },
);

/**
 * 生成可执行 hint 文本。
 *
 * ⚠️ result 是**多行长文本**（含 `task_update({...})` 模板），必须截断：
 * 契约 §6 的 5 种模板最长约 800 字符，这里只留前 240 字符 + 总长度，
 * 完整文本可通过 `debug span` 的 attributes.params 拿到 HintInput 反推。
 */
export const buildHintText = wrapFunction(
  buildHintTextImpl,
  "task.decision.buildHintText",
  {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => {
      const i = (args[0] ?? {}) as HintInput;
      return {
        scenario: i.scenario,
        newTaskId: i.newTaskId,
        targetTaskId: i.targetTaskId ?? null,
        recommendedRootId: i.recommendedRootId ?? null,
        currentParentId: i.currentParentId ?? null,
        confidence: i.confidence ?? null,
      };
    },
    resultFilter: (res: string) => ({
      hintLen: res.length,
      hintPreview: res.slice(0, 240),
      hasTaskUpdate: /task_update\s*\(/.test(res),
      hasTaskId: /"task_id"\s*:/.test(res),
      hasParentTaskId: /"parent_task_id"\s*:/.test(res),
    }),
  },
);

/**
 * 泄漏断言 —— **最关键的一条 trace**。
 *
 * 为什么必须可观测：泄漏断言是「请求体永不含答案」的唯一守门人。
 * 如果它静默跳过/静默失败，trace 里会完全看不出来（无 span = 无证据）。
 * 这里用 `errorIf` 让 span 在抛错时显式标 ERROR。
 */
export const assertNoLeakage = wrapFunction(
  assertNoLeakageImpl,
  "task.decision.assertNoLeakage",
  {
    recordParams: true,
    recordResult: false,
    log: false,
    // 只记键名树摘要，**绝不记值**（值含用户自由文本，可能含敏感信息）
    paramFilter: (args) => ({
      stateKeys: collectKeyNames(args[0]),
      questionKeys: collectKeyNames(args[1]),
    }),
  },
);

/**
 * 写 `options.context.decision_hint`。
 *
 * 返回值是 boolean（写成功/失败），用 `errorIf` 把 false 标成 span ERROR ——
 * 否则"写失败导致 hint 静默丢失"在 trace 里完全看不出来。
 */
export const writeDecisionHint = wrapFunction(
  writeDecisionHintImpl,
  "task.decision.writeDecisionHint",
  {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => {
      const opts = (args[0] ?? {}) as CreateTaskOptions;
      const hint = typeof args[1] === "string" ? (args[1] as string) : "";
      return {
        contextLen: typeof opts.context === "string" ? opts.context.length : 0,
        hintLen: hint.length,
        hintScenario: /task_update\s*\(/.test(hint) ? "actionable" : "plain",
      };
    },
    resultFilter: (res: boolean) => ({ written: res }),
    errorIf: (res: boolean) => (res === false ? new Error("writeDecisionHint returned false (context not a JSON object)") : undefined),
  },
);

/**
 * 键名树收集（最多 40 个，去重）—— 供 assertNoLeakage 的 paramFilter 使用。
 *
 * 只收**键名**，不收值：值里可能有用户自由文本（含 "expected"/"label" 等字样），
 * 收进 trace 既无用又可能误判。
 */
function collectKeyNames(node: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 40 || depth > 4) return out;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 3)) collectKeyNames(item, out, depth + 1);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (out.length >= 40) break;
    if (!out.includes(key)) out.push(key);
    collectKeyNames((node as Record<string, unknown>)[key], out, depth + 1);
  }
  return out;
}
