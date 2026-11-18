/**
 * Task #5390（追加需求）— 「有 task 的 sub-session，task 信息要同步到 session 卡」
 *
 * ## 用户实测（14:05）
 * 「希望如果 subsession 有任务，那么任务的这些信息也需要自动同步到 sub session
 *   卡片中哈，现在好像展示的不是这些东西呢」
 *
 * 截图里的卡只有「执行动态（3 里程碑 / 3 操作记录）」，缺「📄 会话详情」
 * 「📄 任务信息」「⚡ 子会话活性」。
 *
 * ## 已核实：截图那张是 **task 卡**，不是 session 卡
 * - `om_x100b60615b7ac4a0b4b267221483889`（task 5390）在 `lark_card` 里
 *   `session_id = null`，且**不在** `lark_session_card`
 * - 它的 timeline 顶层是 `{meta, milestones, processSteps, progress, ...}`
 *   = **task 卡状态**形状（session 卡状态是 `SessionCardState`）
 * - 标题 `⏱️ 执行动态（N 里程碑 / M 操作记录）` 只由 `buildTimelinePanelTitle`
 *   产出，而它**只被 `buildTaskCard` / workflow 卡调用**；session 卡用的是
 *   硬编码 `📌 执行动态（N）`
 *
 * ## 根因（file:line）
 * `task-component.ts:createTask` 手里的 `sessionId` 是**准的**（来自 tool ctx），
 * 并塞进了 hook context `TaskCreateResultContext.sessionId`（contexts.ts:70）。
 *
 * 但 `lark-cli-task-notify-plugin.ts:onAfterCreate` **只解构 `task`**，然后靠
 * `resolveSessionIdForTask(task.id)` 反查 —— 该函数的三级来源全落空：
 *   1. `cardNotifier.getSessionIdByTask()` —— 内存索引，首卡还没发过 ⇒ 空
 *   2. `cardStateStore.get(taskId).sessionId` —— 持久层，还没写过 ⇒ 空
 *   3. `EnvContext.sessionId` —— hook 执行时的 env 上下文，不是 tool ctx ⇒ 空
 *
 * ⇒ `sessionId` undefined ⇒ `patchSessionCardForTask` 被跳过 ⇒ 回落到
 * `sendCard` 发一张**纯 task 卡**（没有会话详情 / 任务信息 / 活性三个区块）。
 *
 * ## 修法
 * 优先直接用 hook context 里现成的 `ctx.data.sessionId`（权威、同步可得），
 * 反查只作兜底。这是「1 行取值顺序」修复，不动 #5364 的单卡语义。
 */
import { describe, test, expect } from "bun:test";
import {
  LarkCliTaskNotifyHook,
  type TaskNotifyConfig,
} from "./lark-cli-task-notify-plugin";
import type { CardPayload, LarkCardPatchNotifier } from "./lark-card-patch-notifier";

/** 记录所有 upsertSessionCard / sendCard 调用 */
interface Recorder {
  upsert: Array<Record<string, unknown>>;
  taskCardSends: number;
}

function makeNotifier(rec: Recorder): LarkCardPatchNotifier {
  return {
    upsertSessionCard: async (opts: Record<string, unknown>) => {
      rec.upsert.push(opts);
      return { messageId: "om_session_card" } as never;
    },
    // 反查索引：故意返回 undefined —— 模拟「首卡还没发过」的真实首触发时刻
    getSessionIdByTask: () => undefined,
    // 回落发纯 task 卡时用的入口（startCardAndPin → startTask）
    startTask: async () => {
      rec.taskCardSends++;
      return { messageId: "om_task_card" } as never;
    },
    bindTaskToSession: () => {},
    getSessionCardMessageId: () => "om_session_card",
  } as unknown as LarkCardPatchNotifier;
}

function makePlugin(rec: Recorder, extra: Partial<TaskNotifyConfig> = {}) {
  const plugin = new LarkCliTaskNotifyHook({
    cardMode: true,
    cardNotifier: makeNotifier(rec),
    // 不传 cardStateStore ⇒ 持久层来源也落空，与生产首触发一致
    ...extra,
  } as TaskNotifyConfig);
  return plugin;
}

function makeTask() {
  return {
    id: 5390,
    title: "有 task 的 sub-session",
    status: "active",
    progress: 30,
    current_status: "进行中",
    createdAt: "2026-11-12T06:00:00.000Z",
    // ★ patchSessionCardForTask 需要 chatId，否则 `if (!chatId) return false`
    //   直接回落 task 卡（与本测试要断言的路径无关，属噪音）。
    context: JSON.stringify({ larkPerTaskChatId: "oc_test_chat" }),
  } as never;
}

describe("Task #5390 追加需求：task 信息同步进 session 卡", () => {
  test("★ 主路径：onAfterCreate 必须用 hook ctx 的 sessionId（写进 session 卡）", async () => {
    const rec: Recorder = { upsert: [], taskCardSends: 0 };
    const plugin = makePlugin(rec);

    await (
      plugin as unknown as {
        onAfterCreate: (ctx: unknown) => Promise<void>;
      }
    ).onAfterCreate({
      data: {
        task: makeTask(),
        // ★ 权威来源：createTask 手里就有的 sessionId
        sessionId: "session_from_hook_ctx",
      },
    });

    // 必须渲染进 session 卡（本任务的核心断言不变）
    expect(rec.upsert.length).toBe(1);
    expect(rec.upsert[0].sessionId).toBe("session_from_hook_ctx");
    // ★ Task #5580（2026-11-13 用户定稿）：**反转** #5364 的单卡语义 ——
    //   现在任务卡片与 session 卡片**并存**（任务卡片必须保留并 pin），
    //   所以这里 task 卡也应当被发出。回滚开关：`emitTaskCard: false`。
    expect(rec.taskCardSends).toBe(1);
  });

  test("task 信息随首卡一起带进 session 卡（不是只有里程碑）", async () => {
    const rec: Recorder = { upsert: [], taskCardSends: 0 };
    const plugin = makePlugin(rec);

    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: { task: makeTask(), sessionId: "session_abc" },
    });

    const opts = rec.upsert[0] as Record<string, any>;
    // 「📋 任务信息」区块的数据来源
    expect(opts.task).toBeDefined();
    expect(opts.task.id).toBe(5390);
    expect(opts.task.title).toBe("有 task 的 sub-session");
  });

  test("★ 验收标准4：session 卡必须渲染四区块，且不出现 task 卡的 ⏱️ 执行动态", async () => {
    // CV R1 MINOR-3：原来「四区块」只靠人工 E2E 口头确认，没有自动化锁。
    // 这里直接渲染 session 卡并断言区块标题。
    const { buildSessionCard } = await import("./lark-card-patch-notifier");
    const card: unknown = buildSessionCard({
      sessionId: "session_6954fe0e-0ad2-4e63-a08e-b8dcd216d836",
      title: "有 task 的 sub-session",
      agentType: "roy",
      startedAt: "2026-11-12T06:00:00.000Z",
      milestones: [{ title: "Task 创建" }],
      task: {
        id: 5390,
        title: "有 task 的 sub-session",
        status: "active",
        progress: 30,
        currentStatus: "进行中",
        priority: "high",
      },
      activity: null,
    } as never);
    const json = JSON.stringify(card);

    for (const panel of ["📋 会话详情", "📋 任务信息", "⚡ 子会话活性", "📌 执行动态"]) {
      expect(json).toContain(panel);
    }
    // task 卡的标题格式不得出现在 session 卡上（说明没降级）
    expect(json).not.toContain("⏱️ 执行动态");
    // 「任务信息」必须有真实内容，不是空壳
    expect(json).toContain("任务 ID");
    expect(json).toContain("#5390");
  });

  test("★ CV MINOR-1：messageId 取不到时也要绑内存索引（否则 update 会漂回 task 卡）", async () => {
    // 真实触发点：recordSessionCardForTask 里 `if (!messageId) return;`。
    // upsert 没回 messageId、getSessionCardMessageId 也查不到时（持久层抖动 /
    // 竞态窗口），修复前 bindTaskToSession 会被一起跳过 ⇒ 本进程后续
    // update/complete 反查落空 ⇒ 又漂回纯 task 卡。
    const rec: Recorder = { upsert: [], taskCardSends: 0 };
    const bound: Array<{ taskId: number; sessionId: string }> = [];
    const notifier = {
      upsertSessionCard: async () => ({}) as never, // 故意不回 messageId
      getSessionIdByTask: () => undefined,
      getSessionCardMessageId: () => undefined, // 索引也查不到
      startTask: async () => ({ messageId: "om_task_card" }) as never,
      bindTaskToSession: (taskId: number, sessionId: string) => {
        bound.push({ taskId, sessionId });
      },
    } as unknown as LarkCardPatchNotifier;

    const plugin = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    } as TaskNotifyConfig);

    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: { task: makeTask(), sessionId: "session_bind_me" },
    });

    // messageId 拿不到，但内存绑定不能跟着丢
    expect(bound).toEqual([{ taskId: 5390, sessionId: "session_bind_me" }]);
  });

  test("sessionId 缺失时才走反查兜底（不破坏原语义）", async () => {
    const rec: Recorder = { upsert: [], taskCardSends: 0 };
    const plugin = makePlugin(rec);

    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: { task: makeTask() }, // 没有 sessionId
    });

    // 反查也空 ⇒ 只能回落 task 卡（保持原行为，不算回归）
    expect(rec.upsert.length).toBe(0);
    expect(rec.taskCardSends).toBe(1);
  });
});