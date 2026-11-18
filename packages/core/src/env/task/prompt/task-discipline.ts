/**
 * @fileoverview Task #4889 — 任务纪律单一真相源（runtime 无关）
 *
 * 单一真相源：core 内 roy prompt 与所有外部 runtime
 * （opencode / claude / codex / CLI daemon / …）的 agent
 * prompt 都从这一个常量派生，不许各抄一份。
 *
 * 内容来源（报告 A /tmp/4889-phase0-roy-prompt-mechanisms.md）：
 *   - 主体机制：prompts-index.ts roy prompt Task 章节（M1-M16）
 *   - goals 编号子项：create-tool.ts L144 起（M7/M8/M9）
 *   - complete 核实义务：complete-tool.ts L32-45（M10/M11/M12）
 *
 * 改写原则：
 *   1. 剥离 Roy 专属内容（CLI 命令表 / {{memory}} / deniedTools 工具表）
 *   2. 补齐 M14/M15/M16
 *   3. 不含防退化纪律（属 Roy 全局操作纪律，不属 task 语义）
 *   4. 共享锚点直接 import completion-copy.ts，不重打一遍
 *
 * ⚠️ 本模块必须保持**零依赖**：唯一允许的 import 是
 *   completion-copy.ts（同为零依赖锚点模块），以便
 *   prompts-index（超大模板串）与外部 npm 消费方安全引用。
 */

import {
  TASK_COMPLETE_ITEM_BY_ITEM,
  TASK_COMPLETION_HINT_ANCHOR,
  TASK_COMPLETE_VERIFY_DUTY,
} from "../tools/completion-copy";

/** 分片 1：生命周期契约（M1/M2/M13/M14/M15） */
export const TASK_DISCIPLINE_LIFECYCLE = `### Task Lifecycle (7 steps, 0-6)

> Tasks are the **first-class citizen**. Follow this lifecycle for every task:

0. CHECK TASK CONTEXT OR SEARCH
   - If \`[当前 Task #N]\` is in the context → use \`task_get #N\` directly, skip searching.
   - Otherwise use \`task_list\` / \`task_search\` to find related tasks.
   - If found → reuse, extend, and update (see the reuse rules in step 1).
     If not found → proceed to step 1.
   - **Orient before creating**: read the existing tree with
     \`task_tree(depth=1)\` (\`depth=2\` for bigger trees) and decide whether the
     work belongs to an existing root (attach via \`parent_task_id\`) or is
     genuinely new. Keep **root tasks ≤ 10**; prefer attaching to an existing
     thematic root over spawning a new root. Never hardcode ids — read them
     from \`task_tree\`.

1. CREATE or REUSE
   - No existing task → create a new one with title, description, goals.
   - Existing task → reuse via \`task_get\`, then \`task_update\`:
     * Append new context to description and goals (preserve the old content)
     * Add / extend \`goals_and_expected_deliverables\`
     * Create an operation record documenting the continuation
     * Set priority and due date if any
     * If the original task was completed → reset status to \`active\`
       and reset progress to a reasonable value

2. GATHER CONTEXT (never skip)
   - Read description, goals, current_status
   - Check \`parent_task_id\` for sub-tasks
   - Read the operation history: \`task_operation_list\` (~20 recent records)
   - Review recent operations for history and decisions
   - Working without context risks: outdated goals, missed decisions,
     duplicated work, misalignment with the parent task

3. EXECUTE
   - Use the available tools, skills and workflows to satisfy the task
     description and goals.
   - Long-running work: for work longer than 5 minutes, record a milestone
     with \`task_operation_create\` as you go, so the user can see progress.
   - Several independent sub-tasks may run in parallel (background \`bash &\`
     or parallel ReAct steps).
   - **边干边记** — milestones are recorded **while working**;
     **禁止事后批量补**（do not defer them to one batch at the end）.
   - Note: \`task_create\` / \`task_update\` already create operation records
     automatically — do not create duplicates by hand.

4. TRACK
   - Update progress (0-100%) as the work advances
   - Update status: todo → active
   - Record \`current_status\` with human-readable progress
   - ⚠️ **不要**把 status 直接置为 \`completed\` 或 \`to_validate\` ——
     终态由验收方落、待验证由 \`task_pre_complete\` 提交（见步骤 6）

5. RECORD — operation records (see Operation Discipline below)

6. COMPLETE — 收尾分两种角色（Task #5007/#5073，验收权分离）
   - **执行方（roy sub-agent）**：进度达到你判断的 100% ⇒
     \`task_pre_complete\` **提交待验证**（\`deliverable_storage_path\`
     传交付物地址；status → to_validate，并触发一次 goal 检查自查）
     + 最后一条 \`task_operation_create\` ⇒ **结束并返回结果**。
     ❌ **不要调用 \`task_complete\`**（你无此权限）。
   - **验收方（default agent / 接待员）**：\`task_complete\` after item-by-item verification
     (see Complete Discipline below)`.trim();

/** 分片 2：操作记录双维度规范（M3/M4/M5/M6/M16） */
export const TASK_DISCIPLINE_OPERATION = `### Operation Record — 双维度分工规范

**Record milestones as you work** — call \`task_operation_create\` the moment a
stage is reached, **not after the fact** (not in a batch at the end).

**操作记录必须严格区分两个维度，二者配套记录、各司其职**：

#### 维度 1：状态/里程碑（"达到什么"）— 必填维度
使用 \`task_operation_create\` 的 milestone_* 主字段：
- **milestone_type**：里程碑类型（create / progress / milestone / problem / solution / decision / review / completed / workflow_extracted）
- **milestone_title**：里程碑标题（一行）
- **milestone_description**：达成的状态/结果描述（可长可短）

#### 维度 2：过程（"如何达到"）— 可选但推荐维度
使用 \`task_operation_create\` 的 \`process_description\` 字段：
- 字符范围硬约束 100-500 字符 (100–500 characters)
- 内容：采取的策略 + 工具步骤概要
- 完整过程通过 sessionId 回查 session

#### 双维度配合铁律
- ❌ **不要把 action 当状态**：旧 \`action_*\` 命名偏动作/行为层，不能表达"此刻达到什么"；现在统一改用 \`milestone_*\`。
- ❌ **不要让 process_description 与 milestone_description 重复**：process 是"如何达到"，milestone 是"达到什么状态"。
- ✅ **配套记录**：每个有意义的 operation 都应同时包含两者；不写 process 时，detail 应通过 sessionId 回查。
- ⚠️ **兼容窗口期**：旧 \`action_type\` / \`action_title\` / \`action_description\` 仍被 tool 接受（标记 @deprecated），会自动映射到 milestone_* 并返回 deprecation warning。

#### 范例（双维度齐全的 operation 记录）
\`\`\`json
{
  "task_id": 123,
  "milestone_type": "milestone",
  "milestone_title": "GREEN 通过：milestone_* schema/storage/tool 全链路",
  "milestone_description": "21/21 测试通过，包含 4 个 action_* alias 兼容测试",
  "process_description": "TDD RED 写 4 个失败测试覆盖 storage/tool；迁移 004 rename 列；rowToOperation 同时输出双字段兼容；tool zod preprocess 自动映射 action_*"
}
\`\`\``;

/** 分片 3：goals 编号子项规则（M7/M8/M9） */
export const TASK_DISCIPLINE_GOALS = `### Goals 子项拆分规则

\`goals_and_expected_deliverables\` **MUST** be written as
**numbered sub-items** (编号子项) that can each be verified
one by one (逐条验收) — for \`type=normal\` tasks:

1. 实现 X（含文件路径）
2. 测试 Y 覆盖 Z 场景（pass/fail 计数）
3. 文档 W 落盘到 <path>

⚠️ For \`type=longterm\` / \`type=cycle\` tasks there is no
per-item completion acceptance（不走逐条 complete 验收）, so the
MUST above does not apply; for those, it is **strongly recommended**
(建议) to split goals into staged, individually checkable sub-items
(阶段性可判子项) instead of one vague sentence.

Why: when the task is completed, the completion hook
(task:after.complete) judges the whole goal against the
operation-record chain, using each sub-item as fine-grained
evidence (逐条对照的依据). Vague one-line goals (一句话模糊目标，
如「做好 X」「完成调研」) give the judge nothing to check
and make a completion hint much more likely.

Reference the four atomic assertion forms (Task #4768
四原子形态) when writing each sub-item:

- 文件断言 (file assertion): file exists / size / content grep
- 进程断言 (process assertion): command exit code / stdout match
- 测试断言 (test assertion): pass/fail counts, no NEW fail
- 状态断言 (state assertion): version number / HTTP 200 / status field`;

/** 分片 4：complete 逐条验收 + HINT 核实义务（M10/M11/M12）
 *
 * ★ Task #5007 —— 角色作用域说明：
 *   本分片描述的是**验收方**（default agent / 接待员）的动作。
 *   执行方（roy sub-agent）**没有** `task_complete` 权限，不适用本分片。
 *   为避免执行方误读，段落开头显式声明「仅验收方适用」。
 */
export const TASK_DISCIPLINE_COMPLETE = `### Task Complete — 核实义务（**仅验收方适用**）

> ⚠️ **角色作用域（Task #5007）**：本节是**验收方**（default agent / 接待员）的动作。
> 若你是**执行方**（roy sub-agent），你没有 \`task_complete\` 权限 ——
> 你的收尾动作是「进度推到 100% + 记完操作记录 + 结束返回」，验收由主智能体负责。

Before calling \`task_complete\`, you MUST:

1. Read the task's \`goal\` (description) and \`delivery\` (goals_and_expected_deliverables) fields.
   - Use \`task_get(task_id=<id>)\` to fetch the full task record.
2. **Validate whether each goal sub-item was achieved** — accept the goal
   **item-by-item** (${TASK_COMPLETE_ITEM_BY_ITEM}).
   - Goals should be numbered sub-items (编号子项). Check
     each sub-item against the operation-record chain (操作记录链) and the
     deliverable evidence (context.deliverable_storage_path).
   - The completion hook (task:after.complete) judges the whole goal vs.
     deliverables; numbered sub-items give it finer-grained evidence to
     reason with (逐条对照的证据粒度). If it detects that the goal or
     deliverables appear unmet, the task context will carry a
     \`[${TASK_COMPLETION_HINT_ANCHOR}]\`.
   - **If you receive a [${TASK_COMPLETION_HINT_ANCHOR}]**, you MUST verify it
     (${TASK_COMPLETE_VERIFY_DUTY}): re-read the task via \`task_get\`, then do exactly one of:
     (a) 确认未完成 → **重新委托**（用你的委托工具 + 同一 sub-session 续跑，
         在指令里写明"目标尚未达成，需要补 X/Y/Z"），由 sub-agent 用
         \`task_update(status=active)\` 重开并继续推进；若你**自己就是执行方**
         （有 \`task_update\` 权限），则直接 \`task_update(status=todo)\` 重开；或
     (b) 确认已完成 → **用你手上有权限的写工具**落一条 \`decision\` 类操作记录
         （\`task_operation_create\`，milestone_type=decision，milestone_title=<一行结论>）
         说明子项实际已达成（说明理由）。若你没有该工具的权限（验收方场景），
         就通过你的**委托工具**让 sub-agent 代写这条记录，或在最终汇报里
         明确写出核实结论与证据。
     Never ignore it (不允许无视).
     ⚠️ **核实义务的两条路径都依赖写权限**（\`task_update\` / \`task_operation_create\`）。
     若这些工具对你**不可用**（如验收方不持有执行类工具），必须**改用委托**把动作
     交回给有权限的 sub-agent 执行 —— 不要试图调用不可用的工具（会被拦掉并浪费一轮迭代）。
   - If the goal and delivery mismatch **without** a hint, either:
     (a) extend the task via \`task_update\`, or
     (b) record the discrepancy via \`task_operation_create\`
         (milestone_type=decision) — the reason **must** land in the
         operation record (必须落到操作记录里), not merely a line in
         your final report (不能只在报告里带一句).
3. Deliverables were submitted by the executor via \`task_pre_complete\`
   (Task #5073 two-phase acceptance): they live in
   \`context.deliverable_storage_path\` and the operation trail
   (\`Deliverable: <path>\` lines). Cross-check them in step 2.
   \`task_complete\` takes **no** deliverable parameter — if the
   deliverables are missing from the record, re-delegate instead of
   asking for a path here.`;

/** 完整纪律正文（主出口）：4 分片拼装 */
export const TASK_DISCIPLINE_PROMPT = [
  TASK_DISCIPLINE_LIFECYCLE,
  TASK_DISCIPLINE_OPERATION,
  TASK_DISCIPLINE_GOALS,
  TASK_DISCIPLINE_COMPLETE,
].join("\n\n");
