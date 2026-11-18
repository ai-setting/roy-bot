/**
 * @fileoverview Task #5360（用户澄清 2026-11-11 22:37）——
 *   卡片实体：**sub-session 永远是主键**，task 是可选的**附加增强信息**
 *
 * ## 用户澄清原文（覆盖了此前「task-or-session 二选一」的理解）
 *
 * > 「**不是**「task 或 sub-session」二选一，而是**以 sub-session 为基底**：
 * >  1. 卡片主键 = sub-session（不是 task）
 * >  2. 有些 sub-session 内部创建了 task，有些没有 —— 都是正常的
 * >  3. 如果该 sub-session 创建了 task → 把 task 信息同步进卡片
 * >     （taskId、title、状态、进度、操作记录等原有信息一个不少）
 * >  4. **无论有无 task，sub-session 相关的刷新逻辑始终存在**：
 * >     刷新看消息数 + 最近 msg（截断）；
 * >     **超时、完成等生命周期事件也体现在卡片上**（这是 subsession 层的）」
 *
 * ## 语义对比（这是本模块存在的全部理由）
 *
 * ```
 * ❌ 旧（错）：type CardSubject = { kind:"task"; taskId } | { kind:"session"; sessionId }
 *            → 主键二选一；task 卡和 session 卡是两张不同的卡
 * ✅ 新（对）：type CardSubject = {
 *              sessionId: string;        // ← 永远是主键，不可缺
 *              taskId?: number;          // ← 可选增强，有就多显示
 *            }
 * ```
 *
 * 关键推论（写代码时最容易搞错的地方）：
 *
 * 1. **刷新永远读 session store**。有 task 时也读 session —— 因为
 *    「消息数 + 最近 msg」是**会话**的属性，不是 task 的属性。
 *    旧实现走 `taskId → bgTask → subSessionId → session`，绕了一圈才拿到
 *    同一个 session；现在主键就是 sessionId，直达。
 * 2. **生命周期（超时/完成/停止）是 session 层的事实**。旧设计里终态来自
 *    `task.status`（没 task 就永远 non-terminal）—— 这正是本次要修的语义错误。
 *    现在终态来自 **跑这个 session 的后台任务**（`BackgroundTask.status`），
 *    与「该 session 有没有建 task」无关。
 * 3. **有 task 只是"多一块信息"**，不改变卡片身份、不改变刷新行为。
 *
 * ## 序列化格式
 *
 * 持久层主键是字符串，格式：
 *
 * ```
 * session:<sessionId>                    ← 无关联 task
 * session:<sessionId>#task:<taskId>      ← 有关联 task（附加段）
 * ```
 *
 * - 主键段**永远是 session**；`#task:` 段是纯附加值，缺了不影响解析
 * - 用 `#` 分隔而不是再嵌 `:`，避免 session id 里含 `:` 时歧义
 *   （session id 可能含 `-` / `_`，理论上也可能含别的；`#` 最少见）
 * - 旧数据（只有 `task_id INTEGER`）迁移时**无法**反推 sessionId ⇒ 标记为
 *   `legacy-task:<n>`，仅用于读旧卡（新卡不再产生这种形态）
 */

// ============================================================================
// 类型
// ============================================================================

/**
 * 卡片实体：**session 为主 + task 可选**。
 *
 * ⚠️ `sessionId` 必填 —— 这是本次澄清的核心，不要为了兼容旧代码把它变可选。
 */
export interface CardSubject {
  /** ★ 主键：跑这次执行的 sub-session */
  sessionId: string;
  /** 附加增强：该 session 内创建的 roy 任务（可能没有） */
  taskId?: number;
}

/** 持久层主键 */
export type CardKey = string;

const SESSION_PREFIX = "session:";
const TASK_SUFFIX_SEP = "#task:";
const LEGACY_TASK_PREFIX = "legacy-task:";

// ============================================================================
// 构造
// ============================================================================

/**
 * 造卡片主键。**sessionId 必填**，taskId 可选（附加值）。
 *
 * @throws sessionId 为空（空主键会撞脏数据，宁可早失败）
 */
export function cardKeyOf(subject: CardSubject): CardKey {
  const sid = typeof subject.sessionId === "string" ? subject.sessionId : "";
  if (!sid.trim()) {
    throw new Error("cardKeyOf: sessionId is required (card primary key)");
  }
  const base = `${SESSION_PREFIX}${sid}`;
  const tid = subject.taskId;
  if (typeof tid === "number" && Number.isSafeInteger(tid) && tid > 0) {
    return `${base}${TASK_SUFFIX_SEP}${tid}`;
  }
  return base;
}

/** 便捷：只给 sessionId（无 task） */
export function sessionCardKey(sessionId: string): CardKey {
  return cardKeyOf({ sessionId });
}

/** 便捷：sessionId + taskId */
export function sessionTaskCardKey(sessionId: string, taskId: number): CardKey {
  return cardKeyOf({ sessionId, taskId });
}

/** 旧卡（迁移期只读）：`legacy-task:<n>` */
export function legacyTaskCardKey(taskId: number): CardKey {
  return `${LEGACY_TASK_PREFIX}${Math.trunc(taskId)}`;
}

// ============================================================================
// 解析
// ============================================================================

/**
 * 解析主键。
 *
 * 失败（非字符串 / 空 / 缺 `session:` 前缀 / sessionId 为空）一律
 * `undefined` —— 调用方降级，**绝不抛、绝不猜**。
 *
 * 注意：`legacy-task:<n>` **不**解析成 CardSubject（它没有 sessionId，
 * 无法参与刷新）；需要区分旧卡时用 `isLegacyTaskCardKey`。
 */
export function parseCardKey(key: unknown): CardSubject | undefined {
  if (typeof key !== "string" || !key) return undefined;
  if (!key.startsWith(SESSION_PREFIX)) return undefined;

  const rest = key.slice(SESSION_PREFIX.length);
  if (!rest) return undefined;

  const sepIdx = rest.lastIndexOf(TASK_SUFFIX_SEP);
  if (sepIdx < 0) {
    // 无 task 段 —— 整个 rest 就是 sessionId
    return rest.trim() ? { sessionId: rest } : undefined;
  }

  const sessionId = rest.slice(0, sepIdx);
  const taskPart = rest.slice(sepIdx + TASK_SUFFIX_SEP.length);
  if (!sessionId.trim() || !/^\d+$/.test(taskPart)) return undefined;

  const taskId = Number(taskPart);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return undefined;

  return { sessionId, taskId };
}

/** 是否是迁移期的旧卡主键（只有 task、没有 session） */
export function isLegacyTaskCardKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith(LEGACY_TASK_PREFIX);
}

/** 判定版 */
export function isCardKey(v: unknown): v is CardKey {
  return parseCardKey(v) !== undefined;
}

// ============================================================================
// 从回调 / 上下文挑 subject
// ============================================================================

/**
 * 从按钮 `value` 里挑出卡片实体。
 *
 * ## 与旧实现的关键差异
 *
 * 旧实现「taskId 优先，没有 taskId 才用 sessionId」—— 那会让**有 task 的
 * session 卡**被当成 task 卡刷新（走 task→bgTask→session 绕路，且丢掉
 * session 层的生命周期）。现在：**sessionId 是主键，taskId 只是附加值**，
 * 所以 sessionId 必须存在，taskId 有就带上。
 *
 * @returns 无 sessionId ⇒ `undefined`（连主键都没有，无法刷新）
 */
export function pickCardSubject(value: {
  sessionId?: unknown;
  taskId?: unknown;
}): CardSubject | undefined {
  const rawSession = value?.sessionId;
  const sessionId =
    typeof rawSession === "string" && rawSession.trim() ? rawSession : undefined;
  if (!sessionId) return undefined;

  const rawTask = value?.taskId;
  const taskId =
    typeof rawTask === "number"
      ? rawTask
      : typeof rawTask === "string" && rawTask.trim()
        ? Number(rawTask.trim())
        : undefined;

  return {
    sessionId,
    ...(taskId !== undefined && Number.isSafeInteger(taskId) && taskId > 0
      ? { taskId }
      : {}),
  };
}

// ============================================================================
// 展示辅助
// ============================================================================

/**
 * 主标签：`会话 <sessionId 截断>`。
 *
 * session 是卡片身份，所以标签以它为主；task 信息在卡片正文里单独展示
 * （见 `buildSessionCard` 的「任务信息」面板）。
 */
export function cardSubjectLabel(subject: CardSubject): string {
  const id = subject.sessionId;
  const shown = id.length > 30 ? `${id.slice(0, 29)}…` : id;
  return `会话 ${shown}`;
}

/** 是否有关联 task（决定卡片是否渲染「任务信息」面板） */
export function hasTask(subject: CardSubject): boolean {
  return typeof subject.taskId === "number" && subject.taskId > 0;
}
