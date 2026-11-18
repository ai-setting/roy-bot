/**
 * @fileoverview Task #4576 — `waitForBackgroundTasks` 的 `isExtraBusy` 组合等待
 *
 * ## 为什么单独成文件
 *
 * 组 C 测的是 **已存在** 的 `waitForBackgroundTasks`（chat-session.ts）新增参数，
 * 与 `chat-event-handler.ts`（新文件）无关。放一起会让整份测试因
 * module-not-found 而"红得没有信息"，掩盖「isExtraBusy 根本不存在」这个
 * 真正的 RED 信号。
 *
 * ## 为什么需要 isExtraBusy（Q1 的核心）
 *
 * `waitForBackgroundTasks` 只看 `listTasks()`。但 EventHandler 里的 **agent 轮
 * 不注册成 background task**，轮询看不见它。若 chat 不等它，`process.exit(0)`
 * 会把通知轮的 agent 直接腰斩 —— 输出丢失、sub-session 半写。
 */

import { describe, expect, test } from "bun:test";

import { probeUnfinishedTasks, waitForBackgroundTasks } from "./chat-session";

// ============================================================================
// 组 C — Q1 与轮询的组合等待
// ============================================================================

/** 造一个 pop 的 BackgroundTaskManager 替身 */
function makeBgManager(tasks: any[]) {
  return { listTasks: () => tasks };
}

describe("组 C：waitForBackgroundTasks 与 handler 忙碌的组合", () => {
  test("C1 后台任务已结束但 extra busy → 继续等，不提前返回", async () => {
    let busy = true;
    // 后台任务一开始就是 finished
    const manager = makeBgManager([{ status: "completed" }]);

    setTimeout(() => {
      busy = false;
    }, 120);

    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 2000,
      pollIntervalMs: 20,
      isExtraBusy: () => busy,
    });

    // ★ 必须等到 busy 变 false 才返回（否则 agent 轮被 exit 掐死）
    expect(busy).toBe(false);
    expect(r.waitedMs).toBeGreaterThan(0);
    expect(r.finished).toBe(true);
    expect(r.stillBusyOnly).toBeUndefined();
  });

  test("C2 extra busy 一直 true → 超时返回 stillBusyOnly（区别于「任务未结束」）", async () => {
    const manager = makeBgManager([]); // 无后台任务
    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 150,
      pollIntervalMs: 20,
      isExtraBusy: () => true,
    });

    expect(r.finished).toBe(false);
    // ★ 关键：不能报成「后台任务未结束」—— 那是撒谎，任务其实早结束了
    expect(r.stillBusyOnly).toBe(true);
    expect(r.stillRunning).toBe(false);
  });

  test("C3 不传 isExtraBusy 时行为零变化（向后兼容 #4571）", async () => {
    const manager = makeBgManager([{ status: "completed" }]);
    const r = await waitForBackgroundTasks(manager as any, { timeoutMs: 500 });
    expect(r.finished).toBe(true);
    expect(r.stillBusyOnly).toBeUndefined();
    expect(r.waitedMs).toBe(0);
  });

  test("C4 没有后台任务但 extra busy → 不能立即返回", async () => {
    const manager = makeBgManager([]);
    let busy = true;
    setTimeout(() => {
      busy = false;
    }, 100);

    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 2000,
      pollIntervalMs: 20,
      isExtraBusy: () => busy,
    });

    expect(busy).toBe(false);
    expect(r.waitedMs).toBeGreaterThan(0);
  });
});


// ============================================================================
// 组 F — 交叉验证 M2：settle 窗口（首发探测的竞态）
// ============================================================================

describe("组 F：M2 settle 窗口", () => {
  test("F1 settleMs>0 时，必须连续 settleMs 内都空闲才返回 settled", async () => {
    const manager = { listTasks: () => [] };
    const t0 = Date.now();
    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      settleMs: 120,
    });
    const elapsed = Date.now() - t0;

    // 必须真的等过 settle 窗口（否则 M2 的竞态还在）
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(r.finished).toBe(true);
  });

  test("F2 settle 期间 handler 变忙 → 不返回，继续等", async () => {
    let busy = false;
    const manager = { listTasks: () => [] };

    // 40ms 后"事件到达"（模拟 publish 落后于 status 变更）
    setTimeout(() => {
      busy = true;
    }, 40);
    // 再 120ms 后处理完
    setTimeout(() => {
      busy = false;
    }, 160);

    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      settleMs: 80,
      isExtraBusy: () => busy,
    });

    expect(busy).toBe(false);
    expect(r.finished).toBe(true);
    // 必须等到 busy 结束后才返回（不是 0ms 直接 settled）
    expect(r.waitedMs).toBeGreaterThan(100);
  });

  test("F3 settleMs 默认 0 ⇒ 行为与之前完全一致（不额外等待）", async () => {
    const manager = { listTasks: () => [] };
    const t0 = Date.now();
    const r = await waitForBackgroundTasks(manager as any, { timeoutMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(80);
    expect(r.waitedMs).toBe(0);
    expect(r.finished).toBe(true);
  });

  test("F4 settle 期间出现未结束任务 → 回到等待循环，不误报 settled", async () => {
    let tasks: any[] = [];
    const manager = { listTasks: () => tasks };

    setTimeout(() => {
      tasks = [{ status: "running" }];
    }, 30);
    setTimeout(() => {
      tasks = [{ status: "completed" }];
    }, 120);

    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      settleMs: 60,
    });

    expect(r.finished).toBe(true);
    expect(r.waitedMs).toBeGreaterThan(100);
  });
});

// ============================================================================
// 组 G — 第二轮 xval（FAIL）修复
// ============================================================================

describe("组 G：xval2 修复", () => {
  test("G1 (N1/ M2 外层) probeUnfinishedTasks 必须能报 hasAnyTask", () => {
    // 任务 status 已是 completed（listTasks 仍能看见这条记录）但事件还没入队
    const manager = { listTasks: () => [{ status: "completed" }] };
    const p = probeUnfinishedTasks(manager as any);
    // 不是「未结束」
    expect(p.unfinished).toBe(false);
    // ★ 但「存在任务」必须为 true —— 这正是外层门禁该用的判据
    expect(p.hasAnyTask).toBe(true);
  });

  test("G2 (N1) 空列表时 hasAnyTask=false", () => {
    const manager = { listTasks: () => [] };
    expect(probeUnfinishedTasks(manager as any).hasAnyTask).toBe(false);
  });

  test("G3a (N2) 任务停在 awaiting-user → outcome 必须是 awaiting-user（不能落到 else 报已完成）", async () => {
    const manager = { listTasks: () => [{ status: "awaiting-user" }] };
    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 120,
      pollIntervalMs: 20,
    });
    // 「等完了」（没有更活跃的任务要等）但结局是 awaiting-user ——
    // chat.ts 的判断链里 outcome 分支排在 finished 之前，所以不会打印
    // 「✅ 后台任务已完成」这个谎。
    expect(r.outcome).toBe("awaiting-user");
    expect(r.stillRunning).toBe(false);
    expect(r.stillBusyOnly).toBeUndefined();
  });

  test("G3b (N2) awaiting-user + handler 持续忙到超时 → outcome 仍必须是 awaiting-user", async () => {
    const manager = { listTasks: () => [{ status: "awaiting-user" }] };
    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 120,
      pollIntervalMs: 20,
      isExtraBusy: () => true, // 逼循环跑满 → 走超时收尾分支
    });
    expect(r.finished).toBe(false);
    // ★ 关键：超时收尾不能无条件写 "timeout"，否则 chat.ts 落到 else 撒谎
    expect(r.outcome).toBe("awaiting-user");
    expect(r.stillRunning).toBe(false);
  });

  test("G4 (N5) settleMs=NaN 不能让等待永不结束", async () => {
    const manager = { listTasks: () => [] };
    const t0 = Date.now();
    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      settleMs: Number.NaN,
    });
    // NaN 必须被当作 0（立即返回），不能跑满 5s
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.finished).toBe(true);
  });
});

// ============================================================================
// 组 H — 第三轮 xval：N1 门禁放宽引入的新谎（MEDIUM-1 / LOW-1）
// ============================================================================

describe("组 H：失败任务不能被报成「已完成」", () => {
  test("H1 任务 failed → probe 必须报 failed，且 outcome 不能是 settled", async () => {
    const manager = { listTasks: () => [{ status: "failed" }] };
    const p = probeUnfinishedTasks(manager as any);
    // ★ N1 放宽门禁后 failed 任务会进等待块 → 若 outcome 落 settled，
    //   chat.ts 的 else 分支会打印「✅ 后台任务已完成」—— 新的谎。
    expect(p.failed).toBe(true);

    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 120,
      pollIntervalMs: 20,
    });
    expect(r.outcome).not.toBe("settled");
    expect(r.outcome).toBe("failed");
  });

  test("H2 timeout / stopped 也归入 failed 一族", async () => {
    for (const status of ["timeout", "stopped"]) {
      const p = probeUnfinishedTasks({ listTasks: () => [{ status }] } as any);
      expect(p.failed).toBe(true);
    }
  });

  test("H3 completed 任务不算 failed", () => {
    const p = probeUnfinishedTasks({ listTasks: () => [{ status: "completed" }] } as any);
    expect(p.failed).toBe(false);
    expect(p.hasAnyTask).toBe(true);
  });

  test("H4 混合：一个 completed + 一个 failed → failed 优先级更高（不能报成功）", async () => {
    const manager = {
      listTasks: () => [{ status: "completed" }, { status: "failed" }],
    };
    const r = await waitForBackgroundTasks(manager as any, {
      timeoutMs: 120,
      pollIntervalMs: 20,
    });
    expect(r.outcome).toBe("failed");
  });
});

describe("组 I2 — xval4 NEW-1/NEW-4", () => {
  test("I2 (NEW-4) 未知状态不能被算成 settled（否则报「已完成」）", async () => {
    const p = probeUnfinishedTasks({ listTasks: () => [{ status: "cancelled" }] } as any);
    // 不在已知终态白名单里 → 不能当成成功结束
    expect(p.settledByProof).toBe(false);

    const r = await waitForBackgroundTasks(
      { listTasks: () => [{ status: "cancelled" }] } as any,
      { timeoutMs: 100, pollIntervalMs: 20 },
    );
    expect(r.outcome).not.toBe("settled");
  });

  test("I3 (NEW-4) 全部 completed 才算 settledByProof", () => {
    expect(
      probeUnfinishedTasks({ listTasks: () => [{ status: "completed" }] } as any)
        .settledByProof,
    ).toBe(true);
    expect(
      probeUnfinishedTasks({ listTasks: () => [{ status: "failed" }] } as any)
        .settledByProof,
    ).toBe(false);
  });

  test("I4 (NEW-1) failed + handler 忙 → 不能把 failure 吞进 stillBusyOnly", async () => {
    const r = await waitForBackgroundTasks(
      { listTasks: () => [{ status: "failed" }] } as any,
      { timeoutMs: 120, pollIntervalMs: 20, isExtraBusy: () => true },
    );
    // ★ failed 必须能穿透 stillBusyOnly 分支
    expect(r.failed).toBe(true);
    expect(r.outcome).toBe("failed");
  });
});
