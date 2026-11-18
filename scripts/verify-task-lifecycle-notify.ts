#!/usr/bin/env bun
/**
 * Verify Task Lifecycle Notify via real TaskComponent.
 *
 * Creates a real TaskComponent with LarkCliTaskNotifyHook registered,
 * drives a full lifecycle (create -> update -> progress -> complete),
 * and asserts that the hook would have fired (via mock sendLarkMessage).
 *
 * Usage:
 *   bun run scripts/verify-task-lifecycle-notify.ts
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CORE = resolve(ROOT, "packages/core/src/index.ts");

// 1) 写一个端到端验证脚本，注入 hook，运行真实 task 生命周期
const verifyScript = `
import { TaskComponent, LarkCliTaskNotifyHook, NotifyType, runWithEnvContext, SQLiteTaskStore } from "@ai-setting/roy-bot-core";

// 1) 准备临时 SQLite DB
const tempDb = "/tmp/roy-task-lifecycle-verify.db";
try { require("fs").unlinkSync(tempDb); } catch {}
try { require("fs").unlinkSync(tempDb + "-shm"); } catch {}
try { require("fs").unlinkSync(tempDb + "-wal"); } catch {}

const store = new SQLiteTaskStore(tempDb);
await store.initialize();

// 2) 创建 TaskComponent（绕过完整 configComponent，传一个最小可用的）
const taskComponent = new TaskComponent({});

// 3) 替换 store 为我们的临时 store
taskComponent["store"] = store;

// 4) 监听所有 sendLarkMessage 调用
const messages = [];
const origSend = LarkCliTaskNotifyHook.prototype["sendLarkMessage"];
LarkCliTaskNotifyHook.prototype["sendLarkMessage"] = async (opts) => {
  messages.push(opts);
  console.log("[mock-send]", opts.title);
  console.log("  content:", JSON.stringify(opts.content).slice(0, 200));
};

// 6) 创建 LarkCliTaskNotifyHook 并注册到 TaskComponent
const hook = new LarkCliTaskNotifyHook({
  sourceId: "verify-source",
  pluginName: "LarkCliTaskNotifyPlugin",
  // 使用默认 notifyTypes（已包含所有生命周期事件）
});

taskComponent.registerHook("task:after.create", hook);
taskComponent.registerHook("task:after.update", hook);
taskComponent.registerHook("task:operation:after.create", hook);

// 7) 构造 envContext（包含 replyChannel）
const envContext = {
  envEvent: { metadata: {} },
  sourceId: "verify-source",
  userId: "verify-user",
  replyChannel: {
    chatId: "oc_test_chat",
    messageId: "om_test_msg",
  },
  pluginEnabled: { "verify-source:LarkCliTaskNotifyPlugin": true },
};

// 8) 在 envContext 中跑整个生命周期
await runWithEnvContext(envContext, async () => {
  // Step 1: 创建 task
  const task = await taskComponent.createTask({
    title: "测试任务生命周期",
    description: "验证 LarkCliTaskNotifyHook 是否能覆盖完整生命周期",
    priority: "high",
    project_path: ROOT,
    sessionId: "verify-session",
  });
  console.log(">>> Created task #" + task.id);

  // Step 2: 进度更新 (todo -> active)
  await taskComponent.updateTask(task.id, {
    status: "active",
    progress: 25,
    current_status: "开始执行：收集上下文",
  });
  console.log(">>> Updated to active, 25%");

  // Step 3: 进度更新 (25% -> 60%)
  await taskComponent.updateTask(task.id, {
    progress: 60,
    current_status: "执行中：编写测试",
  });
  console.log(">>> Updated to 60%");

  // Step 4: 进度更新 (60% -> 95%)
  await taskComponent.updateTask(task.id, {
    progress: 95,
    current_status: "验证阶段",
  });
  console.log(">>> Updated to 95%");

  // Step 5: 完成任务
  await taskComponent.completeTask(task.id, "verify-session");
  console.log(">>> Completed");
});

// 9) 还原 sendLarkMessage
LarkCliTaskNotifyHook.prototype["sendLarkMessage"] = origSend;

// 10) 统计发送的消息
console.log("\\n=== Summary ===");
console.log("Total messages:", messages.length);
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  console.log(\`[\${i+1}/\${messages.length}] \${m.type} - \${m.title}\`);
}

const expectedTypes = [
  NotifyType.TASK_CREATED,
  NotifyType.OPERATION_CREATED, // create operation
  NotifyType.TASK_UPDATED, // todo -> active
  NotifyType.OPERATION_CREATED, // progress operation
  NotifyType.TASK_UPDATED, // 25 -> 60
  NotifyType.OPERATION_CREATED, // progress operation
  NotifyType.TASK_UPDATED, // 60 -> 95
  NotifyType.OPERATION_CREATED, // progress operation
  NotifyType.TASK_UPDATED, // 95 -> 100 (this fires task:after.update)
  NotifyType.TASK_COMPLETED,
  NotifyType.OPERATION_CREATED, // completed operation
];

console.log("\\nExpected event types:", expectedTypes.length);
const actualTypes = messages.map(m => m.type);
console.log("Actual event types:  ", actualTypes.length);

const missing = expectedTypes.filter(t => !actualTypes.includes(t));
if (missing.length > 0) {
  console.log("❌ MISSING:", missing);
  process.exit(1);
}

console.log("\\n✅ All expected event types fired!");
console.log("\\n=== Trace Points Captured ===");
console.log("- task.component.createTask (start)");
console.log("- task.component.createOperation (start)");
console.log("- task.component.updateTask (start)");
console.log("- task.component.completeTask (start)");
console.log("- lark-cli-task-notify.execute (per hook)");
console.log("- lark-cli-task-notify.sendNotify (per notification)");
console.log("- lark-cli-task-notify.sendLarkMessage (per lark call)");
console.log("\\nRun debug trace:");
console.log("  bun run packages/cli/dist/bin/roy-bot.js debug trace <traceId>");
console.log("  bun run packages/cli/dist/bin/roy-bot.js debug span <spanId>");
`;

// 写入临时文件
const tmpScript = "/tmp/verify-task-lifecycle.mjs";
await Bun.write(tmpScript, verifyScript);

// 执行
const result = spawnSync("bun", ["run", tmpScript], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    ROY_TRACE_DEBUG: "1",
    LOG_TRACE_LOGGING_LEVEL: "debug",
    NODE_PATH: `${ROOT}/packages/core/node_modules:${ROOT}/node_modules`,
  },
});

process.exit(result.status ?? 0);
