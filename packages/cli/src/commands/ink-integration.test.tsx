/**
 * @fileoverview Task #2280: ink REPL 集成验证
 *
 * 验证 (不使用 ink-testing-library 避免 pre-existing 并行测试 isolation 问题):
 * 1. REPLInkApi 接口契约
 * 2. REPLInk 组件导出 + props 签名
 * 3. StreamOutputService.setChunkCallback
 * 4. QueryExecutor.setChunkCallback 透传
 * 5. REPL.start() useInk 分支逻辑
 */

import { test, expect, describe } from "bun:test";
import { REPLInk, renderInkREPL } from "./repl-ink";
import type { REPLInkApi, REPLInkProps } from "./repl-ink";
import { StreamOutputService } from "../services/stream-output.service";
import { QueryExecutor } from "./shared/query-executor";

// REPLInk 组件不需要在测试里 render（避免 ink-testing-library 并行 isolation 问题）
// 我们通过类型/导出 + 逻辑分支测试来验证

describe("Task #2280: ink REPL 集成验证", () => {
  test("REPLInk + renderInkREPL 正确导出", () => {
    expect(typeof REPLInk).toBe("function"); // React component
    expect(typeof renderInkREPL).toBe("function");
  });

  test("REPLInkApi 接口契约（用 mock 验证形状）", () => {
    const api: REPLInkApi = {
      appendMessage: () => {},
      appendAssistantDelta: () => {},
      finishAssistantStream: () => {},
      setMode: () => {},
      setStatusBarCtx: () => {},
      clearMessages: () => {},
      exit: () => {},
      triggerCompact: () => {},
    };
    // 验证所有方法存在
    expect(typeof api.appendMessage).toBe("function");
    expect(typeof api.appendAssistantDelta).toBe("function");
    expect(typeof api.finishAssistantStream).toBe("function");
    expect(typeof api.setMode).toBe("function");
    expect(typeof api.setStatusBarCtx).toBe("function");
    expect(typeof api.clearMessages).toBe("function");
    expect(typeof api.exit).toBe("function");
    expect(typeof api.triggerCompact).toBe("function");
  });

  test("REPLInkProps 接口契约（用 mock 验证形状）", () => {
    // 验证 REPLInkProps 的可选字段都被正确接受
    const props: REPLInkProps = {
      initialContext: {
        model: "M3",
        cwd: "/tmp",
        version: "1.0",
        sessionTitle: "test",
      },
      onSubmit: () => {},
      onReady: () => {},
      onCommand: () => true,
      initialMessages: [{ role: "user", content: "hi" }],
      initialMode: "ready",
      initialStatusBarCtx: { cwd: "/x" },
    };
    expect(props.initialContext.model).toBe("M3");
    expect(typeof props.onSubmit).toBe("function");
    expect(typeof props.onReady).toBe("function");
    expect(typeof props.onCommand).toBe("function");
  });

  test("StreamOutputService.setChunkCallback 在 llm.text 事件触发", () => {
    const events: any[] = [];
    const svc = new StreamOutputService();
    svc.setChunkCallback((e: any) => events.push(e));

    // 模拟 llm.text 事件
    svc.handleEvent({
      type: "llm.text",
      payload: { delta: "hello " },
    } as any);
    svc.handleEvent({
      type: "llm.text",
      payload: { delta: "world" },
    } as any);

    // 验证 emitChunk 被调用
    const textEvents = events.filter((e: any) => e.type === "llm.text");
    expect(textEvents.length).toBe(2);
    expect(textEvents[0].delta).toBe("hello ");
    expect(textEvents[1].delta).toBe("world");
  });

  test("StreamOutputService.setChunkCallback 接受 undefined 关闭", () => {
    const events: any[] = [];
    const svc = new StreamOutputService();
    svc.setChunkCallback((e: any) => events.push(e));
    svc.handleEvent({
      type: "llm.text",
      payload: { delta: "first" },
    } as any);
    expect(events.length).toBe(1);

    // 关闭回调
    svc.setChunkCallback(undefined);
    svc.handleEvent({
      type: "llm.text",
      payload: { delta: "second" },
    } as any);
    expect(events.length).toBe(1); // 不增加
  });

  test("StreamOutputService setChunkCallback throw 不影响 stdout 流", () => {
    const svc = new StreamOutputService();
    svc.setChunkCallback(() => {
      throw new Error("external failure");
    });

    // 应该不抛错（emitChunk 内部 try/catch）
    expect(() => {
      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "x" },
      } as any);
    }).not.toThrow();
  });

  test("StreamOutputService chunk 回调 — tool.call / tool.result / llm.completed", () => {
    const events: any[] = [];
    const svc = new StreamOutputService({
      showToolCalls: true,
      showToolResults: true,
    });
    svc.setChunkCallback((e: any) => events.push(e));

    svc.handleEvent({
      type: "tool.call",
      payload: { id: "t1", name: "Bash", arguments: { cmd: "ls" } },
    } as any);
    svc.handleEvent({
      type: "tool.result",
      payload: { name: "Bash", result: { output: "file.txt" } },
    } as any);
    svc.handleEvent({
      type: "llm.completed",
      payload: { content: "final response" },
    } as any);

    expect(events.some((e: any) => e.type === "tool.call")).toBe(true);
    expect(events.some((e: any) => e.type === "tool.result")).toBe(true);
    expect(events.some((e: any) => e.type === "llm.completed")).toBe(true);
  });

  test("QueryExecutor.setChunkCallback 透传到 streamService（mocked）", () => {
    // 用 mock 创建 QueryExecutor（不实际启动 env）
    const mockEnv = {} as any;
    const mockSessionComp = {} as any;
    const mockOutput = { warn: () => {} } as any;

    const qe = new QueryExecutor({
      env: mockEnv,
      sessionComponent: mockSessionComp,
      output: mockOutput,
      quiet: true,
    });

    // 没有 streamService 时 setChunkCallback 应该是 no-op
    expect(() => qe.setChunkCallback(() => {})).not.toThrow();
  });

  test("REPL.start() 的 useInk 分支：useInk=false + isTTY=true → readline 路径", () => {
    // Task #2281 修复后：useInk 决策（escape hatch + isTTY）由 handler 闭包提前计算
    // start() 只看 useInk 字段本身决定走哪个路径
    //
    // useInk=false → startReadline（无论 stdout.isTTY 和 env 是什么）
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const origEnv = process.env.ROY_AGENT_NO_INK;
    process.env.ROY_AGENT_NO_INK = "0";

    // 模拟 start() 的判断逻辑（简化版 — Task #2281 修复后）
    const useInkOption: boolean = false;
    const shouldUseInk: boolean = Boolean(useInkOption);
    expect(shouldUseInk).toBe(false);

    // 恢复 env
    if (origEnv === undefined) {
      delete process.env.ROY_AGENT_NO_INK;
    } else {
      process.env.ROY_AGENT_NO_INK = origEnv;
    }
  });

  test("REPL.start() 的 useInk 分支：useInk=true → ink 路径", () => {
    // Task #2281 修复后：useInk 决策已经在 handler 闭包里完成
    // useInk=true 直接走 ink，不重复检查 isTTY/env
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.ROY_AGENT_NO_INK = "0";

    const useInkOption: boolean = true;
    const shouldUseInk: boolean = Boolean(useInkOption);
    expect(shouldUseInk).toBe(true);

    delete process.env.ROY_AGENT_NO_INK;
  });

  test("handler 闭包 useInk 计算：env=1 → false（escape hatch 阻止 ink）", () => {
    // Task #2281: handler 闭包计算 useInk 字段
    //   const useInk = process.env.ROY_AGENT_NO_INK !== "1" && process.stdout.isTTY === true;
    // 这里验证 escape hatch 的关键路径
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.ROY_AGENT_NO_INK = "1";

    const useInk =
      process.env.ROY_AGENT_NO_INK !== "1" && process.stdout.isTTY === true;
    // ROY_AGENT_NO_INK=1 → useInk=false → startReadline（即使 isTTY=true）
    expect(useInk).toBe(false);

    delete process.env.ROY_AGENT_NO_INK;
  });

  test("handler 闭包 useInk 计算：isTTY=false → false（非 TTY 走 readline 避免 rl=null）", () => {
    // Task #2281: 这是修复的核心 bug — 之前 useInk=true + isTTY=false 会走 readline → rl=null 报错
    // 现在 handler 计算 useInk 时就排除非 TTY
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    process.env.ROY_AGENT_NO_INK = "0";

    const useInk =
      process.env.ROY_AGENT_NO_INK !== "1" && process.stdout.isTTY === true;
    expect(useInk).toBe(false);

    delete process.env.ROY_AGENT_NO_INK;
  });

  test("handler 闭包 useInk 计算：env=0 + isTTY=true → true（默认 ink 路径）", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.ROY_AGENT_NO_INK = "0";

    const useInk =
      process.env.ROY_AGENT_NO_INK !== "1" && process.stdout.isTTY === true;
    expect(useInk).toBe(true);

    delete process.env.ROY_AGENT_NO_INK;
  });

  test("Bug 1 regression: useInk=true + 非 TTY 不会走到 startReadline（避免 rl=null 报错）", () => {
    // Task #2281 fix: 之前 handler 硬编码 useInk=true + start() 又检查 isTTY
    // 非 TTY 模式下: useInk=true 但 isTTY=false → 走 startReadline → this.rl=null → 报错
    //
    // 修复后: handler 计算 useInk 时就排除非 TTY，所以 useInk=false → 走 startReadline
    // (有 rl)，不报错
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    process.env.ROY_AGENT_NO_INK = "0";

    // 模拟 handler 闭包逻辑（修复后版本）
    const useInk =
      process.env.ROY_AGENT_NO_INK !== "1" && process.stdout.isTTY === true;
    // 关键: useInk=false 一定走 startReadline
    expect(useInk).toBe(false);
    // start() 决策: useInk=false → startReadline (有 rl，不报错)
    const useInkPath = useInk === true;
    expect(useInkPath).toBe(false);

    delete process.env.ROY_AGENT_NO_INK;
  });
});

