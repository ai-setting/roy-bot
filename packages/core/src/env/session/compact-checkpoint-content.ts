/**
 * @fileoverview C 方案 checkpoint 内容处理（Task #4933 重写）
 *
 * 用户决策（飞书群 oc_xxxxxxxxxxxxxxxx）：
 *   压缩最终产物是**整段自然语言** checkpoint 正文（`content`），
 *   不再有 summary/processKeyPoints/currentState/nextSteps/userIntents 五栏位，
 *   也不再有固定 markdown 小节契约 + 章节解析器（上一轮方案被用户否定）。
 *
 * 本模块是**纯函数**集合：
 *   1. normalizeCheckpointContent — 守护：只判「有没有实质文本」
 *   2. buildCheckpointFromText    — LLM 自然语言输出 → { title, content }
 *   3. adaptLegacyCheckpoint      — 旧格式（五栏位）读时适配 → 新格式
 *   4. createCheckpointContent    — checkpoint 消息正文渲染
 *
 * 设计原则：
 *   - 守护逻辑极简但必须保留：全空 → 拒绝归档（2026-10-16 生产事故，
 *     曾静默吞掉 4731 条消息，绝对不能回归）
 *   - 旧 checkpoint 的语义完整保留（读时适配，不写回数据库）
 */

import type { SessionCheckpoint } from "./types";

// ============================================================================
// 守护
// ============================================================================

/**
 * 已知的「降级哨兵」字符串 —— 它们**不是**有效 checkpoint 内容。
 *
 * - "[Hint extraction failed]"：phase1（compact-hint）失败哨兵
 * - "maximum iterations reached"：agent 迭代上限哨兵
 * - "no usable checkpoint output"：compact 守护拒绝归档时的报错前缀
 */
const DEGRADED_TEXT_SENTINELS: ReadonlySet<string> = new Set([
  "[hint extraction failed]",
  "maximum iterations reached",
  "no usable checkpoint output",
]);

/** 正文最小长度阈值：低于它视为占位文本，不可用 */
const MIN_CONTENT_LENGTH = 20;

/**
 * 判断一段文本是否可作为 checkpoint 正文。
 *
 * 守护规则（极简）：
 *   - 非空（trim 后有内容）
 *   - 不是降级哨兵
 *   - 长度 ≥ MIN_CONTENT_LENGTH
 *
 * @returns 归一化（trim）后的正文，不可用返回 undefined
 */
export function normalizeCheckpointContent(
  text?: string | null
): string | undefined {
  const raw = (text ?? "").trim();
  if (!raw) return undefined;
  if (DEGRADED_TEXT_SENTINELS.has(raw.toLowerCase())) return undefined;
  if (raw.length < MIN_CONTENT_LENGTH) return undefined;
  return raw;
}

// ============================================================================
// 自然语言 → checkpoint
// ============================================================================

export interface CheckpointFromText {
  title: string;
  content: string;
}

/**
 * 把 LLM 输出的整段自然语言构造成 checkpoint 的 title + content。
 *
 * 标题策略：首个 markdown 标题行（`#`~`######`）→ 否则首个非空行；
 * 超长截断到 80 字符。正文整段保留（含列表、代码块等自由形式）。
 *
 * @returns { title, content }，文本不可用返回 undefined
 */
export function buildCheckpointFromText(
  text?: string | null
): CheckpointFromText | undefined {
  const content = normalizeCheckpointContent(text);
  if (!content) return undefined;

  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s+/.test(l)) ?? lines[0] ?? "";
  const title = heading
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
    .slice(0, 80);

  return {
    title: title || "Untitled Checkpoint",
    content,
  };
}

// ============================================================================
// 旧格式读时适配（lazy adapter）
// ============================================================================

/** 判断是否新格式（已有整段 content） */
function isModernCheckpoint(cp: SessionCheckpoint): boolean {
  return typeof (cp as { content?: unknown }).content === "string"
    && ((cp as { content?: string }).content ?? "").trim().length > 0;
}

/**
 * 把旧格式 checkpoint（summary/processKeyPoints/currentState/nextSteps/
 * userIntents 五栏位）在**内存中**适配为新格式（content 整段自然语言）。
 *
 * ⚠️ 只做读时适配：不写回数据库、不修改原对象（纯函数）。
 *    生产库 555 个存量 checkpoint 全是旧格式，靠本函数在读取时
 *    合成 content，新代码无感知。
 *
 * 合成策略：title + summary + 各栏位编号串联，语义完整保留。
 * 新格式原样返回（引用相等）。
 */
export function adaptLegacyCheckpoint(
  cp: SessionCheckpoint
): SessionCheckpoint {
  if (isModernCheckpoint(cp)) return cp;

  const legacy = cp as unknown as {
    summary?: string;
    processKeyPoints?: string[];
    currentState?: string;
    nextSteps?: string[];
    userIntents?: string[];
  };

  const sections: string[] = [];

  const summary = (legacy.summary ?? "").trim();
  if (summary) sections.push(summary);

  const points = legacy.processKeyPoints ?? [];
  if (points.length) {
    sections.push(points.map((p, i) => `${i + 1}. ${p}`).join("\n"));
  }

  const state = (legacy.currentState ?? "").trim();
  if (state) sections.push(state);

  const steps = legacy.nextSteps ?? [];
  if (steps.length) {
    sections.push(steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  }

  const intents = legacy.userIntents ?? [];
  if (intents.length) {
    sections.push(intents.map((u, i) => `${i + 1}. ${u}`).join("\n"));
  }

  // 合成正文；若合成结果仍低于阈值（全空旧 checkpoint），兜底用 title
  let content = sections.join("\n\n").trim();
  if (!content) content = cp.title ?? "";
  if (!normalizeCheckpointContent(content)) {
    // 完全无信息（连 title 都没有）——保底给最小占位，避免下游崩
    content = cp.id ? `Checkpoint ${cp.id}` : "";
  }

  // ★ C 方案：适配结果是**纯新格式** —— 显式剥离旧五栏位，
  //   避免下游误以为它们仍是契约字段（apply 写回时也不会残留）。
  return {
    id: cp.id,
    messageIndex: cp.messageIndex,
    title: cp.title,
    content,
    messageCountBefore: cp.messageCountBefore,
    createdAt: cp.createdAt,
    type: cp.type,
    ...(cp.recentMessages ? { recentMessages: cp.recentMessages } : {}),
  } as SessionCheckpoint;
}

// ============================================================================
// checkpoint 消息正文渲染
// ============================================================================

/**
 * 渲染 checkpoint 消息正文（存为 user 消息，进入 LLM 上下文）。
 *
 * 形态（无伪造小节标题）：
 *   # Checkpoint: {title}
 *
 *   {整段 content}
 *
 *   {N} messages compacted at {ISO}
 */
export function createCheckpointContent(
  checkpoint: SessionCheckpoint
): string {
  const adapted = adaptLegacyCheckpoint(checkpoint);
  const lines = [
    `# Checkpoint: ${checkpoint.title}`,
    "",
    adapted.content,
    "",
    `${checkpoint.messageCountBefore} messages compacted at ${new Date(checkpoint.createdAt).toISOString()}`,
  ];
  return lines.join("\n");
}
