/**
 * @fileoverview Task #4627 — Laya 决策插件的**注册路径**回归测试
 *
 * ⚠️ 这是 Task #4627 的 **RED → GREEN** 核心测试。
 *
 * 背景：#4620 实现了 LayaDecisionPlugin，但集成路径有 2 个阻断 bug：
 *
 *   Bug 1：environment.ts 用 `agentComponent.registerPlugin("default", plugin)` 注册 ——
 *         这走的是 **Agent Plugin** 通道，只在 agent 作用域 hook 点派发
 *         （agent:before.start / agent:before.llm / ...），**不含 `task:before.create`**。
 *         `task:before.create` 只由 `globalHookManager.execute()` 派发。
 *
 *   Bug 2：注册代码整段位于 `if (!agent)` 分支内 → `act --agent roy` 走 else 分支，
 *         插件一次都没注册。
 *
 * 本文件断言**注册后的真实链路**：注册 hook → 真实 `task_create` 工具执行
 * → output 里出现 `[TASK_CREATE_HINT]`。
 *
 * 注册方式由 `environment.ts` 的 `registerLayaDecisionTaskHook()` 暴露，
 * 这样测试和生产走**同一段代码**，不会各写各的。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { createTaskTool } from "../tools/create-tool";
import { TaskHookPoints } from "../hooks/task-hook-points";
import { globalHookManager } from "../../hook/global-hook-manager";
import { registerLayaDecisionTaskHook } from "../../environment";
import type { DecisionPort, DecisionResponse } from "./decision-port";

const LAYA_THRESHOLD = 0.85;

/** 假 port：记录请求，返回指定 choice + 置信度 */
function portReturning(
  choice: string,
  confidence: number,
  reqs: unknown[] = [],
): DecisionPort {
  return {
    async decide(req: any): Promise<DecisionResponse> {
      reqs.push(req);
      return {
        answers: {
          reuse_or_create: {
            choice,
            confidence,
            x_jev_confidence: confidence,
          },
        },
      } as DecisionResponse;
    },
    isDisabled: () => false,
  };
}

interface Fixture {
  taskComponent: TaskComponent;
  tool: ReturnType<typeof createTaskTool>;
  dbPath: string;
  dir: string;
}

let fixture: Fixture | null = null;

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "laya-reg-"));
  const dbPath = join(dir, "tasks.db");
  const configComponent = new ConfigComponent();
  const taskComponent = new TaskComponent();
  await taskComponent.init({
    name: "task",
    version: "1.0.0",
    enabled: true,
    options: {
      configComponent,
      config: { storage: { type: "sqlite", dbPath } },
    },
  } as any);
  const tool = createTaskTool(taskComponent);
  return { taskComponent, tool, dbPath, dir };
}

/** 建一个候选任务（走真实 createTask，会触发 BEFORE_CREATE hook —— 此时还没注册 hook） */
async function seedTask(
  f: Fixture,
  title: string,
  description: string,
  tags: string[],
): Promise<number> {
  const r: any = await f.tool.execute(
    {
      title,
      description,
      tags,
      project_path: "/tmp/p",
      context: JSON.stringify({ type: "feature" }),
    },
    { session_id: "s" } as any,
  );
  const m = String(r.output).match(/#(\d+)/);
  if (!m) throw new Error(`seed failed: ${r.output ?? r.error}`);
  return Number(m[1]);
}

describe("Task #4627 — Laya 决策插件注册路径（task:before.create）", () => {
  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    // 清掉全局 hook，避免污染其它测试
    globalHookManager.unregister(TaskHookPoints.BEFORE_CREATE, "laya-decision");
    if (fixture) {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fixture = null;
    }
  });

  // ==================================================================
  // 核心断言：注册之后，真实 task_create 的 output 必须带 [TASK_CREATE_HINT]
  //
  // ❌ 在 #4627 修复前这段是 RED：
  //    - Bug 1：registerPlugin 不写 globalHookManager → hook 根本不触发
  //    - Bug 2：注册在 if (!agent) 内 → act --agent roy 走不到
  // ✅ 修复后 GREEN。
  // ==================================================================
  test("registered hook → real task_create output contains [TASK_CREATE_HINT]", async () => {
    const f = fixture!;
    const id1 = await seedTask(f, "候选一 封装 Laya 模型成 Jev 语义服务", "把训练好的 Laya 模型封装成标准 Jev 语义 HTTP 服务，写入 auth.json", ["laya"]);
    const id2 = await seedTask(f, "候选二 在 roy-bot 接入 Laya 决策端口", "在 roy-bot 新 worktree 实现 Laya decision port 并集成到 task:before.create hook", ["laya"]);

    // 用假 port 注入（避免依赖真实 Laya 服务）
    const reqs: unknown[] = [];
    const port = portReturning(`#${id2} 候选二 在 roy-bot 接入 Laya 决策端口`, 0.99, reqs);

    // ★ 生产同款注册路径
    registerLayaDecisionTaskHook(f.taskComponent, { decisionPort: port } as any);

    const r: any = await f.tool.execute(
      {
        title: "把 Laya 封装成 Jev 语义 HTTP 服务并接进 roy-bot",
        description:
          "把训练好的 Laya 模型封装成标准 Jev 语义 HTTP 服务，写入 auth.json，然后在 roy-bot 的新 worktree 里实现 client 并集成到 task:before.create hook。",
        tags: ["laya"],
        project_path: "/tmp/p",
        context: JSON.stringify({ type: "feature", similar_task_ids: [id1, id2] }),
      },
      { session_id: "s" } as any,
    );

    expect(r.success).toBe(true);
    expect(reqs.length).toBe(1);
    expect(r.output).toContain("[TASK_CREATE_HINT]");
    expect(r.output).toContain(`task_update`);
    expect(r.output).toContain(String(id2));
  });

  // ==================================================================
  // 幂等保护：registerLayaDecisionTaskHook 调多次，hook 只应存在 1 份
  // （globalHookManager.register 是 push，不去重会重复调模型）
  // ==================================================================
  test("registering twice → only ONE hook registered (idempotent)", () => {
    const f = fixture!;
    const port = portReturning("NEW_TASK", 0.99);
    const before = globalHookManager.count(TaskHookPoints.BEFORE_CREATE);

    registerLayaDecisionTaskHook(f.taskComponent, { decisionPort: port } as any);
    const afterFirst = globalHookManager.count(TaskHookPoints.BEFORE_CREATE);

    registerLayaDecisionTaskHook(f.taskComponent, { decisionPort: port } as any);
    const afterSecond = globalHookManager.count(TaskHookPoints.BEFORE_CREATE);

    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst); // ★ 第二次不再新增
  });

  // ==================================================================
  // fail-open：注入一个会抛异常的 port → task_create 仍必须成功
  // ==================================================================
  test("port throws → task_create still succeeds (fail-open)", async () => {
    const f = fixture!;
    const id1 = await seedTask(f, "候选一 封装 Laya 模型成 Jev 语义服务", "描述", ["laya"]);
    const id2 = await seedTask(f, "候选二 在 roy-bot 接入 Laya 决策端口", "描述", ["laya"]);

    const boomPort: DecisionPort = {
      async decide(): Promise<DecisionResponse> {
        throw new Error("simulated laya outage");
      },
      isDisabled: () => false,
    };
    registerLayaDecisionTaskHook(f.taskComponent, { decisionPort: boomPort } as any);

    const r: any = await f.tool.execute(
      {
        title: "新任务 触发 fail-open",
        description: "描述",
        tags: ["laya"],
        project_path: "/tmp/p",
        context: JSON.stringify({ type: "feature", similar_task_ids: [id1, id2] }),
      },
      { session_id: "s" } as any,
    );

    expect(r.success).toBe(true);
    expect(r.output).toContain("Task created successfully");
    expect(r.output).not.toContain("[TASK_CREATE_HINT]");
  });

  // ==================================================================
  // ★ RED 铁证：复现 #4620 的**原始注册方式**
  //   agentComponent.registerPlugin("default", plugin)
  //
  // 断言它**不会**在 globalHookManager 里留下任何 task:before.create 痕迹，
  //   → 证明「Agent Plugin 通道 ≠ task hook 通道」（Bug 1）。
  //
  // 这个测试在修复后**依然应该通过**（因为我们不再用那条路），
  //   它是「为什么旧写法不行」的永久护栏。
  // ==================================================================
  test("Agent Plugin registration (old #4620 path) does NOT reach task:before.create", async () => {
    const f = fixture!;
    const id1 = await seedTask(f, "候选一 封装 Laya 模型成 Jev 语义服务", "描述", ["laya"]);
    const id2 = await seedTask(f, "候选二 在 roy-bot 接入 Laya 决策端口", "描述", ["laya"]);

    // —— 复刻 #4620 的**原始 Agent Plugin 写法** ——
    // ⚠️ 这里刻意**不**用 createLayaDecisionPlugin()：那个工厂在 #4627 里已经
    //    改成 task-hook 形态了。要复现 bug 1 必须用**旧版 Agent Plugin 形态**
    //    （hooks: [{point, priority}] + execute 返回 HookResult）。
    const { AgentComponent } = await import("../../agent/agent-component");
    const agentComponent = new AgentComponent();
    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      options: { configComponent: new ConfigComponent() },
    } as any);
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: "test",
      deniedTools: [],
    } as any);

    const reqs: unknown[] = [];
    const port = portReturning("NEW_TASK", 0.99, reqs);
    const oldStyleAgentPlugin = {
      name: "laya-decision",
      version: "1.0.0",
      description: "Task #4467 — 旧版 Agent Plugin 形态",
      // ⚠️ `as HookPoint` 强转绕过 —— agent/types.ts 的 HookPoint 联合类型里
      //    **没有** "task:before.create"（旧代码正是这么绕过去的）
      hooks: [{ point: "task:before.create" as any, priority: 20 }],
      execute: async (_ctx: any) => {
        await port.decide({} as any);
        return { continue: true } as any; // ⚠️ HookResult 里没有 continue 字段
      },
    };
    agentComponent.registerPlugin("default", oldStyleAgentPlugin as any);

    const before = globalHookManager.count(TaskHookPoints.BEFORE_CREATE);

    // ★ Agent Plugin 通道**不会**写 globalHookManager
    expect(globalHookManager.count(TaskHookPoints.BEFORE_CREATE)).toBe(before);

    // 即使强行把它塞进 task hook 位（说明只有 task hook 能触发）
    // 老写法本身也做不到 —— 这里断言「老写法的产物不含 task hook 注册副作用」
    const r: any = await f.tool.execute(
      {
        title: "新任务 老注册路径",
        description: "描述",
        tags: ["laya"],
        project_path: "/tmp/p",
        context: JSON.stringify({ type: "feature", similar_task_ids: [id1, id2] }),
      },
      { session_id: "s" } as any,
    );
    expect(r.success).toBe(true);
    expect(reqs.length).toBe(0); // ← 老路径下模型**根本没被调用**
    expect(r.output).not.toContain("[TASK_CREATE_HINT]");
  });

  // ==================================================================
  // 共享实例：生产路径必须复用同一个插件实例
  // （否则 auth.json 反复读 + 熔断计数每次归零 → 熔断形同虚设）
  // ==================================================================
  test("production path reuses ONE plugin instance (auth read once, strikes accumulate)", async () => {
    // 不传 options → 走进程级共享缓存
    const { getSharedLayaDecisionPlugin } = await import("./laya-decision-plugin");
    const a = getSharedLayaDecisionPlugin();
    const b = getSharedLayaDecisionPlugin();
    expect(a).toBe(b); // ★ 同一个实例
    // 传了 options → 独立实例（测试隔离）
    const c = getSharedLayaDecisionPlugin({ timeoutMs: 1234 });
    expect(c).not.toBe(a);
  });

  // ==================================================================
  // 门禁读的是 x_jev_confidence（不是 confidence 归一化熵）
  // ==================================================================
  test("gate reads x_jev_confidence, NOT the normalized-entropy confidence", async () => {
    const f = fixture!;
    const id1 = await seedTask(f, "候选一 封装 Laya 模型成 Jev 语义服务", "描述", ["laya"]);
    const id2 = await seedTask(f, "候选二 在 roy-bot 接入 Laya 决策端口", "描述", ["laya"]);

    const reqs: unknown[] = [];
    // confidence（归一化熵）= 0.99 → 若误读它会出错 hint
    // x_jev_confidence（Jev 公式）= 0.5 → 正确读法应该 < 0.85 → 无 hint
    const port: DecisionPort = {
      async decide(req: any): Promise<DecisionResponse> {
        reqs.push(req);
        return {
          answers: {
            reuse_or_create: {
              choice: `#${id2} 候选二 在 roy-bot 接入 Laya 决策端口`,
              confidence: 0.99, // ← 归一化熵，**不该**用来过门禁
              x_jev_confidence: 0.5, // ← Jev 公式置信度，**应该**用它
            },
          },
        } as DecisionResponse;
      },
      isDisabled: () => false,
    };
    registerLayaDecisionTaskHook(f.taskComponent, { decisionPort: port } as any);

    const r: any = await f.tool.execute(
      {
        title: "新任务 置信度来源校验",
        description: "描述",
        tags: ["laya"],
        project_path: "/tmp/p",
        context: JSON.stringify({ type: "feature", similar_task_ids: [id1, id2] }),
      },
      { session_id: "s" } as any,
    );

    expect(reqs.length).toBe(1); // ★ 静默档**不进入 Stage B** → 只调 1 次模型
    expect(r.success).toBe(true);
    // x_jev_confidence = 0.5 < 0.85 → 必须**无 hint**
    expect(r.output).not.toContain("[TASK_CREATE_HINT]");
  });
});
