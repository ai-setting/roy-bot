/**
 * @fileoverview QueryExecutor per-session 作用域测试 (Task #4486 Phase 3)
 *
 * 核心语义（TDD）：
 * 1. `setSessionScope(sessionId)` 把 sessionId 透传给 StreamOutputService
 *    的 session 过滤 + runId（per-run abort 隔离）。
 * 2. 作用域可在 streamService 创建前设置（pending 缓存），创建时自动应用。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { QueryExecutor } from "./query-executor";
import { OutputService } from "../../services/output.service";
import {
  StreamOutputService,
  resetStreamAbort,
  abortStream,
  __resetAllStreamAbortForTest,
} from "../../services/stream-output.service";

function makeExecutor() {
  const mockEnv = {
    subscribeTo: vi.fn().mockReturnValue(vi.fn()),
    getComponent: vi.fn(),
  };
  const mockSession = { setSummaryComponents: vi.fn() };
  const output = new OutputService();
  output.configure({ quiet: true });
  return new QueryExecutor({
    env: mockEnv as any,
    sessionComponent: mockSession as any,
    output,
    quiet: true,
    silent: true,
  });
}

function llmText(delta: string, sessionId?: string) {
  return {
    type: "llm.text",
    payload: { delta },
    ...(sessionId ? { metadata: { sessionId } } : {}),
  } as any;
}

describe("Task #4486 Phase 3: QueryExecutor per-session scope", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  afterEach(() => {
    __resetAllStreamAbortForTest();
  });

  test("setSessionScope 在 streamService 创建前设置会被缓存，创建后生效", () => {
    const qe = makeExecutor();
    const chunks: any[] = [];

    // 先设 scope + chunk callback（都早于 subscribeToEvents）
    qe.setSessionScope("sess_A");
    qe.setChunkCallback((e) => chunks.push(e));

    qe.subscribeToEvents({ showReasoning: false, showToolCalls: false, showToolResults: false });

    const svc = (qe as any).streamService as StreamOutputService;
    expect(svc).toBeTruthy();

    // 本 session 事件被接受，别的 session 被过滤
    svc.handleEvent(llmText("mine", "sess_A"));
    svc.handleEvent(llmText("other", "sess_B"));

    expect(chunks.filter((c) => c.type === "llm.text").map((c) => c.delta)).toEqual(["mine"]);

    qe.dispose();
  });

  test("streamService 已存在时 setSessionScope 立即生效", () => {
    const qe = makeExecutor();
    qe.subscribeToEvents({ showReasoning: false, showToolCalls: false, showToolResults: false });
    const svc = (qe as any).streamService as StreamOutputService;

    const chunks: any[] = [];
    qe.setChunkCallback((e) => chunks.push(e));

    qe.setSessionScope("sess_X");
    svc.handleEvent(llmText("x", "sess_X"));
    svc.handleEvent(llmText("y", "sess_Y"));

    expect(chunks.filter((c) => c.type === "llm.text").map((c) => c.delta)).toEqual(["x"]);

    qe.dispose();
  });

  test("setSessionScope 同时绑定 runId → 只受自己 run 的 abort 影响", () => {
    const qe = makeExecutor();
    const chunks: any[] = [];
    qe.setSessionScope("sess_A");
    qe.setChunkCallback((e) => chunks.push(e));
    qe.subscribeToEvents({ showReasoning: false, showToolCalls: false, showToolResults: false });

    const svc = (qe as any).streamService as StreamOutputService;

    // 别的 run 被 abort → 不影响我
    abortStream("sess_B");
    svc.handleEvent(llmText("still-works", "sess_A"));
    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(1);

    // 自己被 abort → 停下
    abortStream("sess_A");
    svc.handleEvent(llmText("blocked", "sess_A"));
    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(1);

    qe.dispose();
  });

  test("未设置 scope 时保持旧行为（不过滤、全局 abort）", () => {
    const qe = makeExecutor();
    const chunks: any[] = [];
    qe.setChunkCallback((e) => chunks.push(e));
    qe.subscribeToEvents({ showReasoning: false, showToolCalls: false, showToolResults: false });

    const svc = (qe as any).streamService as StreamOutputService;
    svc.handleEvent(llmText("a", "sess_A"));
    svc.handleEvent(llmText("b", "sess_B"));

    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(2);

    qe.dispose();
  });
});
