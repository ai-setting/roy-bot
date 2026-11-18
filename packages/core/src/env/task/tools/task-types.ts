/**
 * @fileoverview Task Tool Parameter Schemas
 */

import { z } from "zod";

// ============================================================================
// Legacy argument aliases (Task #4619)
// ============================================================================

/**
 * The sentinel values used when a caller does **not** supply a value.
 *
 * They are deliberately the values the field descriptions already documented
 * ("Use 'unknown' if unknown" / "If unknown, use '{}' or '{"type":"unknown"}'"),
 * so the advertised contract and the runtime default agree.
 *
 * ⚠️ They are *sentinels*, not caller-specified values. `create-tool.ts`
 * must therefore treat them as "the caller said nothing" — otherwise a
 * default would mask the parent-task inheritance (Task #2395).
 */
export const UNKNOWN_PROJECT_PATH = "unknown";
export const UNKNOWN_TASK_CONTEXT = '{"type":"unknown"}';

/**
 * Accept the legacy `id` spelling alongside the current `task_id`.
 *
 * ## Why
 *
 * `roy-plugin-for-agent` used to publish its **own** MCP tool catalogue
 * (`claude/mcp/tools.mjs`), which had drifted from roy's real schemas: it
 * used `id` where roy uses `task_id`.
 *
 * Task #4619 replaced that drifted copy with roy's **real** schemas (the
 * whole point: one source of truth) — but that silently broke every client
 * written against the published plugin's catalogue:
 *
 *     task_get({ id: 5 })   →   "task_id required"
 *
 * (zod's `.object()` strips unknown keys, and `task_id` is required, so it
 * fails loudly rather than degrading — which is good, but still a break.)
 *
 * So the schema accepts **both** spellings. If both are supplied with
 * different values, the current name (`task_id`) wins — never a silent
 * ambiguity.
 *
 * The helper returns a **shape** (not a ZodEffects) so the callers can
 * `.extend()` it with their own fields.
 */
function taskIdShape() {
  return {
    task_id: z.number().describe("Task ID"),
  };
}

/**
 * Normalise the legacy `id` into `task_id` before validation.
 *
 * ## Precedence (never a silent ambiguity)
 *
 * | input                | result                      |
 * |----------------------|-----------------------------|
 * | `{ id: 5 }`          | `task_id = 5`               |
 * | `{ task_id: 5 }`     | `task_id = 5`               |
 * | `{ id: 1, task_id: 2 }` | `task_id = 2` (**current wins**) |
 *
 * The current name (`task_id`) always wins when both are present. Silently
 * picking `id` would let a stale client argument override an explicit one —
 * the worst possible failure mode for an identifier.
 *
 * ## Why `id` is NOT part of the zod shape
 *
 * The shape only declares `task_id`. If `id` were a declared field, the
 * generated JSON Schema would carry `additionalProperties: false` **with**
 * `id` listed — and, more importantly, a model reading the advertised schema
 * would be told that `id` is a first-class parameter, inviting it to send
 * `id` where `task_id` is expected. Normalising in a `preprocess` keeps the
 * advertised contract exactly one name wide while still accepting the old
 * spelling at runtime.
 *
 * (zod's `.object()` strips unknown keys, so the stray `id` is dropped from
 * the parsed result — it never leaks into a task row.)
 */
function normaliseLegacyTaskId(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  // `task_id` absent (or explicitly undefined) + a usable `id` → alias it.
  if (obj.task_id === undefined && obj.id !== undefined) {
    return { ...obj, task_id: obj.id };
  }
  return obj;
}

/**
 * Build an object schema that accepts `id` as an alias of `task_id`.
 *
 * `z.preprocess` returns a `ZodEffects`, not a `ZodObject`. Both consumers
 * of these schemas cope with that:
 *
 * - **MCP**: `toJsonSchemaDocument()` unwraps `_def.schema` before calling
 *   `zodToJsonSchema`;
 * - **LLM**: `toolParametersToJsonSchema()` handles `ZodEffects` directly
 *   (`effectStrategy: "input"`).
 *
 * `z.preprocess` also does **not** swallow the inner `.default()`s — a
 * preprocess result still flows into the inner object schema, so
 * `include_operations` keeps its own default (Task #4619: `true`).
 */
function withLegacyTaskId<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(normaliseLegacyTaskId, z.object({ ...taskIdShape(), ...shape }));
}

/**
 * task_create tool parameters
 */
export const CreateTaskToolSchema = z.object({
  title: z.string().describe("Task title"),
  description: z.string().optional().describe("Task description"),
  priority: z.enum(["low", "medium", "high"]).optional().describe("Task priority"),
  type: z.enum(["normal", "cycle", "longterm"]).optional().default("normal").describe(
    "Task type. normal: 常规任务，需要跟踪完成. cycle: 周期任务（如每周发周报），无需 complete，定期执行. longterm: 长期任务/愿景目标（如提升公司影响力），难以一次性完成，持续跟进"
  ),
  // Task #4791 — goals 拆分规则：写成可逐条验收的编号子项，
  // 让 completion hook（#4760）能逐条对照操作记录链验收。
  goals_and_expected_deliverables: z.string().optional().describe(
    "Goals and expected deliverables. " +
    "⚠️ 写成可逐条验收的编号子项（1. … 2. … 3. …），每条是一个可判定的交付/动作" +
    "（文件断言：文件存在/大小/内容；进程断言：命令 exit code/stdout；" +
    "测试断言：pass/fail 计数；状态断言：版本号/HTTP 200/状态字段）。" +
    "避免一句话模糊目标（如「做好 X」「完成调研」）——" +
    "任务完成时 completion hook 会按这些子项逐条对照操作记录验收。"
  ),
  due_date: z.string().optional().describe("Due date (ISO format)"),
  tags: z.array(z.string()).optional().describe("Task tags (for search, stored in task.tags JSON field)"),
  // Task #4619: `project_path` was required, which broke every client
  // written against the plugin's old (drifted) catalogue, where only
  // `title` was required. It now defaults to "unknown" — the value the
  // description already told callers to use.
  //
  // ⚠️ The default is the *documented sentinel* for "not known", NOT a
  // caller-specified value: `create-tool.ts` distinguishes "the caller
  // omitted it" from "the caller explicitly wrote 'unknown'" so that an
  // omitted `project_path` still lets the child task inherit the parent's
  // project_path (Task #2395).
  project_path: z.string().default("unknown").describe(
    "Project root path for task positioning. " +
    "Used to locate the project space for this task. " +
    "Use 'unknown' if unknown. (Defaults to 'unknown'.)"
  ),
  parent_task_id: z.union([z.number(), z.null()]).optional().describe(
    "父任务 ID（可选）。不传或传 null 时，创建根任务（root task）。\n" +
    "如需将任务挂载到某个父任务下，传入对应父任务 ID。\n" +
    "**调用前必须先调用 task_tree(depth=2)** 查看现有任务树结构，避免重复创建根任务、避免孤儿任务。\n" +
    "决策路径（按顺序匹配）：\n" +
    "  A. 归属到现有 longterm 根（如「[Longterm] X 生态」）→ parent_task_id = 该根 ID\n" +
    "  B. 归属到现有主题聚类（非 longterm 根，但同主题）→ parent_task_id = 该根 ID\n" +
    "  C. 新建根任务 → 省略 parent_task_id（让树根 ≤10）\n" +
    "如何找到 parent_task_id：使用 task_tree(depth=2) 获取的树形结构，\n" +
    "根据节点 id 选择合适的父任务 ID（来自 tree 输出，**不要硬编码**数字）。"
  ),
  // Task #4619: `context` was required for the same reason. It now defaults
  // to '{"type":"unknown"}' — the value the description already documented.
  //
  // ⚠️ Like `project_path`, the default is the *documented sentinel* for
  // "not known", NOT a caller-specified value. `create-tool.ts` merges the
  // caller's context JSON with the inherited parent context, and a
  // caller-supplied sentinel would win over the inherited fields.
  context: z.string().default('{"type":"unknown"}').describe(
    "JSON string with time-space positioning information for task continuity. " +
    "This field is crucial for Agent task handoff. " +
    "Core fields: worktree_path (git worktree path), branch (current branch), type (feature/bug/refactor/chore). " +
    "Example for coding: {\"worktree_path\": \"/path/worktree\", \"branch\": \"feature/xyz\", \"type\": \"feature\"}. " +
    "Example for other: {\"type\": \"general\"}. " +
    "If unknown, use '{}' or '{\"type\":\"unknown\"}'. " +
    "IMPORTANT: Must be a valid JSON string! " +
    "**Task #4467 — similar_task_ids (REQUIRED)**: array of existing task ids that " +
    "cover the same ground as this request, used by the task:before.create decision " +
    "check to suggest reusing/reopening instead of creating a duplicate. " +
    "Search first (task_search / task_get), then pass the ids. " +
    "It may be an empty array [] if you searched and found nothing related — " +
    "but the field itself must be present. " +
    "Example: {\"type\":\"feature\", \"similar_task_ids\": [4433, 4445]}"
  ),
  owner: z.union([z.string(), z.null()]).optional().describe(
    "负责人（owner）：这个任务由**谁**负责推进，可空（不传 / 传 null 即未指派）。" +
    "取值为自由字符串（open_id / 用户名 / 邮箱均可，core 不解释格式）；" +
    "多人协作场景下用它区分负责人，与 sessionId（谁在操作）、project_path（哪个项目）正交。" +
    "向后兼容：省略该字段时任务以 owner=null 创建。"
  ),
});

export type CreateTaskToolParams = z.infer<typeof CreateTaskToolSchema>;

/**
 * task_get tool parameters
 *
 * Task #4619 (cross-validation M-2): `include_operations` now defaults to
 * **true**.
 *
 * The old plugin's `bridge.mjs` returned `{ ...task, operations }`
 * unconditionally, and its advertised catalogue for `task_get` had exactly
 * one property (`id`) — there was no way to ask for the lean shape. When
 * the plugin moved to roy's real schemas, the default `false` silently
 * dropped the milestones from every response, with no error anywhere.
 *
 * The richer response is the compatible one, so it is now the default;
 * `include_operations: false` still opts out.
 */
export const GetTaskToolSchema = withLegacyTaskId({
  include_operations: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include operation records (milestones / process log) with the task. " +
      "Defaults to true — the task's operation history is part of its detail. " +
      "Pass false for a lean task-only response.",
    ),
});

export type GetTaskToolParams = z.infer<typeof GetTaskToolSchema>;

/**
 * task_list tool parameters
 */
export const ListTasksToolSchema = z.object({
  status: z.enum(["todo", "active", "to_validate", "completed", "paused", "cancelled", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  type: z.enum(["normal", "cycle", "longterm"]).optional().describe("Filter by task type"),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
  depth: z.number().optional().describe(
    "检索层级深度：0=只根任务（无父任务），1=根+一层子任务，2=根+二层子任务，-1 或忽略=全部"
  ),
  include_archived: z.boolean().optional().default(false).describe(
    "是否包含已归档任务（status=archived 的任务默认被排除）"
  ),
});

export type ListTasksToolParams = z.infer<typeof ListTasksToolSchema>;

/**
 * task_search tool parameters
 */
export const SearchTasksToolSchema = z.object({
  keywords: z.array(z.string()).describe("关键词列表（AND 逻辑，匹配 title/description/goals/tags/operations）"),
  limit: z.number().optional().default(20).describe("返回数量"),
  offset: z.number().optional().default(0).describe("偏移量"),
  status: z.enum(["todo", "active", "to_validate", "completed", "paused", "cancelled", "archived"]).optional().describe("按状态筛选"),
  priority: z.enum(["low", "medium", "high"]).optional().describe("按优先级筛选"),
  type: z.enum(["normal", "cycle", "longterm"]).optional().describe("按类型筛选"),
  exclude_task_id: z.number().optional().describe("排除的 task ID"),
  depth: z.number().optional().describe(
    "检索层级深度：0=只根任务，1=根+一层子任务，2=根+二层子任务，-1 或忽略=全部"
  ),
  include_archived: z.boolean().optional().default(false).describe(
    "是否包含已归档任务（status=archived 的任务默认被排除）"
  ),
});

export type SearchTasksToolParams = z.infer<typeof SearchTasksToolSchema>;

/**
 * task_update tool parameters
 */
export const UpdateTaskToolSchema = withLegacyTaskId({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["todo", "active", "to_validate", "completed", "paused", "cancelled", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  type: z.enum(["normal", "cycle", "longterm"]).optional().describe("Task type"),
  progress: z.number().min(0).max(100).optional(),
  current_status: z.string().optional(),
  goals_and_expected_deliverables: z.string().optional().describe(
    "Goals and expected deliverables. " +
    "⚠️ 追加/修改时同样写成可逐条验收的编号子项（1. … 2. … 3. …），" +
    "每条是一个可判定的交付/动作（文件断言：文件存在/大小/内容；" +
    "进程断言：命令 exit code/stdout；测试断言：pass/fail 计数；" +
    "状态断言：版本号/HTTP 200/状态字段）。" +
    "避免一句话模糊目标（如「做好 X」「完成调研」）——" +
    "任务完成时 completion hook 会按这些子项逐条对照操作记录验收。" +
    "（Task #4833 — 与 task_create 的 goals 规则同源）"
  ),
  due_date: z.string().optional(),
  tags: z.array(z.string()).optional(),
  project_path: z.string().optional().describe("Project path, identifies which project this task belongs to"),
  context: z.string().optional().describe("Task context information for storing additional context"),
  parent_task_id: z.union([z.number(), z.null()]).optional().describe("Parent task ID (set to null to make it a root task)"),
  owner: z.union([z.string(), z.null()]).optional().describe(
    "负责人（owner）：可空。传字符串 = 指派/改派该负责人；传 null 或空字符串 = 清空（未指派）；" +
    "**省略该字段** = 不改动（与 status / progress 等字段语义一致）。" +
    "用于多人协作场景标注任务负责人。"
  ),
});

export type UpdateTaskToolParams = z.infer<typeof UpdateTaskToolSchema>;

/**
 * task_delete tool parameters
 */
export const DeleteTaskToolSchema = z.object({
  task_id: z.number().describe("Task ID"),
});

export type DeleteTaskToolParams = z.infer<typeof DeleteTaskToolSchema>;

/**
 * task_complete tool parameters
 *
 * Task #2778: 新增 deliverable_storage_path 参数。
 * Task #5073 设计调整① — task_complete 精简为**纯验收动作**：
 *
 *   deliverable_storage_path 入参已删除（用户 2026-11-06 明令）。
 *   交付物在 pre_complete 阶段（task_pre_complete）提交落库
 *   （task.context.deliverable_storage_path + operation Deliverable 行），
 *   task_complete 只做状态修改验收：逐条核对 goals 子项后
 *   把 to_validate → completed（TASK_COMPLETION_TERMINAL）。
 *
 *   ⚠️ 交付物通道 = task_pre_complete，验收通道 = task_complete ——
 *     两者职责分离后，交付物参数不该再出现在 complete 的 schema 里。
 *
 *   兼容性：unknown-key 被 zod 静默剥离（withLegacyTaskId 的 object
 *   不含 additionalProperties:false）→ 老调用方传了 deliverable 也
 *   不报错，只是不再被读取。CLI / TaskStoreBackend（MCP 通道）的
 *   completeTask(deliverable) 底层签名保留（#5060 修复链不破坏）。
 */
export const CompleteTaskToolSchema = withLegacyTaskId({});

export type CompleteTaskToolParams = z.infer<typeof CompleteTaskToolSchema>;

/**
 * task_pre_complete tool parameters (Task #5073 — 两阶段验收)
 *
 * sub-agent 交付时调用：把任务置为 to_validate（待验证），
 * 交付物参数与 task_complete 完全同构（deliverable_storage_path），
 * 让执行方「提交待验证」的调用体验与验收方「落终态」一致。
 */
export const PreCompleteTaskToolSchema = withLegacyTaskId({
  deliverable_storage_path: z.string().optional().describe(
    "交付物的寻址地址（路径 / URL / 分支名等）。" +
    "会持久化到 task.context.deliverable_storage_path，" +
    "并写入 operation 记录（Deliverable 行），供验收方 task_complete 时逐条对照。"
  ),
  current_status: z.string().optional().describe(
    "本次交付的进展摘要（可选）。" +
    "会拼进「待验证：」文案，作为任务当前状态展示给验收方（default agent）。"
  ),
});

export type PreCompleteTaskToolParams = z.infer<typeof PreCompleteTaskToolSchema>;

/**
 * task_cancel tool parameters (Task #5007)
 *
 * 取消 Task 本身（status = "cancelled"）。
 * ⚠️ 与 `stop_task` 正交：stop_task 停**后台进程**（bg process id），
 *    task_cancel 停**任务记录**（task id）。需要连用时先 stop_task 再 task_cancel。
 */
export const CancelTaskToolSchema = withLegacyTaskId({
  reason: z.string().optional().describe(
    "取消原因（可选）。会写入该任务的 operation 记录，便于事后追溯验收结论。",
  ),
});

export type CancelTaskToolParams = z.infer<typeof CancelTaskToolSchema>;

/**
 * task_batch_archive tool parameters
 */
export const BatchArchiveToolSchema = z.object({
  task_ids: z.array(z.number()).describe("要归档的任务 ID 列表"),
  reason: z.string().optional().describe("归档原因（可选，会写入每个任务的 operation 记录）"),
});

export type BatchArchiveToolParams = z.infer<typeof BatchArchiveToolSchema>;

/**
 * task_batch_delete tool parameters
 */
export const BatchDeleteToolSchema = z.object({
  task_ids: z.array(z.number()).describe("要删除的任务 ID 列表"),
});

export type BatchDeleteToolParams = z.infer<typeof BatchDeleteToolSchema>;

/**
 * task_tree tool parameters
 *
 * Returns a hierarchical (forest) view of tasks. Use this BEFORE calling
 * task_create to choose the right parent_task_id (or decide to create a root).
 */
export const TreeTasksToolSchema = z.object({
  depth: z.number().optional().default(2).describe(
    "树的展开深度。默认 2 (根 + 一层子任务 + 二层孙任务)。" +
    "0 = 只返回根任务，不展开任何子节点。" +
    "-1 或负数 = 无限层级（全部展开）。"
  ),
  parent_task_id: z.number().optional().describe(
    "只看指定父任务的子树。不传则从所有根任务（forest）开始。"
  ),
  status: z.enum(["todo", "active", "to_validate", "completed", "paused", "cancelled", "archived"]).optional().describe(
    "按状态过滤（与 task_list 一致）。"
  ),
  priority: z.enum(["low", "medium", "high"]).optional().describe(
    "按优先级过滤。"
  ),
  type: z.enum(["normal", "cycle", "longterm"]).optional().describe(
    "按任务类型过滤。"
  ),
  include_archived: z.boolean().optional().default(false).describe(
    "是否包含已归档任务（默认 false，与 task_list 一致）。"
  ),
});

export type TreeTasksToolParams = z.infer<typeof TreeTasksToolSchema>;
