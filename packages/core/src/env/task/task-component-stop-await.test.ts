/**
 * @fileoverview TaskComponent.stop() dispose-await regression tests
 *
 * Task #4794 根因 #3 — e2e 复现：act 收尾时
 * TaskComponent.stop() 调用 backgroundTaskManager.dispose(...)
 * 但**没有 await**（dispose 是 async）。结果：
 *   1. dispose 打印一次 "dispose waiting for N running task(s)"
 *   2. 在 await setTimeout(200) 处让出事件循环
 *   3. stop() 继续 → Environment stopped → process.exit(0)
 *   4. 同进程后台子 agent 被杀死（done 文件永不生成）
 *
 * 修复：stop() 必须 await dispose()，保证 waitForRunningTasks
 * 等待语义真正生效（act 收尾等待子 agent 跑完再退出）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";

describe("TaskComponent.stop await dispose (Task #4794 root cause #3)", () => {
  let taskComponent: TaskComponent;
  let configComponent: ConfigComponent;
  let disposeCalls: number;

  beforeEach(async () => {
    configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    disposeCalls = 0;
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-stop-await-test-${Date.now()}.db`),
          },
        },
      },
    });

    // 替换 backgroundTaskManager：dispose 记录调用 + 模拟
    // waitForRunningTasks 的耗时（让 fire-and-forget 缺陷可观测）
    const fakeManager = {
      dispose: async (opts?: { skipAbortRunningTasks?: boolean; waitForRunningTasks?: boolean }) => {
        disposeCalls++;
        lastDisposeOpts = opts ?? {};
        // 模拟等待运行中任务的耗时（真实实现是轮询）
        if (opts?.waitForRunningTasks) {
          await new Promise((r) => setTimeout(r, 300));
        }
      },
      getTask: () => undefined,
      listTasks: () => [],
    };
    lastDisposeOpts = {};
    (taskComponent as any).backgroundTaskManager = fakeManager;
  });

  let lastDisposeOpts: { skipAbortRunningTasks?: boolean; waitForRunningTasks?: boolean };

  afterEach(async () => {
    // stop() 已把 manager 置 undefined，直接 super.stop() 兜底
    (taskComponent as any).backgroundTaskManager = undefined;
    await taskComponent.stop().catch(() => {});
  });

  test("RED-A: stop() 必须等待 dispose 完成（await 语义）", async () => {
    (taskComponent as any).skipAbortRunningTasksOnDispose = true;
    (taskComponent as any).waitForRunningTasksOnDispose = true;

    const start = Date.now();
    await taskComponent.stop();
    const elapsed = Date.now() - start;

    // dispose 被调用
    expect(disposeCalls).toBe(1);
    // 修复后 stop() 会 await dispose 的 300ms 模拟等待；
    // fire-and-forget 缺陷下 elapsed < 300（stop 立即返回）
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(lastDisposeOpts.skipAbortRunningTasks).toBe(true);
    expect(lastDisposeOpts.waitForRunningTasks).toBe(true);
  });

  test("RED-B: stop() 后 backgroundTaskManager 引用被清空（防重复 dispose）", async () => {
    await taskComponent.stop();
    expect((taskComponent as any).backgroundTaskManager).toBeUndefined();
    expect(disposeCalls).toBe(1);
  });
});
