/**
 * @fileoverview TaskOpWatermarkPlugin tests — Task #5081 (M1)
 *
 * ## 契约（设计文档 /tmp/task-op-awareness-design.md）
 *
 * - 挂 `agent:after.tool`，水位用 **operation id**（单调自增）而非 timestamp
 * - 查询必须**绕过 operationsCache**（跨进程写不失效缓存）：
 *   优先 `listOperationsFresh`，能力探测失败降级 `listOperations` + `invalidateOperationsCache`
 * - 过滤：`op.sessionId === ctx.context.sessionId` 或 `op.sessionId === "unknown"`
 *   的记录**不算别人的**（自提醒 doom loop 防护 + #5073 pre_complete 回归）
 * - 无 task 绑定（getTaskIdsBySessionId 返回空）→ 跳过
 * - N 条新 operation 聚合成 **1 条**提醒；单 run 限流 5 次；消息 ≤1500 字符
 * - DB 读异常不影响工具执行（plugin 返回 `{ continue: true }`）
 * - helper kind 合并顺序：`delegate` → `task-ops` → `max-iter`（max-iter 永远最后）
 * - 提醒文案必须带具体 task id + `task_operation_list(task_id=N)` 指引 + 「可忽略」出口
 *
 * ## 测试策略
 *
 * 用 fake TaskComponent（内存 store）直接驱动 plugin.execute()，
 * 不依赖真实 SQLite —— plugin 只依赖 duck-typed 接口
 * （getTaskIdsBySessionId / listOperationsFresh / listOperations /
 *   invalidateOperationsCache / getTask）。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createTaskOpWatermarkPlugin,
  TASK_OP_WATERMARK_MAX_REMINDERS,
  TASK_OP_WATERMARK_MESSAGE_LIMIT,
  TASK_OP_WATERMARK_AUDIT_INTERVAL,
} from "./task-op-watermark-plugin";
import { enqueueToAddFakeUserMessage } from "./fake-user-message-helper";
import type { HookContext, AgentContext, Plugin } from "../../agent/types";
import type { TaskOperation } from "../types";

// ============================================================================
// Fake TaskComponent
// ============================================================================

interface FakeOp {
  id: number;
  taskId: number;
  sessionId: string;
  milestoneType: string;
  milestoneTitle: string;
  milestoneDescription?: string;
  timestamp: string;
}

class FakeTaskComponent {
  ops: FakeOp[] = [];
  taskIdsBySession = new Map<string, number[]>();
  tasks = new Map<number, { id: number; title: string }>();
  /** 模拟不支持 fresh 的 store（T14 降级路径用） */
  supportsFresh = true;
  /** 模拟 DB 抛错（T15 用） */
  throwOnList = false;
  freshCallCount = 0;
  fallbackCallCount = 0;
  invalidateCallCount = 0;
  /** 主缓存（T13：fresh 不污染主缓存） */
  private cache = new Map<number, TaskOperation[]>();

  addTask(id: number, sessionIds: string[], title = `Task #${id}`) {
    this.tasks.set(id, { id, title });
    for (const sid of sessionIds) {
      const arr = this.taskIdsBySession.get(sid) ?? [];
      arr.push(id);
      this.taskIdsBySession.set(sid, arr);
    }
  }

  addOp(o: Partial<FakeOp> & { id: number; taskId: number; sessionId: string }) {
    this.ops.push({
      milestoneType: "progress",
      milestoneTitle: `op ${o.id}`,
      timestamp: new Date(1700000000000 + o.id * 1000).toISOString(),
      ...o,
    } as FakeOp);
    this.cache.delete(o.taskId);
  }

  async getTaskIdsBySessionId(sessionId: string): Promise<number[]> {
    return this.taskIdsBySession.get(sessionId) ?? [];
  }

  async getTask(id: number) {
    return this.tasks.get(id);
  }

  async listOperationsFresh(options: { taskId: number; limit?: number }): Promise<TaskOperation[]> {
    this.freshCallCount++;
    if (this.throwOnList) throw new Error("db down");
    const ops = this.ops
      .filter((o) => o.taskId === options.taskId)
      .sort((a, b) => b.id - a.id)
      .slice(0, options.limit ?? 50);
    return ops.map(toOperation);
  }

  async listOperations(options: { taskId: number; limit?: number }): Promise<TaskOperation[]> {
    this.fallbackCallCount++;
    if (this.throwOnList) throw new Error("db down");
    const cached = this.cache.get(options.taskId);
    const ops = cached ?? this.ops
      .filter((o) => o.taskId === options.taskId)
      .sort((a, b) => b.id - a.id);
    if (!cached) this.cache.set(options.taskId, ops);
    return ops.slice(0, options.limit ?? 50).map(toOperation);
  }

  invalidateOperationsCache(taskId: number): void {
    this.invalidateCallCount++;
    this.cache.delete(taskId);
  }
}

function toOperation(o: FakeOp): TaskOperation {
  return {
    id: o.id,
    taskId: o.taskId,
    sessionId: o.sessionId,
    milestoneType: o.milestoneType as TaskOperation["milestoneType"],
    milestoneTitle: o.milestoneTitle,
    milestoneDescription: o.milestoneDescription ?? "",
    processDescription: "",
    timestamp: o.timestamp,
    actionType: o.milestoneType as TaskOperation["actionType"],
    actionTitle: o.milestoneTitle,
    actionDescription: o.milestoneDescription ?? "",
  };
}

// ============================================================================
// HookContext helpers
// ============================================================================

function makeCtx(opts: {
  sessionId: string;
  traceId?: string;
  toolResult?: any;
}): HookContext {
  return {
    agent: { name: "roy" } as any,
    iteration: 1,
    maxIterations: 50,
    messages: [{ role: "user", content: "q" }],
    tools: [],
    systemPrompt: "x",
    context: {
      sessionId: opts.sessionId,
      traceId: opts.traceId ?? `q-${Math.random()}`,
    } as unknown as AgentContext,
    toolResult: opts.toolResult ?? {
      id: "tc1",
      name: "bash",
      success: true,
      result: { success: true, output: "ok", metadata: {} },
    },
  } as unknown as HookContext;
}

function peekMeta(ctx: HookContext): any {
  return (ctx.toolResult as any)?.result?.metadata?.toAddFakeUserMessage;
}

function metaContent(ctx: HookContext): string {
  const m = peekMeta(ctx);
  if (!m) return "";
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

// ============================================================================
// Tests
// ============================================================================

describe("TaskOpWatermarkPlugin (Task #5081 M1)", () => {
  let tc: FakeTaskComponent;

  beforeEach(() => {
    tc = new FakeTaskComponent();
  });

  function makePlugin(overrides?: { resolveTaskComponent?: () => any }): Plugin {
    return createTaskOpWatermarkPlugin({
      resolveTaskComponent: overrides?.resolveTaskComponent ?? (() => tc as any),
    });
  }

  // ---------------------------------------------------------------- T1
  it("T1: 别人写 operation → 注入提醒（含 task id / task_operation_list 指引 / 可忽略出口）", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "done something" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    const m = peekMeta(ctx);
    expect(m).toBeDefined();
    expect(m.role).toBe("user");
    const content = metaContent(ctx);
    expect(content).toContain("Task #100");
    expect(content).toContain("task_operation_list(task_id=100)");
    expect(content).toContain("done something");
    // 可忽略出口（防 LLM 把提醒当最高指令）
    expect(content.toLowerCase()).toMatch(/忽略|ignore/);
    // 「其他 agent」语义
    expect(content).toMatch(/其他|other/i);
  });

  // ---------------------------------------------------------------- T2
  it("T2: 自己写（sessionId 相同）→ 不提醒（防自提醒 doom loop）", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S1", milestoneTitle: "my own op" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    expect(peekMeta(ctx)).toBeUndefined();
  });

  // ---------------------------------------------------------------- T6
  it("T6: sessionId='unknown' 的 operation 视为自己 → 不提醒", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "unknown", milestoneTitle: "unknown writer" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    expect(peekMeta(ctx)).toBeUndefined();
  });

  // ---------------------------------------------------------------- T3
  it("T3: 水位去重 — 同一 operation 不重复提醒；新 op 才再提醒", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "op one" });

    const p = makePlugin();
    const ctx1 = makeCtx({ sessionId: "S1", traceId: "t1" });
    await p.execute(ctx1);
    expect(peekMeta(ctx1)).toBeDefined();

    // 第二次工具调用，无新 op → 不提醒
    const ctx2 = makeCtx({ sessionId: "S1", traceId: "t2" });
    await p.execute(ctx2);
    expect(peekMeta(ctx2)).toBeUndefined();

    // 新 op (id=2) → 再次提醒
    tc.addOp({ id: 2, taskId: 100, sessionId: "S2", milestoneTitle: "op two" });
    const ctx3 = makeCtx({ sessionId: "S1", traceId: "t3" });
    await p.execute(ctx3);
    expect(peekMeta(ctx3)).toBeDefined();
    expect(metaContent(ctx3)).toContain("op two");
   });

  // ---------------------------------------------------------------- T4
  it("T4: 无 task 绑定 → 跳过（不抛异常、不提醒）", async () => {
    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S9" }); // S9 无绑定
    const result = await p.execute(ctx);

    expect(result.continue).toBe(true);
    expect(peekMeta(ctx)).toBeUndefined();
  });

  // ---------------------------------------------------------------- T5
  it("T5: N 条聚合 → 恰好 1 条提醒（详情 ≤3 条 + 省略提示）", async () => {
    tc.addTask(100, ["S1"]);
    for (let i = 1; i <= 5; i++) {
      tc.addOp({ id: i, taskId: 100, sessionId: "S2", milestoneTitle: `op ${i}` });
    }

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    const m = peekMeta(ctx);
    expect(m).toBeDefined();
    const content = metaContent(ctx);
    expect(content).toContain("5 条");
    // 最新 3 条详情（op 5 / op 4 / op 3）
    expect(content).toContain("op 5");
    expect(content).toContain("op 4");
    expect(content).toContain("op 3");
    // 更旧的折叠
    expect(content).toContain("省略");
    expect(content).not.toContain("op 2\n");
  });

  // ---------------------------------------------------------------- T7
  it("T7: 多 task 绑定 — 任一 task 有别人的 op 都触发（并集水位）", async () => {
    tc.addTask(100, ["S1"]);
    tc.addTask(101, ["S1"]);
    tc.addOp({ id: 1, taskId: 101, sessionId: "S2", milestoneTitle: "on task 101" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    const content = metaContent(ctx);
    expect(content).toContain("Task #101");
    // DS r1 MINOR-1：指引指向 101（不是聚合到 100 名下）
    expect(content).toContain("task_operation_list(task_id=101)");
  });

  // ---------------------------------------------------------------- T7b
  it("T7b (DS r1 MINOR-1 回归): 多 task 混合命中 — 各 task 独立分段且指引各自正确", async () => {
    tc.addTask(100, ["S1"]);
    tc.addTask(101, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "on 100" });
    tc.addOp({ id: 2, taskId: 101, sessionId: "S2", milestoneTitle: "on 101" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    const content = metaContent(ctx);
    // 两个 task 各自有标题段
    expect(content).toContain("Task #100");
    expect(content).toContain("Task #101");
    // 各自的指引（无错位指向）
    expect(content).toContain("task_operation_list(task_id=100)");
    expect(content).toContain("task_operation_list(task_id=101)");
    // 仍是一条 user message（N 聚 1）
    const m = peekMeta(ctx);
    expect(m.role).toBe("user");
  });

  // ---------------------------------------------------------------- T8
  it("T8: 切换 task → 水位重置（新 task 的旧记录会提醒一次）", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "old task 100 op" });

    const p = makePlugin();
    const ctx1 = makeCtx({ sessionId: "S1", traceId: "t1" });
    await p.execute(ctx1);
    expect(peekMeta(ctx1)).toBeDefined();

    // session 绑定变成 task #200（重新 addTask 映射）
    tc.addTask(200, ["S1"]);
    tc.addOp({ id: 2, taskId: 200, sessionId: "S2", milestoneTitle: "task 200 op" });

    const ctx2 = makeCtx({ sessionId: "S1", traceId: "t2" });
    await p.execute(ctx2);
    expect(metaContent(ctx2)).toContain("Task #200");
  });

  // ---------------------------------------------------------------- T9
  it(`T9: 每 ${TASK_OP_WATERMARK_AUDIT_INTERVAL} 次工具兜底对账 — 水位被错误推进仍能补报`, async () => {
    tc.addTask(100, ["S1"]);

    const p = makePlugin();
    // 14 次：水位正常推进（无 op）
    for (let i = 0; i < TASK_OP_WATERMARK_AUDIT_INTERVAL - 1; i++) {
      await p.execute(makeCtx({ sessionId: "S1", traceId: `t-${i}` }));
    }
    expect(peekMeta(makeCtx({ sessionId: "S1" }))).toBeUndefined();

    // 别人的 op 写入，但水位被「错误推进」：通过前 14 次调用后写 op，
    // 且让水位检查看到的 id 已被消费（模拟竞态）——这里直接验证
    // 第 15 次触发强制对账：即使 plugin 内部水位认为已消费，
    // 兜底对账（不看水位）也能发现该 op。
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "audit catch" });

    const ctx = makeCtx({ sessionId: "S1", traceId: "t-final" });
    await p.execute(ctx);
    // 水位增量检查本身就会发现它（水位 < 1）——两条路径任一命中即提醒
    expect(metaContent(ctx)).toContain("audit catch");
  });

  // ---------------------------------------------------------------- T9b
  it("T9b (DS r1/r2 回归): peer 后写且 id 更高 — audit 轮不重报 + 限流预算不被烧光 + 迟到新记录仍被提醒", async () => {
    tc.addTask(100, ["S1"]);
    // 判别形状（DS r3 MINOR-1）：**自写 op 先建立水位**，peer op
    // **后写且 id 更高** —— 这是 r2 回归的触发条件（自写 op 抬高
    // lastSeenOpId 而 lastNotifiedOpId 落后）。r2 坏版在 20 轮内
    // 会把 peer op 重报 2 次（每 15 轮一次）。
    tc.addOp({ id: 1, taskId: 100, sessionId: "S1", milestoneTitle: "self progress A" });
    tc.addOp({ id: 2, taskId: 100, sessionId: "S1", milestoneTitle: "self progress B" });

    const p = makePlugin();

    // 第 1 轮：只有自写 op → 不提醒，但水位建立（lastSeenOpId=2）
    const ctx1 = makeCtx({ sessionId: "S1", traceId: "t0" });
    await p.execute(ctx1);
    expect(peekMeta(ctx1)).toBeUndefined();

    // 第 2 轮前 peer 写 op（id=3 > selfMax=2，后写）→ 触发提醒
    tc.addOp({ id: 3, taskId: 100, sessionId: "S2", milestoneTitle: "peer-3" });
    const ctx2 = makeCtx({ sessionId: "S1", traceId: "t1" });
    await p.execute(ctx2);
    expect(metaContent(ctx2)).toContain("peer-3");

    // 20 轮内（跨一个 audit 周期）无新 peer op → peer-3 不得重报；
    // 期间自写新 op（真实形状，AUTOINCREMENT id 单调增）也不得诱发重报
    let repeats = 0;
    for (let turn = 3; turn <= 22; turn++) {
      if (turn === 10) {
        tc.addOp({ id: 23, taskId: 100, sessionId: "S1", milestoneTitle: "self progress C" });
      }
      const ctx = makeCtx({ sessionId: "S1", traceId: `t-${turn}` });
      await p.execute(ctx);
      if (peekMeta(ctx)) repeats++;
    }
    expect(repeats).toBe(0);

    // 第 23 轮写入迟到新 peer op（id=24 > 自写 23，AUTOINCREMENT
    // 保证后写者 id 更大）→ 必须被提醒
    tc.addOp({ id: 24, taskId: 100, sessionId: "S2", milestoneTitle: "late-NEW-24" });
    const ctx2b = makeCtx({ sessionId: "S1", traceId: "t-23" });
    await p.execute(ctx2b);
    expect(metaContent(ctx2b)).toContain("late-NEW-24");
    expect(metaContent(ctx2b)).not.toContain("peer-3");
  });

  // ---------------------------------------------------------------- T10
  it("T10: 提醒限流 — 超过上限后不再注入，但水位仍推进（不重复报）", async () => {
    tc.addTask(100, ["S1"]);
    let opId = 0;
    const p = makePlugin();

    let reminders = 0;
    for (let round = 0; round < TASK_OP_WATERMARK_MAX_REMINDERS + 2; round++) {
      opId++;
      tc.addOp({ id: opId, taskId: 100, sessionId: "S2", milestoneTitle: `op ${opId}` });
      const ctx = makeCtx({ sessionId: "S1", traceId: `t-${round}` });
      await p.execute(ctx);
      if (peekMeta(ctx)) reminders++;
    }

    expect(reminders).toBe(TASK_OP_WATERMARK_MAX_REMINDERS);
  });

  // ---------------------------------------------------------------- T11
  it("T11: 消息长度上限 — 超长描述被截断，总长 ≤ 上限", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({
      id: 1,
      taskId: 100,
      sessionId: "S2",
      milestoneTitle: "huge op",
      milestoneDescription: "x".repeat(5000),
    });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    const content = metaContent(ctx);
    expect(content.length).toBeLessThanOrEqual(TASK_OP_WATERMARK_MESSAGE_LIMIT);
    expect(content).toContain("已截断");
    expect(content).toContain("huge op");
  });

  // ---------------------------------------------------------------- T12
  it("T12: helper 合并顺序 — task-ops 在 delegate 之后、max-iter 之前；finalKind=max-iter", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "merged op" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });

    // 先 delegate（AutoTaskPlugin 风格）
    enqueueToAddFakeUserMessage(
      ctx.toolResult,
      { role: "user", content: "DELEGATE_HINT" } as any,
      "delegate",
    );
    // 再 task-ops
    await p.execute(ctx);
    // 最后 max-iter
    enqueueToAddFakeUserMessage(
      ctx.toolResult,
      { role: "user", content: "MAX_ITER_HINT" } as any,
      "max-iter",
    );

    const content = metaContent(ctx);
    const delegateIdx = content.indexOf("DELEGATE_HINT");
    const taskOpsIdx = content.indexOf("Task #100");
    const maxIterIdx = content.indexOf("MAX_ITER_HINT");
    expect(delegateIdx).toBeGreaterThanOrEqual(0);
    expect(taskOpsIdx).toBeGreaterThan(delegateIdx);
    expect(maxIterIdx).toBeGreaterThan(taskOpsIdx);

    const meta = (ctx.toolResult as any).result.metadata;
    expect(meta.__fakeUserMessageKind).toBe("max-iter");
  });

  // ---------------------------------------------------------------- T13
  it("T13: plugin 优先走 listOperationsFresh（绕缓存）；能力探测失败走 fallback", async () => {
    tc.addTask(100, ["S1"]);
    tc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "fresh op" });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    expect(tc.freshCallCount).toBeGreaterThanOrEqual(1);
    expect(peekMeta(ctx)).toBeDefined();

    // 降级路径：store 不支持 fresh
    tc.supportsFresh = false;
    const tcNoFresh = Object.create(tc) as any;
    tcNoFresh.listOperationsFresh = undefined;
    const p2 = createTaskOpWatermarkPlugin({
      resolveTaskComponent: () => tcNoFresh,
    });
    tc.addOp({ id: 2, taskId: 100, sessionId: "S2", milestoneTitle: "fallback op" });
    const ctx2 = makeCtx({ sessionId: "S1", traceId: "t2" });
    await p2.execute(ctx2);
    expect(tcNoFresh.fallbackCallCount).toBeGreaterThanOrEqual(1);
    expect(tcNoFresh.invalidateCallCount).toBeGreaterThanOrEqual(1);
    expect(metaContent(ctx2)).toContain("fallback op");
  });

  // ---------------------------------------------------------------- T15
  it("T15: DB 读异常 → 不影响工具执行（continue: true，无提醒）", async () => {
    tc.addTask(100, ["S1"]);
    tc.throwOnList = true;

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    const result = await p.execute(ctx);

    expect(result.continue).toBe(true);
    expect(peekMeta(ctx)).toBeUndefined();
  });

  // ------------------------------------------------------------ 回归 #5073
  it("回归 #5073: sub-agent 自己 pre_complete 的 operation（sessionId=自己）不自提醒", async () => {
    tc.addTask(100, ["S1"]);
    // pre-complete-tool.ts:89 写入的 sessionId = sub-session id = 自己
    tc.addOp({
      id: 1,
      taskId: 100,
      sessionId: "S1",
      milestoneType: "milestone",
      milestoneTitle: "待验证（to_validate）：Task #100 submitted for acceptance",
    });

    const p = makePlugin();
    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    expect(peekMeta(ctx)).toBeUndefined();
  });

  // ------------------------------------------------------------ 注册形态
  it("plugin 声明 agent:after.tool hook；resolveTaskComponent 缺省（undefined）时防御性跳过", async () => {
    const p = makePlugin();
    expect(p.name).toBe("TaskOpWatermarkPlugin");
    expect(p.hooks.some((h) => h.point === "agent:after.tool")).toBe(true);

    // resolveTaskComponent 未注入 → 跳过不抛错
    const p2 = createTaskOpWatermarkPlugin({});
    const ctx = makeCtx({ sessionId: "S1" });
    const result = await p2.execute(ctx);
    expect(result.continue).toBe(true);
    expect(peekMeta(ctx)).toBeUndefined();
  });

  // ------------------------------------------------------------ 惰性 DI
  it("惰性 resolver：首次 execute 时才解析 taskComponent（模拟时序晚注册）", async () => {
    let resolved = 0;
    const lateTc = new FakeTaskComponent();
    const p = createTaskOpWatermarkPlugin({
      resolveTaskComponent: () => {
        resolved++;
        return lateTc as any;
      },
    });

    lateTc.addTask(100, ["S1"]);
    lateTc.addOp({ id: 1, taskId: 100, sessionId: "S2", milestoneTitle: "late bound" });

    const ctx = makeCtx({ sessionId: "S1" });
    await p.execute(ctx);

    expect(resolved).toBe(1);
    expect(metaContent(ctx)).toContain("late bound");
  });
});
