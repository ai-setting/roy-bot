/**
 * @fileoverview Interactive EventSource Startup Tests
 *
 * TDD 流程：
 * 1. 测试空数组（不报错）
 * 2. 测试成功启动多个
 * 3. 测试 1 失败 + 2 成功（不影响其他）
 * 4. 测试 id 不存在时报错但继续其他
 * 5. 测试已有 running 的跳过
 * 6. 测试单值语法兼容性（--es a）
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import {
  startEventSources,
  startSingleEventSource,
} from "./interactive-event-sources";

// =============================================================================
// Mock 工具
// =============================================================================

/**
 * 创建 mock OutputService
 */
function createMockOutput() {
  return {
    info: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    configure: vi.fn(),
    isQuiet: vi.fn().mockReturnValue(false),
    isJsonOutput: vi.fn().mockReturnValue(false),
    isNoColor: vi.fn().mockReturnValue(false),
  } as any;
}

/**
 * 创建 mock EventSourceComponent
 */
function createMockEventSourceComponent(
  sources: Array<{ id: string; name: string; type: string }> = [],
) {
  const statusMap = new Map<string, string>();

  return {
    list: vi.fn(() => sources),
    getStatus: vi.fn((id: string) => statusMap.get(id) ?? "created"),
    startSource: vi.fn(async (id: string) => {
      statusMap.set(id, "running");
    }),
    stopSource: vi.fn(async (id: string) => {
      statusMap.set(id, "stopped");
    }),
    _setStatus: (id: string, status: string) => statusMap.set(id, status),
    _getStatus: (id: string) => statusMap.get(id),
  } as any;
}

// =============================================================================
// startEventSources - 多事件源启动
// =============================================================================

describe("startEventSources - 多事件源启动", () => {
  let output: ReturnType<typeof createMockOutput>;

  beforeEach(() => {
    output = createMockOutput();
  });

  test("空数组时跳过（不报错）", async () => {
    // Given
    const component = createMockEventSourceComponent();

    // When
    const summary = await startEventSources([], component, output);

    // Then
    expect(summary.total).toBe(0);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.results).toEqual([]);
    expect(component.startSource).not.toHaveBeenCalled();
  });

  test("undefined 时跳过（不报错）", async () => {
    // Given
    const component = createMockEventSourceComponent();

    // When
    const summary = await startEventSources(undefined as any, component, output);

    // Then
    expect(summary.total).toBe(0);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(component.startSource).not.toHaveBeenCalled();
  });

  test("成功启动多个事件源", async () => {
    // Given
    const sources = [
      { id: "es-1", name: "EventSource 1", type: "timer" },
      { id: "es-2", name: "EventSource 2", type: "lark-cli" },
      { id: "es-3", name: "EventSource 3", type: "websocket" },
    ];
    const component = createMockEventSourceComponent(sources);

    // When
    const summary = await startEventSources(["es-1", "es-2", "es-3"], component, output);

    // Then
    expect(summary.total).toBe(3);
    expect(summary.successCount).toBe(3);
    expect(summary.failedCount).toBe(0);
    expect(summary.results.every((r) => r.success)).toBe(true);
    expect(summary.results.map((r) => r.status)).toEqual([
      "started",
      "started",
      "started",
    ]);
    expect(component.startSource).toHaveBeenCalledTimes(3);
  });

  test("1 失败 + 2 成功 - 不影响其他", async () => {
    // Given
    const sources = [
      { id: "es-1", name: "ES 1", type: "timer" },
      { id: "es-2", name: "ES 2", type: "lark-cli" },
      { id: "es-3", name: "ES 3", type: "websocket" },
    ];
    const component = createMockEventSourceComponent(sources);
    // 让 es-2 启动失败
    component.startSource.mockImplementation(async (id: string) => {
      if (id === "es-2") {
        throw new Error("Connection refused");
      }
      component._setStatus(id, "running");
    });

    // When
    const summary = await startEventSources(["es-1", "es-2", "es-3"], component, output);

    // Then
    expect(summary.total).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.results[0]).toMatchObject({ id: "es-1", success: true, status: "started" });
    expect(summary.results[1]).toMatchObject({ id: "es-2", success: false, status: "failed" });
    expect(summary.results[1].error).toContain("Connection refused");
    expect(summary.results[2]).toMatchObject({ id: "es-3", success: true, status: "started" });
  });

  test("id 不存在时报错但继续其他", async () => {
    // Given
    const sources = [{ id: "es-real", name: "Real", type: "timer" }];
    const component = createMockEventSourceComponent(sources);

    // When
    const summary = await startEventSources(
      ["es-not-exist", "es-real", "es-also-not-exist"],
      component,
      output,
    );

    // Then
    expect(summary.total).toBe(3);
    expect(summary.successCount).toBe(1);
    expect(summary.failedCount).toBe(2);
    expect(summary.results[0]).toMatchObject({ status: "not_found" });
    expect(summary.results[1]).toMatchObject({ status: "started" });
    expect(summary.results[2]).toMatchObject({ status: "not_found" });
  });

  test("已有 running 的跳过", async () => {
    // Given
    const sources = [
      { id: "es-running", name: "Already Running", type: "timer" },
      { id: "es-stopped", name: "Stopped", type: "timer" },
    ];
    const component = createMockEventSourceComponent(sources);
    component._setStatus("es-running", "running");

    // When
    const summary = await startEventSources(["es-running", "es-stopped"], component, output);

    // Then
    expect(summary.total).toBe(2);
    expect(summary.successCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(summary.results[0]).toMatchObject({ status: "skipped", success: true });
    expect(summary.results[1]).toMatchObject({ status: "started", success: true });
    // startSource 只被调用 1 次（es-stopped）
    expect(component.startSource).toHaveBeenCalledTimes(1);
    expect(component.startSource).toHaveBeenCalledWith("es-stopped");
  });

  test("支持前缀匹配", async () => {
    // Given
    const sources = [{ id: "id_abc123_full_id", name: "Full ID Source", type: "timer" }];
    const component = createMockEventSourceComponent(sources);

    // When - 使用短前缀
    const summary = await startEventSources(["id_abc"], component, output);

    // Then
    expect(summary.successCount).toBe(1);
    expect(summary.results[0].id).toBe("id_abc123_full_id");
  });

  test("汇总日志：成功 N/M", async () => {
    // Given
    const sources = [
      { id: "es-1", name: "ES 1", type: "timer" },
      { id: "es-2", name: "ES 2", type: "timer" },
    ];
    const component = createMockEventSourceComponent(sources);

    // When
    await startEventSources(["es-1", "es-2"], component, output);

    // Then
    // 汇总信息应包含 "2/2"
    const allCalls = [
      ...(output.info as any).mock.calls,
      ...(output.success as any).mock.calls,
    ].map((c: any[]) => c[0]).join("\n");
    expect(allCalls).toContain("2/2");
  });
});

// =============================================================================
// startSingleEventSource - 单事件源启动（向后兼容）
// =============================================================================

describe("startSingleEventSource - 单事件源启动", () => {
  test("单值语法 --es a 仍能工作", async () => {
    // Given
    const sources = [{ id: "es-only", name: "Only", type: "timer" }];
    const component = createMockEventSourceComponent(sources);
    const output = createMockOutput();

    // When
    const result = await startSingleEventSource(component, output, "es-only");

    // Then
    expect(result.success).toBe(true);
    expect(result.status).toBe("started");
    expect(result.id).toBe("es-only");
    expect(result.name).toBe("Only");
  });

  test("单值找不到时返回 not_found", async () => {
    // Given
    const component = createMockEventSourceComponent();
    const output = createMockOutput();

    // When
    const result = await startSingleEventSource(component, output, "es-missing");

    // Then
    expect(result.success).toBe(false);
    expect(result.status).toBe("not_found");
  });

  test("单值已在运行返回 skipped", async () => {
    // Given
    const sources = [{ id: "es-running", name: "Running", type: "timer" }];
    const component = createMockEventSourceComponent(sources);
    component._setStatus("es-running", "running");
    const output = createMockOutput();

    // When
    const result = await startSingleEventSource(component, output, "es-running");

    // Then
    expect(result.success).toBe(true);
    expect(result.status).toBe("skipped");
  });
});
