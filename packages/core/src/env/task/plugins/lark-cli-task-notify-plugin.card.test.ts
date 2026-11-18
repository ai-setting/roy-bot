/**
 * @fileoverview LarkCliTaskNotifyHook — 卡片通知模式测试（NEW behavior）
 *
 * 测试 LarkCliTaskNotifyHook 集成 LarkCardPatchNotifier 后的新行为：
 * 1. task:after.create → 调用 notifier.startTask
 * 2. task:after.update → 调用 notifier.updateTask (patch 同一卡片)
 * 3. 同一 task 的多次 update 共享 messageId（不刷屏）
 * 4. task:after.complete → 调用 notifier.finishTask (patch + unpin)
 *
 * 关键设计：每个测试用一个新的 Notifier 实例 + 直接覆盖实例方法
 * （避免 prototype mocks 在 bun --parallel 下的跨 test 污染）
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { LarkCliTaskNotifyHook, NotifyType } from "./lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskCompleteResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Test helpers
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 42,
    title: "测试任务",
    description: "测试描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    ...overrides,
  };
}

function makeReplyChannel(overrides: Partial<any> = {}): any {
  return {
    chatId: "oc_chat123",
    messageId: "om_msg456",
    ...overrides,
  };
}

function makeEnvContext(overrides: Partial<EnvContext> = {}): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test-1",
    userId: "ou_test",
    replyChannel: makeReplyChannel(),
    pluginEnabled: { "es-test-1:LarkCliTaskNotifyHook": true },
    ...overrides,
  } as EnvContext;
}

function makeHookContext<T>(
  hookPoint: string,
  data: T
): HookContext<T> {
  return {
    component: { name: "task", version: "1.0.0" },
    data,
    metadata: {},
    phase: "after",
    hookPoint,
  };
}

/**
 * 创建一个带 mock 方法的 LarkCardPatchNotifier 实例
 * 直接覆盖实例方法（不污染 prototype）
 */
function makeMockNotifier() {
  const notifier = new LarkCardPatchNotifier();
  // 直接覆盖实例方法（不是 prototype）
  (notifier as any).startTask = mock(async () => ({ messageId: "om_card_test" }));
  (notifier as any).updateTask = mock(async () => {});
  (notifier as any).finishTask = mock(async () => {});
  return notifier;
}

// ============================================================================
// Tests
// ============================================================================

describe("LarkCliTaskNotifyHook - card notifier integration", () => {
  let notifier: LarkCardPatchNotifier;

  beforeEach(() => {
    notifier = makeMockNotifier();
  });

  afterEach(() => {
    // 不需要 restore — 每个测试创建新实例
  });

  it("should call notifier.startTask on task:after.create (NEW card-mode behavior)", async () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({ id: 42 });
    const resultCtx = { task } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(hookCtx);
    });

    await new Promise((r) => setTimeout(r, 10));

    expect((notifier as any).startTask).toHaveBeenCalled();
    const call = ((notifier as any).startTask as any).mock.calls[0][0];
    expect(call.chatId).toBe("oc_chat123");
    expect(call.meta.title).toBe("测试任务");
  });

  it("should call notifier.updateTask on task:after.update and reuse messageId (no spam)", async () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({ id: 42, status: "active" });
    const changes = { status: "active" };

    // 模拟 task create 已经发过卡片
    await runWithEnvContext(makeEnvContext(), async () => {
      const innerCtx = { task, changes } as unknown as TaskUpdateResultContext;
      const hookCtx = makeHookContext(TaskHookPoints.AFTER_UPDATE, innerCtx);
      await hook.execute(hookCtx);
    });

    // 第一次 update：notifier 应该被调一次
    expect((notifier as any).updateTask).toHaveBeenCalledTimes(1);

    // 第二次 update：仍然只 patch，不发新消息
    await runWithEnvContext(makeEnvContext(), async () => {
      const innerCtx = { task: makeTask({ id: 42, progress: 75 }), changes: { progress: 75 } } as unknown as TaskUpdateResultContext;
      const hookCtx = makeHookContext(TaskHookPoints.AFTER_UPDATE, innerCtx);
      await hook.execute(hookCtx);
    });

    expect((notifier as any).updateTask).toHaveBeenCalledTimes(2);

    // 关键：两次都用了同一个 messageId（om_card_test），没有 spawn 新消息
    const call1 = ((notifier as any).updateTask as any).mock.calls[0][0];
    const call2 = ((notifier as any).updateTask as any).mock.calls[1][0];
    expect(call1.messageId).toBe("om_card_test");
    expect(call2.messageId).toBe("om_card_test");
  });

  it("should call notifier.finishTask on task:after.complete", async () => {
    // 1) 先 simulate AFTER_CREATE 已发送卡片：直接给 hook 注入 messageId
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    // 模拟 create 时调了 startTask，缓存了 messageId
    (hook as any).cardMessageIds.set(42, "om_card_test");

    const task = makeTask({ id: 42, status: "completed" });
    const innerCtx = { task } as unknown as TaskCompleteResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_COMPLETE, innerCtx);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(hookCtx);
    });

    await new Promise((r) => setTimeout(r, 10));

    expect((notifier as any).finishTask).toHaveBeenCalled();
  });

  it("should fallback to silent skip when cardMode is false (Task #4196: legacy opt-out)", async () => {
    // Task #4196: cardMode=false → 静默 skip（不调 sendLarkMessage 也不发 text）
    // 旧行为：fallback 到 sendLarkMessage
    // 新行为：sendNotify 已删除，cardMode=false 等于"完全不通知"
    const hook = new LarkCliTaskNotifyHook({
      cardMode: false,
    });

    // mock sendLarkMessage 不应被调（Task #4196 干掉 sendNotify）
    const original = (LarkCliTaskNotifyHook.prototype as any).sendLarkMessage;
    const sendLarkSpy = mock(async () => {});
    (LarkCliTaskNotifyHook.prototype as any).sendLarkMessage = sendLarkSpy;

    try {
      const task = makeTask({ id: 42 });
      const resultCtx = { task } as unknown as TaskCreateResultContext;
      const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

      await runWithEnvContext(makeEnvContext(), async () => {
        await hook.execute(hookCtx);
      });

      await new Promise((r) => setTimeout(r, 10));

      // Task #4196: cardMode=false → 静默 skip（不调 sendLarkMessage）
      expect(sendLarkSpy).not.toHaveBeenCalled();
      // notifier 也不应被调（cardNotifier 是 undefined）
      expect((notifier as any).startTask).not.toHaveBeenCalled();
    } finally {
      (LarkCliTaskNotifyHook.prototype as any).sendLarkMessage = original;
    }
  });

  it("should NOT retry startTask on subsequent updates when previous start failed (sentinel)", async () => {
    // 替换实例方法为抛出版本，捕获引用以便后续 verify
    const startTaskSpy = mock(async () => {
      throw new Error("first call failed");
    });
    (notifier as any).startTask = startTaskSpy;
    (notifier as any).updateTask = mock(async () => {});

    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({ id: 99, status: "active" });

    // 1) 第一次 update（应该有 startTask fallback，因为没有 messageId）
    await runWithEnvContext(makeEnvContext(), async () => {
      const innerCtx = { task, changes: { status: "active" } } as unknown as TaskUpdateResultContext;
      const hookCtx = makeHookContext(TaskHookPoints.AFTER_UPDATE, innerCtx);
      await hook.execute(hookCtx);
    });

    expect(startTaskSpy.mock.calls.length).toBe(1); // 第一次 fallback 调一次

    // 2) 第二次 update → sentinel 命中，不重试 startTask
    await runWithEnvContext(makeEnvContext(), async () => {
      const innerCtx = { task: makeTask({ id: 99, progress: 75 }), changes: { progress: 75 } } as unknown as TaskUpdateResultContext;
      const hookCtx = makeHookContext(TaskHookPoints.AFTER_UPDATE, innerCtx);
      await hook.execute(hookCtx);
    });

    // startTask 只被调一次（第一次 update 的 fallback），第二次不再重试
    expect(startTaskSpy.mock.calls.length).toBe(1);
  });
});

// ============================================================================
// Task #4196: 默认卡片模式 + 干掉 sendNotify 旧逻辑（RED → GREEN → REFACTOR）
// ============================================================================

describe("LarkCliTaskNotifyHook - Task #4196: 默认卡片模式 + 干掉 sendNotify 旧逻辑", () => {
  it("RED: default cardMode should be true (not require explicit true opt-in)", () => {
    // 不传 cardMode → 期望默认值生效为 true（卡路径启用）
    const hook = new LarkCliTaskNotifyHook({});
    expect((hook as any).config.cardMode).not.toBe(false);
    // 内部应自动创建 cardNotifier
    expect((hook as any).cardNotifier).toBeDefined();
  });

  it("RED: cardMode=false should explicitly opt-out (legacy config)", () => {
    // 显式 false 才禁用卡片模式
    const hook = new LarkCliTaskNotifyHook({ cardMode: false });
    expect((hook as any).config.cardMode).toBe(false);
    expect((hook as any).cardNotifier).toBeUndefined();
  });

  it("RED: execute with default config should call notifier.startTask (no opt-in required)", async () => {
    // 不传 cardMode，不传 cardNotifier → 默认走卡片路径
    const internalNotifier = makeMockNotifier();
    const hook = new LarkCliTaskNotifyHook({});
    // 用 spy 替换内部自动 new 的 notifier 实例
    (hook as any).cardNotifier = internalNotifier;

    const task = makeTask({ id: 77 });
    const resultCtx = { task } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    expect((internalNotifier as any).startTask).toHaveBeenCalled();
  });

  it("RED: sendNotify function should be removed (no old text message path)", () => {
    // 干掉 sendNotify 后，class 上不应再有这个方法
    const hook = new LarkCliTaskNotifyHook({});
    expect(typeof (hook as any).sendNotify).toBe("undefined");
  });

  it("RED: OPERATION_CREATED should also route through cardNotifier (no sendNotify fallback)", async () => {
    // sendNotify 被干掉后，operation 也走卡片 patch（startTask 一次，后续 updateTask）
    const internalNotifier = makeMockNotifier();
    const hook = new LarkCliTaskNotifyHook({});
    (hook as any).cardNotifier = internalNotifier;

    const task = makeTask({ id: 88 });
    // 1) 先发 create → 缓存 messageId
    await runWithEnvContext(makeEnvContext(), async () => {
      const innerCtx = { task } as unknown as TaskCreateResultContext;
      const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, innerCtx);
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    // 2) operation 来了 → 应该 updateTask 同一卡片，不发新 text
    const opCtx = {
      operation: { id: 1001, type: "test", description: "测试操作", taskId: 88 },
    } as any;
    const opHookCtx = {
      component: { name: "task", version: "1.0.0" },
      data: opCtx,
      metadata: {},
      phase: "after",
      hookPoint: "task:operation:after.create",
    } as HookContext<any>;

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(opHookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    // operation 来了应该走 updateTask（卡片 patch 同一 messageId）
    expect((internalNotifier as any).updateTask).toHaveBeenCalled();
  });
});

// ============================================================================
// Task #4220: 修复 1 + 修复 2（路由优先级 + pins 用 user 群）
// ============================================================================

describe("LarkCliTaskNotifyHook - Task #4220: 路由优先级修复（replyChannel 优先）", () => {
  let notifier: LarkCardPatchNotifier;

  beforeEach(() => {
    notifier = makeMockNotifier();
  });

  /**
   * Task #4220 修复 1: 路由问题
   *
   * 当前 bug：cardNotifier 默认把卡片发到 task.context.larkPerTaskChatId（per-task 群），
   * 但 user 在原始 laya-mlx 群看不到卡片。
   *
   * 修复后优先级：
   * 1. envContext.replyChannel.chatId（user 触发的群）← 最高优先级
   * 2. task.context.larkPerTaskChatId（per-task 群）← fallback
   * 3. undefined → 静默 skip
   */

  it("RED: when both replyChannel.chatId and larkPerTaskChatId are present, should use replyChannel.chatId", async () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({
      id: 42,
      context: JSON.stringify({ larkPerTaskChatId: "oc_per_task_group" }),
    });

    const envCtx = makeEnvContext({
      replyChannel: {
        chatId: "oc_user_group", // user 实际所在群
        messageId: "om_user_msg",
      } as any,
    });

    const resultCtx = { task } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

    await runWithEnvContext(envCtx, async () => {
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    // 期望：startTask 被调，chatId 是 replyChannel.chatId（user 群），不是 per-task 群
    expect((notifier as any).startTask).toHaveBeenCalled();
    const call = ((notifier as any).startTask as any).mock.calls[0][0];
    expect(call.chatId).toBe("oc_user_group");
    expect(call.chatId).not.toBe("oc_per_task_group");
  });

  it("RED: when only larkPerTaskChatId is present (no replyChannel), should fall back to larkPerTaskChatId", async () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({
      id: 42,
      context: JSON.stringify({ larkPerTaskChatId: "oc_per_task_group" }),
    });

    const envCtx = makeEnvContext({
      replyChannel: undefined as any, // 没有 replyChannel
    });

    const resultCtx = { task } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

    await runWithEnvContext(envCtx, async () => {
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    // 期望：fallback 到 larkPerTaskChatId
    expect((notifier as any).startTask).toHaveBeenCalled();
    const call = ((notifier as any).startTask as any).mock.calls[0][0];
    expect(call.chatId).toBe("oc_per_task_group");
  });

  it("RED: when neither replyChannel.chatId nor larkPerTaskChatId, should skip silently (no crash)", async () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({ id: 42, context: "{}" });
    const envCtx = makeEnvContext({
      replyChannel: undefined as any,
    });

    const resultCtx = { task } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

    await runWithEnvContext(envCtx, async () => {
      // 不应 throw
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    // 期望：startTask 没被调（静默 skip）
    expect((notifier as any).startTask).not.toHaveBeenCalled();
  });

  it("RED: profile priority should also be replyChannel.profile > task.context.larkPerTaskChatProfile", async () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });

    const task = makeTask({
      id: 42,
      context: JSON.stringify({
        larkPerTaskChatId: "oc_per_task_group",
        larkPerTaskChatProfile: "task-profile",
      }),
    });

    const envCtx = makeEnvContext({
      replyChannel: {
        chatId: "oc_user_group",
        profile: "user-profile",
      } as any,
    });

    const resultCtx = { task } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);

    await runWithEnvContext(envCtx, async () => {
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 10));

    // 期望：startTask 用 user-profile（replyChannel 优先）
    expect((notifier as any).startTask).toHaveBeenCalled();
    const call = ((notifier as any).startTask as any).mock.calls[0][0];
    expect(call.profile).toBe("user-profile");
    expect(call.profile).not.toBe("task-profile");
  });
});
describe("Task #5599: task hook 复用 wiring 发的 session 卡（共享 notifier）", () => {
  it("RED: task:after.create with ctx sessionId should patch wiring's card (no duplicate send)", async () => {
    const notifier = new LarkCardPatchNotifier();
    // 记录 send 调用
    let sendCount = 0;
    const sendTitles: string[] = [];
    (notifier as any).runLarkCli = mock(async (argv: string[], op: string) => {
      const joined = Array.isArray(argv) ? argv.join(" ") : String(argv);
      if (joined.includes("+messages-send")) {
        sendCount++;
        const m = joined.match(/content[":]+([^"]{0,60})/);
        sendTitles.push(m ? m[1] : joined.slice(0, 80));
      }
      return JSON.stringify({ data: { message_id: "om_wiring_" + sendCount } });
    });

    // 1) wiring 发首卡（session 生命周期事件）
    await notifier.upsertSessionCard({
      chatId: "oc_chat123",
      sessionId: "session_shared",
      lifecycle: "running",
    });
    expect(sendCount).toBe(1);

    // 2) task hook 事件（同 session）→ 应 patch 而不是再发
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    });
    const task = makeTask({ id: 77, sessionId: "session_shared" });
    const resultCtx = { task, sessionId: "session_shared" } as unknown as TaskCreateResultContext;
    const hookCtx = makeHookContext(TaskHookPoints.AFTER_CREATE, resultCtx);
    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(hookCtx);
    });
    await new Promise((r) => setTimeout(r, 20));

    // ★ Task #5599：task hook 允许发 task 卡（两卡并存），但**绝不允许再发 session 卡**
    const sessionCardSends = sendTitles.filter((t) => t.includes("会话卡实时更新"));
    const taskCardSends = sendTitles.filter((t) => t.includes("任务卡实时更新"));
    expect(sessionCardSends.length).toBe(1); // 只有 wiring 那张
    expect(taskCardSends.length).toBe(1); // 并存模式：task 卡允许
    // task hook 的 patch 命中 wiring 卡（upsert created=false）→ 不新增 session 卡 send
    expect(sendCount).toBe(2);
  });
});
