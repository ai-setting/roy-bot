/**
 * @fileoverview Task #4620 — Laya 专用的 state / criteria 渲染
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────────────
 *
 * `decision-hint-plugin.ts`（#4481）里的 `buildStageARequest` 是按**阿里百炼
 * systemone** 的习惯写的：state 传一个 JSON 对象，criteria key 用
 * `#<id> [<type>] <title>`。
 *
 * 但 #4614 训出来的 Laya 模型是在**完全不同的渲染格式**上训练的
 * （`laya-train/scripts/build_dataset.py`）：
 *
 *   state = "【新任务标题】{title}\n"
 *           "【新任务描述】{desc[:600]}\n"
 *           "【候选任务】\n"
 *           "{key}\n    {value}\n..."          ← 候选也**重复**在 state 里
 *   key   = "#{id} {title[:50]}"               ← 没有 [type] 段
 *   value = "{status_letter}|{ago}|{desc[:45]} [tags: a,b,c,d]"   ← 与 roy-bot 相同
 *
 * Task #4620 实测（200 条 held-out，scripts/format_probe.py）：
 *
 *   | state 格式 | key 格式 | 准确率   |
 *   |-------------|----------|----------|
 *   | laya 原样   | laya 原样 | **79.00%** |
 *   | roy JSON   | laya 原样 | 56.50%   |
 *   | laya 原样   | roy      | 63.00%   |
 *   | roy JSON   | roy      | 46.50%   |
 *
 * → **两个格式都要对齐**：state 换成 laya 的中文文本形态，key 换成 laya 的
 *   `#{id} {title[:50]}`（去掉 `[type]` 段）。这是把 46.5% 拉回 79% 的关键。
 *
 * ── 与roy-bot 的 key 映射 ─────────────────────────────────────────────────
 *
 * laya 的 key 是 `#{id} {title[:50]}`，模型回的 choice 也是这个形态。
 * 插件要把 choice 映射回 task id —— 见 `matchChoiceToCandidate`。
 */

/** laya 训练时的候选 key 长度上限（build_dataset.py: `t["title"][:50]`） */
export const LAYA_CANDIDATE_TITLE_MAX = 50;

/** laya 训练时的候选描述长度上限（build_dataset.py: `t["desc"][:45]`） */
export const LAYA_CANDIDATE_DESC_MAX = 45;

/** laya 训练时的 tags 展示上限（build_dataset.py: `t["tags"][:4]`） */
export const LAYA_CANDIDATE_TAGS_MAX = 4;

/** 新任务描述在 state 里的长度上限（build_dataset.py: `req_desc[:600]`） */
export const LAYA_STATE_DESC_MAX = 600;

/** laya 训练时的 NEW_TASK 选项描述（必须逐字一致，见 build_dataset.py） */
export const LAYA_NEW_TASK_DESC = "新建为独立任务（与所有现有候选均无明确关联）";

export interface LayaCandidate {
  id: number;
  title: string;
  status: string;
  /** 相对时间，形如 "3d" / "5h" / "12m" */
  ago: string;
  description: string;
  tags: string[];
}

export interface LayaStateInput {
  title: string;
  description: string;
  /** Task #4669 — req 任务自身的 tags（渲染成【请求标签】行；无 tags 时省略） */
  tags?: string[];
  candidates: LayaCandidate[];
}

/** status → 首字母（laya 训练时用的是**大写**，roy-bot 用小写 —— 这里跟 laya） */
const LAYA_STATUS_LETTER: Record<string, string> = {
  active: "A",
  todo: "T",
  completed: "C",
  paused: "P",
  cancelled: "X",
  archived: "R",
};

/** laya key = `#{id} {title[:50]}` —— 注意**没有** `[type]` 段 */
export function layaCandidateKey(c: { id: number; title: string }): string {
  return `#${c.id} ${truncate(c.title, LAYA_CANDIDATE_TITLE_MAX)}`;
}

/**
 * laya value = `{status_letter}|{ago}|{desc[:45]} [tags: a,b,c,d]`
 *
 * 与 roy-bot 的 `renderCandidateValue`（#4107 模板）**结构一致**，
 * 只有 status 字母大小写不同（laya 训练用大写）。
 */
export function layaCandidateValue(c: {
  status: string;
  ago: string;
  description: string;
  tags?: string[];
}): string {
  const letter = LAYA_STATUS_LETTER[c.status] ?? (c.status.charAt(0) || "T").toUpperCase();
  const desc = truncate(c.description.replace(/\n/g, " "), LAYA_CANDIDATE_DESC_MAX);
  const tags = (c.tags ?? []).slice(0, LAYA_CANDIDATE_TAGS_MAX);
  const tagsPart = tags.length > 0 ? ` [tags: ${tags.join(",")}]` : "";
  return `${letter}|${c.ago}|${desc}${tagsPart}`;
}

/**
 * 渲染 laya 训练格式的 state。
 *
 * ⚠️ 候选**同时**出现在 state 文本里和 criteria 里 —— 这是训练时的形态，
 *   不是冗余：模型是从 state 的自然语言里读候选的。
 */
export function renderLayaState(input: LayaStateInput): string {
  const desc = (input.description || "").slice(0, LAYA_STATE_DESC_MAX) || "(无)";
  const lines: string[] = [];
  for (const c of input.candidates) {
    lines.push(`${layaCandidateKey(c)}\n    ${layaCandidateValue(c)}`);
  }
  // Task #4669 — req tags 段：在描述之后、候选之前；无 tags 时整行省略
  //   （向后兼容：与 #4620 的三段格式逐字一致）
  const tags = (input.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const tagsLine = tags.length > 0 ? `【请求标签】${tags.join(",")}\n` : "";
  return (
    `【新任务标题】${input.title}\n` +
    `【新任务描述】${desc}\n` +
    tagsLine +
    `【候选任务】\n` +
    lines.join("\n")
  );
}

/**
 * 渲染 laya 训练格式的 criteria。
 *
 * NEW_TASK 的**描述必须逐字**用 `LAYA_NEW_TASK_DESC` —— 训练集里每个 case
 * 都是这句话，换字会让模型对「新建」这个选项的先验偏移。
 */
export function renderLayaCriteria(candidates: LayaCandidate[]): Record<string, string> {
  const crit: Record<string, string> = {};
  for (const c of candidates) {
    crit[layaCandidateKey(c)] = layaCandidateValue(c);
  }
  crit["NEW_TASK"] = LAYA_NEW_TASK_DESC;
  return crit;
}

/**
 * 把模型回的 choice 映射回候选 task id。
 *
 * laya 的 choice 是完整的 key（`#1234 标题...`），但也可能被截断成裸 `#1234`。
 * 两种都要认。
 */
export function matchChoiceToCandidate(
  choice: string,
  candidates: LayaCandidate[],
): number | undefined {
  if (typeof choice !== "string" || choice.length === 0) return undefined;

  // 精确匹配完整 key
  for (const c of candidates) {
    if (layaCandidateKey(c) === choice) return c.id;
  }

  // 裸 #id
  if (choice.startsWith("#")) {
    const bare = Number(choice.slice(1));
    if (Number.isInteger(bare) && candidates.some((c) => c.id === bare)) return bare;
  }

  // key 被截断的情况：`#1234 标题前...` —— 用 #id 前缀匹配
  const m = /^#(\d+)\s/.exec(choice);
  if (m) {
    const bare = Number(m[1]);
    if (Number.isInteger(bare) && candidates.some((c) => c.id === bare)) return bare;
  }

  return undefined;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max);
}
