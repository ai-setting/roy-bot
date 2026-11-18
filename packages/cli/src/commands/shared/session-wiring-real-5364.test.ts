/**
 * @fileoverview Task #5364 返工 —— **生产接线真实性**测试
 *
 * ## 这个文件与其它测试的区别
 *
 * 前一轮的失败教训写成了 t_w：「55 条测试全绿 + CV PASS，真机一跑全崩」。
 * 根因是**测试断言了「函数实现了」，没断言「生产路径真的用上了它」**：
 *
 * - `getSharedCardNotifier()` 返回 `undefined`（生产 env 没有那两个属性）
 * - `loadSessionActivity` / `resolveSessionIdByTask` 端口零注入
 * - 插件实例与 sessionCardSender 用两个不同 notifier
 *
 * 所以本文件的断言一律是「**生产装配点存在且接的就是这个单例**」：
 *
 * 1. `getSharedCardNotifier` 不依赖 env 属性 → 必返回单例
 * 2. `createEventHandlerForInteractive` 产出的 EventHandler 其 sessionCardSender
 *    用的是**同一个** notifier 单例（发卡后能在单例里查到 messageId）
 * 3. 两个装配点的源码里**确实有** `loadSessionActivity` / `resolveSessionIdByTask`
 *    （静态断言源码，防「又忘了接」—— 这是上一轮的原样翻车方式）
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getSharedLarkCardNotifier,
  __resetSharedLarkCardNotifierForTest,
} from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-patch-notifier";
import {
  createEventHandlerForInteractive,
  resetEventStoreCacheForTest,
} from "./event-handler-wiring";
import { EventMessageFormatter } from "./event-message-formatter";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

const SESSION = "session_wiring_5364";
const CHAT = "oc_wiring_5364";

const tmpDir = mkdtempSync(join(tmpdir(), "wiring5364-"));
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
});

function sessionEvent(lifecycle: string): EnvEvent {
  return {
    id: `evt-wire-${lifecycle}`,
    type: "task.background.session_started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_wire",
      subSessionId: SESSION,
      parentSessionId: "parent-wire",
      description: "接线性验证",
      subagentType: "roy",
      lifecycle,
    },
    metadata: {
      source: "task.background",
      replyChannel: { type: "lark-cli", chatId: CHAT, profile: "tongzhuli" },
    },
  } as unknown as EnvEvent;
}

// ============================================================================
// 1. 单例不依赖 env 属性（上一版 BLOCKER-4 的根因）
// ============================================================================

describe("★ BLOCKER-4 根因：notifier 单例不依赖 env 属性", () => {
  test("★★ env 上**没有任何**插件属性时，共享 notifier 依然拿得到（非 undefined）", () => {
    // 生产 Environment 的真实形状：既没有 getPluginInstance，
    // 也没有 _pluginInstances。上一版就是在这里落 undefined。
    const productionEnv = {
      getComponent: () => undefined,
      // 注意：故意不提供 getPluginInstance / _pluginInstances
    };

    expect(
      (productionEnv as Record<string, unknown>).getPluginInstance,
    ).toBeUndefined();
    expect(
      (productionEnv as Record<string, unknown>)._pluginInstances,
    ).toBeUndefined();

    // 单例不依赖它
    const a = getSharedLarkCardNotifier();
    expect(a).toBeDefined();
    expect(getSharedLarkCardNotifier()).toBe(a);
  });
});

// ============================================================================
// 2. wiring 产出的 sessionCardSender 用的是同一个单例
// ============================================================================

describe("★★ createEventHandlerForInteractive 的 sessionCardSender 真接线", () => {
  test("★★ 发 session 生命周期事件 → 卡发在**共享单例**里（可反查 messageId）", async () => {
    const notifier = getSharedLarkCardNotifier();

    // 挂 runner：既阻止真 spawn lark-cli，又记录真实 send
    const sends: string[] = [];
    notifier.testRunner = async (argv, op) => {
      if (op === "send") {
        sends.push(argv.join(" "));
        return JSON.stringify({ ok: true, data: { message_id: "om_wire_1" } });
      }
      return JSON.stringify({ ok: true });
    };

    const handler = createEventHandlerForInteractive({
      env: { getComponent: () => undefined } as any,
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

    // 直接投递两条生命周期事件（真实分发路径）
    await (handler as unknown as {
      handleEvent: (e: EnvEvent) => Promise<void>;
    }).handleEvent(sessionEvent("running"));
    await (handler as unknown as {
      handleEvent: (e: EnvEvent) => Promise<void>;
    }).handleEvent(sessionEvent("completed"));

    // 等 fire-and-forget 的 sender 跑完
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && sends.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 200));

    // ★ 核心断言：卡确实发了，而且**记在共享单例上**
    //   上一版这里会是 undefined（sender 用的是另一个 new 出来的实例）
    expect(sends.length).toBe(1); // 两个生命周期 → 只有一张卡
    expect(notifier.getSessionCardMessageId(SESSION)).toBe("om_wire_1");
  });
});

// ============================================================================
// 3. 静态断言：两个生产装配点真的注入了缺失过的端口
// ============================================================================

describe("★★ 静态守门：生产装配点的端口不许再漏", () => {
  /**
   * 为什么用源码静态断言而不是运行时：
   * 运行时注入需要构造完整 Environment（重、且极易被 mock 绕过 —— 那正是
   * 上一轮的死法）。源码断言**结构性地**保证「这个字符串出现在装配点里」，
   * 一旦有人删掉端口注入，测试立刻红。
   */

  test("★★ 飞书装配点注入了 loadSessionActivity / resolveSessionIdByTask", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../../../core/src/env/event-source/event-source-handlers.ts",
      ),
      "utf8",
    );
    expect(src).toContain("loadSessionActivity: createSessionActivityProbe(");
    expect(src).toContain("resolveSessionIdByTask:");
    // 且不再靠不存在的 env 属性借 notifier
    expect(src).toContain("getSharedLarkCardNotifier()");
  });

  test("★★ 企微装配点注入了 loadSessionActivity", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../../../core/src/env/event-source/wecom-cli-handler.ts",
      ),
      "utf8",
    );
    expect(src).toContain("loadSessionActivity = createSessionActivityProbe(");
  });

  // ★ Task #5420（CV MAJOR-2）：「💬 会话查看」端口守门。
  //
  // BLOCKER-1 的死法：loadSessionMessages 被误放进
  // `createSessionActivityProbe({...})` 的入参（probe 不消费，
  // 静默丢弃）⇒ 生产 wiring 零赋值、真机面板永不出现。
  // 源码断言锁死「顶层注入」形态，防止同类坑再踩。
  test("★★ 飞书装配点在 setCardActionPorts 顶层注入 loadSessionMessages", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../../../core/src/env/event-source/event-source-handlers.ts",
      ),
      "utf8",
    );
    // 顶层注入（带 this.environment 的独立实现）
    expect(src).toContain("loadSessionMessages: async (sessionId: string");
    // 绝不能嵌进 probe 入参（那是被静默丢弃的死形态）
    expect(src).not.toMatch(/loadSessionMessages:\s*async[^]*?createSessionActivityProbe/);
    // probe 入参对象里不得出现该键（简单同行检查）
    const probeCall = src.match(
      /loadSessionActivity:\s*createSessionActivityProbe\(\{[\s\S]*?\n      \}\),/,
    );
    expect(probeCall).toBeDefined();
    expect(probeCall![0]).not.toContain("loadSessionMessages");
  });

  test("★★ SessionActivityPorts 不声明 loadSessionMessages（防同名可选字段骗过类型检查）", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../../../core/src/env/task/plugins/sub-session-activity.ts",
      ),
      "utf8",
    );
    const portsBlock = src.match(
      /export interface SessionActivityPorts \{[\s\S]*?\n\}/,
    );
    expect(portsBlock).toBeDefined();
    // 去掉注释后再断言（注释里的历史说明不算声明）
    const codeOnly = portsBlock![0]
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toContain("loadSessionMessages");
  });

  test("★★ wiring 不再靠 env.getPluginInstance 借 notifier（那是 BLOCKER-4 根因）", () => {
    const src = readFileSync(join(import.meta.dir, "event-handler-wiring.ts"), "utf8");
    // 允许出现在**注释**里（解释历史），但不能出现在可执行代码里
    const codeLines = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    const code = codeLines.join("\n");
    expect(code).not.toContain("getPluginInstance?.(");
    expect(code).not.toContain("_pluginInstances?.get?.");
    // 而是走单例
    expect(code).toContain("getSharedLarkCardNotifier()");
  });

  test("★★ LarkCliTaskNotifyHook 生产默认走共享单例（不与 sender 分裂）", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../../../core/src/env/task/plugins/lark-cli-task-notify-plugin.ts",
      ),
      "utf8",
    );
    // 生产分支必须取单例；测试分支用独立实例（CV R3 m1：防跨用例串味）
    expect(src).toContain("getSharedLarkCardNotifier()");
    expect(src).toContain("isTestEnv ? new LarkCardPatchNotifier() : getSharedLarkCardNotifier()");
    // 绝不能退回「无条件 new」（那是 BLOCKER-4 的原始形态）
    expect(src).not.toContain("this.cardNotifier = config.cardNotifier ?? new LarkCardPatchNotifier();");
  });
});