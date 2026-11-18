/**
 * @fileoverview Task #4760 — task completion hook 的 Laya decision 判定
 *
 * 与 create 侧（`laya-decision-plugin.ts`，#4620）的关系：
 *   - create 侧挂在 `task:before.create`，判「新建 vs 复用」
 *   - 本插件挂在 `task:after.complete`（AFTER_COMPLETE），判
 *     「目标 vs 交付物 match / 目标是否达成 / 交付物是否产出」
 *
 * 形态：**只提示，不拦截**（与 create 侧契约一致）。
 *   AFTER_COMPLETE 触发时任务**已经**是 completed —— hint 只能
 *   ① 追加写进 `task.context.completion_hint`（走 updateTask）
 *   ② 落一条 operation 记录
 *   绝不能阻断已完成状态、绝不能抛错。
 *
 * ── fail-open 六场景（对齐 create 侧 #4620） ─────────────────────
 *   1. 未配置 provider（auth.json 缺失 / 无 laya-goal-decision）→ 不调模型
 *   2. auth 损坏 / port 抛错（网络、超时）→ 静默
 *   3. 响应畸形（无 answers / 无 answer）→ 静默
 *   4. 置信度 < 0.92 → 不写 hint
 *   5. operation chain 空 → 不调模型
 *   6. choice 无法识别 → 静默
 *
 * ── provider 分离（Task #4804） ────────────────────────────────
 *   completion hook 读 `providers["laya-goal-decision"]`
 *   （model=task-completion / v13e ckpt，判「目标 vs 交付物」）；
 *   create hook 继续读 `providers["laya-decision"]`
 *   （model=task-decision / v3-tags，判「新建 vs 复用」）。
 *   goal 专用 provider 缺失时保守回退 laya-decision（fail-open 不变）。
 *
 * ── 泄漏断言 ─────────────────────────────────────────────────────
 *   deny-list 含 decision/hint/target/answer 等键名 →
 *   question key 必须命名 `completion_check`、criteria 用
 *   `PASS_COMPLETED/FAIL_INCOMPLETE`（已验证不命中）；
 *   state 用中文文本形态（【】段）则天然无对象键。
 *
 * ── 时序关键（勘查结论） ─────────────────────────────────────────
 *   AFTER_COMPLETE 触发时 `completed` operation 尚未写入
 *   （completeTask 在 hook 之后才 createOperation）。
 *   因此 operation chain 里看到的是「完成前的历史记录」——
 *   这正是判定所需的证据链，无需等 completed 记录。
 */

import {
  LayaDecisionPort,
  loadLayaAuthForPurpose,
} from "./laya-port";
import type { DecisionPort, DecisionRequest, DecisionResponse, DecisionAnswer } from "./decision-port";
import { pickGateConfidence } from "./decision-hint-plugin";
import type { TaskCompleteResultContext } from "../hooks/contexts";
import type { Task, TaskOperation } from "../types";
import { createLogger } from "../../log-trace/logger";
// Task #4494 — trace 插桩
import { TracedAs } from "../../log-trace/decorator";

const logger = createLogger("plugin:laya-completion");

/** 完成判定的置信度门禁（对齐 create 侧 LAYA_REUSE_THRESHOLD = 0.92） */
export const LAYA_COMPLETION_THRESHOLD = 0.92;

/** 二选一 criteria 值（不命中泄漏 deny-list；模型按 choice 回） */
const CHOICE_PASS = "PASS_COMPLETED";
const CHOICE_FAIL = "FAIL_INCOMPLETE";

/** 操作记录链渲染上限（防 state 无限膨胀） */
const MAX_OPERATIONS_IN_STATE = 20;
/** 单条操作记录标题/描述截断 */
const OP_TITLE_MAX = 60;
const OP_DESC_MAX = 120;
/** 任务目标截断 */
const GOALS_MAX = 400;

// ========================================================================
// Hint 文案（核实义务模式，对齐 create 侧 commit c74818f2）
// ========================================================================

/**
 * 构造完成核验 hint。
 *
 * 核实义务 + 二选一：(a) 确认未完成 → 重开继续推进；
 * (b) 确认已完成 → 落 operation 说明理由。不允许无视。
 */
export function buildCompletionHint(task: Task, confidence: number): string {
  return [
    "[TASK_COMPLETION_HINT] 决策模型检测到「目标 vs 交付物」可能不匹配：任务已标记完成，但操作记录链显示目标或交付物可能未达成。",
    "",
    `任务：#${task.id} [${task.type}] ${task.title}`,
    `状态：${task.status} ｜ 判定置信度：${confidence.toFixed(4)}`,
    "",
    "⚠️ 你必须核实本提示：先用 task_get(task_id=" +
      task.id +
      ") 复核任务的目标（description / goals_and_expected_deliverables）与交付物证据（context.deliverable_storage_path、操作记录链）。",
    "核实后二选一执行：",
    "(a) 确认未完成 → task_update(task_id=" +
      task.id +
      ", status=todo) 重开任务继续推进；",
    "(b) 确认已完成 → task_operation_create(task_id=" +
      task.id +
      ", milestone_type=decision, ...) 落一条操作记录说明已完成的理由。",
    "不允许无视本提示。",
  ].join("\n");
}

// ========================================================================
// state 渲染（laya 中文文本形态，【】段）
// ========================================================================

/** 渲染操作记录链（正序：最早的在前） */
function renderOperations(ops: TaskOperation[]): string {
  if (ops.length === 0) return "(无操作记录)";
  // ⚠️ Task #4760 review M1 修复：timestamp 是 ISO 字符串（types.ts），
  //   数值相减得 NaN → 排序失效。改用 Date 解析。
  const sorted = [...ops].sort(
    (a, b) =>
      new Date(a.timestamp ?? 0).getTime() -
      new Date(b.timestamp ?? 0).getTime(),
  );
  // ★ Task #4776 review MINOR-2：窗口截断时保证首条记录（通常是
  //   createTask 自动落的 create 锚点）在场 —— 7c2d30f2 前提：
  //   create 记录承载任务描述，是判定「目标 vs 交付物」的有效证据。
  //   窗口 = 前 1 条（create 锚点）+ 最近 MAX-1 条；不足窗口时全量。
  let windowed: TaskOperation[];
  if (sorted.length <= MAX_OPERATIONS_IN_STATE) {
    windowed = sorted;
  } else {
    const tail = sorted.slice(-(MAX_OPERATIONS_IN_STATE - 1));
    const head = sorted.slice(0, 1);
    // 去重：head 与 tail 可能重叠（理论上不会，防御性处理）
    const seen = new Set(tail.map((o) => o.id));
    windowed = seen.has(head[0].id) ? tail : [...head, ...tail];
  }
  return windowed
    .map((op, i) => {
      const title = (op.milestoneTitle || "").slice(0, OP_TITLE_MAX);
      const desc = (op.milestoneDescription || "")
        .replace(/\n/g, " ")
        .slice(0, OP_DESC_MAX);
      const proc = (op.processDescription || "")
        .replace(/\n/g, " ")
        .slice(0, OP_DESC_MAX);
      const parts = [`#${i + 1} [${op.milestoneType}] ${title}`];
      if (desc) parts.push(`    ${desc}`);
      if (proc) parts.push(`    过程：${proc}`);
      return parts.join("\n");
    })
    .join("\n");
}

/** 从 task.context JSON 里读 deliverable_storage_path（损坏时返回空串） */
function readDeliverablePath(task: Task): string {
  try {
    const parsed = JSON.parse(task.context || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const p = (parsed as Record<string, unknown>).deliverable_storage_path;
      return typeof p === "string" ? p : "";
    }
  } catch {
    /* context 损坏 → 视为无交付物声明 */
  }
  return "";
}

/**
 * Task #4804 — 从一段 goals 子项文本里抽首个路径样 token。
 *
 * 子项形如「产出 /tmp/x/a.txt，内容为 A」—— 路径是唯一可机器
 * 比对的锚点。抽不出（纯动作描述）返回 null。
 *
 * CV MAJOR-1 修复（DS 复审 v2）：改用 ASCII 路径字符集 ——
 * 路径只由 [A-Za-z0-9._~\-/@%+] 组成，遇任何非 ASCII 字符
 * （中文/全角括号/全角冒号）即停，彻底杜绝 CJK 污染
 * （含「（」在前或后两种位置）。
 *
 * CV MAJOR-2 修复（DS 复审 v3）：加**左边界**断言 ——
 * 散文里的斜杠（分支名 fix/task-show-*、比值 reward/duration、
 * 工具名 tool/bash、相对路径 dist/pkg）不是绝对路径。
 * 要求 `/` 前面是行首或分隔符（空白/中文括号/冒号/逗号），
 * 且 token 至少 2 字符。
 *
 * CV MAJOR-2b（DS 复审 v3 收尾）：token 还须**像文件路径** ——
 * 含 2 个以上 `/`（/tmp/x/a.txt）或带扩展名（/report.md）。
 * 否则 "/tmp-host"（docker mount 参数）这类伪路径会被误当交付物。
 */
function looksLikeFilePath(token: string): boolean {
  // CV MAJOR-1（DS 复审 v4）：以 "//" 开头的是 scheme:// 的后半截
  // （"https://h/p" → "//h/p"），不是本地路径 —— 直接拒绝。
  if (token.startsWith("//")) return false;
  if ((token.match(/\//g) ?? []).length >= 2) return true;
  return /\.[A-Za-z0-9]+$/.test(token);
}

function firstPathToken(text: string): string | null {
  // CV MAJOR-1（DS 复审 v4）：URL 不是可比对路径 ——
  // "https://my.feishu.cn/docx/abc" 里的 "//" 左边是半角冒号，
  // 若直接抽出 "//my.feishu.cn/docx/abc" 这种假 token
  // （2 个斜杠 → 通过 looksLikeFilePath），它永不进 declaredSet
  // → 恒判「未产出」→ 假 FAIL hint。
  // 守卫放在 looksLikeFilePath（拒绝 "//" 前缀 token），
  // 半角冒号仍留在左边界集合里 —— 否则「产出:/tmp/x/a.txt」
  // 这种「冒号紧贴路径」的合法形态会被误杀。
  const m = text.match(/(?:^|[\s（(【「:：,，])(\/[A-Za-z0-9._~\-/@%+]{2,})/);
  if (!m) return null;
  return looksLikeFilePath(m[1]) ? m[1] : null;
}

/**
 * Task #4804 — 生成【逐条对照】行。
 *
 * e2e 探针（#4804）实证：v13e 对 goals×deliverable 的**隐式差异**
 * 不敏感（H 形态 PASS 0.98），需要 state 明示未达成子项才判 FAIL
 * （J 形态 0.955，K 全完成不误报 0.985，L 纯事实无结论词 PASS 0.911
 * —— 模型需要结论词）。因此对照行：
 *   - 每个编号子项抽路径，与交付物声明做**完整 token** 比对
 *   - 命中 → 「已产出」；未命中 → 「未产出」
 *   - 尾缀结论词「目标未完成 / 目标全部完成」
 * CV MAJOR-2 修复：deliverable 必须自身像路径集合（含 `/` 且每个
 * 逗号分隔 token 都以 `/` 开头）才做比对 —— 分支名 / 飞书 URL 等
 * 非路径形态不做子项比对（无法可靠判定，宁可不生成）。
 * 比对用「token 边界」而非裸子串：`/tmp/x/a.txt` 不被
 * `/tmp/x/a.txt.bak` 误判为已产出。
 *
 * CV MAJOR-3 修复：对照行整体截断到 CHECKLIST_MAX（1200 字符），
 * 与 GOALS_MAX 同量级，防止大量子项突破 state 预算。
 */
const CHECKLIST_MAX = 1200;

/** CV MAJOR-2（DS 复审 v2）：deliverable 分隔符 —— 半角/全角逗号、
 *  分号、顿号、换行都算分隔（真实任务里 37 例用 ; 分隔） */
const DELIVERABLE_SPLIT = /[,，;；、\n]/;

/** CV MAJOR-1（DS 复审 v3）：" + " 也是分隔符 —— 真实数据里 12.7%
 *  的 deliverable 用 " + " 连接多个路径（"/a.md + 报告 /b.md"） */
const DELIVERABLE_PLUS_SPLIT = /\s\+\s/;

/** 从一个 deliverable 段里剥出纯路径（剥附注前缀词、尾部标点） */
function stripDeliverableToken(t: string): string | null {
  const seg = t.trim();
  if (!seg) return null;
  // URL 形态（https://…）不是可比对的本地路径
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(seg)) return null;
  // 段内可能有前缀词（"报告 /tmp/b.md"、"diff /tmp/c.diff"）→
  // 扫出第一个绝对路径 token（同一套左边界规则）
  const m = seg.match(
    /(?:^|[\s（(【「:：,，])(\/[A-Za-z0-9._~\-/@%+]{2,})/,
  );
  if (!m) return null;
  // MINOR-2（DS 复审 v3）：剥尾部标点（"/tmp/x/a.txt。" → "/tmp/x/a.txt"）
  // CV MINOR-1（DS 复审 v4）：ASCII 尾部标点也要剥 ——
  // 路径字符集含 "."，故 "/tmp/x/a.txt." 会把句末点吃进 token。
  const path = m[1].replace(/[。，、；：）】」"'”’.,;:!?)\]}]+$/u, "");
  return path.startsWith("/") ? path : null;
}

/** URL 段（可忽略，不是路径也不算失败） */
function isUrlSegment(seg: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(seg.trim());
}

/** 把 deliverable 串拆成段（先拆 " + "，再拆多分隔符，
 *  再拆 URL 段与段内空格分隔的裸路径 —— Task #4834 F1） */
function splitDeliverableSegments(deliverable: string): string[] {
  return deliverable
    .split(DELIVERABLE_PLUS_SPLIT)
    .flatMap((s) => s.split(DELIVERABLE_SPLIT))
    .flatMap((s) => splitUrlSegments(s))
    .flatMap((s) => splitSpaceSeparatedPaths(s))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Task #4834 — CV MAJOR-1/MINOR-2/MINOR-3：把段内的 **URL 片段**
 *  全部拆成独立段（不只段首那一个）。
 *
 *  背景：段内出现 URL 时，若不拆开，URL 与其后第一个路径会被合并成
 *  一段 —— 该段以 "https://" 开头 → stripDeliverableToken 判为 URL
 *  返回 null → 段里的路径永久丢失 → 对应子项被误标「未产出」。
 *
 *  处理两类 URL：
 *  - `file://` —— **本地路径的 URL 形态** → 剥掉 scheme 保留路径
 *    （否则本地文件会被当成远端资源忽略）。
 *  - 其他 scheme（https/http/...）—— 远端资源 → 独立成段，忽略。
 */
function splitUrlSegments(seg: string): string[] {
  // URL token：scheme:// 后跟非空白字符
  const re = /([a-z][a-z0-9+.-]*:\/\/\S+)/gi;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    // URL 之前的非 URL 部分（可能是附注词 + 路径）
    const before = seg.slice(last, m.index).trim();
    if (before) parts.push(before);
    const url = m[1];
    if (/^file:\/\//i.test(url)) {
      // file:// 是本地路径形态 → 剥 scheme 保留绝对路径
      const local = url.replace(/^file:\/\//i, "");
      if (local) parts.push(local);
    } else {
      parts.push(url);
    }
    last = m.index + url.length;
  }
  const rest = seg.slice(last).trim();
  if (rest) parts.push(rest);
  return parts.length > 0 ? parts : [seg];
}

/** Task #4834 — F1：段内「空格分隔的裸路径」拆段锚点。
 *  返回每个路径 token 的起始下标；只有 ≥2 个锚点才需要拆。
 *  "//" 开头的 token（URL scheme 残余，如 "https:" 后的
 *  "//my.feishu.cn/…"）**不作**锚点 —— 否则会把 URL 拆成
 *  "https:" + "//…" 两个垃圾段，破坏 URL 段识别。 */
function spaceSeparatedPathStarts(seg: string): number[] {
  const re = /(?:^|[\s（(【「:：,，])(\/[A-Za-z0-9._~\-/@%+]{2,})/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    // "^" 分支零宽匹配（m[0] 以 "/" 开头）→ 路径起点 = m.index；
    // 边界字符分支消耗 1 字符 → 路径起点 = m.index + 1。
    const pathStart = m[0].startsWith("/") ? m.index : m.index + 1;
    if (m[1].startsWith("//")) continue;
    starts.push(pathStart);
  }
  return starts;
}

/** Task #4834 — F1：段内空格分隔的多路径拆段。
 *  例："/tmp/a.md /tmp/b.md" → ["/tmp/a.md", "/tmp/b.md"]；
 *  "报告 /tmp/a.md 报告 /tmp/b.md" →
 *  ["报告 /tmp/a.md", "报告 /tmp/b.md"]（附注词跟自己的路径走）。
 *  <2 个锚点 → 原样返回（单路径段不拆，附注语义保持）。 */
function splitSpaceSeparatedPaths(seg: string): string[] {
  const starts = spaceSeparatedPathStarts(seg);
  if (starts.length < 2) return [seg];
  const parts: string[] = [seg.slice(0, starts[1])];
  for (let i = 1; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : seg.length;
    parts.push(seg.slice(starts[i], end));
  }
  return parts;
}

function isPathLikeDeliverable(deliverable: string): boolean {
  if (!deliverable.includes("/")) return false;
  const segs = splitDeliverableSegments(deliverable);
  if (segs.length === 0) return false;
  // 至少一个段能解析出绝对路径
  const paths = segs.map(stripDeliverableToken).filter((p): p is string => p !== null);
  if (paths.length === 0) return false;
  // 非 URL 段必须都能解析出路径（URL 段允许被忽略）
  return segs.every(
    (s, i) => stripDeliverableToken(s) !== null || isUrlSegment(s),
  );
}

function renderCriteriaChecklist(
  goalsText: string,
  deliverable: string,
): string | null {
  if (!deliverable || deliverable === "(未声明)") return null;
  // CV MAJOR-2：非路径形态的 deliverable（分支名/URL）不比对
  if (!isPathLikeDeliverable(deliverable)) return null;
  // 编号子项拆行：行首「1.」「2、」「1)」等
  const items = goalsText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\s*[.、)）]/.test(l));
  if (items.length === 0) return null;
  const tokens = items.map(firstPathToken);
  if (tokens.some((t) => t === null)) return null;
  // CV MAJOR-2（DS 复审 v2）：完整 token 边界比对 ——
  // deliverable 按多分隔符拆开 + 剥附注，命中 = 存在完全
  // 相等的 token（避免 a.txt ⊂ a.txt.bak 假阳性）
  // CV MAJOR-1（DS 复审 v3）：" + " 也当分隔符
  const declared = splitDeliverableSegments(deliverable)
    .map(stripDeliverableToken)
    .filter((t): t is string => t !== null);
  const declaredSet = new Set(declared);
  // CV MINOR-4：保留 goals 原始编号（跳号/非 1 起始也对得上）
  const lines = items.map((item, i) => {
    const token = tokens[i] as string;
    const done = declaredSet.has(token);
    const origNum = item.match(/^(\d+)\s*[.、)）]/)?.[1] ?? String(i + 1);
    // Q 形态措辞（#4804 消融实验定稿）：全路径 + 「已产出/未产出」
    // + 尾缀结论词 —— 「不在交付物声明中」措辞置信度掉到 0.2-0.7
    return done
      ? `${origNum}. ${token} 已产出`
      : `${origNum}. ${token} 未产出`;
  });
  const anyUndone = tokens.some(
    (t) => !declaredSet.has(t as string),
  );
  const raw = `【逐条对照】${lines.join("；")}，目标${
    anyUndone ? "未完成" : "全部完成"
  }`;
  // CV MAJOR-3：护栏截断（保住头尾结论词）
  if (raw.length > CHECKLIST_MAX) {
    const suffix = `目标${anyUndone ? "未完成" : "全部完成"}`;
    // CV MINOR-2（DS 复审 v4）：截断要切在**条目边界**上，
    // 不能把 token 切成半截（"…；53. /…" 那种语义噪声会喂给 v13e）。
    const head = raw.slice(0, CHECKLIST_MAX - suffix.length - 2);
    const lastSep = head.lastIndexOf("；");
    const cut = lastSep > 0 ? head.slice(0, lastSep) : head;
    // 省略号单独成段（前面留分隔符），避免和最后一个条目黏在一起
    return `${cut}；…，${suffix}`;
  }
  return raw;
}

/**
 * 渲染 laya 训练格式的中文文本 state。
 *
 * ⚠️ 用【】段而非 JSON 对象 —— laya 模型在中文文本形态上训练；
 *   且文本形态天然没有对象键，不会命中泄漏断言的 deny-list。
 *
 * Task #4804 — goals 为编号子项且交付物声明可比对时，插入
 * 【逐条对照】段（见 renderCriteriaChecklist 注释）。
 */
export function renderCompletionState(task: Task, ops: TaskOperation[]): string {
  const goals = (task.goals_and_expected_deliverables || "(无)")
    .replace(/\n/g, " ")
    .slice(0, GOALS_MAX);
  const deliverable = readDeliverablePath(task) || "(未声明)";
  // 对照行用**原始 goals 文本**（保留换行才能拆编号子项）
  const checklist = renderCriteriaChecklist(
    task.goals_and_expected_deliverables || "",
    deliverable,
  );
  return (
    `【任务标题】${task.title}\n` +
    `【任务目标】${goals}\n` +
    `【交付物声明】${deliverable}\n` +
    (checklist ? `${checklist}\n` : "") +
    `【操作记录】\n` +
    renderOperations(ops)
  );
}

/** 渲染 completion_check 二选一 question（key 不命中泄漏 deny-list） */
export function buildCompletionQuestion(): Record<string, unknown> {
  return {
    completion_check: {
      type: "choice",
      instructions:
        "根据任务目标、交付物声明与操作记录链，判断该任务是否真正达成目标且产出交付物。" +
        `若证据充分支持已完成，选 ${CHOICE_PASS}；若目标或交付物疑似未达成，选 ${CHOICE_FAIL}。`,
      criteria: {
        [CHOICE_PASS]: "目标已达成且交付物已产出",
        [CHOICE_FAIL]: "目标或交付物疑似未达成",
      },
    },
  };
}

// ========================================================================
// Plugin
// ========================================================================

export interface LayaCompletionPluginOptions {
  /** auth.json 路径（默认 ~/.roy-bot/auth.json） */
  authPath?: string;
  /** 硬超时（默认 2000ms） */
  timeoutMs?: number;
  /** 连续超时多少次后自我禁用（默认 3） */
  maxStrikes?: number;
  /** 注入 port（测试用；给了就不读 auth.json） */
  decisionPort?: DecisionPort;
  /** 完成判定的置信度门禁（默认 0.92） */
  completionThreshold?: number;
}

export class LayaCompletionPlugin {
  readonly name = "laya-completion";
  readonly version = "1.0.0";
  readonly description =
    "Task #4760 — task:after.complete 完成判定（目标/交付物 match，只提示不拦截）";

  private readonly options: LayaCompletionPluginOptions;
  private port: DecisionPort | null = null;
  private portResolved = false;

  constructor(options: LayaCompletionPluginOptions = {}) {
    this.options = options;
    if (options.decisionPort) {
      this.port = options.decisionPort;
      this.portResolved = true;
    }
  }

  /** 当前是否已自我禁用（熔断）—— 供观测 */
  isDisabled(): boolean {
    return this.port?.isDisabled() ?? false;
  }

  /** 懒加载 + 缓存 port（读 auth.json 只做一次） */
  private async resolvePort(): Promise<DecisionPort | null> {
    if (this.portResolved) return this.port;
    this.portResolved = true;
    try {
      // Task #4804 — provider 分离：completion hook 读
      // laya-goal-decision（缺失时保守回退 laya-decision）
      const auth = await loadLayaAuthForPurpose(
        this.options.authPath ??
          `${process.env.HOME ?? "~"}/.roy-bot/auth.json`,
        "goal",
      );
      if (!auth) return null;
      this.port = new LayaDecisionPort({
        baseURL: auth.baseURL,
        apiKey: auth.apiKey,
        model: auth.model,
        timeoutMs: this.options.timeoutMs,
        maxStrikes: this.options.maxStrikes,
      });
    } catch (err) {
      logger.warn(
        `[laya-completion] loadLayaAuth failed (fail-open): ${(err as Error)?.message}`,
      );
      this.port = null;
    }
    return this.port;
  }

  /**
   * hook 入口 —— **永不抛**。
   *
   * @param ctx   TaskCompleteResultContext（或框架 HookContext，载荷在 .data）
   * @param taskComponent TaskComponent（只读用：listOperations / getTask；
   *                      写 hint 用 updateTask + createOperation）
   */
  @TracedAs("task.laya.completion.onAfterComplete", {
    recordParams: false,
    recordResult: false,
    log: false,
    paramFilter: (args) => {
      const raw = (args[0] ?? {}) as any;
      const ctx = raw?.data ?? raw;
      return {
        taskId: ctx?.task?.id,
        terminalStatus: ctx?.terminalStatus,
        hasTaskComponent: Boolean(args[1]),
      };
    },
    resultFilter: (_res: void) => ({ ok: true }),
  })
  async execute(
    ctx: TaskCompleteResultContext | { data: TaskCompleteResultContext },
    taskComponent: any,
  ): Promise<void> {
    try {
      const data = normalizeHookCtx(ctx);
      await this.run(data, taskComponent);
    } catch (err) {
      // ⚠️ 兜底：任何异常都不得影响完成语义
      logger.warn(
        `[laya-completion] unexpected failure, ignored: ${(err as Error)?.message}`,
      );
    }
  }

  private async run(
    ctx: TaskCompleteResultContext,
    taskComponent: any,
  ): Promise<void> {
    if (!taskComponent) {
      logger.warn("[laya-completion] taskComponent not injected — skip");
      return;
    }

    // ★ Task #5073（设计调整②）— 判定时机收窄为两态：
    //   - to_validate：sub-agent 提交待验证（自查关）—— 判定提示
    //     会写进 task.context，供验收方 task_complete 时对照
    //   - completed：default agent 验收落定（复检）
    // failed / cancelled / timeout / archived 等其余状态照旧 skip。
    if (ctx.terminalStatus !== "completed" && ctx.terminalStatus !== "to_validate") {
      logger.debug(
        `[laya-completion] terminalStatus=${ctx.terminalStatus} — skip (only completed / to_validate)`,
      );
      return;
    }

    const task = ctx.task;
    if (!task?.id) return;

    // ① 读操作记录链（timestamp DESC → 取全量后正序渲染）
    // ★ Task #4776 review MINOR-2：store 层默认 limit=20，不传会把
    //   >20 op 任务的 create 锚点（最早记录）挤掉 —— 与 7c2d30f2
    //   「create 记录视为有效证据」前提不符。显式传大 limit 全量取。
    let ops: TaskOperation[] = [];
    try {
      ops = await taskComponent.listOperations({
        taskId: task.id,
        limit: 1_000_000,
        offset: 0,
      });
    } catch (err) {
      logger.warn(
        `[laya-completion] listOperations failed (fail-open): ${(err as Error)?.message}`,
      );
      return;
    }
    logger.info(
      `[laya-completion] judging task #${task.id}: chain=${ops?.length ?? 0} ops, terminalStatus=${ctx.terminalStatus}`,
    );
    if (!ops || ops.length === 0) {
      logger.debug("[laya-completion] empty operation chain — pass through");
      return;
    }

    // ② 解析 port（未配置 → fail-open）
    const port = await this.resolvePort();
    if (!port) {
      logger.debug("[laya-completion] no decision port configured — skip");
      return;
    }
    if (port.isDisabled()) {
      logger.debug("[laya-completion] port self-disabled (circuit open) — skip");
      return;
    }

    // ③ 渲染请求（中文文本 state + completion_check 二选一）
    const req: DecisionRequest = {
      state: renderCompletionState(task, ops),
      questions: buildCompletionQuestion(),
    };

    // ④ 调模型（异常 → fail-open）
    let answer: DecisionAnswer | undefined;
    try {
      const res: DecisionResponse = await port.decide(req);
      answer = res?.answers?.["completion_check"];
    } catch (err) {
      logger.warn(
        `[laya-completion] decide failed (fail-open): ${(err as Error)?.message}`,
      );
      return;
    }
    if (!answer || typeof answer.choice !== "string") {
      logger.debug("[laya-completion] malformed answer — skip");
      return;
    }

    // ⑤ 门禁：pickGateConfidence（x_jev_confidence 优先）
    const confidence = pickGateConfidence(answer);
    const threshold = this.options.completionThreshold ?? LAYA_COMPLETION_THRESHOLD;
    if (confidence < threshold) {
      logger.debug(
        `[laya-completion] confidence ${confidence} < ${threshold} — pass through`,
      );
      return;
    }

    // ⑥ 判定 FAIL_INCOMPLETE → 写 hint（PASS_COMPLETED → 静默放行）
    if (answer.choice !== CHOICE_FAIL) {
      // review M7：任何非 FAIL 的 choice（含乱串）都静默放行
      logger.debug(
        `[laya-completion] choice=${answer.choice} (not FAIL_INCOMPLETE) — no hint`,
      );
      return;
    }

    await this.writeHint(task, confidence, taskComponent);
  }

  /** hint 回写：追加 context.completion_hint + 落 operation 记录（都不阻断） */
  private async writeHint(
    task: Task,
    confidence: number,
    taskComponent: any,
  ): Promise<void> {
    const hint = buildCompletionHint(task, confidence);

    // ① 追加写 context.completion_hint（不破坏既有字段）
    try {
      let parsed: Record<string, unknown> = {};
      try {
        const p = JSON.parse(task.context || "{}");
        if (p && typeof p === "object" && !Array.isArray(p)) {
          parsed = p as Record<string, unknown>;
        }
      } catch {
        /* context 损坏 → 用空对象 */
      }
      parsed.completion_hint = hint;
      // ★ Task #4776 review MINOR-1：走 updateTaskContext（store 直写）
      //   而非 updateTask —— AFTER_COMPLETE 内的嵌套 updateTask 会
      //   二次 fire AFTER_UPDATE，把通知订阅者（LarkCliTaskNotifyHook）
      //   无谓拉起，终态任务被再次走终态判定路径。hint 回写是内部
      //   簿记，不应有通知副作用。
      await taskComponent.updateTaskContext(task.id, JSON.stringify(parsed));
      logger.info(
        `[laya-completion] hint written to task #${task.id} context (conf=${confidence.toFixed(4)})`,
      );
    } catch (err) {
      logger.warn(
        `[laya-completion] updateTask hint failed (ignored): ${(err as Error)?.message}`,
      );
    }

    // ② 落一条 operation 记录（审计痕迹）
    try {
      await taskComponent.createOperation({
        taskId: task.id,
        sessionId: "laya-completion",
        milestoneType: "decision",
        milestoneTitle: "[TASK_COMPLETION_HINT] 目标/交付物疑似未达成",
        milestoneDescription: `决策模型判定 FAIL_INCOMPLETE（conf=${confidence.toFixed(4)}）。hint 已写入 task.context.completion_hint，等待 agent 核实。`,
      });
    } catch (err) {
      logger.warn(
        `[laya-completion] createOperation hint failed (ignored): ${(err as Error)?.message}`,
      );
    }
  }
}

/** 归一化 hook 上下文（接受裸载荷或框架 HookContext） */
function normalizeHookCtx(
  ctx: TaskCompleteResultContext | { data: TaskCompleteResultContext },
): TaskCompleteResultContext {
  const maybe = ctx as { data?: TaskCompleteResultContext } & Partial<TaskCompleteResultContext>;
  return maybe && typeof maybe === "object" && maybe.data
    ? maybe.data
    : (ctx as TaskCompleteResultContext);
}

// ========================================================================
// Plugin factory — 适配 roy-bot 的 **task hook** 通道
// ========================================================================

/**
 * Task #4760 — 把 LayaCompletionPlugin 包成可注册到 task hook 的形态。
 *
 * 注册方式仿 `registerLayaDecisionTaskHook`（environment.ts:87）：
 *   - unregister + register 幂等（globalHookManager.register 是 push）
 *   - fail-open：注册失败绝不影响 agent 启动
 *   - hook-manager `safeExecute` 自带异常隔离（hook 抛错只记日志）
 */
export function createLayaCompletionPlugin(
  options?: LayaCompletionPluginOptions,
): {
  /** Hook 唯一名称（用于幂等去重 / unregister） */
  name: string;
  /** 执行优先级 */
  priority: number;
  /** hook 执行体 —— 永不抛 */
  execute: (ctx: unknown) => Promise<void>;
  /** 内层插件实例（供观测 / 测试） */
  plugin: LayaCompletionPlugin;
} {
  // ⚠️ Task #4760 review M3 修复：进程级共享实例（对齐 create 侧
  //   getSharedLayaDecisionPlugin）—— 否则 handle_query 每次
  //   重新注册都会 new 一个新 port → auth.json 重复读盘 +
  //   maxStrikes 熔断计数跨 query 被重置。
  //   传了 options（测试注入）时不走缓存，避免测试串味。
  const inner =
    options && Object.keys(options).length > 0
      ? new LayaCompletionPlugin(options)
      : getSharedCompletionPlugin();
  return {
    name: "laya-completion",
    priority: 20,
    execute: async (ctx: unknown) => {
      // ⚠️ taskComponent 由注册方闭包注入（见 registerLayaCompletionTaskHook）
      await inner.execute(ctx as any, (inner as any).__taskComponent);
    },
    plugin: inner,
  };
}

/** 进程级共享实例（仅生产路径用；传了 options 就新建，避免测试串味） */
let sharedCompletionPlugin: LayaCompletionPlugin | null = null;
function getSharedCompletionPlugin(): LayaCompletionPlugin {
  if (!sharedCompletionPlugin) {
    sharedCompletionPlugin = new LayaCompletionPlugin();
  }
  return sharedCompletionPlugin;
}

/**
 * 把 LayaCompletionPlugin 注册到 `task:after.complete`（AFTER_COMPLETE）。
 *
 * ⚠️ 幂等：先 unregister 再 register，保证全局恰好 1 份。
 * ⚠️ fail-open：注册失败返回 false，不影响调用方。
 *
 * @param taskComponent TaskComponent（由 this.getComponent("task") 取得）
 * @param options LayaCompletionPluginOptions（生产不传 → 读 auth.json；
 *                测试可注入 decisionPort）
 * @returns 是否成功注册
 */
export function registerLayaCompletionTaskHook(
  taskComponent: any | undefined | null,
  options?: LayaCompletionPluginOptions,
): boolean {
  if (!taskComponent) {
    logger.warn(
      "[registerLayaCompletionTaskHook] TaskComponent not available — skip (fail-open)",
    );
    return false;
  }
  try {
    const hook = createLayaCompletionPlugin(options);
    // 闭包注入 taskComponent（插件需要 listOperations / updateTask / createOperation）
    (hook.plugin as any).__taskComponent = taskComponent;

    // ★ 幂等：先摘掉同名的旧 hook，保证全局恰好 1 份
    taskComponent.unregisterHook(TaskHookPoints.AFTER_COMPLETE, hook.name);

    taskComponent.registerHook(TaskHookPoints.AFTER_COMPLETE, {
      name: hook.name,
      priority: hook.priority,
      execute: async (ctx: unknown) => {
        // ★ 永不抛：hook 的 execute 抛出会污染 task_component 的 hook 链
        try {
          // HookContext 的载荷在 `.data`；但不同调用方也可能直接传裸载荷
          const data =
            ctx && typeof ctx === "object" && "data" in ctx
              ? (ctx as { data: unknown }).data
              : ctx;
          await hook.plugin.execute(data as any, taskComponent);
        } catch (err) {
          logger.warn(
            `[registerLayaCompletionTaskHook] hook execution failed (ignored): ${
              (err as Error)?.message
            }`,
          );
        }
      },
    });
    logger.info(
      `[registerLayaCompletionTaskHook] registered hook "${hook.name}" at ${TaskHookPoints.AFTER_COMPLETE} (priority=${hook.priority})`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[registerLayaCompletionTaskHook] registration failed (ignored): ${(err as Error)?.message}`,
    );
    return false;
  }
}

// TaskHookPoints 在注册函数里用到 —— 放文件底部 import 以避免循环依赖
// （review M5：保留底部 import 形态，ESM hoisting 使其语义与顶部一致）
import { TaskHookPoints } from "../hooks/task-hook-points";
