/**
 * @fileoverview Task #5364 —— 企微「单卡 + 按钮驱动更新」**真接线**测试
 *
 * ## 为什么这个文件必须存在（前几轮反复翻车的地方）
 *
 * #5360 的教训（CV R2/R3/R4/R5 连续判不合格）：**逻辑全实现了、单测全绿，
 * 但生产路径到不了**。
 *
 * 本轮 B 方案有两个接线命门，都在「两个模块之间」：
 *
 * 1. **sender 与刷新端口必须共享同一个 store**
 *    - sender（`event-handler-wiring.ts`）写 lifecycle
 *    - 刷新（`wecom-cli-handler.ts` 的 `loadSessionCardState`）读 lifecycle
 *    - 若各建一个实例 ⇒ writer 写 A、reader 读 B ⇒ 卡片永远「运行中」
 *      （而且 `get()` 恒 undefined ⇒ sender 以为没发过卡 ⇒ **重发第二张卡**，
 *      同时违背 B 方案的两条要求）
 *
 * 2. **`WecomCliInstance` 真的把 store 接上**（不是只有字段）
 *    - `wireCardActionPorts()` 里必须 `this.sessionCardStore ??= getShared...()`
 *    - 端口上必须真的挂 `loadSessionCardState` + `updateSessionCard`
 *
 * 所以本文件断言的**不是纯函数**，而是：
 *
 * ```
 * lifecycle 事件 → sender → store
 *                              ↓（同一个实例）
 * 用户点刷新 → loadSessionCardState → aibot_respond_update_msg 帧（含最新状态）
 * ```
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WECOM_CLI_ES_TYPE,
  wecomCliHandler,
} from "./wecom-cli-handler";
import {
  __resetWecomRespondRegistryForTest,
  registerWecomRespondTarget,
} from "./wecom-respond-registry";
import {
  WecomCardActionKey,
  wecomCardTaskIdForSession,
} from "./wecom-card-builder";
import { createWecomSessionCardSender } from "./wecom-session-card-sender";
import {
  getSharedWecomSessionCardStore,
  __resetSharedWecomSessionCardStoreForTest,
} from "../task/plugins/wecom-session-card-store";
import type { EventSourceConfig } from "./types";

const SESSION_ID = "session_wire_04357c17";
const REQ_ID = "REQ-WIRE-1";

const tmpDir = mkdtempSync(join(tmpdir(), "wecom-single-card-wire-"));
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  __resetWecomRespondRegistryForTest();
  __resetSharedWecomSessionCardStoreForTest();
  // 用独立 db 文件而不是内存：验证「同一路径 ⇒ 同一数据」这条真实语义
  process.env.ROY_AGENT_WECOM_SESSION_CARD_DB = join(
    tmpDir,
    `s-${Math.random().toString(36).slice(2)}.db`,
  );
});

function makeWsConfig(): EventSourceConfig {
  return {
    id: "es-wecom-single-card",
    name: "wecom-single-card",
    type: WECOM_CLI_ES_TYPE,
    botId: "B1",
    secret: "S1",
    handleRule: { plugins: [] },
  } as EventSourceConfig;
}

function sessionRefreshFrame() {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: REQ_ID },
    body: {
      msgid: "MSG-1",
      chattype: "single",
      from: { userid: "DongZhaoKun" },
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          card_type: "button_interaction",
          event_key: WecomCardActionKey.REFRESH_ACTIVITY,
          task_id: wecomCardTaskIdForSession(SESSION_ID),
        },
      },
    },
  };
}

/** 造一条生命周期事件（企微单聊） */
function lifecycleEvent(lifecycle: string) {
  return {
    id: `evt-${lifecycle}`,
    type: "task.background.session_started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_wire",
      subSessionId: SESSION_ID,
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      subagentType: "roy",
      lifecycle,
      startedAt: Date.now() - 40 * 60 * 1000,
      associatedTaskId: 5364,
    },
    metadata: {
      source: "task.background",
      sourceId: "es-wecom-single-card",
      replyChannel: {
        type: "wecom-cli",
        chatId: "DongZhaoKun",
        params: { chatType: "single", sourceId: "es-wecom-single-card" },
      },
    },
  } as never;
}

/**
 * 让 instance 拿到一个可用的 wsBridge（只用来捕获 sendFrameWithReqId）。
 *
 * 不 mock 整个 bridge：只替 `sendFrameWithReqId`，其余字段保持 undefined
 * —— 与生产里「bridge 还没有」的降级路径一致，避免测试掩盖问题。
 */
function attachBridge(inst: unknown): Array<{ reqId: string; body: any }> {
  const captured: Array<{ reqId: string; body: any }> = [];
  (inst as { wsBridge?: unknown }).wsBridge = {
    sendFrameWithReqId: (frame: {
      cmd: string;
      headers: { req_id: string };
      body: Record<string, unknown>;
    }) => {
      captured.push({ reqId: frame.headers.req_id, body: frame.body });
      return undefined;
    },
  };
  return captured;
}

// ============================================================================
// A. 命门 1：sender 与刷新端口共享同一 store
// ============================================================================

describe("★ 命门 1：共享 store（sender 写 / 刷新读）", () => {
  test("sender 走 core 共享单例 ⇒ 写进去的 lifecycle 能被刷新端口读到", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    attachBridge(inst);
    // 模拟 start() 的默认 cross-wire（注入 store + 端口）
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    expect(
      (inst as unknown as { hasSessionCardStore: () => boolean }).hasSessionCardStore(),
    ).toBe(true);

    // 用**同一个**共享 store 造 sender（生产 wiring 里的做法）
    const store = getSharedWecomSessionCardStore();
    const sends: any[] = [];
    const send = createWecomSessionCardSender({
      store,
      sendCard: async (i) => {
        sends.push(i);
        return { ok: true };
      },
    });

    await send(lifecycleEvent("running"));
    await send(lifecycleEvent("completed"));

    // 只发一张卡（B 方案）
    expect(sends).toHaveLength(1);
    // 刷新端口读得到最新状态（不是「运行中」）
    const got = store.get(SESSION_ID);
    expect(got?.lifecycle).toBe("completed");
  });

  test("★ 若 sender 用**另一个** store（模拟接线错误）⇒ 刷新读不到（变异验证）", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    attachBridge(inst);
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    // 故意用独立 store（错误接线）
    const { createMemoryWecomSessionCardStore } = await import(
      "../task/plugins/wecom-session-card-store"
    );
    const wrongStore = createMemoryWecomSessionCardStore();
    const send = createWecomSessionCardSender({
      store: wrongStore,
      sendCard: async () => ({ ok: true }),
    });
    await send(lifecycleEvent("completed"));

    // 共享 store（刷新真正读的那个）里没有记录 ⇒ 卡片永远显示旧状态
    expect(getSharedWecomSessionCardStore().get(SESSION_ID)).toBeUndefined();
  });
});

// ============================================================================
// B. 命门 2：点刷新 → 真的发出 update 帧（含最新 lifecycle）
// ============================================================================

describe("★ 命门 2：刷新真的发出 aibot_respond_update_msg", () => {
  test("生命周期推进后点刷新 → 帧里是「已完成」+ 操作记录 + task_id 原样回填", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const captured = attachBridge(inst);
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    // 1) 生命周期事件写进共享 store（sender 侧）
    const store = getSharedWecomSessionCardStore();
    const send = createWecomSessionCardSender({
      store,
      sendCard: async () => ({ ok: true }),
    });
    await send(lifecycleEvent("running"));
    await send(lifecycleEvent("completed"));

    // 2) 用户点「刷新」（生产路径：handleWsFrame → handleCardActionEvent）
    await (
      inst as unknown as { handleWsFrame: (f: unknown) => Promise<void> }
    ).handleWsFrame(sessionRefreshFrame());

    // 3) 真的发出了 update 帧
    const update = captured.find(
      (c) => c.body?.response_type === "update_template_card",
    );
    expect(update).toBeDefined();
    expect(update!.reqId).toBe(REQ_ID);

    const tc = update!.body.template_card;
    // 协议：task_id 必须原样回填
    expect(tc.task_id).toBe(wecomCardTaskIdForSession(SESSION_ID));
    // B 方案：最新生命周期体现在卡片上（不是「运行中」）
    expect(tc.main_title.title).toContain("已完成");
    const rows = tc.horizontal_content_list as Array<{
      keyname: string;
      value: string;
    }>;
    const values = rows.map((r) => `${r.keyname}:${r.value}`).join("|");
    expect(values).toContain("已完成"); // 生命周期里程碑
    expect(values).toContain("5364"); // 任务号（信息不丢）
  });

  test("★ 变验证：删掉 wireCardActionPorts 里的 store 注入 ⇒ 刷新不发帧", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const captured = attachBridge(inst);
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    // 人为抹掉（模拟「忘了注入 store」的接线缺陷）
    (inst as unknown as { sessionCardStore?: unknown }).sessionCardStore = undefined;
    const ports = (inst as unknown as { cardActionPorts?: Record<string, unknown> })
      .cardActionPorts;
    if (ports) {
      delete ports.loadSessionCardState;
      delete ports.updateSessionCard;
    }

    const store = getSharedWecomSessionCardStore();
    const send = createWecomSessionCardSender({
      store,
      sendCard: async () => ({ ok: true }),
    });
    await send(lifecycleEvent("running"));

    await (
      inst as unknown as { handleWsFrame: (f: unknown) => Promise<void> }
    ).handleWsFrame(sessionRefreshFrame());

    // 没有 updateSessionCard 端口 ⇒ 走降级 updateCard 路径，
    // 而测试里的 cardActionPorts.updateCard 会经 bridge.respond... 未注册 ⇒
    // 结果：**没有** update_template_card 帧带完整快照（只有空的降级帧或无帧）
    const fullSnapshot = captured.filter((c) => {
      const tc = c.body?.template_card as
        | { horizontal_content_list?: Array<{ keyname: string }> }
        | undefined;
      return tc?.horizontal_content_list?.some((r) => r.keyname === "会话");
    });
    expect(fullSnapshot).toHaveLength(0);
  });

  test("★ 无记录（重启后 store 空）→ 仍有反馈帧（降级，不静默）", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const captured = attachBridge(inst);
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    // store 里没有该 session（模拟重启后）
    await (
      inst as unknown as { handleWsFrame: (f: unknown) => Promise<void> }
    ).handleWsFrame(sessionRefreshFrame());

    // 仍应发出一个 update 帧（哪怕只有活性/占位）
    const update = captured.find(
      (c) => c.body?.response_type === "update_template_card",
    );
    expect(update).toBeDefined();
    expect(update!.reqId).toBe(REQ_ID);
  });
});
// ============================================================================
// C. Task #5418：task 卡刷新回退的反查端口（多命中取最新）
// ============================================================================

describe("★ Task #5418：findSessionCardByTaskId 反查", () => {
  test("同一 task 多条 session 卡 → 取未终结/最新的一条（不是最早的）", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    attachBridge(inst);
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    const store = getSharedWecomSessionCardStore();
    // 旧会话（已终结，早创建）
    store.upsert({
      sessionId: "session_old_5418",
      chatId: "wo26OgBgAA",
      chatType: "single",
      cardTaskId: "roy-session-session_old_5418",
      lifecycle: "completed",
      associatedTaskId: 5418,
      createdAt: 1000,
      updatedAt: 2000,
      closedAt: 2000,
    });
    // 新会话（未终结，晚创建）
    store.upsert({
      sessionId: "session_new_5418",
      chatId: "wo26OgBgAA",
      chatType: "single",
      cardTaskId: "roy-session-session_new_5418",
      lifecycle: "running",
      associatedTaskId: 5418,
      createdAt: 3000,
      updatedAt: 4000,
    });

    const ports = (
      inst as unknown as {
        cardActionPorts: {
          findSessionCardByTaskId?: (t: number) => unknown;
        };
      }
    ).cardActionPorts;
    expect(typeof ports.findSessionCardByTaskId).toBe("function");

    const hit = ports.findSessionCardByTaskId!(5418) as {
      sessionId: string;
    };
    // 必须是未终结的最新会话，不是 created_at ASC 的第一条（旧的）
    expect(hit.sessionId).toBe("session_new_5418");
  });

  test("无关联记录 → undefined（诚实降级）", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    attachBridge(inst);
    (
      inst as unknown as { wireCardActionPorts: () => void }
    ).wireCardActionPorts();

    const ports = (
      inst as unknown as {
        cardActionPorts: {
          findSessionCardByTaskId?: (t: number) => unknown;
        };
      }
    ).cardActionPorts;

    expect(ports.findSessionCardByTaskId!(999999)).toBeUndefined();
  });
});
