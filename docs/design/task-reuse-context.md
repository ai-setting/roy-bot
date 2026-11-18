# Task Reuse Context — Design (Task #2389)

> 优化 roy-bot 任务创建/委托机制，减少同一场景产生的大量重复 Task。

## 0. 现状盘点（事实）

### 0.1 Hook 基础设施（已具备）
- `TaskHookPoints` 已在 `packages/core/src/env/task/hooks/task-hook-points.ts` 定义：
  - `task:before.create` / `task:after.create`
  - `task:before.update` / `task:after.update` / `task:after.complete`
  - `task:before.delete` / `task:after.delete`
  - `task:delegate:before` / `task:delegate:after`
  - `task:operation:before.create` / `task:operation:after.create`
- `TaskComponent.executeHook` 在每次 create / update / complete / operation 都会触发对应 hook。
- 已存在示例 hook（`LarkCliTaskNotifyHook`）订阅 `task:after.create / task:after.update / task:operation:after.create`。

### 0.2 现 similar_task_ids 注入（事实）
- `delegate-tool.ts:282-283` schema：`similar_task_ids: z.array(z.number()).max(3)`，description 要求 "Search for similar tasks before calling this tool"。
- `executeWithAbort` (`delegate-tool.ts:1093-1140`) 在 prompt 构造时遍历 `similarTaskIds`，调用 `taskComponent.getTask()` + `listOperations()`，拼接成 `## Similar Tasks Reference` 段落追加到 `fullPrompt`。
- **缺陷**：要求 default agent **主动** 用 `task_search` 找出相似 ID 然后填入；现实里多数 default agent 直接给空数组或填最近一次 ID，导致子 agent 看不到候选。

### 0.3 Task continuation / reopen 能力（已具备，但未成文）
- `UpdateTaskToolSchema` (task-types.ts:102-118) 已允许 `status: ["todo", "active", "completed", "paused", "cancelled", "archived"]`，无转换限制。
- `updateTool` (`tools/update-tool.ts`) 在 status/progress/current_status 变化时会自动 `createOperation` 记录一次 progress。
- 因此：**无需新增 `task_reopen` API**——`task_update(task_id, { status: "active" })` 即可 reopen，已具备原子操作 + 操作审计。

### 0.4 Prompt 现状
- `packages/core/src/env/prompt/prompts-index.ts` 已有一段 "Task Selection Logic — PRIORITY ORDER"（行 720 起），但**只在 roy sub-agent 的 base prompt 里出现**——主 agent / 默认 prompt 没有。
- 同时 default agent (`prompts-index.ts:190`) 让 default agent 在 delegate 前主动搜相似任务并填 `similar_task_ids`。

### 0.5 Session / process / bg task 信息（可得）
- `subSession.info.metadata`：`subagent_type`, `created_by`, `task_description`, `messageId`, `chatId`, `larkMessageId`, `larkUserId`, `larkProfile`, `parentSessionId`
- `BackgroundTaskManager` 持有 `taskId: bgProcessId`、`subSessionId`、parentSessionId 关联
- `getEnvContext()`（AsyncLocalStorage）→ messageId / userId / replyChannel

---

## 1. 设计目标

最小但完整的 MVP：

| 目标 | 满足方式 |
|---|---|
| 全局可查询的任务创建上下文 | **进程内 bounded LRU + TTL registry**（不持久化到 DB，因为 hook 时机只覆盖运行时；DB 查询作为 fallback） |
| 跨进程 / 重启能力 | 通过现有 `task_search` / `task_list` 走 DB，registry 提供"最近活动"快路径 |
| delegate prompt 自动注入候选 | `executeWithAbort` 调用前查 registry，自动格式化候选段落 |
| 与 `similar_task_ids` 协同 | 去重：registry 候选中已含的 ID 不再重复列出；合并到同一段落 |
| 安全 reopen / continuation | 现有 `task_update(status=active|todo)` 已够；新增测试 + prompt 指引 |
| 隐私 / token 控制 | 描述截断、敏感 token 模式（如 `sk-...`、`Bearer ...`、`xoxb-...`）替换为 `<redacted>` |
| 错误复用防护 | 只**列候选**，不自动合并/关闭任何 task；明确 prompt 指令要求 subagent `task_get` 确认 |

---

## 2. 数据结构

```ts
// packages/core/src/env/task/task-creation-registry.ts

export interface TaskRecordSource {
  /** 直接创建该 task 的 sessionId（TaskComponent.createTask 调用栈里的 sessionId） */
  sessionId?: string;
  /** session 父链中的更上层的 session（顶层 main session） */
  parentSessionId?: string;
  /** 背景 task id（process_<ts>_<rand>）若该 task 由 delegate 触发 */
  bgTaskId?: string;
  /** 创建者 subagent_type（roy / workflow-runner / ...） */
  subagentType?: string;
  /** OS process.pid（Node） */
  processId?: number;
}

export interface TaskRecord {
  taskId: number;
  title: string;
  description: string;       // sanitized + truncated
  goals: string;             // sanitized + truncated
  tags: string[];
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  parentTaskId?: number;
  source: TaskRecordSource;
  createdAt: string;         // ISO
  updatedAt: string;         // ISO
  operationCount: number;    // 近似用于排序
}

export interface RecentQueryOptions {
  /** 限定当前 scope 内（默认 = 当前 process 全局） */
  scope?: { sessionId?: string; parentSessionId?: string; subagentType?: string };
  /** 最多返回多少条 */
  limit?: number;
  /** 哪些状态应被包含（默认 = 全部非 archived） */
  statuses?: TaskStatus[];
  /** 候选中要排除的 id（用于与 similar_task_ids 去重） */
  excludeIds?: number[];
  /** 排除的 parent task id 子树（避免暴露无关祖先） */
  excludeAncestorOf?: number[];
  /** 仅展示最近 N 小时内的 */
  sinceHours?: number;
}

export interface ReuseCandidatePromptSection {
  /** "Recent task context (reuse candidates)" 段落 markdown */
  markdown: string;
  /** 候选 id 列表（与 excludeIds 合并后），便于测试断言 */
  candidateIds: number[];
  /** 是否非空（用于判断是否注入） */
  isEmpty: boolean;
}
```

---

## 3. 模块划分

| 文件 | 行数预估 | 职责 |
|---|---|---|
| `packages/core/src/env/task/task-creation-registry.ts` | ~280 | 核心 registry：record/update/remove/recent/sanitize、LRU+TTL 配置 |
| `packages/core/src/env/task/task-creation-registry.test.ts` | ~350 | 单元测试：基本 CRUD / scope / LRU / TTL / sanitization / 并发 |
| `packages/core/src/env/task/task-reuse-context.ts` | ~120 | prompt builder：`buildReuseCandidateSection(registry, opts)` 返回 markdown |
| `packages/core/src/env/task/task-reuse-context.test.ts` | ~250 | 单元测试：truncation / dedupe / empty / a-stock-screener fixture |
| `packages/core/src/env/task/registry-hook-installer.ts` | ~80 | 把 registry 挂到 TaskComponent hook 系统的工具函数 |
| `packages/core/src/env/task/registry-hook-installer.test.ts` | ~150 | 集成测试：hook → registry → prompt builder 端到端 |
| 修改 `delegate-tool.ts` | +~50 | `executeWithAbort` 调用 `buildReuseCandidateSection`；不改 schema |
| 修改 `prompts-index.ts` | +~10 | 在 default agent prompt 加 "reuse candidates section will be auto-injected" 说明 |
| 修改 `prompts-index.test.ts` | +~20 | 新断言验证 prompt 提及 reuse candidates |

---

## 4. 关键设计点

### 4.1 为什么用进程内 LRU+TTL，而不是持久化
- Hook 时机是 runtime-only；DB 查询成本高且增加延迟（每次 delegate 都要查）。
- `task_search` / `task_list` 已覆盖跨重启场景——registry 是"最近活跃任务"快路径。
- 进程退出后 registry 丢失是预期行为；DB fallback 在 prompt builder 里**可选**调用（默认关闭，避免延迟）。

### 4.2 去重策略
- `excludeIds`: 来自 `similarTaskIds`（用户显式提供）。
- registry 候选如果在 `excludeIds` 里，不重复列出。
- 但是**同一段不重复**：merged markdown 一次输出，避免 prompt 噪声。

### 4.3 sanitization
- 描述截断（默认 240 字符，配置项 `maxDescriptionChars`）。
- token 模式替换：`/(sk-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|Bearer [A-Za-z0-9._-]{8,}|ghp_[A-Za-z0-9]{20,})/g` → `<redacted>`
- goals 同样处理。

### 4.4 reopen / continuation 复用现有 API
- **不新增** `task_reopen`：现有 `task_update(task_id, { status: "active", current_status: "...continued work..." })` 即可。
- 新增 prompt 指引：建议 subagent 先 `task_get`，再决定 `task_update`（重开 + 描述追加 + status 改 active），最后 `task_operation_create(milestone_type: "decision", title: "Continuation: <reason>")`。
- 加测试覆盖：`completed → active` 转换，operation 记录不被丢失。

### 4.5 错误复用防护
- registry 只**列出**候选；**不**自动合并、关闭、改写任何 task。
- prompt 指令明文："Only after `task_get` confirms the candidate is the same work, prefer `task_update` / reopen. Otherwise create a new task with a distinguishing title/parent."
- 不允许"仅凭标题相似"自动合并。

### 4.6 并发安全
- registry 内部 `Map<number, TaskRecord>` + 写操作串行化（`Promise.resolve().then` 队列）。
- `record()` / `update()` 都是同步写入 Map，hook 调用栈不持有 await。
- LRU eviction 在 record / update 后同步执行。

---

## 5. delegate prompt 注入位置

`delegate-tool.ts` 的 `executeWithAbort` (行 1044-1140)：

```ts
// NEW: 注入 reuse candidates 段落（在 similar_task_ids 段落后，或合并）
const reuseSection = buildReuseCandidateSection({
  registry: getOrCreateTaskReuseRegistry(env),
  similarTaskIds: similarTaskIds ?? [],
  scope: { subagentType },
  limit: 5,
  maxChars: 2000,
  maxDescriptionChars: 240,
});
if (!reuseSection.isEmpty) {
  fullPrompt += `\n\n${reuseSection.markdown}`;
}
```

registry 实例通过 `EnvironmentService` 单例或 per-process 全局变量持有（懒初始化）。

---

## 6. 测试计划（TDD）

### 6.1 单元（必须全绿）
- `task-creation-registry.test.ts`
  - 记录 / 更新 / 移除
  - LRU 上限触发后最旧条目淘汰
  - TTL 过期后 `recent()` 不返回
  - scope 过滤（sessionId / parentSessionId / subagentType）
  - excludeIds 排除
  - statuses 过滤（默认排除 archived）
  - sanitization 替换 token / 截断描述
  - 并发 `record()` 20 次 → recent() 严格按 updatedAt DESC 返回
- `task-reuse-context.test.ts`
  - 空候选 → markdown 为空 / isEmpty=true
  - 3 个候选 + 2 个 excludeIds → 1 个候选，去重正确
  - 描述超长被截断
  - token 被脱敏
  - a-stock-screener fixture（5 个 task 标题相似，第二次 "注册" prompt 应看到前 4 个候选）
  - 候选顺序：updatedAt DESC + 与 current scope 关联的优先

### 6.2 集成（必须全绿）
- `registry-hook-installer.test.ts`
  - 注册 hook 后，调用 `taskComponent.createTask` → registry 立即含该 task
  - `taskComponent.updateTask` → registry record 同步更新
  - `taskComponent.completeTask` → registry record status = completed
  - 不重复记录同一 task（多次 update 不创建多条记录）
- delegate-tool 端到端：
  - 注册 registry 后调 `executeWithAbort`（带 subSession 含 sessionId + metadata），prompt 含 reuse candidates 段落
  - 关闭 registry（环境变量或构造开关）→ prompt **不**含该段落（向后兼容）
  - 与 `similar_task_ids` 共存：candidate 不重复

### 6.3 Backward compatibility
- `delegate-tool.test.ts` 全部既有测试**不修改**直接跑通
- `prompts-index.test.ts` 全部既有测试**不修改**直接跑通

### 6.4 Reopen tests
- `update-tool.test.ts` 加用例：completed → active 转换，operation 保留
- registry 在 reopen 时记录一次 update（status: active）

---

## 7. 风险与限制

| 风险 | 等级 | 缓解 |
|---|---|---|
| registry 跨进程失效 | 🟡 中 | DB fallback 可选（默认关闭）；prompt 不阻塞 |
| 错误合并相似任务 | 🔴 高 | 仅列候选 + 强制要求 `task_get` 确认 |
| 描述泄漏密钥 | 🟡 中 | sanitization 强制开启（白名单 allowlist） |
| prompt token 超限 | 🟢 低 | `limit` / `maxChars` / 截断都有 |
| LRU 抢占正在用 task | 🟢 低 | registry 只**观察**，不删 task 数据；DB 仍在 |
| 并发 delegate 写入冲突 | 🟢 低 | Map 同步写入，无 await |
| `task_update` 完成→active 触发副作用 | 🟢 低 | 已存在的 hook 会收到 AFTER_UPDATE，预期行为 |
| LarkCliTaskNotifyHook 在 reopen 时重复发完成通知 | 🟢 低 | hook 监听状态变化，重开也合理发通知（"重新打开"事件） |

---

## 8. 验证清单（Verify Checklist）

- [ ] `task-creation-registry.ts` 实现 + 单元测试 ≥ 10 case 全绿
- [ ] `task-reuse-context.ts` 实现 + 单元测试 ≥ 6 case 全绿（含 a-stock-screener fixture）
- [ ] `registry-hook-installer.ts` 实现 + 集成测试 ≥ 4 case 全绿
- [ ] `delegate-tool.ts` 在 `executeWithAbort` 注入 reuse candidates
- [ ] `delegate-tool.test.ts` 既有测试全绿（**不修改**）
- [ ] `prompts-index.ts` 增加 reuse candidates 说明
- [ ] `prompts-index.test.ts` 既有测试全绿 + 新增 reuse 段断言
- [ ] `update-tool.test.ts` 新增 completed→active 测试
- [ ] `bun run build:cli:dev:single` 通过
- [ ] `bun packages/cli/dist/bin/roy-bot.js --help` 可执行
- [ ] reports/2389-task-reuse-summary.md 输出
- [ ] git commit TDD 风格（每步 RED → GREEN → refactor）

---

## 9. 待用户拍板点（默认值已给）

1. registry 上限：默认 500 entries / 24h TTL —— 可改？
2. 候选 limit：默认 5 —— 可改？
3. prompt 截断：maxChars 2000 / maxDescriptionChars 240 —— 可改？
4. 是否启用 DB fallback（task_search）—— **默认关闭**（避免延迟）

默认均已写进实现；运行后用户可在 review 时调。