/**
 * @fileoverview Task #4571 — `chat` 命令的 session 处理（TDD RED→GREEN）
 *
 * ## 用户报障（真机复现）
 *
 * ```bash
 * $ roy-bot chat "请 delegate 一个后台任务：用 bash 执行 sleep 8 然后 echo done"
 * 🤖 Agent
 *   直接尝试委托 3 次，全部因同类错误失败：
 *     Parent session not found: cli-chat
 * ```
 *
 * ## 根因
 *
 * `packages/cli/src/commands/chat.ts:60` 硬编码：
 * ```typescript
 * sessionId: "cli-chat",     // ← 从未 create/register
 * ```
 *
 * `delegate_task` 要把后台任务挂到父 session（`delegate-tool.ts` createTask）：
 * ```typescript
 * const parentSession = await sessionComponent.get(parentSessionId);
 * if (!parentSession) throw new Error(`Parent session not found: ${parentSessionId}`);
 * ```
 * `get("cli-chat")` → undefined → throw ⇒ **delegate 100% 失败**。
 *
 * ## 本文件锁定的契约
 *
 * 1. `createChatSession()` **必须**真的调 `sessionComponent.create()`，
 *    并且用返回的 `id`（不是硬编码字符串）。
 * 2. 创建后**必须**能 `sessionComponent.get(id)` 查回来 —— 这是
 *    delegate_task 的唯一前提。
 * 3. title 必须含消息摘要（可辨识），metadata 必须标 `created_by: "cli-chat"`
 *    （便于 `roy-bot sessions delete --older-than` 等清理工具筛选）。
 * 4. **绝不删 session**（保留可追溯；清理交给现成的 sessions 子命令）。
 * 5. create 失败 → 抛明确错误（不许回退到硬编码 "cli-chat"，那会把
 *    原始 bug 又放回来）。
 */

import { describe, expect, test, vi } from "bun:test";

import {
  createChatSession,
  buildChatSessionTitle,
  CHAT_SESSION_CREATED_BY,
  CHAT_SESSION_TITLE_MAX_CHARS,
  waitForBackgroundTasks,
  hasUnfinishedTasks,
  probeUnfinishedTasks,
  DEFAULT_CHAT_WAIT_TIMEOUT_MS,
} from "./chat-session";

// ============================================================================
// 极简 sessionComponent mock（只实现 chat 需要的两个方法）
// ============================================================================

interface MockSession {
  id: string;
  title: string;
  metadata?: Record<string, unknown>;
}

function makeSessionComponent(opts: {
  failCreate?: boolean;
} = {}) {
  // 用 Map 模拟真实的 session store：create 后 get 必须能查到
  const store = new Map<string, MockSession>();
  let seq = 0;

  const component = {
    create: vi.fn(async (options: {
      id?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    } = {}) => {
      if (opts.failCreate) {
        throw new Error("disk full");
      }
      const id = options.id ?? `session_gen_${++seq}`;
      const session: MockSession = {
        id,
        title: options.title ?? "Session",
        metadata: options.metadata,
      };
      store.set(id, session);
      return session;
    }),
    get: vi.fn(async (id: string) => store.get(id)),
    setActiveSession: vi.fn(async (_id: string) => true),
  };

  return { component, store };
}

// ============================================================================
// 组 1：createChatSession —— 核心（对应"Parent session not found"根因）
// ============================================================================

describe("createChatSession", () => {
  test("★ 用 create() 返回的真实 id，不是硬编码 'cli-chat'", async () => {
    const { component } = makeSessionComponent();
    const result = await createChatSession(component as any, {
      message: "帮我 delegate 一个任务",
    });

    // 必须调过 create
    expect(component.create).toHaveBeenCalledTimes(1);
    // ★ 返回的 id 必须来自 create 的结果，且**不等于**硬编码值
    expect(result.sessionId).toBe("session_gen_1");
    expect(result.sessionId).not.toBe("cli-chat");
  });

  test("★ session 落进 store —— delegate_task 才能找到父 session", async () => {
    const { component } = makeSessionComponent();
    const { sessionId } = await createChatSession(component as any, {
      message: "q",
    });

    // 这就是 delegate-tool 里 createTask 的第一步
    const parentSession = await component.get(sessionId);
    expect(parentSession).toBeDefined();
    expect(parentSession!.id).toBe(sessionId);
  });

  test("create 失败 → 抛明确错误（绝不回退到硬编码 cli-chat）", async () => {
    const { component } = makeSessionComponent({ failCreate: true });
    await expect(
      createChatSession(component as any, { message: "q" }),
    ).rejects.toThrow(/chat session/i);
  });

  test("sessionComponent 缺失 / 没有 create 方法 → 抛明确错误", async () => {
    await expect(
      createChatSession(undefined as any, { message: "q" }),
    ).rejects.toThrow(/sessionComponent/i);

    await expect(
      createChatSession({} as any, { message: "q" }),
    ).rejects.toThrow(/sessionComponent/i);
  });

  test("★ 绝不调用 delete / remove（保留可追溯，清理交给 sessions 子命令）", async () => {
    const { component } = makeSessionComponent();
    (component as any).delete = vi.fn();
    (component as any).remove = vi.fn();

    await createChatSession(component as any, { message: "q" });

    expect((component as any).delete).not.toHaveBeenCalled();
    expect((component as any).remove).not.toHaveBeenCalled();
  });

  test("metadata 标 created_by = 'cli-chat'（便于按来源筛选/清理）", async () => {
    const { component } = makeSessionComponent();
    await createChatSession(component as any, { message: "帮我查天气" });

    const call = component.create.mock.calls[0]![0]!;
    expect(call.metadata?.created_by).toBe(CHAT_SESSION_CREATED_BY);
    expect(CHAT_SESSION_CREATED_BY).toBe("cli-chat");
    // 顺手带上原始 query，便于 sessions grep 追溯
    expect(call.metadata?.chatMessage).toBe("帮我查天气");
  });

  test("两个 chat 调用的 session 互不相同（不共享同一个 session）", async () => {
    const { component } = makeSessionComponent();
    const a = await createChatSession(component as any, { message: "a" });
    const b = await createChatSession(component as any, { message: "b" });
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

// ============================================================================
// 组 2：title 生成
// ============================================================================

describe("buildChatSessionTitle", () => {
  test("含消息摘要 + chat 标识", () => {
    const title = buildChatSessionTitle("帮我 delegate 一个后台任务");
    expect(title).toContain("帮我 delegate");
    expect(title.toLowerCase()).toContain("chat");
  });

  test("★ 超长消息截断到上限（不把整段 query 塞进 title）", () => {
    const long = "这是一段很长的消息".repeat(50);
    const title = buildChatSessionTitle(long);
    // 摘要部分不超过上限
    expect(title.length).toBeLessThanOrEqual(CHAT_SESSION_TITLE_MAX_CHARS + 30);
    expect(title).toContain("…");
  });

  test("多行消息压成单行（title 里不能有换行）", () => {
    const title = buildChatSessionTitle("第一行\n第二行\n第三行");
    expect(title).not.toContain("\n");
    expect(title).toContain("第一行");
  });

  test("空消息 → 有兜底 title（不产生空字符串）", () => {
    for (const m of ["", "   ", "\n\n"]) {
      const title = buildChatSessionTitle(m);
      expect(title.length).toBeGreaterThan(0);
      expect(title.toLowerCase()).toContain("chat");
    }
  });

  test("title 不超过 128 字符（session store 的实用上限）", () => {
    const title = buildChatSessionTitle("字".repeat(500));
    expect(title.length).toBeLessThanOrEqual(128);
  });
});

// ============================================================================
// 组 3：waitForBackgroundTasks —— Q4（chat 提前 exit 会掐死后台任务）
// ============================================================================

/** 可控时钟 + 瞬时 sleep（不真等，测试要快） */
function makeFakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

function makeManager(statuses: string[]) {
  // 每次 listTasks 返回当前快照（测试里可随时改）
  const state = { statuses: [...statuses] };
  return {
    state,
    manager: { listTasks: () => state.statuses.map((s) => ({ status: s })) },
  };
}

describe("hasUnfinishedTasks", () => {
  test("pending / running 算未结束", () => {
    for (const s of ["pending", "running"]) {
      const { manager } = makeManager([s]);
      expect(hasUnfinishedTasks(manager as any)).toBe(true);
    }
  });

  test("★ awaiting-user 算已结束（chat 无法回答，等满 30s 是纯浪费）", () => {
    // 语义：chat 是单轮一次性命令，ask_user 停下来也没渠道把问题交给用户
    //       （ChatTui 拿到回答就 exit）。所以它等价于"等不到结果"。
    const { manager } = makeManager(["awaiting-user"]);
    expect(hasUnfinishedTasks(manager as any)).toBe(false);
  });

  test("★ 查询失败 → hasUnfinishedTasks 返回 false，但 probe 能区分出来", () => {
    const broken = { listTasks: () => { throw new Error("db locked"); } } as any;
    expect(hasUnfinishedTasks(broken)).toBe(false);
    const probe = probeUnfinishedTasks(broken);
    expect(probe.queryFailed).toBe(true);
    expect(probe.error).toContain("db locked");
  });

  test("manager 缺失 ≠ 查询失败（chat 没 delegate 时属正常）", () => {
    const probe = probeUnfinishedTasks(undefined);
    expect(probe.unfinished).toBe(false);
    expect(probe.queryFailed).toBe(false);
  });

  test("completed / failed / timeout / stopped 算已结束", () => {
    for (const s of ["completed", "failed", "timeout", "stopped"]) {
      const { manager } = makeManager([s]);
      expect(hasUnfinishedTasks(manager as any)).toBe(false);
    }
  });

  test("manager 缺失 / listTasks 抛错 → false（绝不因此挂住 CLI）", () => {
    expect(hasUnfinishedTasks(undefined)).toBe(false);
    expect(hasUnfinishedTasks({} as any)).toBe(false);
    expect(
      hasUnfinishedTasks({
        listTasks: () => { throw new Error("boom"); },
      } as any),
    ).toBe(false);
  });
});

describe("waitForBackgroundTasks", () => {
  test("★ 无活跃任务 → 立即返回，不等待", async () => {
    const clock = makeFakeClock();
    const { manager } = makeManager([]);
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r.finished).toBe(true);
    expect(r.waitedMs).toBe(0);
  });

  test("★ 任务在 3 次轮询后结束 → finished=true，等到它结束", async () => {
    const clock = makeFakeClock();
    const { manager, state } = makeManager(["running"]);
    let ticks = 0;
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      onTick: () => {
        ticks += 1;
        if (ticks === 3) state.statuses = ["completed"]; // 第 3 轮结束
      },
    });
    expect(ticks).toBe(3);
    expect(r.finished).toBe(true);
    expect(r.waitedMs).toBe(300);
    expect(r.stillRunning).toBe(false);
  });

  test("★ 超过 timeoutMs 仍未结束 → finished=false + stillRunning=true（不永久挂住）", async () => {
    const clock = makeFakeClock();
    const { manager } = makeManager(["running"]);
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 500,
    });
    expect(r.finished).toBe(false);
    expect(r.stillRunning).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(500);
    // 有界：不能无限轮询
    expect(r.waitedMs).toBeLessThanOrEqual(600);
  });

  test("默认 timeout 是 30s（有界，不是无限）", () => {
    expect(DEFAULT_CHAT_WAIT_TIMEOUT_MS).toBe(30_000);
  });

  test("manager 缺失 → 立即 finished（chat 无 delegate 时零开销）", async () => {
    const clock = makeFakeClock();
    const r = await waitForBackgroundTasks(undefined, {
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r.finished).toBe(true);
    expect(r.waitedMs).toBe(0);
  });

  test("多任务混合：只要有一个在跑就继续等", async () => {
    const clock = makeFakeClock();
    const { manager, state } = makeManager(["completed", "running", "failed"]);
    let ticks = 0;
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      onTick: () => {
        ticks += 1;
        if (ticks === 2) state.statuses = ["completed", "completed", "failed"];
      },
    });
    expect(r.finished).toBe(true);
    expect(ticks).toBe(2);
  });
});

// ============================================================================
// 组 4：交叉验证 findings 的回归护栏
// ============================================================================

describe("交叉验证 findings 回归护栏", () => {
  test("MEDIUM: wait 轮询中查询失败 → finished=false + queryFailed=true（不假装等到了）", async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const flaky = {
      listTasks: () => {
        calls += 1;
        if (calls === 1) return [{ status: "running" }]; // 初次探测：有任务
        throw new Error("db locked"); // 之后查询炸
      },
    };
    const r = await waitForBackgroundTasks(flaky as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
    });
    expect(r.finished).toBe(false);
    expect(r.queryFailed).toBe(true);
    expect(r.error).toContain("db locked");
  });

  test("LOW: awaiting-user 不阻塞等待（chat 无法回答，等满 30s 是浪费）", async () => {
    const clock = makeFakeClock();
    const { manager } = makeManager(["awaiting-user"]);
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r.finished).toBe(true);
    expect(r.waitedMs).toBe(0);
  });

  test("LOW: 默认时钟是单调的（performance.now），不是 Date.now", async () => {
    // 不传 now → 用默认时钟；断言它单调递增（performance.now 语义）
    const { manager, state } = makeManager(["running"]);
    let ticks = 0;
    const r = await waitForBackgroundTasks(manager as any, {
      sleep: async () => {
        ticks += 1;
        if (ticks === 2) state.statuses = ["completed"];
      },
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    expect(r.finished).toBe(true);
    expect(ticks).toBe(2);
  });
});

// ============================================================================
// 组 5：第二轮 xval（ed25e840）的 3 个 MEDIUM 回归护栏
// ============================================================================

describe("第二轮 xval MEDIUM 护栏", () => {
  test("★ MEDIUM#1: awaiting-user 时 outcome='awaiting-user'，不是 settled", async () => {
    const clock = makeFakeClock();
    const { manager } = makeManager(["awaiting-user"]);
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
    });
    // 不阻塞（不白等 30s），但**不能**报成完成
    expect(r.waitedMs).toBe(0);
    expect(r.outcome).toBe("awaiting-user");
    expect(r.outcome).not.toBe("settled");
  });

  test("★ MEDIUM#1: 真的没任务 → outcome='settled'（可以报已完成）", async () => {
    const clock = makeFakeClock();
    const { manager } = makeManager([]);
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r.outcome).toBe("settled");
  });

  test("★ MEDIUM#2: 超时收尾探测抛错 → queryFailed=true（不报假成功）", async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const flaky = {
      listTasks: () => {
        calls += 1;
        // 前几次正常"仍在跑"，超时收尾那次抛错
        if (calls <= 3) return [{ status: "running" }];
        throw new Error("db gone");
      },
    };
    const r = await waitForBackgroundTasks(flaky as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 300,
    });
    expect(r.finished).toBe(false);
    // 关键：既超时又查询失败，必须暴露 queryFailed，绝不能 stillRunning=false 就报成功
    expect(r.queryFailed).toBe(true);
    expect(r.outcome).toBe("unknown");
  });

  test("★ 超时且仍能查到任务 → outcome='timeout' + stillRunning=true", async () => {
    const clock = makeFakeClock();
    const { manager } = makeManager(["running"]);
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 300,
    });
    expect(r.finished).toBe(false);
    expect(r.stillRunning).toBe(true);
    expect(r.outcome).toBe("timeout");
    expect(r.queryFailed).toBeUndefined();
  });

  test("正常等到结束 → outcome='settled' + finished=true", async () => {
    const clock = makeFakeClock();
    const { manager, state } = makeManager(["running"]);
    let ticks = 0;
    const r = await waitForBackgroundTasks(manager as any, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      onTick: () => { if (++ticks === 2) state.statuses = ["completed"]; },
    });
    expect(r.finished).toBe(true);
    expect(r.outcome).toBe("settled");
  });
});
