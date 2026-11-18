/**
 * @fileoverview TDD — Task #4983 补漏：workflow 路径的 ask_user 不该双发
 *
 * ## 为什么补这个（review 自查发现的真实缺陷）
 *
 * 本次修复给 `ask_user` 工具加了「抛错前把问题投到 IM 渠道」的能力。
 * 但 **workflow 路径**有自己的呈现通道：
 *
 *   ask_user → AskUserError → agent-component-adapter 重建并重抛
 *     → executor catch → engine 的 `node.interrupt`
 *     → session metadata.pendingAskUserQuery
 *     → workflow_run 工具返回 `status: 'paused'` + `query`
 *     → CLI 的 `renderRunResult` 渲染「💬 Agent asked: <问题>」
 *
 * ⇒ 若工具层也投一次 IM ⇒ **用户收到两条**同样的问题。
 * ⇒ workflow 路径必须显式关闭工具层投递（`askUserDelivery: 'off'`）。
 *
 * ## 第二个缺陷：delivered 标记在 workflow 路径丢失
 *
 * `agent-component-adapter.ts` 重建 `AskUserError` 时**没有透传 `delivered`**
 * ⇒ CLI 兜底层读到 `delivered=false` ⇒ **再投一次** ⇒ 双发。
 *
 * ## 测试范围（R4：全部改为**行为断言** + bun:test，不再做源码正则）
 *
 *   RED-1  adapter 构造的 context.metadata.askUserDelivery === 'off'
 *          （行为：mock agentComponent.run 抓取传入 context）
 *   RED-2  workflow 路径重建 AskUserError 时透传 delivered
 *          （行为：mock run 抛 __ASK_USER_ERROR__，断言重抛的
 *          AskUserError.delivered 与载荷一致）
 *   RED-3  AskUserError 的 delivered 默认值是 false（向后兼容）
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { AskUserError } from "../types/workflow-hil";
import { AgentComponentAdapter } from "./agent-component-adapter";
import type { AgentComponent } from "../../agent/agent-component";

// ============================================================================
// 脚手架：用最小 stub 构造 AgentComponentAdapter，抓取 run 传参 / 控制 run 行为
// ============================================================================

function makeAdapter(runImpl: (name: string, query: any, ctx: any) => Promise<any>) {
  const runSpy = vi.fn(runImpl);
  const adapter = new AgentComponentAdapter(
    { run: runSpy } as unknown as AgentComponent,
    {},
    // sessionComponent：不需要真实创建（stub 空实现即可）
    {
      getContext: vi.fn(async () => ({ messages: [], checkpoint: undefined })),
      create: vi.fn(async () => { throw new Error("no-create-in-test"); }),
      get: vi.fn(),
      update: vi.fn(),
      addMessage: vi.fn(),
    } as any,
  );
  return { adapter, runSpy };
}

const AGENT_CONFIG = {
  type: "general",
  prompt: "do something",
  nodeId: "node-1",
} as any;

describe("Task #4983 — workflow 路径的 ask_user 双发防护（行为断言）", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // ------------------------------------------------------------------
  // RED-1：workflow agent 的 context.metadata 必须显式关闭工具层投递
  // ------------------------------------------------------------------
  it("RED-1: adapter 传给 agentComponent.run 的 context.metadata.askUserDelivery === 'off'", async () => {
    let capturedCtx: any;
    const { adapter } = makeAdapter(async (_n, _q, ctx) => {
      capturedCtx = ctx;
      return { iterations: 1, toolCalls: [], finalText: "ok" };
    });

    await adapter.run(AGENT_CONFIG);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.metadata).toBeDefined();
    // ★ 行为断言：workflow 路径关闭工具层 IM 直投
    //   （否则用户会收到「CLI 渲染」+「IM」两条同样的问题）
    expect(capturedCtx.metadata.askUserDelivery).toBe("off");
    });

  // ------------------------------------------------------------------
  // RED-2：workflow 路径重建 AskUserError 时透传 delivered
  // ------------------------------------------------------------------
  it("RED-2: run 抛 __ASK_USER_ERROR__(delivered:true) ⇒ adapter 重抛的 AskUserError.delivered === true", async () => {
    const payload = JSON.stringify({
      query: "需要用户确认",
      sessionId: "agent_s1",
      nodeId: "node-1",
      nodeType: "agent",
      agentSessionId: "agent_x",
      delivered: true,
    });

    const { adapter } = makeAdapter(async () => {
      return {
        iterations: 2,
        toolCalls: [],
        finalText: undefined,
        error: `__ASK_USER_ERROR__:${payload}`,
      };
    });

    const err = await adapter
      .run(AGENT_CONFIG)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    expect(err.query).toBe("需要用户确认");
    // ★ 行为断言：delivered 必须透传（丢掉 ⇒ CLI 兜底再投 ⇒ 双发）
    expect(err.delivered).toBe(true);
  });

  it("RED-2b: run 抛 __ASK_USER_ERROR__(delivered:false) ⇒ 重抛的 AskUserError.delivered === false", async () => {
    const payload = JSON.stringify({
      query: "工具层没投成",
      sessionId: "agent_s2",
      nodeId: "node-2",
      nodeType: "agent",
      agentSessionId: undefined,
      delivered: false,
    });

    const { adapter } = makeAdapter(async () => {
      return {
        iterations: 2,
        toolCalls: [],
        finalText: undefined,
        error: `__ASK_USER_ERROR__:${payload}`,
      };
    });

    const err = await adapter
      .run(AGENT_CONFIG)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(AskUserError);
    expect(err.delivered).toBe(false);
  });

  // ------------------------------------------------------------------
  // RED-3：AskUserError 的 delivered 默认值是 false（向后兼容）
  // ------------------------------------------------------------------
  it("RED-3: AskUserError 的 delivered 默认值是 false", () => {
    const err = new AskUserError("r", "s", "n", "agent", "q");
    expect(err.delivered).toBe(false);

    const delivered = new AskUserError("r", "s", "n", "agent", "q", undefined, undefined, true);
    expect(delivered.delivered).toBe(true);
  });
});
