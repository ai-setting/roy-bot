/**
 * @fileoverview Task #5580 —— **生产接线真实性**测试（防「测试绿了真机没接」）
 *
 * 与 `lark-session-task-list-5580.test.ts`（渲染/action 单测）互补：
 * 那个文件证明「函数实现了」，本文件证明「生产装配点真的用上了它」——
 * 这是 #5364 那轮「55 条测试全绿、真机一跑全崩」的教训。
 *
 * 两条断言：
 * A. session 生命周期首卡真的带上「🗂️ 任务列表」（经真实 `sessionCardSender`）
 * B. `wireCardActionPorts` 真的注入了 `loadSessionTasks` / `loadTaskMilestones`
 *    （静态断言源码，防「又忘了接」）
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getSharedLarkCardNotifier,
  __resetSharedLarkCardNotifierForTest,
} from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-patch-notifier";
import { __resetSharedLarkSessionCardStoreForTest } from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-state-store";
import {
  createEventHandlerForInteractive,
  resetEventStoreCacheForTest,
} from "./event-handler-wiring";
import { EventMessageFormatter } from "./event-message-formatter";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

const SESSION = "session_wiring_5580";
const CHAT = "oc_wiring_5580";

const tmpDir = mkdtempSync(join(tmpdir(), "wiring5580-"));
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  resetEventStoreCacheForTest();
  __resetSharedLarkCardNotifierForTest();
  // ★ Task #5591：notifier 构造即回灌 session store ⇒ 共享内存
  //   store 一并重置（前用例落库的卡会让"默认应发新卡"场景静默命中旧卡）。
  __resetSharedLarkSessionCardStoreForTest();
});

function sessionEvent(lifecycle: string): EnvEvent {
  return {
    id: `evt-5580-${lifecycle}`,
    type: "task.background.session_started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_5580",
      subSessionId: SESSION,
      parentSessionId: "parent-5580",
      description: "任务列表接线验证",
      subagentType: "roy",
      lifecycle,
    },
    metadata: {
      source: "task.background",
      replyChannel: { type: "lark-cli", chatId: CHAT, profile: "tongzhuli" },
    },
  } as unknown as EnvEvent;
}

/** 假 env：task 组件能按 session 反查出两个 task（最近优先由 updatedAt 决定） */
function makeEnvWithTasks(): any {
  const tasks: Record<number, any> = {
    101: {
      id: 101,
      title: "较早的任务",
      status: "completed",
      progress: 100,
      updated_at: "2026-11-13T08:00:00.000Z",
    },
    102: {
      id: 102,
      title: "较新的任务",
      status: "active",
      progress: 30,
      updated_at: "2026-11-13T10:00:00.000Z",
    },
  };
  return {
    getComponent: (name: string) => {
      if (name !== "task") return undefined;
      return {
        getTask: async (id: number) => tasks[id],
        updateTask: async () => ({}),
        getTaskIdsBySessionId: async () => [101, 102],
        listOperations: async ({ taskId }: { taskId: number }) => [
          {
            milestoneTitle: `任务${taskId} 创建`,
            timestamp: "2026-11-13T09:00:00.000Z",
          },
        ],
      };
    },
  };
}

describe("★ 生产接线：session 首卡真的带「🗂️ 任务列表」（Task #5580）", () => {
  test("★★ 生命周期事件 → 发出的卡片 JSON 含任务列表 + 两个切换按钮", async () => {
    const notifier = getSharedLarkCardNotifier();
    const sentCards: any[] = [];
    notifier.testRunner = async (argv, op) => {
      if (op === "send") {
        const contentIdx = argv.indexOf("--content");
        const raw =
          contentIdx >= 0
            ? argv[contentIdx + 1]
            : JSON.parse(argv[argv.indexOf("--data") + 1]).content;
        sentCards.push(JSON.parse(raw));
        return JSON.stringify({ ok: true, data: { message_id: "om_wire_5580" } });
      }
      return JSON.stringify({ ok: true });
    };

    const handler = createEventHandlerForInteractive({
      env: makeEnvWithTasks(),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv: async () => {},
      sessionComponent: {
        create: async () => undefined,
        get: async () => undefined,
        list: async () => [],
        getActiveSessionId: () => undefined,
        setActiveSession: () => {},
      } as any,
      isIdle: () => true,
      dbPath: join(tmpDir, "events.db"),
    } as any);

    await (
      handler as unknown as { handleEvent: (e: EnvEvent) => Promise<void> }
    ).handleEvent(sessionEvent("running"));

    // 等 fire-and-forget 的 sessionCardSender 落定
    for (let i = 0; i < 40 && sentCards.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sentCards.length).toBe(1);

    const card = sentCards[0];
    const flat = JSON.stringify(card);
    // 任务列表面板存在
    const listPanel = (card.body?.elements ?? []).find(
      (e: any) => e?.element_id === "session_task_list",
    );
    expect(listPanel).toBeDefined();
    expect(flat).toContain("#101");
    expect(flat).toContain("#102");
    // 两个切换按钮，且**最近优先**：102（10:00）排在 101（08:00）前面
    const btns = (listPanel.elements ?? []).filter(
      (e: any) => e?.tag === "button" && e?.value?.action === "select_task",
    );
    expect(btns.length).toBe(2);
    expect(btns[0].value.sessionId).toBe(SESSION);
    expect(String(btns[0].value.taskId)).toBe("102");
    expect(String(btns[1].value.taskId)).toBe("101");
  });
});

describe("★ 生产接线：wireCardActionPorts 注入新端口（静态源码断言）", () => {
  test("★★ event-source-handlers.ts 真的注入了 loadSessionTasks / loadTaskMilestones", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../../core/src/env/event-source/event-source-handlers.ts"),
      "utf8",
    );
    expect(src).toContain("loadSessionTasks:");
    expect(src).toContain("loadTaskMilestones:");
    expect(src).toContain("getTaskIdsBySessionId");
  });

  test("★★ event-handler-wiring.ts 首卡真的带 tasks", () => {
    const src = readFileSync(join(import.meta.dir, "event-handler-wiring.ts"), "utf8");
    expect(src).toContain("loadSessionTasksForCard");
    expect(src).toContain("tasks: sessionTasks");
  });
});

// ============================================================================
// ★ emitSessionCard 开关（Task #5580 续）：与 emitTaskCard 对称
// ============================================================================

import type { LarkCardPatchNotifier } from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-patch-notifier";

/**
 * 构造一个带 ES 配置的 env：
 * `handleRule.pluginConfig.LarkCliTaskNotifyPlugin.emitSessionCard = <v>`
 */
function makeEnvWithEmitSessionCard(emitSessionCard: unknown): any {
  return {
    getComponent: (name: string) => {
      if (name === "event-source") {
        return {
          list: () => [
            {
              id: "es_5580",
              type: "lark-cli",
              handleRule: {
                plugins: ["LarkCliTaskNotifyPlugin"],
                pluginConfig: {
                  LarkCliTaskNotifyPlugin: { emitSessionCard },
                },
              },
            },
          ],
        };
      }
      return undefined;
    },
  };
}

describe("★ emitSessionCard 开关（与 emitTaskCard 对称）", () => {
  test("★★ emitSessionCard: false → session 卡不发送（task 卡照常）", async () => {
    const notifier: LarkCardPatchNotifier & { testRunner?: any } =
      getSharedLarkCardNotifier() as any;
    const sentCards: any[] = [];
    notifier.testRunner = async (argv: string[], op: string) => {
      if (op === "send") {
        const i = argv.indexOf("--content");
        sentCards.push(JSON.parse(argv[i + 1]));
        return JSON.stringify({ ok: true, data: { message_id: "om_es_off" } });
      }
      return JSON.stringify({ ok: true });
    };

    const handler = createEventHandlerForInteractive({
      env: makeEnvWithEmitSessionCard(false),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv: async () => {},
      sessionComponent: {
        create: async () => undefined,
        get: async () => undefined,
        list: async () => [],
        getActiveSessionId: () => undefined,
        setActiveSession: () => {},
      } as any,
      isIdle: () => true,
      dbPath: join(tmpDir, "events-es-off.db"),
    } as any);

    await (
      handler as unknown as { handleEvent: (e: EnvEvent) => Promise<void> }
    ).handleEvent(sessionEvent("running"));
    for (let i = 0; i < 20 && sentCards.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sentCards.length).toBe(0);
  });

  test("★★ emitSessionCard 未配置（默认）→ session 卡照常发送", async () => {
    const notifier: LarkCardPatchNotifier & { testRunner?: any } =
      getSharedLarkCardNotifier() as any;
    const sentCards: any[] = [];
    notifier.testRunner = async (argv: string[], op: string) => {
      if (op === "send") {
        const i = argv.indexOf("--content");
        sentCards.push(JSON.parse(argv[i + 1]));
        return JSON.stringify({ ok: true, data: { message_id: "om_es_on" } });
      }
      return JSON.stringify({ ok: true });
    };

    const handler = createEventHandlerForInteractive({
      env: makeEnvWithEmitSessionCard(undefined),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv: async () => {},
      sessionComponent: {
        create: async () => undefined,
        get: async () => undefined,
        list: async () => [],
        getActiveSessionId: () => undefined,
        setActiveSession: () => {},
      } as any,
      isIdle: () => true,
      dbPath: join(tmpDir, "events-es-on.db"),
    } as any);

    await (
      handler as unknown as { handleEvent: (e: EnvEvent) => Promise<void> }
    ).handleEvent(sessionEvent("running"));
    for (let i = 0; i < 20 && sentCards.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sentCards.length).toBe(1);
  });
});
