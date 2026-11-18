/**
 * @fileoverview Task #5580（补充需求 2026-11-15）—— emitTaskCard /
 * emitSessionCard 从 config.jsonc 读取
 *
 * 配置键（沿用 task 组件既有点号惯例）：
 * - `task.plugins.larkCard.emitTaskCard`（默认 true）
 * - `task.plugins.larkCard.emitSessionCard`（默认 true）
 *
 * 链路：config.jsonc → ConfigComponent file source（XDG_DATA_HOME 下
 * config.jsonc，watch 默认开 ⇒ 热更新）→ taskComponent.getCardNotifyConfig()
 * → LarkCliTaskNotifyHook.currentEmitTaskCard() 每次现读。
 *
 * ## 与 event-sources.json 的关系（双通道，非双真相源）
 *
 * - config.jsonc：**全局默认**（所有 ES 共用），改文件热更新
 * - event-sources.json 的 handleRule.pluginConfig：**per-ES 覆盖**
 *   （resolveEmitSessionCard，见 event-handler-wiring.ts）
 * 优先级：代码级显式 config > per-ES 覆盖 > config.jsonc > 默认 true。
 */

import { describe, test, expect } from "bun:test";
import {
  TASK_CONFIG_REGISTRATION,
  TASK_DEFAULTS,
} from "./task-config-registration";
import { LarkCliTaskNotifyHook } from "./plugins/lark-cli-task-notify-plugin";
import { ConfigComponent } from "../../config/config-component";
import { TaskComponent } from "./task-component";

describe("task 配置注册：larkCard 卡片开关（Task #5580）", () => {
  test("★ TASK_CONFIG_REGISTRATION 注册两个开关键（env+file 双源）", () => {
    const keys = TASK_CONFIG_REGISTRATION.keys.map((k) => k.key);
    expect(keys).toContain("task.plugins.larkCard.emitTaskCard");
    expect(keys).toContain("task.plugins.larkCard.emitSessionCard");
    for (const k of TASK_CONFIG_REGISTRATION.keys) {
      if (k.key.startsWith("task.plugins.larkCard.")) {
        expect(k.sources).toContain("file");
        expect(k.sources).toContain("env");
      }
    }
  });

  test("★ TASK_DEFAULTS 默认都是 true（不配置 = 现行为不变）", () => {
    expect(TASK_DEFAULTS["task.plugins.larkCard.emitTaskCard"]).toBe(true);
    expect(TASK_DEFAULTS["task.plugins.larkCard.emitSessionCard"]).toBe(true);
  });
});

describe("taskComponent.getCardNotifyConfig（config.jsonc 读取）", () => {
  function makeTaskComponent(): TaskComponent {
    // 只测 accessor，不跑完整 init（init 需要 store 等）
    const tc = new TaskComponent();
    (tc as any).configComponent = new ConfigComponent();
    return tc;
  }

  test("★ 未配置 → 默认 true（现行为不变）", () => {
    const tc = makeTaskComponent();
    const flags = tc.getCardNotifyConfig();
    expect(flags.emitTaskCard).toBe(true);
    expect(flags.emitSessionCard).toBe(true);
  });

  test("★ config.jsonc 显式 false → 关（emitTaskCard）", async () => {
    const tc = makeTaskComponent();
    const cc = (tc as any).configComponent as ConfigComponent;
    await cc.set("task.plugins.larkCard.emitTaskCard", false);
    const flags = tc.getCardNotifyConfig();
    expect(flags.emitTaskCard).toBe(false);
    expect(flags.emitSessionCard).toBe(true);
  });

  test("★ 两个都关 → 都 false", async () => {
    const tc = makeTaskComponent();
    const cc = (tc as any).configComponent as ConfigComponent;
    await cc.set("task.plugins.larkCard.emitTaskCard", false);
    await cc.set("task.plugins.larkCard.emitSessionCard", false);
    const flags = tc.getCardNotifyConfig();
    expect(flags.emitTaskCard).toBe(false);
    expect(flags.emitSessionCard).toBe(false);
  });

  test('★ 脏值（字符串 "false"）→ 按 true 处理（安全侧）', async () => {
    const tc = makeTaskComponent();
    const cc = (tc as any).configComponent as ConfigComponent;
    await cc.set("task.plugins.larkCard.emitTaskCard", "false" as unknown as boolean);
    expect(tc.getCardNotifyConfig().emitTaskCard).toBe(true);
  });

  test("★ 热更新：改值后 accessor 立即读到新值（无缓存）", async () => {
    const tc = makeTaskComponent();
    const cc = (tc as any).configComponent as ConfigComponent;
    expect(tc.getCardNotifyConfig().emitTaskCard).toBe(true);
    await cc.set("task.plugins.larkCard.emitTaskCard", false);
    expect(tc.getCardNotifyConfig().emitTaskCard).toBe(false);
    await cc.set("task.plugins.larkCard.emitTaskCard", true);
    expect(tc.getCardNotifyConfig().emitTaskCard).toBe(true);
  });
});

describe("LarkCliTaskNotifyHook 现读 config.jsonc 开关", () => {
  function makeHook(): LarkCliTaskNotifyHook {
    return new LarkCliTaskNotifyHook({ cardMode: true } as any);
  }

  test("★ hook 未接线 reader + 无显式 config → 默认 true", () => {
    expect((makeHook() as any).currentEmitTaskCard()).toBe(true);
  });

  test("★ reader 报 emitSessionCard=false 不影响 emitTaskCard", () => {
    const hook = makeHook();
    (hook as any).cardNotifyConfigReader = () => ({
      emitTaskCard: true,
      emitSessionCard: false,
    });
    expect((hook as any).currentEmitTaskCard()).toBe(true);
  });

  test("★ reader 报 emitTaskCard=false → currentEmitTaskCard false", () => {
    const hook = makeHook();
    (hook as any).cardNotifyConfigReader = () => ({
      emitTaskCard: false,
      emitSessionCard: true,
    });
    expect((hook as any).currentEmitTaskCard()).toBe(false);
  });

  test("★ 代码级显式 config.emitTaskCard 优先于 reader（单测覆盖）", () => {
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      emitTaskCard: false,
    } as any);
    (hook as any).cardNotifyConfigReader = () => ({
      emitTaskCard: true,
      emitSessionCard: true,
    });
    expect((hook as any).currentEmitTaskCard()).toBe(false);
  });

  test("★ reader 抛错 → 安全侧默认 true", () => {
    const hook = makeHook();
    (hook as any).cardNotifyConfigReader = () => {
      throw new Error("config down");
    };
    expect((hook as any).currentEmitTaskCard()).toBe(true);
  });

  test("★★ 端到端：config.jsonc emitTaskCard=false → onAfterCreate 不发任务卡", async () => {
    const taskCardStarts: any[] = [];
    const notifier = {
      upsertSessionCard: async () => ({ messageId: "om_session_cfg" }),
      getSessionIdByTask: () => undefined,
      startTask: async (o: any) => {
        taskCardStarts.push(o);
        return { messageId: "om_task_cfg", pinned: true };
      },
      bindTaskToSession: () => {},
      getSessionCardMessageId: () => "om_session_cfg",
    };
    // 模拟 config.jsonc 里 emitTaskCard=false 的 taskComponent
    const cc = new ConfigComponent();
    await cc.set("task.plugins.larkCard.emitTaskCard", false);
    const tc = new TaskComponent();
    (tc as any).configComponent = cc;

    const plugin = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardNotifyConfigReader: () => tc.getCardNotifyConfig(),
    } as any);

    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: {
        task: {
          id: 5580,
          title: "config 开关验证",
          status: "active",
          context: JSON.stringify({ larkPerTaskChatId: "oc_cfg" }),
        },
        sessionId: "session_cfg",
      },
    });

    // session 卡照发；任务卡被 config.jsonc 关掉
    expect(taskCardStarts.length).toBe(0);
  });
});
