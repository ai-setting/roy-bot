# `task:after.complete` — Task Complete Hook

> Added: 2026-07-10

A new task lifecycle hook point that fires **only when a task transitions to a
terminal status** (`completed` / `failed` / `cancelled` / `timeout`), distinct
from the existing `task:after.update` which fires on every update.

## Why

Before this hook, plugins had to *hack* `task:after.update` by inspecting
`task.status === "completed" | "failed"` to detect completion events. This
coupled plugin authors to status semantics and forced them to remember to filter
the right transitions.

`task:after.complete` lets plugins express the intent directly:

```ts
plugin.registerHook({
  point: "task:after.complete",   // ← semantic, not filtered
  handler: ctx => notify(ctx.task, ctx.terminalStatus),
});
```

## Behavior

| `updateTask({ status })` | AFTER_UPDATE | AFTER_COMPLETE |
| --- | :---: | :---: |
| `status: "active"`   | ✅ | ❌ |
| `status: "paused"`   | ✅ | ❌ |
| `status: "todo"`     | ✅ | ❌ |
| `progress: 50`       | ✅ | ❌ |
| `status: "completed"`| ✅ | ✅ |
| `status: "failed"`   | ✅ | ✅ |
| `status: "cancelled"`| ✅ | ✅ |
| `status: "timeout"`  | ✅ | ✅ |

Both hooks fire in the **same** `updateTask` call when a terminal status is
reached. Plugin authors can pick one or the other:

- subscribe to **AFTER_COMPLETE** when the plugin only cares about end-of-life
  (notifications, webhooks, completion artifacts)
- subscribe to **AFTER_UPDATE** for the broad "any update" stream

## Hook Context

```ts
interface TaskCompleteResultContext {
  task: Task;                                  // updated task entity
  changes: Partial<UpdateTaskOptions>;         // which fields changed
  terminalStatus:                              // explicit terminal status
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout";
  sessionId: string;                           // session that initiated the transition
  tagService: TagService;                      // tag service injection
}
```

## Hook Constant

```ts
import { TaskHookPoints } from "@ai-setting/roy-bot-core";

TaskHookPoints.AFTER_COMPLETE  // "task:after.complete"
```

## Example Plugin

```ts
import { BasePlugin, type HookDefinition } from "@ai-setting/roy-bot-core/plugin";

class NotifierPlugin extends BasePlugin {
  readonly name = "notifier";

  init(env: PluginEnv) {
    env.registerHook({
      point: "task:after.complete",
      priority: 5,
      handler: this.onComplete.bind(this),
    });
  }

  private async onComplete(ctx: HookContext<TaskCompleteResultContext>) {
    const { task, terminalStatus, sessionId } = ctx.data;
    if (terminalStatus === "completed") {
      await sendSlack(`Task #${task.id} "${task.title}" is done!`, sessionId);
    } else if (terminalStatus === "failed") {
      await sendPagerDuty(`Task #${task.id} failed`, task.id, sessionId);
    }
  }
}
```

## Implementation Notes

- Triggered inside `TaskComponent.updateTask()` whenever `options.status` enters
  the terminal set. `TaskComponent.completeTask()` (the high-level helper)
  reaches the same code path via `updateTask({ status: "completed" })`.
- `sessionId` is sourced from the current `EnvContext` (thread-local); falls
  back to `""` if no context is set. Plugin authors that need exact provenance
  should still rely on `task.updateTask` `changes` or `operation` records.
- Cycle-type tasks **cannot** be completed (existing guard), so
  `AFTER_COMPLETE` will never fire for them. The throw propagates through
  the existing `completeTask` validation.
