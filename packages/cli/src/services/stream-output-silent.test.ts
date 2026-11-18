/**
 * @fileoverview Task #2286: StreamOutputService silent 模式测试
 *
 * 验证:
 * - silent=true 时 handleText / handleReasoning / handleToolCall 等不写 stdout
 * - silent=true 时 chunk callback 仍触发（ink REPL 需要）
 * - silent=false 时行为不变（readline 路径兼容）
 * - writeStdout / logStdout helper 正确路由
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "bun:test";
import { StreamOutputService } from "./stream-output.service";
import type { StreamChunkEvent } from "./stream-output.service";

describe("Task #2286: StreamOutputService silent 模式", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ============================================================
  // silent=true: 不写 stdout
  // ============================================================
  describe("silent=true: 禁用 stdout 写入", () => {
    test("handleText 不写 stdout", () => {
      const svc = new StreamOutputService({ silent: true });
      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "hello" },
      } as any);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("handleReasoning 不写 stdout", () => {
      const svc = new StreamOutputService({
        silent: true,
        showReasoning: true,
      });
      svc.handleEvent({
        type: "llm.reasoning",
        payload: { delta: "thinking..." },
      } as any);
      // 累积到 buffer 但不刷新（buffer < 15）
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("handleToolCall 不写 stdout", () => {
      const svc = new StreamOutputService({
        silent: true,
        showToolCalls: true,
      });
      svc.handleEvent({
        type: "tool.call",
        payload: { id: "t1", name: "Bash", arguments: { cmd: "ls" } },
      } as any);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("handleToolResult 不写 stdout", () => {
      const svc = new StreamOutputService({
        silent: true,
        showToolResults: true,
      });
      svc.handleEvent({
        type: "tool.result",
        payload: { name: "Bash", result: { output: "file.txt" } },
      } as any);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("handleToolError 不写 stdout", () => {
      const svc = new StreamOutputService({
        silent: true,
        showToolCalls: true,
      });
      svc.handleEvent({
        type: "tool.error",
        payload: { toolName: "Bash", error: "fail" },
      } as any);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("handleCompleted 不写 stdout", () => {
      const svc = new StreamOutputService({ silent: true });
      svc.handleEvent({
        type: "llm.completed",
        payload: { content: "done" },
      } as any);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // silent=true: chunk callback 仍触发
  // ============================================================
  describe("silent=true: chunk callback 仍触发", () => {
    test("llm.text chunk 仍 emit", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({ silent: true });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "hello" },
      } as any);
      expect(events.some((e) => e.type === "llm.text" && e.delta === "hello")).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("llm.reasoning chunk 仍 emit", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({
        silent: true,
        showReasoning: true,
      });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      svc.handleEvent({
        type: "llm.reasoning",
        payload: { delta: "thinking..." },
      } as any);
      expect(events.some((e) => e.type === "llm.reasoning")).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("tool.call / tool.result / tool.error chunk 仍 emit", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({
        silent: true,
        showToolCalls: true,
        showToolResults: true,
      });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      svc.handleEvent({
        type: "tool.call",
        payload: { id: "t1", name: "Bash", arguments: {} },
      } as any);
      svc.handleEvent({
        type: "tool.result",
        payload: { name: "Bash", result: { output: "ok" } },
      } as any);
      svc.handleEvent({
        type: "tool.error",
        payload: { toolName: "X", error: "e" },
      } as any);

      expect(events.some((e) => e.type === "tool.call")).toBe(true);
      expect(events.some((e) => e.type === "tool.result")).toBe(true);
      expect(events.some((e) => e.type === "tool.error")).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    // Task #4124: tool.result must carry the toolId so the Ink TUI can
    // match it to the originating tool.call.
    test("tool.result chunk carries toolId from the payload", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({ silent: true, showToolResults: true });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      svc.handleEvent({
        type: "tool.result",
        payload: { id: "call-42", name: "Bash", result: { output: "ok" } },
      } as any);

      const result = events.find((e) => e.type === "tool.result");
      expect(result).toBeDefined();
      expect(result.toolId).toBe("call-42");
      expect(result.toolName).toBe("Bash");
    });

    test("llm.completed chunk 仍 emit", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({ silent: true });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      svc.handleEvent({
        type: "llm.completed",
        payload: { content: "final" },
      } as any);
      expect(events.some((e) => e.type === "llm.completed")).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // silent=false: 行为不变（向后兼容）
  // ============================================================
  describe("silent=false: 向后兼容 readline 路径", () => {
    test("handleText 仍写 stdout", () => {
      const svc = new StreamOutputService({ silent: false });
      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "hello" },
      } as any);
      expect(stdoutSpy).toHaveBeenCalled();
    });

    test("默认 (silent 不传) = silent=false", () => {
      const svc = new StreamOutputService();
      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "hello" },
      } as any);
      expect(stdoutSpy).toHaveBeenCalled();
    });

    test("handleToolCall 仍写 stdout", () => {
      const svc = new StreamOutputService({
        silent: false,
        showToolCalls: true,
      });
      svc.handleEvent({
        type: "tool.call",
        payload: { id: "t1", name: "Bash", arguments: {} },
      } as any);
      expect(stdoutSpy).toHaveBeenCalled();
    });
  });

  // ============================================================
  // silent 不影响 emitChunk 内部状态
  // ============================================================
  describe("silent 不影响 internal state", () => {
    test("silent=true 时 fullText 仍累积", () => {
      const svc = new StreamOutputService({ silent: true });
      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "hello " },
      } as any);
      svc.handleEvent({
        type: "llm.text",
        payload: { delta: "world" },
      } as any);
      expect(svc.getFullText()).toBe("hello world");
      // 但 stdout 不应有输出
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Task #4278 片6: reasoning chunks 必须每条都 emit（不能只 emit 第一条）
  // ============================================================
  describe("Task #4278 片6: llm.reasoning chunk 全量 emit", () => {
    test("reasoningStarted 之后仍 emit 每个 delta（回归：early-return 吞掉后续 delta）", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({ silent: true, showReasoning: true });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      // 第一条 delta 长度 >= 15 → flushReasoningBuffer → reasoningStarted=true
      for (const delta of ["A".repeat(15), "second ", "third"]) {
        svc.handleEvent({ type: "llm.reasoning", payload: { delta } } as any);
      }

      const deltas = events
        .filter((e) => e.type === "llm.reasoning")
        .map((e) => e.delta);
      expect(deltas).toEqual(["A".repeat(15), "second ", "third"]);
      expect(deltas.join("")).toBe("A".repeat(15) + "second third");
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    test("reasoningClosedByText 之后不再 emit（text 已以绿色输出同样内容）", () => {
      const events: any[] = [];
      const svc = new StreamOutputService({ silent: true, showReasoning: true });
      svc.setChunkCallback((e: StreamChunkEvent) => events.push(e));

      svc.handleEvent({ type: "llm.reasoning", payload: { delta: "before" } } as any);
      svc.handleEvent({ type: "llm.text", payload: { delta: "answer" } } as any);
      svc.handleEvent({ type: "llm.reasoning", payload: { delta: "after-text" } } as any);

      const deltas = events.filter((e) => e.type === "llm.reasoning").map((e) => e.delta);
      expect(deltas).toEqual(["before"]);
    });
  });
});
