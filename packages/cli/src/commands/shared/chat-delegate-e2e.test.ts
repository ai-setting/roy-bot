/**
 * @fileoverview Task #4571 — chat 命令端到端：session 真实存在 → delegate 能挂上
 *
 * ## 这个文件回答「修完之后 delegate 真的能跑吗」
 *
 * 上一份 `chat-session.test.ts` 只测了「created session 能 get 回来」。
 * 但那只是**必要条件**。本文件用真实的 `BackgroundTaskManager.createTask()`
 * 走一遍 delegate 的挂载路径，证明：
 *   - 修之前（sessionId="cli-chat" 未注册）→ `Parent session not found`
 *   - 修之后（createChatSession 的真实 id）→ createTask 成功返回 taskId/subSessionId
 *
 * ## 为什么不 mock createTask 的内部
 *
 * 我们要锁的正是 `createTask()` 里那句：
 * ```typescript
 * const parentSession = await sessionComponent.get(parentSessionId);
 * if (!parentSession) throw new Error(`Parent session not found: ${parentSessionId}`);
 * ```
 * mock 掉它等于把 bug 也 mock 掉了。所以这里给一个**真的能用**的最小
 * SessionComponent（内存 Map 实现），让 createTask 自己走完校验。
 */

import { describe, expect, test, vi } from "bun:test";

import { BackgroundTaskManager } from "@ai-setting/roy-bot-core/env/task/delegate/delegate-tool";

import { createChatSession } from "./chat-session";

/**
 * 最小可用 SessionComponent（内存实现）。
 *
 * 只需要 `create` / `get` —— BackgroundTaskManager.createTask 用到的全部方法。
 * `_runSubAgent` 那一步无法在此环境真实执行，所以用一个**不等待**的 stub
 * 让 createTask 立即返回（我们要测的只是"挂载"这一步）。
 */
function makeRealishSessionComponent() {
  const store = new Map<string, any>();
  let seq = 0;
  return {
    create: async (options: any = {}) => {
      const id = options.id ?? `session_e2e_${++seq}`;
      const s = {
        id,
        title: options.title ?? "Session",
        metadata: options.metadata ?? {},
        messageCount: 0,
      };
      store.set(id, s);
      return s;
    },
    get: async (id: string) => store.get(id),
    update: async (id: string, patch: any) => {
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, ...patch });
    },
    setActiveSession: async () => true,
    getActiveSessionId: () => undefined,
    list: async () => [],
  };
}

function makeEnv(sessionComponent: any) {
  const events: any[] = [];
  return {
    events,
    pushEnvEvent: (e: any) => events.push(e),
    getComponent: (name: string) => (name === "session" ? sessionComponent : null),
  } as any;
}

// ============================================================================
// 组 1：复现「修之前」的失败（钉住根因，防止有人改回去）
// ============================================================================

describe("根因锚定：硬编码 cli-chat 必然失败", () => {
  test("★ sessionComponent.get('cli-chat') → undefined（这就是 Parent session not found 的来源）", async () => {
    const sessionComponent = makeRealishSessionComponent();
    // 模拟 chat.ts 旧行为：直接用一个从未 create 的字符串
    const parentSession = await sessionComponent.get("cli-chat");
    expect(parentSession).toBeUndefined();
  });

  test("★ BackgroundTaskManager.createTask 拿未注册的 parent → 抛 Parent session not found", async () => {
    const sessionComponent = makeRealishSessionComponent();
    const env = makeEnv(sessionComponent);
    const manager = new BackgroundTaskManager(env);

    await expect(
      manager.createTask({
        parentSessionId: "cli-chat", // ← 旧 chat.ts 的硬编码值
        description: "sleep5",
        prompt: "run sleep 5",
        subagentType: "general",
      }),
    ).rejects.toThrow(/Parent session not found: cli-chat/);
  });
});

// ============================================================================
// 组 2：修完之后 createTask 能挂上（真机报障的核心诉求）
// ============================================================================

describe("修复后：chat 的真实 session 能挂住 delegate", () => {
  test("★ createChatSession 的 id → createTask 不再抛 Parent session not found", async () => {
    const sessionComponent = makeRealishSessionComponent();
    const env = makeEnv(sessionComponent);

    // ① 用新实现拿到真实 session（这正是 chat.ts 要改成做的）
    const { sessionId } = await createChatSession(sessionComponent as any, {
      message: "请 delegate 一个 sleep 5 的任务",
    });

    // ② 直接喂给 BackgroundTaskManager（走真实校验分支）
    const manager = new BackgroundTaskManager(env);
    const result = await manager.createTask({
      parentSessionId: sessionId,
      description: "sleep5",
      prompt: "run sleep 5 && echo done",
      subagentType: "general",
    });

    // 不再抛错，且拿到 process id + sub session
    expect(result.taskId).toMatch(/^process_/);
    expect(typeof result.subSessionId).toBe("string");
    expect(result.subSessionId.length).toBeGreaterThan(0);
  });

  test("修复后 task 挂在正确的 parentSessionId 上（不是 cli-chat）", async () => {
    const sessionComponent = makeRealishSessionComponent();
    const env = makeEnv(sessionComponent);
    const { sessionId } = await createChatSession(sessionComponent as any, {
      message: "q",
    });

    const manager = new BackgroundTaskManager(env);
    const { taskId } = await manager.createTask({
      parentSessionId: sessionId,
      description: "d",
      prompt: "p",
      subagentType: "general",
    });

    const task = manager.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.parentSessionId).toBe(sessionId);
    expect(task!.parentSessionId).not.toBe("cli-chat");
  });
});
