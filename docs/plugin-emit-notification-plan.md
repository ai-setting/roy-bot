# Task #1772 — Plugin Notification Plan v2.1 (Detailed)

> **For agentic workers (Execute):** Steps use checkbox (`- [ ]`) syntax for tracking.
> Plugin 端 TDD is **mandatory** — RED before GREEN.

**Goal:** 完成 plugin 端 RoyPluginTaskShow / TaskShowPlugin 通过 `env.notify` 消费事件总线，并补完 host 端 docs / commit / 跨仓 typecheck。

**Architecture:**

```
RoyPluginTaskShow / TaskShowPlugin (task:after.complete hook)
   │
   ▼
env.notify({type:"visualization_ready", title, content, metadata:{taskId, url, terminalStatus}})
   │
   ▼
PluginComponent.routeNotification()
   │
   ▼
EventBusNotificationChannel (default) ── sends via env.pushEnvEvent
   │
   ▼
plugin.notification.visualization_ready event
   │
   ▼
Env-level Event Subscriber (CLI / IM 适配器)
```

**Tech Stack:** TypeScript, bun test, @ai-setting/roy-bot-core peer dep, plugin.json manifest.

---

## 双侧状态（PLAN 验证后）

### host 端 (roy-bot v2 worktree) — 主体已 commit

- 分支: `feature/plugin-emit-notification-v2`（2 commits ahead of origin/main）
- 路径: `~/work/codework/personal/roy_world/roy-bot/.worktrees/feature-plugin-emit-notification-v2`
- 测试: 193/193 green
- 未 commit: `README.md` (modified), `docs/plugin-emit-notification.md` (untracked)

### plugin 端 (roy-plugin-task-show) — 主体未开始

- 分支: `feature/plugin-emit-notification-consumer`
- 路径: `~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer`
- 测试: 38/38 green（baseline）
- 版本: 0.3.0
- 关键文件:
  - `src/plugin.ts` (`onTaskAfterComplete` 当前调 `injectVisualizationUrl()` mutate `result.output`)
  - `src/url-injector.ts` (`injectVisualizationUrl()`)
  - `src/types.ts` (`PluginEnvLike` interface — **没有** `notify` field)
  - `plugin.json` (manifest — 描述未提及 env.notify)
  - `package.json` (**没有** typecheck script)
  - `README.md` / `CHANGELOG.md`（**未** 提及 env.notify 迁移）

---

## Plugin 端 Phase 3 (核心新工作)

### Task P3-T1: RED — 写失败测试

**Files:**
- Create: `test/plugin-notify.test.ts`

- [ ] **Step 1: 创建测试文件，写失败用例**

```typescript
import { describe, test, expect, vi } from "bun:test";
import { TaskShowPlugin, createTaskShowPlugin } from "../src/index.js";
import { DEFAULT_CONFIG } from "../src/types.js";

/**
 * 创建带 notify spy 的 fake PluginEnv
 */
function makeFakeEnvWithNotify() {
  const hooks: any[] = [];
  const notify = vi.fn(async (_opts: any) => {});
  return {
    hooks,
    notify,
    registerHook: (def: any) => hooks.push(def),
    getComponent: () => null,
    getConfig: () => undefined,
  };
}

describe("TaskShowPlugin — env.notify consumer", () => {
  test("calls env.notify with visualization_ready on task completion", async () => {
    const env = makeFakeEnvWithNotify();
    const plugin = createTaskShowPlugin({ port: 0, autoStart: false });
    await plugin.init(env);

    const ctx = {
      tool: { name: "bash" },
      args: {},
      result: { success: true, output: "ok", metadata: {} },
    };
    await plugin.onToolAfterExecute(ctx);
    await plugin.onTaskAfterComplete({
      data: {
        task: { id: 42, status: "completed", title: "Test" },
        terminalStatus: "completed",
        sessionId: "sess-1",
      },
    });

    expect(env.notify).toHaveBeenCalledTimes(1);
    const opts = env.notify.mock.calls[0][0];
    expect(opts.type).toBe("visualization_ready");
    expect(opts.title).toContain("42");
    expect(opts.metadata.taskId).toBe(42);
    expect(opts.metadata.terminalStatus).toBe("completed");
  });

  test("does NOT mutate result.output (regression: previously mutated)", async () => {
    const env = makeFakeEnvWithNotify();
    const plugin = createTaskShowPlugin({ port: 0, autoStart: false });
    await plugin.init(env);

    const ctx = {
      tool: { name: "bash" },
      args: {},
      result: { success: true, output: "ok", metadata: {} },
    };
    await plugin.onToolAfterExecute(ctx);
    await plugin.onTaskAfterComplete({
      data: {
        task: { id: 50, status: "completed" },
        terminalStatus: "completed",
        sessionId: "",
      },
    });

    // 关键断言：result.output 不被 mutate（迁移到 notify 模式）
    expect(ctx.result.output).toBe("ok");
  });

  test("does NOT call env.notify on non-terminal status", async () => {
    const env = makeFakeEnvWithNotify();
    const plugin = createTaskShowPlugin({ port: 0, autoStart: false });
    await plugin.init(env);

    const ctx = {
      tool: { name: "bash" },
      args: {},
      result: { success: true, output: "ok", metadata: {} },
    };
    await plugin.onToolAfterExecute(ctx);
    await plugin.onTaskAfterComplete({
      data: {
        task: { id: 60, status: "running" },
        terminalStatus: "running",
        sessionId: "",
      },
    });

    expect(env.notify).not.toHaveBeenCalled();
  });

  test("swallows env.notify errors (does not throw out of hook)", async () => {
    const env = makeFakeEnvWithNotify();
    env.notify = vi.fn(async () => {
      throw new Error("notify failed");
    });
    const plugin = createTaskShowPlugin({ port: 0, autoStart: false });
    await plugin.init(env);

    const ctx = {
      tool: { name: "bash" },
      args: {},
      result: { success: true, output: "ok", metadata: {} },
    };
    await plugin.onToolAfterExecute(ctx);

    // 不应该 throw
    expect(async () => {
      await plugin.onTaskAfterComplete({
        data: {
          task: { id: 70, status: "completed" },
          terminalStatus: "completed",
          sessionId: "",
        },
      });
    }).not.toThrow();
  });

  test("dedupes: multiple task:after.complete calls only notify once", async () => {
    const env = makeFakeEnvWithNotify();
    const plugin = createTaskShowPlugin({ port: 0, autoStart: false });
    await plugin.init(env);

    const ctx = {
      tool: { name: "bash" },
      args: {},
      result: { success: true, output: "ok", metadata: {} },
    };
    await plugin.onToolAfterExecute(ctx);

    // 模拟 host 多次 fire 同一 task
    await plugin.onTaskAfterComplete({
      data: { task: { id: 80, status: "completed" }, terminalStatus: "completed", sessionId: "" },
    });
    await plugin.onTaskAfterComplete({
      data: { task: { id: 80, status: "completed" }, terminalStatus: "completed", sessionId: "" },
    });

    expect(env.notify).toHaveBeenCalledTimes(1);
  });

  test("includes URL in metadata for subscribers to link to visualization page", async () => {
    const env = makeFakeEnvWithNotify();
    const plugin = createTaskShowPlugin({ port: 7788, host: "127.0.0.1", autoStart: false });
    await plugin.init(env);

    const ctx = {
      tool: { name: "bash" },
      args: {},
      result: { success: true, output: "ok", metadata: {} },
    };
    await plugin.onToolAfterExecute(ctx);
    await plugin.onTaskAfterComplete({
      data: {
        task: { id: 90, status: "completed", title: "demo" },
        terminalStatus: "completed",
        sessionId: "",
      },
    });

    const opts = env.notify.mock.calls[0][0];
    expect(opts.metadata.url).toMatch(/^http:\/\/127\.0\.0\.1:7788\/task\/90$/);
  });

  afterEach(async () => {
    // dispose handled by plugin.dispose()
  });
});
```

- [ ] **Step 2: 验证 RED**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
bun test test/plugin-notify.test.ts
```

预期：测试失败，错误信息应为 `TypeError: env.notify is not a function` 或类似（因为 `PluginEnvLike` 没有 `notify`）。

### Task P3-T2: GREEN — 类型扩展

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 加 NotificationOptions interface**

在 `src/types.ts` 顶部添加：

```typescript
/**
 * NotificationOptions — Plugin 发出的通知负载（与 host 端 NotificationOptions 对齐）
 *
 * Plugin 通过 `env.notify(options)` 发送通知。
 * Host 端 `PluginComponent.routeNotification` 把通知路由到 NotificationChannel。
 * 默认 `EventBusNotificationChannel` 把它转成 `plugin.notification.<type>` 事件，
 * 通过 `env.pushEnvEvent` 发送。
 */
export interface NotificationOptions {
  /** 通知类型（必填），EventBus 通道转成 `plugin.notification.<type>` 事件 */
  type: string;
  /** 通知标题 */
  title: string;
  /** 通知内容（人类可读） */
  content: string;
  /** 额外元数据，透传到 event.metadata */
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: 加 PluginEnvLike.notify field**

修改 `PluginEnvLike` interface：

```typescript
export interface PluginEnvLike {
  registerHook?: (def: {
    point: string;
    priority?: number;
    name?: string;
    handler: (ctx: unknown) => unknown | Promise<unknown>;
  }) => void;
  getComponent?: (name: string) => unknown;
  getConfig?: (key: string) => unknown;
  /**
   * Send a notification through the host's plugin notification channel(s).
   * Added in roy-bot 2026-07-10+ (v0.4.0 plugin contract).
   * Recommended over directly mutating tool result.output.
   */
  notify?: (options: NotificationOptions) => void | Promise<void>;
}
```

- [ ] **Step 3: 验证类型编译**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
npx tsc --noEmit  # or bun run typecheck if added
```

预期：0 errors（plugin 端 codebase 小，目前干净）。

### Task P3-T3: GREEN — plugin.ts 实现

**Files:**
- Modify: `src/plugin.ts` (specifically the `onTaskAfterComplete` method)

- [ ] **Step 1: 替换 `injectVisualizationUrl` 调用为 `env.notify`**

找到 `onTaskAfterComplete` 中这段（当前实现）：

```typescript
const outcome = injectVisualizationUrl({
  ctx: { result: lastResult },
  cfg: this.cfg,
  taskId,
});
if (outcome.mutated) {
  info(`injected visualization URL ${outcome.url} into last tool result for task ${taskId}`);
}
```

替换为：

```typescript
// v0.4.0+: 通过 env.notify 发出 visualization_ready 通知（替代 mutate result.output）
const url = buildVisualizationUrl(this.cfg, taskId);
try {
  await this.env?.notify?.({
    type: "visualization_ready",
    title: `Task #${taskId} ${terminalStatus}`,
    content: [
      `Task: ${data?.task?.title ?? ""}`,
      `Status: ${terminalStatus}`,
      `Visualization: ${url}`,
    ].filter(Boolean).join("\n"),
    metadata: {
      taskId,
      terminalStatus,
      url,
      taskTitle: data?.task?.title,
      sessionId: data?.sessionId,
    },
  });
  info(`notified visualization_ready for task ${taskId}: ${url}`);
} catch (err) {
  warn(`env.notify failed for task ${taskId}: ${err}`);
}
```

- [ ] **Step 2: 移除 `lastResultByTask` map（不再需要）**

由于不再 mutate `result.output`，删除：

```typescript
private lastResultByTask = new Map<number, any>();
```

以及所有 set/get/clear 相关代码（搜索 `lastResultByTask`，删除 set 和 get 调用，保留 `clear()` 调用为 `clear()` 即可 — 但因为 map 删了，clear 也删掉）。

具体：`dispose()` 中 `this.lastResultByTask.clear();` 改为删掉那一行。

- [ ] **Step 3: 验证 GREEN**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
bun test test/plugin-notify.test.ts
```

预期：6 个新测试全部 pass。

- [ ] **Step 4: 跑全量回归**

```bash
bun test
```

预期：原有 38 个 + 新 6 个 = 44 个全部 pass。

注意：plugin.test.ts 中的 `it("injects visualization URL on terminal status", ...)` 这种用例**应该改为失败**（因为我们已经不 mutate 了）。需要：
- 把这条用例**更新**为"calls env.notify on terminal status"（或类似）
- 或者把它移到 plugin-notify.test.ts（更整洁）

Execute 应**手动检查** plugin.test.ts 并把断言 mutate output 的用例改为断言 env.notify。

### Task P3-T4: REFACTOR — url-injector @deprecated

**Files:**
- Modify: `src/url-injector.ts`（仅 JSDoc）

- [ ] **Step 1: 给 `injectVisualizationUrl` 加 @deprecated JSDoc**

在文件顶部 JSDoc 后、`export function injectVisualizationUrl` 前加：

```typescript
/**
 * @deprecated 自 v0.4.0 起，RoyPluginTaskShow / TaskShowPlugin 通过
 *   `env.notify({type:"visualization_ready", ...})` 发出通知替代直接
 *   mutate `result.output`。此函数保留仅为向后兼容旧 Plugin，新代码
 *   请直接调用 `env.notify`。
 *   **删除计划**：v1.0.0。
 */
```

- [ ] **Step 2: 验证**

```bash
bun test test/url-injector.test.ts
```

预期：url-injector.test.ts 全部 pass（向后兼容）。

### Task P3-T5: plugin.json 更新

**Files:**
- Modify: `plugin.json`

- [ ] **Step 1: 更新 description 字段**

找到 description：

```
"description": "Visualize the tool call chain of a task on a local web service and inject the URL into tool results. Subscribes to tool:before.execute (for self-managed timing), tool:after.execute, task:after.complete (preferred, 2026-07-10+) and task:after.update (legacy fallback)."
```

改为：

```
"description": "Visualize the tool call chain of a task on a local web service and emit visualization_ready notifications via env.notify (preferred, 2026-07-10+). Subscribes to tool:before.execute (for self-managed timing), tool:after.execute, task:after.complete (preferred) and task:after.update (legacy fallback). Direct tool result.output mutation is deprecated in favor of env.notify."
```

- [ ] **Step 2: 更新 `task:after.complete` hook purpose 字段**

找到：

```
"purpose": "PREFERRED hook point (roy-bot 2026-07-10+). When a task transitions to a terminal status (completed/failed/cancelled/timeout), finalize the session and inject the visualization URL into the last tool result. terminalStatus field is explicit — no status filtering required."
```

改为：

```
"purpose": "PREFERRED hook point (roy-bot 2026-07-10+). When a task transitions to a terminal status (completed/failed/cancelled/timeout), finalize the session and emit a visualization_ready notification via env.notify. The notification is delivered through the host's PluginComponent notification channels (default: EventBusNotificationChannel which publishes plugin.notification.visualization_ready on the env event bus). terminalStatus field is explicit — no status filtering required."
```

- [ ] **Step 3: 更新 urlInjectEnabled config 描述**

找到：

```
"urlInjectEnabled": {
  "type": "boolean",
  "default": true,
  "description": "Append a 📊 visualization URL to the last tool result when a task completes"
}
```

改为：

```
"urlInjectEnabled": {
  "type": "boolean",
  "default": false,
  "description": "**Deprecated since v0.4.0** — set to false. The plugin now emits visualization_ready notifications via env.notify (recommended) instead of mutating the last tool result. Set to true only for backward compatibility with hosts that do not yet support env.notify."
}
```

- [ ] **Step 4: 验证 plugin.json 合法**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
node -e "console.log(JSON.parse(require('fs').readFileSync('plugin.json', 'utf-8')).name)"
```

预期：`@ai-setting/roy-plugin-task-show`

### Task P3-T6: README + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README 加 "## env.notify Migration (v0.4.0+)" 章节**

找到 README 中合适的 hook / 集成位置，在末尾或配置章节后加：

```markdown
## env.notify Migration (v0.4.0+)

Starting in v0.4.0, the plugin **emits `visualization_ready` notifications via `env.notify()`** instead of mutating `result.output` directly. This aligns with roy-bot's unified plugin notification architecture:

- Plugin calls `env.notify({type: "visualization_ready", title, content, metadata})`
- Host routes through `PluginComponent.routeNotification()` → default `EventBusNotificationChannel`
- Event subscribers (CLI / IM adapters) receive `plugin.notification.visualization_ready` events

### Migration Example

**Before (v0.3.0)** — direct mutation (deprecated):
```typescript
// Inside task:after.complete handler:
// Inject URL into last tool result
const result = lastResultByTask.get(taskId);
result.output += `\n\n---\n📊 Visualization: ${url}`;
```

**After (v0.4.0+)** — env.notify:
```typescript
// Inside task:after.complete handler:
await env.notify({
  type: "visualization_ready",
  title: `Task #${taskId} completed`,
  content: `Visualization: ${url}`,
  metadata: { taskId, url, terminalStatus, taskTitle, sessionId },
});
```

### What still works

- The local HTTP service is **unchanged** — `/task/<id>` still serves the visualization page
- The URL is included in `metadata.url` so subscribers can render it in IM messages
- `tool:before.execute` / `tool:after.execute` / `task:after.update` hooks unchanged
```

- [ ] **Step 2: CHANGELOG 加 v0.4.0 entry**

在 CHANGELOG.md 顶部、release-please managed note 之后、`## [0.1.0]` 之前加：

```markdown
## [0.4.0] — unreleased

### ⚠️ Migration: env.notify replaces direct output mutation

The plugin now emits `visualization_ready` notifications via `env.notify()` instead of mutating `result.output` directly. This aligns with roy-bot's unified plugin notification architecture (Phase 1+2+3 of Task #1772).

### Changes

- **`PluginEnvLike.notify`** interface added — opt-in, callable as `env.notify({type, title, content, metadata})`
- **`onTaskAfterComplete`** handler — now calls `env.notify({type:"visualization_ready", ...})` with `metadata.url` pointing at the visualization page
- **`injectVisualizationUrl()`** in `src/url-injector.ts` — marked `@deprecated`, retained for backward compatibility, removal planned for v1.0.0
- **`urlInjectEnabled`** config default changed to `false` — set to `true` only for legacy hosts without `env.notify` support
- **`lastResultByTask`** map removed — no longer needed (we no longer mutate result.output)
- **`plugin.json`** description and `task:after.complete` hook purpose updated to reflect the new contract

### Action required

- **Host upgrade recommended** — hosts on roy-bot 2026-07-10+ automatically forward `plugin.notification.visualization_ready` events to IM subscribers
- **No code changes needed for consumers** — the visualization URL is still accessible at `http://<host>:<port>/task/<id>` and is now also delivered via the env event bus
```

### Task P3-T7: typecheck script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加 typecheck script**

在 `scripts` 块加：

```json
"typecheck": "tsc --noEmit -p tsconfig.json",
```

- [ ] **Step 2: 跑 typecheck**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
bun run typecheck
```

预期：0 errors。

### Task P3-T8: Plugin 端 commit

- [ ] **Step 1: 暂存所有变更**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
git add src/types.ts src/plugin.ts src/url-injector.ts plugin.json package.json README.md CHANGELOG.md test/plugin-notify.test.ts test/plugin.test.ts
git status
```

预期：看到上述文件 staged。

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(notify): consume env.notify instead of mutating result.output

Migrate RoyPluginTaskShow / TaskShowPlugin from direct result.output mutation
to env.notify({type:\"visualization_ready\", ...}). This aligns with roy-bot's
unified plugin notification architecture (Task #1772, Phase 1+2+3 on host side).

Changes:
- PluginEnvLike.notify field added (opt-in)
- onTaskAfterComplete calls env.notify with type=visualization_ready
- injectVisualizationUrl() marked @deprecated (kept for back-compat)
- urlInjectEnabled config default flipped to false
- lastResultByTask map removed (no longer needed)
- 6 new tests covering notify call, no-mutation regression, error swallow,
  non-terminal skip, dedup, URL metadata"
```

- [ ] **Step 3: 验证 commit**

```bash
git log -1 --oneline
```

预期：显示新 commit。

---

## Host 端 Phase 5-6

### Task P5-T1: Host 端 docs commit

- [ ] **Step 1: 暂存 docs + README**

```bash
cd ~/work/codework/personal/roy_world/roy-bot/.worktrees/feature-plugin-emit-notification-v2
git add README.md docs/plugin-emit-notification.md
git status
```

预期：这两个文件 staged。

- [ ] **Step 2: Commit**

```bash
git commit -m "docs(env): add Plugin Notification README section + design doc

- README.md: add 'Plugin Notification' section with quick example
- docs/plugin-emit-notification.md: full design doc (458 lines)
  covering architecture, API reference, default/legacy channels,
  migration guide from lark-cli to env-level subscriber pattern,
  built-in RoyPluginTaskShow example, design decisions, tests"
```

- [ ] **Step 3: 验证**

```bash
git log -3 --oneline
```

预期：看到新 docs commit 在最后。

### Task P4-T1: Host 端 typecheck

- [ ] **Step 1: 跑 typecheck**

```bash
cd ~/work/codework/personal/roy_world/roy-bot/.worktrees/feature-plugin-emit-notification-v2/packages/core
bun run typecheck 2>&1 | tee /tmp/host-typecheck.log
```

预期：pre-existing errors（与本次工作无关，如 llm.ts / bash-effect.ts）不算新 error。

- [ ] **Step 2: diff vs baseline**

```bash
cd ~/work/codework/personal/roy_world/roy-bot/.worktrees/feature-plugin-emit-notification-v2
git stash  # 暂存 docs uncommitted if any
git checkout origin/main -- packages/core/src/env/plugin/ packages/core/src/env/task/plugins/
cd packages/core && bun run typecheck > /tmp/host-typecheck-baseline.log 2>&1
cd ../.. && git checkout feature/plugin-emit-notification-v2 -- packages/core/src/env/plugin/ packages/core/src/env/task/plugins/
git stash pop 2>/dev/null || true
diff /tmp/host-typecheck-baseline.log /tmp/host-typecheck.log
```

预期：无 diff（pre-existing errors 一致，无新 error）。

### Task P6-T1: Host 端测试套件验证

- [ ] **Step 1: 跑测试**

```bash
cd ~/work/codework/personal/roy_world/roy-bot/.worktrees/feature-plugin-emit-notification-v2
bun test packages/core/src/env/plugin/ packages/core/src/env/task/plugins/
```

预期：`193 pass / 0 fail / 400 expect() calls`。

---

## Cross-repo Phase 4-6

### Task P4-T2: Plugin 端 typecheck

- [ ] **Step 1: 跑 typecheck**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
bun run typecheck
```

预期：0 errors。

### Task P6-T2: Plugin 端测试套件验证

- [ ] **Step 1: 跑测试**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
bun test
```

预期：44+ pass / 0 fail（38 original + 6 new notify tests，可能还有 plugin.test.ts 中更新后的用例）。

### Task P6-T3: split commit 验证

- [ ] **Step 1: Host 端 git log**

```bash
cd ~/work/codework/personal/roy_world/roy-bot/.worktrees/feature-plugin-emit-notification-v2
git log --oneline origin/main..HEAD
```

预期：
```
<new-docs-commit> docs(env): add Plugin Notification README section + design doc
41f84b6a feat(plugin): add RoyPluginTaskShow as env.notify consumer example
f96508f4 feat(plugin): introduce NotificationChannel abstraction with EventBus default
```

- [ ] **Step 2: Plugin 端 git log**

```bash
cd ~/work/codework/personal/roy_world/roy-plugin-task-show/.worktrees/plugin-emit-notification-consumer
git log --oneline main..HEAD  # 或 origin/main
```

预期：
```
<new-commit> feat(notify): consume env.notify instead of mutating result.output
```

### Task P6-T4: E2E mock 验证（可选）

**可选** — 写一个集成测试模拟"plugin 端 notify → host 端 event bus 收到事件"。

由于 plugin 端是独立 repo，最简单的 E2E 是单元层 mock：
- 在 host 端写 `packages/core/test/integration/plugin-notify-e2e.test.ts`：
  - 创建 `PluginComponent` + `RoyPluginTaskShow`（host 端 example）
  - spy `env.pushEnvEvent`
  - 触发 `task:after.complete`
  - 验证 spy 收到 `plugin.notification.visualization_ready` 事件
  - payload.metadata.source === `"plugin:task-show"`
- **不必做**：跨仓物理 E2E（用 npm pack + bun run install 太重）

如果 Execute 决定**跳过** P6-T4，可以直接进入 P6-T5。

### Task P6-T5: Task 收尾

- [ ] **Step 1: 记录 completion operation**

```
task_operation_create(
  task_id=1772,
  action_type="completed",
  action_title="Task #1772 完成 — Plugin Notification v2 全链路打通",
  action_description="..."
)
```

- [ ] **Step 2: Update task to completed**

```
task_update(
  task_id=1772,
  status="completed",
  progress=100,
  current_status="Task #1772 completed"
)
```

---

## Skills 推荐（Execute 加载）

1. `test-driven-development` — Plugin 端 Phase 3 强制
2. `verification-before-completion` — 每 commit 前 evidence
3. `using-git-worktrees` — worktree 已建好，参考流程

---

## 文件结构（plugin 端最终）

```
roy-plugin-task-show/
├── .worktrees/plugin-emit-notification-consumer/
│   ├── src/
│   │   ├── collector.ts        (unchanged)
│   │   ├── core-stub.d.ts      (unchanged)
│   │   ├── index.ts            (re-export NotificationOptions if needed)
│   │   ├── plugin.ts           (MODIFIED: onTaskAfterComplete calls env.notify)
│   │   ├── server.ts           (unchanged)
│   │   ├── types.ts            (MODIFIED: add NotificationOptions + PluginEnvLike.notify)
│   │   └── url-injector.ts     (MODIFIED: @deprecated JSDoc)
│   ├── test/
│   │   ├── collector.test.ts   (unchanged)
│   │   ├── integration.test.ts (unchanged)
│   │   ├── plugin-notify.test.ts (NEW: 6+ tests)
│   │   ├── plugin.test.ts      (UPDATED: assertions about env.notify not output mutation)
│   │   ├── server.test.ts      (unchanged)
│   │   └── url-injector.test.ts (unchanged)
│   ├── plugin.json             (MODIFIED: description, hook purpose, urlInjectEnabled default)
│   ├── package.json            (MODIFIED: add typecheck script)
│   ├── README.md               (MODIFIED: env.notify Migration section)
│   ├── CHANGELOG.md            (MODIFIED: v0.4.0 entry)
│   └── tsconfig.json           (unchanged)
```

## 文件结构（host 端 — 几乎无变化）

```
roy-bot/
├── .worktrees/feature-plugin-emit-notification-v2/
│   ├── packages/core/src/env/plugin/
│   │   ├── notification-channel.ts          (unchanged from Phase 1)
│   │   ├── event-bus-notification-channel.ts (unchanged)
│   │   ├── lark-cli-notification-channel.ts  (unchanged, @deprecated)
│   │   ├── plugin-component.ts               (unchanged from Phase 2)
│   │   └── types.ts                          (unchanged)
│   ├── packages/core/src/env/task/plugins/
│   │   └── task-show-plugin.ts               (unchanged from Phase 3)
│   ├── docs/
│   │   ├── plugin-emit-notification-plan.md  (NEW: this file)
│   │   └── plugin-emit-notification.md       (existing, will commit in P5-T1)
│   └── README.md                             (existing, will commit in P5-T1)
```

---

## Self-Review Checklist

1. **Spec coverage**:
   - ✅ Host 端 Phase 1+2+3 (已 commit)
   - ✅ Plugin 端 Phase 3 (TDD)
   - ✅ Docs (host + plugin)
   - ✅ typecheck (host + plugin)
   - ✅ commits 拆分 (host 3 commits + plugin 1+ commits)
   - ✅ task 收尾

2. **Placeholder scan**: 无 TBD / TODO / "implement later"

3. **Type consistency**:
   - `NotificationOptions` 在 host 端 `packages/core/src/env/plugin/notification-channel.ts` 定义
   - `NotificationOptions` 在 plugin 端 `src/types.ts` 定义（**结构对齐但独立**，因为 plugin 不依赖 host peer dep）
   - `env.notify(options)` 在两端的 signature 一致
   - `metadata.taskId` / `metadata.terminalStatus` / `metadata.url` / `metadata.taskTitle` / `metadata.sessionId` 一致

4. **Files match**: plugin 端 lastResultByTask 移除对应 plugin.ts dispose() 中 clear 调用也移除；test/plugin.test.ts 中断言 mutate output 的用例改为断言 env.notify。