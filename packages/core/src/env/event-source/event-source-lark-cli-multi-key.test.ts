/**
 * Task #4339：lark-cli 多 EventKey 同时监听
 *
 * 背景（实测，lark-cli 1.0.98）：
 *   - `event consume` 只接受**恰好一个** EventKey；
 *   - 逗号多 key（`im.message.receive_v1,card.action.trigger`）→
 *     `unknown EventKey` → exit 2；
 *   - 通配符（`im.*`）→ 同上；
 *   - 所以"同时监听消息 + 卡片按钮" = **一个 key 一个子进程**，
 *     它们共享同一个 bus daemon（UDS）。
 *
 * 详见 reports/2026-10-19-lark-cli-multi-event-consume-research.md
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";

/** 假子进程：只实现 LarkCliInstance 用到的部分（stdout/stderr/on/kill/pid/killed） */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = Math.floor(Math.random() * 100000);
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killSignals: string[] = [];

  kill(signal?: string): boolean {
    this.killSignals.push(signal ?? "SIGTERM");
    this.killed = true;
    return true;
  }

  /** 模拟 lark-cli stderr 的 ready marker */
  emitReady(eventKey: string): void {
    this.stderr.emit("data", Buffer.from(`[event] ready event_key=${eventKey}\n`));
  }

  /** 模拟子进程退出 */
  emitExit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

/** 测试子类：拦截 spawn + bus 探测，全部离线 */
class TestableLarkCliInstance extends LarkCliInstance {
  created: Array<{ command: string; child: FakeChild }> = [];
  busyKeys: string[] = [];
  /** 测试收尾时释放"挂住的 agent 回合"，避免 afterEach 卡死 */
  autoRelease?: () => void;

  protected spawnConsumeChild(command: string): any {
    const child = new FakeChild();
    this.created.push({ command, child });
    return child;
  }

  protected async probeBusyEventKeys(): Promise<Set<string>> {
    return new Set(this.busyKeys);
  }

  commands(): string[] {
    return this.created.map((c) => c.command);
  }
}

function makeConfig(overrides: Partial<EventSourceConfig> = {}): EventSourceConfig {
  return {
    id: "src-1",
    name: "lark",
    type: "lark-cli",
    enabled: true,
    ...overrides,
  } as EventSourceConfig;
}

/**
 * start() 里有若干 await 点（loadPlugins / bus 探测），spawn 不是同步发生的。
 * 这里轮询等子进程被创建，再喂 `[event] ready` marker（等价于 lark-cli 正常启动），
 * 避免走 5s 的 ready 超时兜底。
 */
async function startAndReady(
  inst: TestableLarkCliInstance,
  expected: number
): Promise<void> {
  const p = inst.start();
  const deadline = Date.now() + 2000;
  while (inst.created.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1));
  }
  for (const c of inst.created) {
    const key = c.command.match(/event consume\s+(\S+)/)?.[1] ?? "k";
    c.child.emitReady(key);
  }
  await p;
}

// ============================================================================
// buildConsumeCommands（纯函数，核心决策点）
// ============================================================================

describe("buildConsumeCommands / Task #4339", () => {
  it("未配置 eventKeys / command → 默认单 key receive_v1（向后兼容）", () => {
    const inst = new TestableLarkCliInstance(makeConfig());
    expect(inst.buildConsumeCommands()).toEqual([
      "lark-cli event consume im.message.receive_v1 --as bot",
    ]);
  });

  it("profile 注入到命令头（多 appId 场景）", () => {
    const inst = new TestableLarkCliInstance(makeConfig({ profile: "tongzhuli" }));
    expect(inst.buildConsumeCommands()).toEqual([
      "lark-cli --profile tongzhuli event consume im.message.receive_v1 --as bot",
    ]);
  });

  it("★★★★ eventKeys 两个 key → 两条命令（一个 key 一个子进程）", () => {
    const inst = new TestableLarkCliInstance(
      makeConfig({
        profile: "tongzhuli",
        eventKeys: ["im.message.receive_v1", "card.action.trigger"],
      })
    );
    expect(inst.buildConsumeCommands()).toEqual([
      "lark-cli --profile tongzhuli event consume im.message.receive_v1 --as bot",
      "lark-cli --profile tongzhuli event consume card.action.trigger --as bot",
    ]);
    // 绝不能拼成逗号形式（lark-cli 会 unknown EventKey → exit 2）
    expect(inst.buildConsumeCommands().join(" ")).not.toContain(",");
  });

  it("eventKeys 里的空串/空白被过滤", () => {
    const inst = new TestableLarkCliInstance(
      makeConfig({ eventKeys: ["im.message.receive_v1", "  ", ""] })
    );
    expect(inst.buildConsumeCommands()).toHaveLength(1);
  });

  it("eventKeys 全为空白 → 退化为默认单 key（不产生空命令）", () => {
    const inst = new TestableLarkCliInstance(makeConfig({ eventKeys: ["", " "] }));
    expect(inst.buildConsumeCommands()).toEqual([
      "lark-cli event consume im.message.receive_v1 --as bot",
    ]);
  });

  it("显式 command 优先于默认值，且 profile 插在第一个 subcommand 前", () => {
    const inst = new TestableLarkCliInstance(
      makeConfig({
        profile: "zhishitong",
        command: "lark-cli event consume im.message.receive_v1 --as bot",
      })
    );
    expect(inst.buildConsumeCommands()).toEqual([
      "lark-cli --profile zhishitong event consume im.message.receive_v1 --as bot",
    ]);
  });

  it("eventKeys 优先于 command（显式多 key 覆盖单命令）", () => {
    const inst = new TestableLarkCliInstance(
      makeConfig({
        command: "lark-cli event consume im.message.receive_v1 --as bot",
        eventKeys: ["card.action.trigger"],
      })
    );
    expect(inst.buildConsumeCommands()).toEqual([
      "lark-cli event consume card.action.trigger --as bot",
    ]);
  });
});

// ============================================================================
// start() / stop() 生命周期
// ============================================================================

describe("多子进程生命周期 / Task #4339", () => {
  let instances: TestableLarkCliInstance[] = [];

  beforeEach(() => {
    instances = [];
  });

  afterEach(async () => {
    for (const inst of instances) {
      // 假子进程不会自己退出 —— 先标成已退出，否则 stop() 会等满优雅退出窗口
      inst.created.forEach((c) => c.child.emitExit(0));
      await inst.stop();
    }
  });

  function make(overrides: Partial<EventSourceConfig> = {}): TestableLarkCliInstance {
    const inst = new TestableLarkCliInstance(makeConfig(overrides));
    instances.push(inst);
    return inst;
  }

  it("eventKeys 两个 key → 真的 spawn 两个子进程，status=running", async () => {
    const inst = make({
      profile: "tongzhuli",
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });

    await startAndReady(inst, 2);

    expect(inst.commands()).toEqual([
      "lark-cli --profile tongzhuli event consume im.message.receive_v1 --as bot",
      "lark-cli --profile tongzhuli event consume card.action.trigger --as bot",
    ]);
    expect(inst.getStatus()).toBe("running");
  });

  it("任一子进程 exit 非 0（例如 exit 2 配置错误）→ status=error", async () => {
    const inst = make({ eventKeys: ["card.action.trigger"] });
    const p = inst.start();
    while (inst.created.length === 0) await new Promise((r) => setTimeout(r, 1));
    inst.created[0].child.emitExit(2);
    await p;

    expect(inst.getStatus()).toBe("error");
  });

  it("正常退出（code 0）不置 error", async () => {
    const inst = make({ eventKeys: ["card.action.trigger"] });
    await startAndReady(inst, 1);
    inst.created[0].child.emitExit(0);

    expect(inst.getStatus()).toBe("running");
  });

  it("stop() 对所有子进程发 SIGTERM，且子进程退出后立即返回（不固定等 5s）", async () => {
    const inst = make({
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });
    await startAndReady(inst, 2);

    const t0 = Date.now();
    const stopPromise = inst.stop();
    // 子进程收到 SIGTERM 后正常退出
    inst.created.forEach((c) => c.child.emitExit(0));
    await stopPromise;

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(inst.created.map((c) => c.child.killSignals)).toEqual([
      ["SIGTERM"],
      ["SIGTERM"],
    ]);
    expect(inst.getStatus()).toBe("stopped");
  });

  it("bus 已有同 key consumer 时打 warn（不阻塞启动）", async () => {
    const inst = make({ eventKeys: ["card.action.trigger"] });
    inst.busyKeys = ["card.action.trigger"];

    await startAndReady(inst, 1);

    expect(inst.getStatus()).toBe("running");
  });

  it("两个子进程各自的 buffer 不互相串行（NDJSON 不错拼）", async () => {
    const inst = make({
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });
    await startAndReady(inst, 2);

    const seen: string[] = [];
    inst.onEvent(((evt: any) => {
      seen.push(evt.metadata.sourceMessageType);
    }) as any);

    const childA = inst.created[0].child;
    const childB = inst.created[1].child;

    // 子进程 A 吐**半截** JSON（尚未换行）——不能污染 B 的行缓冲
    childA.stdout.emit("data", Buffer.from('{"type":"im.message.re'));

    // 子进程 B 吐一条完整合法的 receive 事件
    childB.stdout.emit(
      "data",
      Buffer.from(
        '{"type":"im.message.receive_v1","sender_id":"ou_x","chat_id":"oc_y","message_id":"om_z"}\n'
      )
    );

    await new Promise((r) => setTimeout(r, 100));

    // B 的事件必须被正确解析（若两个子进程共用一个 buffer，
    // 拼出来的行会是 A 的半截 + B 的整行 → 非法 JSON → 类型变 unknown）
    expect(seen).toEqual(["im.message.receive_v1"]);
  });
});

// ============================================================================
// 生产接线 & 健壮性
// ============================================================================

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("生产接线与健壮性 / Task #4339", () => {
  let instances: TestableLarkCliInstance[] = [];

  beforeEach(() => {
    instances = [];
  });

  afterEach(async () => {
    for (const inst of instances) {
      inst.created.forEach((c) => c.child.emitExit(0));
      await inst.stop();
    }
  });

  function make(overrides: Partial<EventSourceConfig> = {}): TestableLarkCliInstance {
    const inst = new TestableLarkCliInstance(makeConfig(overrides));
    instances.push(inst);
    return inst;
  }

  /** 造一个假的 task component（字段名与 core `Task` 实体一致） */
  function makeTaskComponent() {
    const updates: Array<[number, any]> = [];
    return {
      updates,
      component: {
        getTask: async (id: number) => ({
          id,
          title: "标题",
          description: "描述",
          goals_and_expected_deliverables: "目标 G1",
          priority: "high",
          type: "normal",
          project_path: "/proj",
          parent_task_id: 9,
          current_status: "进行中",
          context: '{"worktree_path":"/w"}',
        }),
        updateTask: async (id: number, opts: any) => {
          updates.push([id, opts]);
          return undefined as any;
        },
      },
    };
  }

  it("生产接线：goals_and_expected_deliverables → 端口 goals（否则卡片「🎯 目标」静默丢失）", async () => {
    const inst = make({ eventKeys: ["im.message.receive_v1"] });
    const { component, updates } = makeTaskComponent();
    inst.setEnvironment({
      getComponent: (name: string) => (name === "task" ? component : undefined),
    });

    await startAndReady(inst, 1);

    const ports = (inst as any).cardActionPorts;
    expect(inst.hasCardActionPorts()).toBe(true);

    const t = await ports.getTask(4339);
    // ★ 字段适配的核心断言
    expect(t.goals).toBe("目标 G1");
    expect(t.parent_task_id).toBe(9);
    expect(t.context).toBe('{"worktree_path":"/w"}');
    expect(t.current_status).toBe("进行中");

    await ports.updateTaskContext(4339, '{"larkPerTaskChatId":"oc_x"}');
    expect(updates).toEqual([[4339, { context: '{"larkPerTaskChatId":"oc_x"}' }]]);
  });

  it("外部已注入的 ports 不会被 start() 的默认 cross-wire 覆盖", async () => {
    const inst = make({ eventKeys: ["im.message.receive_v1"] });
    const { component } = makeTaskComponent();
    inst.setEnvironment({
      getComponent: (name: string) => (name === "task" ? component : undefined),
    });

    const custom: any = {
      getTask: async () => ({ id: 1, title: "custom", context: "{}" }),
      notifier: { updateMetaAndBuildCard: () => undefined },
    };
    inst.setCardActionPorts(custom);

    await startAndReady(inst, 1);

    expect((inst as any).cardActionPorts).toBe(custom);
  });

  it("stderr 里跨 chunk 到达的 JSON 事件不会丢", async () => {
    const inst = make({ eventKeys: ["im.message.receive_v1"] });
    await startAndReady(inst, 1);

    const seen: string[] = [];
    inst.onEvent(((evt: any) => {
      seen.push(evt.metadata.sourceMessageType);
    }) as any);

    const child = inst.created[0].child;
    // 一条 JSON 被切成两个 chunk
    child.stderr.emit("data", Buffer.from('{"type":"im.message.receive_'));
    child.stderr.emit(
      "data",
      Buffer.from('v1","sender_id":"ou_x","chat_id":"oc_y","message_id":"om_z"}\n')
    );

    await sleep(100);
    expect(seen).toEqual(["im.message.receive_v1"]);
  });

  it("所有子进程退出后状态变 stopped（不再对外谎报 running）", async () => {
    const inst = make({
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });
    await startAndReady(inst, 2);
    expect(inst.getStatus()).toBe("running");

    inst.created.forEach((c) => c.child.emitExit(0));
    await sleep(20);

    expect(inst.getStatus()).toBe("stopped");
  });

  it("只有一个子进程退出时仍保持 running（另一个还在监听）", async () => {
    const inst = make({
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });
    await startAndReady(inst, 2);

    inst.created[0].child.emitExit(0);
    await sleep(20);

    expect(inst.getStatus()).toBe("running");
  });

  it("并发调用 start() 不会重复 spawn 子进程", async () => {
    const inst = make({ eventKeys: ["im.message.receive_v1"] });

    const p1 = inst.start();
    const p2 = inst.start(); // 应被 starting 守卫拦下

    const deadline = Date.now() + 2000;
    while (inst.created.length < 1 && Date.now() < deadline) {
      await sleep(1);
    }
    inst.created.forEach((c) => c.child.emitReady("k"));
    await Promise.all([p1, p2]);

    expect(inst.created).toHaveLength(1);
  });
});

// ============================================================================
// ★ 关键性质：card.action.trigger 不能被"上一条飞书消息的 agent 回合"阻塞
// ============================================================================

describe("card action 即时处理（不被 agent 回合阻塞）/ Task #4339", () => {
  let instances: TestableLarkCliInstance[] = [];

  beforeEach(() => {
    instances = [];
  });

  afterEach(async () => {
    for (const inst of instances) {
      inst.autoRelease?.();
      // 假子进程不会自己退出 —— 先标成已退出，否则 stop() 会等满优雅退出窗口
      inst.created.forEach((c) => c.child.emitExit(0));
      await inst.stop();
    }
  });

  function make(overrides: Partial<EventSourceConfig> = {}): TestableLarkCliInstance {
    const inst = new TestableLarkCliInstance(makeConfig(overrides));
    instances.push(inst);
    return inst;
  }

  it("上一条消息的 agent 回合还没结束（永挂）时，卡片按钮依然被立即处理", async () => {
    const inst = make({
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });
    await startAndReady(inst, 2);

    // ── 模拟"上一条飞书消息正在跑 agent react，且迟迟不结束" ──
    let agentStarted = false;
    let agentFinished = false;
    let releaseAgent!: () => void;
    const agentGate = new Promise<void>((r) => {
      releaseAgent = r;
    });
    inst.autoRelease = releaseAgent;

    inst.onEvent(async () => {
      agentStarted = true;
      await agentGate; // 永不 resolve（直到测试收尾）
      agentFinished = true;
    });

    const msgChild = inst.created[0].child; // im.message.receive_v1
    const cardChild = inst.created[1].child; // card.action.trigger

    // 1) 先来一条普通消息 → 触发 agent 回合（挂住）
    msgChild.stdout.emit(
      "data",
      Buffer.from(
        '{"type":"im.message.receive_v1","sender_id":"ou_x","chat_id":"oc_y","message_id":"om_z","content":"hi"}\n'
      )
    );

    // 等 agent 真的进入"处理中"
    const deadline = Date.now() + 2000;
    while (!agentStarted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(agentStarted).toBe(true);
    expect(agentFinished).toBe(false); // 确实还挂在那里

    // 2) 卡片按钮被点 → 必须立刻处理，不能排队等 agent
    const handled: string[] = [];
    inst.setCardActionPorts({
      getTask: async () => ({ id: 4339, title: "t", context: "{}" }),
      updateTaskContext: async () => {},
      createGroupChat: async () => {
        handled.push("create_group");
        return "oc_new_group";
      },
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
      // 端口注入，避免真的 spawn lark-cli 去 patch 卡片
      patchByToken: async () => {
        handled.push("patch_card");
      },
    });

    cardChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "card.action.trigger",
          token: "tok",
          message_id: "om_card",
          chat_id: "oc_chat",
          operator_id: "ou_op",
          action_value: JSON.stringify({ action: "create_group", taskId: "4339" }),
        }) + "\n"
      )
    );

    // 给事件处理留出时间
    const cardDeadline = Date.now() + 2000;
    while (handled.length < 2 && Date.now() < cardDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // ★ 核心断言：agent 还挂着，卡片动作已经跑完了
    expect(agentFinished).toBe(false);
    expect(handled).toEqual(["create_group", "patch_card"]);

    releaseAgent();
  });

  it("card.action.trigger 不会进入 eventHandler（= 不进 EventHandler 的串行队列）", async () => {
    const inst = make({
      eventKeys: ["im.message.receive_v1", "card.action.trigger"],
    });
    await startAndReady(inst, 2);

    const seenTypes: string[] = [];
    inst.onEvent(((evt: any) => {
      seenTypes.push(evt.metadata.sourceMessageType);
    }) as any);

    inst.setCardActionPorts({
      getTask: async () => ({ id: 1, title: "t", context: "{}" }),
      updateTaskContext: async () => {},
      createGroupChat: async () => "oc_new",
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
      patchByToken: async () => {},
    });

    const cardChild = inst.created[1].child;
    cardChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "card.action.trigger",
          token: "tok",
          message_id: "om_card",
          chat_id: "oc_chat",
          action_value: JSON.stringify({ action: "create_group", taskId: "1" }),
        }) + "\n"
      )
    );

    await new Promise((r) => setTimeout(r, 100));

    // eventHandler 只应看到普通消息，绝不应看到 card.action.trigger
    expect(seenTypes).toEqual([]);
  });
});
