/**
 * @fileoverview Task #5073 — to_validate（待验证）的卡片渲染契约
 *
 * 需求（用户 2026-11-06）：task_pre_complete 把任务置为 to_validate 后，
 * 卡片要有中文「待验证」文案。
 *
 * 语义决策（decision #38602）：
 *   to_validate 是**非终态**（等待验收的活跃等待态）——
 *   卡片保持 running 更新态（不 unpin、不收尾），
 *   「待验证」文案通过 current_status 自然展示
 *   （preCompleteTask 已把 current_status 写成「待验证：…」，
 *    卡片 meta.currentStatus 渲染「📶 当前状态」行）。
 *
 * 本测试守住 4 件事：
 *   1. to_validate 走普通 updateTask（卡片保持 running，不 pause/finish）
 *   2. 卡片 meta.currentStatus 带「待验证」文案（来自 task.current_status）
 *   3. cardStatusOf 不把 to_validate 判成终态（不 unpin / 不 closed）
 *   4. CLI 渲染层：to_validate 有专属颜色（区别于终态灰/失败红）
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mock } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import {
  MemoryLarkCardStateStore,
} from "./lark-card-state-store";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";
import { TASK_TO_VALIDATE_STATUS_WORD } from "../tools/completion-copy";
import { colorByStatus } from "../../../../../cli/src/commands/tasks/task-graph";

mock("../../../log-trace/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  TracedAs: () => () => (target: any, _name: string, _d: any) => {},
}));

describe("Task #5073 — to_validate 卡片渲染", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "5073-card-"));
  });

  function makeTask(overrides: Partial<any> = {}): any {
    return {
      id: 5073,
      title: "两阶段验收测试任务",
      description: "desc",
      status: "to_validate",
      priority: "high",
      type: "normal",
      progress: 100,
      current_status: `${TASK_TO_VALIDATE_STATUS_WORD}：实现完成，测试全绿`,
      createdAt: "2026-11-06T00:00:00Z",
      updatedAt: "2026-11-06T01:00:00Z",
      project_path: "/tmp/test",
      context: "{}",
      ...overrides,
    };
  }

  function makeEnvContext(): EnvContext {
    return {
      envEvent: { metadata: {} },
      sourceId: "es-5073",
      userId: "ou_test",
      replyChannel: { chatId: "oc_chat5073", messageId: "om_msg5073" },
      pluginEnabled: { "es-5073:LarkCliTaskNotifyHook": true },
    } as EnvContext;
  }

  function makeHookContext<T>(hookPoint: string, data: T): HookContext<T> {
    return {
      component: { name: "task", version: "1.0.0" },
      data,
      metadata: {},
      phase: "after",
      hookPoint,
    } as HookContext<T>;
  }

  function makeMockNotifier(): any {
    return {
      startTask: mock(async (..._args: any[]) => ({
        messageId: "om_5073_card",
        pinned: true,
      })),
      updateTask: mock(async (..._args: any[]) => {}),
      finishTask: mock(async (..._args: any[]) => {}),
      pauseTask: mock(async (..._args: any[]) => {}),
    };
  }

  async function bootstrapCard(hook: LarkCliTaskNotifyHook): Promise<void> {
    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ status: "active", current_status: "推进中" }),
        } as TaskCreateResultContext),
      );
    });
  }

  it("1. to_validate 走普通 updateTask（卡片保持 running，不 pause/finish）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask(),
          changes: { status: "to_validate" },
        } as TaskUpdateResultContext),
      );
    });

    // 普通 patch（running），**不是**终态收尾（finishTask）也不是暂停（pauseTask）
    expect((notifier as any).updateTask).toHaveBeenCalled();
    expect((notifier as any).finishTask).not.toHaveBeenCalled();
    expect((notifier as any).pauseTask).not.toHaveBeenCalled();

    // 记录仍 open（可继续更新），pin 保留
    const rec = store.get(5073)!;
    expect(rec.status).toBe("open");
    expect(rec.pinned).toBe(true);
  });

  it("2. 卡片 meta.currentStatus 带「待验证」文案", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask(),
          changes: { status: "to_validate" },
        } as TaskUpdateResultContext),
      );
    });

    const call = ((notifier as any).updateTask as any).mock.calls[0][0];
    expect(call.meta.currentStatus).toContain(TASK_TO_VALIDATE_STATUS_WORD);
    expect(call.meta.currentStatus).toContain("实现完成");
  });

  it("3. cardStatusOf 不把 to_validate 判成终态（卡片不 unpin / 不 closed）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask(),
          changes: { status: "to_validate" },
        } as TaskUpdateResultContext),
      );
    });

    const rec = store.get(5073)!;
    // open = 仍可继续 patch；closed = 终态（错误）；无 closedAt
    expect(rec.status).not.toBe("closed");
    expect(rec.closedAt).toBeUndefined();
  });

  it("4. CLI 渲染：to_validate 有专属颜色（非默认灰）", () => {
    const color = colorByStatus("to_validate");
    // 与默认（gray）不同 —— CLI 列表里 to_validate 应可辨识
    expect(color).not.toBe((colorByStatus("unknown-status-x") as any));
    // chalk.green / chalk.blue / chalk.yellow / chalk.cyan 之一均可，
    // 这里只锁「不是 fallback gray」：默认分支返回同一 chalk.gray
    expect(typeof color).toBe("function");
  });

  it("5. AFTER_COMPLETE(terminalStatus=to_validate) 不收尾卡片（DS review MAJOR-1）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      // preCompleteTask 显式 fire AFTER_COMPLETE（自查关）：
      // terminalStatus="to_validate" —— 卡片必须保持 running，
      // **不能**走 sendCardFinish（「已完成」+ unpin）
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
          task: makeTask(),
          changes: { status: "to_validate" },
          terminalStatus: "to_validate",
          sessionId: "sess_5073",
          tagService: {},
        } as any),
      );
    });

    expect((notifier as any).finishTask).not.toHaveBeenCalled();
    expect((notifier as any).pauseTask).not.toHaveBeenCalled();
    // 记录仍 open 且 pin 保留 —— 验收还没发生
    const rec = store.get(5073)!;
    expect(rec.status).toBe("open");
    expect(rec.pinned).toBe(true);
  });

  it("6. AFTER_COMPLETE(terminalStatus=completed) 仍正常收尾（验收完成）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
          task: makeTask({ status: "completed" }),
          changes: { status: "completed" },
          terminalStatus: "completed",
          sessionId: "sess_5073",
          tagService: {},
        } as any),
      );
    });

    // 真验收完成 ⇒ 卡片收尾（finishTask），unpin
    expect((notifier as any).finishTask).toHaveBeenCalledTimes(1);
  });

  // ── Task #5164 需求 2b：header 第二行状态文案随任务状态实时同步 ──
  it("7. 状态流转时 header 第二行状态文案实时同步（to_validate → 待验证）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask(),
          changes: { status: "to_validate" },
        } as TaskUpdateResultContext),
      );
    });

    // updateTask 调用必须带 status="to_validate"（header 第二行渲染该短语）
    const call = ((notifier as any).updateTask as any).mock.calls.at(-1)[0];
    expect(call.status).toBe("to_validate");
  });

  it("8. paused 流转时 header 状态文案同步（stopped）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    const ctx = makeEnvContext();
    await runWithEnvContext(ctx, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ status: "paused" }),
          changes: { status: "paused" },
        } as TaskUpdateResultContext),
      );
    });

    const call = ((notifier as any).pauseTask as any).mock.calls.at(-1)[0];
    expect(call.status).toBe("stopped"); // paused → 卡片 stopped（⏹️ 已停止）
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
