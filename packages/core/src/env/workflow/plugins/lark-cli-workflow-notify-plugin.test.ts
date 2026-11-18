/**
 * @fileoverview LarkCliWorkflowNotifyHook — RED/GREEN contract
 *
 * 目标：把 workflow run 的进展同步到飞书群，**复用任务进展卡片的样式与逻辑**：
 *   - `workflow:before.run`  → notifier.startWorkflow（发卡 + pin）
 *   - `workflow:before.node` → notifier.updateWorkflow（patch 同一卡片）
 *   - `workflow:after.node`  → notifier.updateWorkflow（patch 同一卡片 + 进度/里程碑）
 *   - `workflow:after.run`   → notifier.finishWorkflow（终态 patch + unpin）
 *
 * 断言口径：
 *   1. 4 个 hook 点各自被正确分发（载荷从 `ctx.data` 读取，不是 `ctx` 本身）
 *   2. 同一 runId 全程复用同一个 messageId（不重复建卡、不刷屏）
 *   3. after.run 终态 status 正确（completed/failed/stopped）
 *   4. 取不到 replyChannel / chatId 时安全跳过（不抛错、不调 lark-cli）
 *   5. pluginEnabled["<sourceId>:<pluginName>"] 未启用 → 整插件跳过
 *
 * ⚠️ 关键契约：`globalHookManager.execute(point, data, metadata)` 会把 data 包进
 *    `HookContext`；hook 的 execute 第 1 个参数是 ctx，载荷在 `ctx.data`。
 *
 * 测试不真的调用 lark-cli：每个用例注入一个方法被 mock 的 LarkCardPatchNotifier。
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  LarkCliWorkflowNotifyHook,
  createLarkCliWorkflowNotifyHook,
} from "./lark-cli-workflow-notify-plugin";
import { LarkCardPatchNotifier } from "../../task/plugins/lark-card-patch-notifier";
import { WorkflowHookPoints } from "../hooks/workflow-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  WorkflowRunHookData,
  WorkflowNodeHookData,
} from "../hooks/workflow-hook-points";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Test helpers
// ============================================================================

const SOURCE_ID = "es-wf-1";
const PLUGIN_NAME = "LarkCliWorkflowNotifyPlugin";

function makeReplyChannel(overrides: Partial<any> = {}): any {
  return {
    type: "lark-cli",
    chatId: "oc_wf_chat",
    messageId: "om_trigger_msg",
    profile: "wf-profile",
    ...overrides,
  };
}

function makeEnvContext(overrides: Partial<EnvContext> = {}): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: SOURCE_ID,
    userId: "ou_test",
    replyChannel: makeReplyChannel(),
    pluginEnabled: { [`${SOURCE_ID}:${PLUGIN_NAME}`]: true },
    ...overrides,
  } as unknown as EnvContext;
}

function makeHookContext<T>(hookPoint: string, data: T): HookContext<T> {
  return {
    component: { name: "workflow", version: "1.0.0" },
    data,
    metadata: {},
    phase: hookPoint.includes("before") ? "before" : "after",
    hookPoint,
  };
}

/** mock 掉 notifier 的三个 workflow 方法（不污染 prototype） */
function makeMockNotifier() {
  const notifier = new LarkCardPatchNotifier();
  (notifier as any).startWorkflow = mock(async () => ({
    messageId: "om_wf_card",
    pinned: true,
  }));
  (notifier as any).updateWorkflow = mock(async () => {});
  (notifier as any).finishWorkflow = mock(async () => {});
  return notifier;
}

function runPayload(overrides: Partial<WorkflowRunHookData> = {}): WorkflowRunHookData {
  return {
    runId: "workflow_run_1",
    sessionId: "workflow_run_1",
    workflowId: "wf-def-1",
    workflowName: "发版流程",
    status: "running",
    input: { branch: "main" },
    totalNodes: 3,
    completedNodes: 0,
    ...overrides,
  };
}

function nodePayload(overrides: Partial<WorkflowNodeHookData> = {}): WorkflowNodeHookData {
  return {
    runId: "workflow_run_1",
    sessionId: "workflow_run_1",
    workflowName: "发版流程",
    nodeId: "n1",
    nodeType: "agent",
    status: "running",
    totalNodes: 3,
    completedNodes: 1,
    ...overrides,
  };
}

function newHook(notifier: LarkCardPatchNotifier, extra: Record<string, unknown> = {}) {
  return new LarkCliWorkflowNotifyHook({
    pluginName: PLUGIN_NAME,
    sourceId: SOURCE_ID,
    cardNotifier: notifier,
    nodeThrottleMs: 0,
    ...extra,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("LarkCliWorkflowNotifyHook - 分发 + 单卡片语义", () => {
  let notifier: LarkCardPatchNotifier;
  beforeEach(() => {
    notifier = makeMockNotifier();
  });

  it("workflow:before.run → startWorkflow（chatId 取 replyChannel，标题含 workflow 名）", async () => {
    const hook = newHook(notifier);
    const ctx = makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload());

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(ctx);
    });

    expect((notifier as any).startWorkflow).toHaveBeenCalledTimes(1);
    const call = ((notifier as any).startWorkflow as any).mock.calls[0][0];
    expect(call.chatId).toBe("oc_wf_chat");
    expect(call.profile).toBe("wf-profile");
    expect(call.meta.runId).toBe("workflow_run_1");
    expect(call.meta.workflowName).toBe("发版流程");
    expect(call.totalNodes).toBe(3);
  });

  it("workflow:before.node / after.node → updateWorkflow 复用同一 messageId（载荷从 ctx.data）", async () => {
    const hook = newHook(notifier);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(
        makeHookContext(WorkflowHookPoints.BEFORE_NODE, nodePayload({ nodeId: "n1" }))
      );
      await hook.execute(
        makeHookContext(
          WorkflowHookPoints.AFTER_NODE,
          nodePayload({ nodeId: "n1", status: "completed" })
        )
      );
    });

    // 只建一张卡
    expect((notifier as any).startWorkflow).toHaveBeenCalledTimes(1);
    expect((notifier as any).updateWorkflow).toHaveBeenCalledTimes(2);

    const u1 = ((notifier as any).updateWorkflow as any).mock.calls[0][0];
    const u2 = ((notifier as any).updateWorkflow as any).mock.calls[1][0];
    expect(u1.messageId).toBe("om_wf_card");
    expect(u2.messageId).toBe("om_wf_card");
    // 节点进度取自 ctx.data 的 completedNodes/totalNodes
    expect(u2.completedNodes).toBe(1);
    expect(u2.totalNodes).toBe(3);
  });

  it("同一 runId 建卡只发生一次（重复 before.run 复用 messageId，不刷屏）", async () => {
    const hook = newHook(notifier);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
    });

    expect((notifier as any).startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("不同 runId → 各自独立建卡（互不干扰）", async () => {
    const hook = newHook(notifier);
    (notifier as any).startWorkflow = mock(async (opts: any) => ({
      messageId: `om_${opts.meta.runId}`,
      pinned: true,
    }));

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(
        makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload({ runId: "r1", sessionId: "r1" }))
      );
      await hook.execute(
        makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload({ runId: "r2", sessionId: "r2" }))
      );
    });

    expect((notifier as any).startWorkflow).toHaveBeenCalledTimes(2);
  });

  it("workflow:after.run completed → finishWorkflow(completed) 且清理 messageId 跟踪", async () => {
    const hook = newHook(notifier);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(
        makeHookContext(
          WorkflowHookPoints.AFTER_RUN,
          runPayload({ status: "completed", completedNodes: 3, durationMs: 1234 })
        )
      );
      // 终态后再来一次（引擎不应发生，但插件要幂等：不重复建卡/finish）
      await hook.execute(makeHookContext(WorkflowHookPoints.AFTER_RUN, runPayload({ status: "completed" })));
    });

    expect((notifier as any).finishWorkflow).toHaveBeenCalledTimes(1);
    const call = ((notifier as any).finishWorkflow as any).mock.calls[0][0];
    expect(call.messageId).toBe("om_wf_card");
    expect(call.status).toBe("completed");
    expect(call.completedNodes).toBe(3);
    expect(call.durationMs).toBe(1234);
    // 跟踪项已清理（诊断用）
    expect((hook as any).cardMessageIds.size).toBe(0);
  });

  it.each([
    ["failed", "failed"],
    ["stopped", "stopped"],
    ["completed", "completed"],
  ])("workflow:after.run status=%s → finishWorkflow(%s)", async (runStatus, expected) => {
    const hook = newHook(notifier);
    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(
        makeHookContext(
          WorkflowHookPoints.AFTER_RUN,
          runPayload({
            status: runStatus as any,
            error: runStatus === "failed" ? "boom" : undefined,
            stopReason: runStatus === "stopped" ? "user stop" : undefined,
          })
        )
      );
    });

    const call = ((notifier as any).finishWorkflow as any).mock.calls[0][0];
    expect(call.status).toBe(expected);
  });

  it("after.run failed 把 error 透传给卡片", async () => {
    const hook = newHook(notifier);
    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(
        makeHookContext(
          WorkflowHookPoints.AFTER_RUN,
          runPayload({ status: "failed", error: "节点 n2 崩溃" })
        )
      );
    });

    const call = ((notifier as any).finishWorkflow as any).mock.calls[0][0];
    expect(call.error).toContain("节点 n2 崩溃");
  });
});

describe("LarkCliWorkflowNotifyHook - 安全跳过 + 门控", () => {
  it("取不到 replyChannel.chatId → 安全跳过（不抛错、不调 notifier）", async () => {
    const notifier = makeMockNotifier();
    const hook = newHook(notifier);

    const env = makeEnvContext({ replyChannel: undefined as any });
    await runWithEnvContext(env, async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_NODE, nodePayload()));
      await hook.execute(
        makeHookContext(WorkflowHookPoints.AFTER_RUN, runPayload({ status: "completed" }))
      );
    });

    expect((notifier as any).startWorkflow).not.toHaveBeenCalled();
    expect((notifier as any).updateWorkflow).not.toHaveBeenCalled();
    expect((notifier as any).finishWorkflow).not.toHaveBeenCalled();
  });

  it("完全没有 ALS env context → 安全跳过（不抛错）", async () => {
    const notifier = makeMockNotifier();
    const hook = newHook(notifier);

    // 不在 runWithEnvContext 中执行 → getEnvContextOrEmpty() 返回 {}
    await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));

    expect((notifier as any).startWorkflow).not.toHaveBeenCalled();
  });

  it("pluginEnabled[<sourceId>:<pluginName>] 未启用 → 整插件跳过", async () => {
    const notifier = makeMockNotifier();
    const hook = newHook(notifier);

    const env = makeEnvContext({
      pluginEnabled: { [`${SOURCE_ID}:${PLUGIN_NAME}`]: false },
    });
    await runWithEnvContext(env, async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
    });

    expect((notifier as any).startWorkflow).not.toHaveBeenCalled();
  });

  it("startWorkflow 抛错 → 不崩溃，打失败哨兵，后续 update 不重试建卡", async () => {
    const notifier = makeMockNotifier();
    const startSpy = mock(async () => {
      throw new Error("lark-cli exploded");
    });
    (notifier as any).startWorkflow = startSpy;
    const hook = newHook(notifier);

    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_RUN, runPayload()));
      await hook.execute(makeHookContext(WorkflowHookPoints.BEFORE_NODE, nodePayload()));
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect((notifier as any).updateWorkflow).not.toHaveBeenCalled();
  });
});

describe("LarkCliWorkflowNotifyHook - 注册契约", () => {
  it("暴露 4 个 workflow hook 点（供 event-source-handlers.getPluginHookPoints 读取）", () => {
    const hook = createLarkCliWorkflowNotifyHook({});
    const points = (hook as any).hookPoints as string[];
    expect(points).toContain(WorkflowHookPoints.BEFORE_RUN);
    expect(points).toContain(WorkflowHookPoints.AFTER_RUN);
    expect(points).toContain(WorkflowHookPoints.BEFORE_NODE);
    expect(points).toContain(WorkflowHookPoints.AFTER_NODE);
    expect(points).toHaveLength(4);
  });

  it("工厂函数返回 Hook 实例（name/priority/pluginName/sourceId 齐全）", () => {
    const hook = createLarkCliWorkflowNotifyHook({
      pluginName: PLUGIN_NAME,
      sourceId: SOURCE_ID,
    });
    expect(hook.name).toBe(PLUGIN_NAME);
    expect(typeof hook.execute).toBe("function");
    expect(hook.pluginName).toBe(PLUGIN_NAME);
    expect(hook.sourceId).toBe(SOURCE_ID);
    expect(typeof hook.priority).toBe("number");
  });
});
