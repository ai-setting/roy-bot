/**
 * @fileoverview Interactive Esc Key Handler Tests
 * 
 * TDD: 测试 Interactive 模式的 Esc 按键中断功能
 * 
 * 场景 1: 正在执行时按 Esc - 中断 LLM 调用 + 停止流式输出 + 恢复 prompt
 * 场景 2: 空闲时按 Esc - 不做任何操作
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { REPL } from "./run";
import { COLORS, abortStream, resetStreamAbort, streamAbortSignal } from "../services/stream-output.service";

// ============================================================================
// Test Suite
// ============================================================================

describe("REPL.handleEscKey - Esc 按键中断流式输出", () => {
  let mockExecute: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockShutdown: ReturnType<typeof vi.fn>;
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockEnv: any;

  beforeEach(() => {
    // 重置 abort 信号
    resetStreamAbort();

    // 创建 mock 函数
    mockExecute = vi.fn().mockResolvedValue("done");
    mockStatus = vi.fn().mockReturnValue({
      sessionId: "test",
      sessionTitle: "Test",
      messageCount: 0,
      tokenCount: 0,
    });
    mockShutdown = vi.fn().mockResolvedValue(undefined);
    mockAbort = vi.fn();

    // Mock environment with agent component
    mockEnv = {
      getComponent: vi.fn().mockImplementation((name: string) => {
        if (name === "agent") {
          return { abort: mockAbort };
        }
        return undefined;
      }),
    };
  });

  test("handleEscKey() 方法应该存在", () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      mockEnv
    );

    // Assert - handleEscKey 应该是 REPL 的一个方法
    expect(typeof repl.handleEscKey).toBe("function");
  });

  test("正在执行时按 Esc - 应该调用 AgentComponent.abort", () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      mockEnv
    );

    // 模拟正在执行状态
    // 通过私有属性访问（测试用途）
    (repl as any).isExecuting = true;

    // Act
    repl.handleEscKey();

    // Assert - AgentComponent.abort 应该被调用
    expect(mockAbort).toHaveBeenCalledWith("default");
    expect(mockAbort).toHaveBeenCalledTimes(1);
  });

  test("正在执行时按 Esc - 应该调用 abortStream", () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      mockEnv
    );

    // 模拟正在执行状态
    (repl as any).isExecuting = true;

    // 重置确认
    resetStreamAbort();
    expect(streamAbortSignal.aborted).toBe(false);

    // Act
    repl.handleEscKey();

    // Assert - abortStream 应该被调用，streamAbortSignal.aborted 应该为 true
    expect(streamAbortSignal.aborted).toBe(true);
  });

  test("正在执行时按 Esc - 应该重置 isExecuting 状态为 false", async () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      mockEnv
    );

    // 模拟正在执行状态
    (repl as any).isExecuting = true;
    expect((repl as any).isExecuting).toBe(true);

    // Act — Task #2245 — Codex P1-3: handleEscKey is now async
    await repl.handleEscKey();

    // Assert - isExecuting 应该被重置为 false
    expect((repl as any).isExecuting).toBe(false);
  });

  test("空闲时按 Esc - 不应该调用 AgentComponent.abort", () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      mockEnv
    );

    // 确保处于空闲状态
    (repl as any).isExecuting = false;

    // Act
    repl.handleEscKey();

    // Assert - AgentComponent.abort 不应该被调用
    expect(mockAbort).not.toHaveBeenCalled();
  });

  test("空闲时按 Esc - 不应该调用 abortStream", () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      mockEnv
    );

    // 确保处于空闲状态
    (repl as any).isExecuting = false;

    // 重置确认
    resetStreamAbort();

    // Act
    repl.handleEscKey();

    // Assert - abortStream 不应该被调用
    expect(streamAbortSignal.aborted).toBe(false);
  });

  test("没有 env 时按 Esc - 应该仍然调用 abortStream", () => {
    // Arrange - 不传入 env
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute,
        onStatus: mockStatus,
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: mockShutdown,
      },
      undefined // 不传入 env
    );

    // 模拟正在执行状态
    (repl as any).isExecuting = true;
    resetStreamAbort();

    // Act
    repl.handleEscKey();

    // Assert - 即使没有 env，abortStream 也应该被调用
    expect(streamAbortSignal.aborted).toBe(true);
  });
});

describe("Esc 与 Ctrl+C 的区别", () => {
  test("Esc 和 Ctrl+C 都会中断流式输出，但行为不同", () => {
    // 这个测试文档化两种中断方式的区别
    
    // Ctrl+C 第一次：中断执行 + 显示 "按 Ctrl+C 再次中断或退出程序"
    // Ctrl+C 第二次（在空闲时）：退出程序
    
    // Esc：仅在执行时中断 + 显示 "[已中断，可以继续输入]"
    // Esc 在空闲时：不做任何操作
    
    // 两种方式都调用：
    // 1. AgentComponent.abort("default") - 中断底层 LLM 调用
    // 2. abortStream() - 停止流式输出显示
    // 3. isExecuting = false - 重置状态
    // 4. rl.prompt(true) - 恢复 prompt
    
    // 不同点：
    // - Esc 在空闲时不做任何操作
    // - Ctrl+C 在空闲时会退出程序
    
    expect(true).toBe(true); // 文档化测试
  });
});
