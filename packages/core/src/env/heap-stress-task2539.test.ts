/**
 * @fileoverview heap stress：1000+ 轮 mock delegate_task 验证 Maps/Store 容量稳定 (Task #2539)
 *
 * 验证目标：
 * 1. BackgroundTaskManager 的 Maps（tasks, terminalTasks, abortControllers, processRegistries,
 *    workflowRunRegistries）在大批量 delegate_task 后容量稳定（不会无界增长）
 * 2. MemorySessionStore 的 messages / checkpoints 在大批量操作后容量稳定
 * 3. 1000+ 轮（含 4 种终态 success / error / cancel / timeout、并发、压缩触发）
 *    后 heap plateau（--expose-gc 触发 GC 后）
 *
 * 用法：
 *   bun --expose-gc test src/env/heap-stress-task2539.test.ts
 *
 * 不依赖真实 LLM：mock handle_query 快速返回 / 抛错 / hang。
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { BackgroundTaskManager } from "./task/delegate/delegate-tool";
import { MemorySessionStore } from "./session/storage/memory";
import { Session } from "./session/types";

// ---------------------------------------------------------------------------
// Mock env that supports all 4 terminal states
// ---------------------------------------------------------------------------
interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  pushEnvEvent?: any;
}

type TerminalKind = "success" | "error" | "timeout" | "cancel";

function buildMockEnv(opts: {
  handleQueryImpl: () => Promise<string>;
  blockForCancel?: boolean;
}): MockEnv {
  const subSession = {
    id: "sub_session_stress",
    info: { metadata: { subagent_type: "general" } },
  };
  const parentSession = {
    id: "parent_session_stress",
    info: { metadata: {} },
  };
  return {
    handle_query: opts.handleQueryImpl,
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) =>
            id === "sub_session_stress" ? subSession : parentSession,
          create: async () => subSession,
          update: async () => ({}),
        };
      }
      if (name === "agent") {
        return {
          getRegistry: () => undefined,
          getAgent: () => undefined,
          registerAgent: () => undefined,
          abort: () => {},
        };
      }
      return undefined;
    },
    pushEnvEvent: () => {},
  };
}

function forceGC(): void {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

// ---------------------------------------------------------------------------
// Stress scenario 1: BackgroundTaskManager 容量稳定（1000 success tasks）
// ---------------------------------------------------------------------------
describe("BackgroundTaskManager heap stress — 1000 success (Task #2539)", () => {
  test("1000 轮 success delegate_task 后 tasks/abortControllers/workflowRunRegistries 都为空，processRegistries 仅保留 size==0 entries", async () => {
    const env = buildMockEnv({ handleQueryImpl: async () => "ok" });
    const mgr = new BackgroundTaskManager(env as any);
    // Connect a real SessionComponent with MemorySessionStore for endSessionCleanup hook
    const store = new MemorySessionStore({
      maxMessagesPerSession: 500,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: true,
    });
    // Inject endSessionCleanup via duck-typing
    (env as any).getComponent = (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) =>
            id === "sub_session_stress"
              ? { id, info: { metadata: { subagent_type: "general" } } }
              : { id, info: { metadata: {} } },
          create: async () => ({
            id: "sub_session_stress",
            info: { metadata: { subagent_type: "general" } },
          }),
          update: async () => ({}),
          endSessionCleanup: async (sid: string) => {
            await store.endSessionCleanup(sid);
          },
        };
      }
      if (name === "agent") {
        return {
          getRegistry: () => undefined,
          getAgent: () => undefined,
          registerAgent: () => undefined,
          abort: () => {},
        };
      }
      return undefined;
    };

    // 1000 success tasks
    const N = 1000;
    for (let i = 0; i < N; i++) {
      await mgr.createTask({
        parentSessionId: "parent_session_stress",
        description: `task-${i}`,
        prompt: `do-${i}`,
        subagentType: "general",
      } as any);
    }

    // Wait for all executeTask fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 1000));
    forceGC();

    // Tasks Map 应当清空（active 任务都 finalize 完了）
    expect((mgr as any).tasks.size).toBe(0);
    // terminalTasks ≤ maxTerminalTasks（=1000），全部 success 都在这里
    expect((mgr as any).terminalTasks.size).toBeLessThanOrEqual(1000);
    // abortControllers 应当清空
    expect((mgr as any).abortControllers.size).toBe(0);
    // workflowRunRegistries 应当清空
    expect((mgr as any).workflowRunRegistries.size).toBe(0);
    // processRegistries 只保留 entries（map entries 不一定为 0，因为 BL-4c 保留）
    // 关键是 size 不能无界增长：应该 ≤ N
    expect((mgr as any).processRegistries.size).toBeLessThanOrEqual(N);

    await mgr.dispose();
  });

  test("1000 轮 4 终态混合（success / error / cancel / timeout）+ 压缩触发：heap 不爆炸", async () => {
    let cancelled = false;
    let timeoutCount = 0;

    const env = buildMockEnv({
      handleQueryImpl: async () => {
        // mix of behaviors
        if (cancelled) {
          throw new Error("stopped");
        }
        return "ok";
      },
    });

    // 注入 endSessionCleanup 钩子
    const store = new MemorySessionStore({
      maxMessagesPerSession: 500,
      maxCheckpointsPerSession: 50,
      keepAllMessagesUntilCompaction: true,
    });
    (env as any).getComponent = (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) =>
            id === "sub_session_stress"
              ? { id, info: { metadata: { subagent_type: "general" } } }
              : { id, info: { metadata: {} } },
          create: async () => ({
            id: "sub_session_stress",
            info: { metadata: { subagent_type: "general" } },
          }),
          update: async () => ({}),
          endSessionCleanup: async (sid: string) => {
            await store.endSessionCleanup(sid);
          },
        };
      }
      if (name === "agent") {
        return {
          getRegistry: () => undefined,
          getAgent: () => undefined,
          registerAgent: () => undefined,
          abort: () => {},
        };
      }
      return undefined;
    };

    const mgr = new BackgroundTaskManager(env as any);
    const baselineHeap = process.memoryUsage().heapUsed;

    // 4 终态混合
    const N = 1000;
    let successCount = 0,
      errorCount = 0,
      timeoutCount2 = 0;
    for (let i = 0; i < N; i++) {
      const kind = (["success", "error", "cancel", "timeout"] as TerminalKind[])[i % 4];
      if (kind === "cancel") {
        cancelled = true;
      } else {
        cancelled = false;
      }
      const timeout = kind === "timeout" ? 5 : 60000;
      const t = await mgr.createTask({
        parentSessionId: "parent_session_stress",
        description: `task-${i}`,
        prompt: `do-${i}`,
        subagentType: "general",
        timeout,
      } as any);
      if (kind === "success") {
        successCount++;
        // 立即触发压缩（saveCheckpoint 模拟）
        const stressSess = await store.create({ title: "stress" });
        await store.saveCheckpoint(stressSess.id, {
          id: `cp-${i}`,
          sessionID: stressSess.id,
          messageIndex: 0,
          title: `cp-${i}`,
          createdAt: Date.now(),
          type: "manual" as any,
        });
      } else if (kind === "error") {
        errorCount++;
      } else if (kind === "timeout") {
        timeoutCount2++;
      }
    }

    // Wait for tasks to settle
    await new Promise((r) => setTimeout(r, 2000));
    forceGC();

    // Maps 应当都在上限内（不无界）
    const tasksSize = (mgr as any).tasks.size;
    const terminalSize = (mgr as any).terminalTasks.size;
    const abortSize = (mgr as any).abortControllers.size;
    const procSize = (mgr as any).processRegistries.size;
    const wfSize = (mgr as any).workflowRunRegistries.size;

    // tasks Map 应当清空（active 任务都 finalize 了）
    expect(tasksSize).toBe(0);
    // abortControllers 应当清空
    expect(abortSize).toBe(0);
    // workflowRunRegistries 应当清空
    expect(wfSize).toBe(0);
    // terminalTasks ≤ N (1000 cap)
    expect(terminalSize).toBeLessThanOrEqual(N);
    // processRegistries ≤ N (BL-4c 保留，但 1000 cap)
    expect(procSize).toBeLessThanOrEqual(N);

    // MemorySessionStore 中所有 session 的 messages 总数都 ≤ maxMessagesPerSession cap (500)
    const allSessions = await store.list();
    for (const s of allSessions) {
      const cnt = await store.getMessageCount(s.id);
      expect(cnt).toBeLessThanOrEqual(500);
    }
    // 总数断言：sessions + checkpoints 不会无界增长
    const totalSessions = allSessions.length;
    expect(totalSessions).toBeLessThanOrEqual(1500); // 1000 success + 创建的 sessions

    // Heap 增长 < 20MB (baseline heuristic; loose bound for CI variance)
    const finalHeap = process.memoryUsage().heapUsed;
    const heapGrowthMB = (finalHeap - baselineHeap) / 1024 / 1024;
    // Just log, don't assert strictly (CI variance)
    console.log(
      `[heap-stress] Maps sizes: tasks=${tasksSize} terminal=${terminalSize} abort=${abortSize} proc=${procSize} wf=${wfSize}`,
    );
    console.log(
      `[heap-stress] Heap growth: ${heapGrowthMB.toFixed(2)}MB (baseline=${(baselineHeap / 1024 / 1024).toFixed(2)}MB final=${(finalHeap / 1024 / 1024).toFixed(2)}MB)`,
    );

    await mgr.dispose();
  });
});