/**
 * Tests for ToolNode timeout configuration (P1/P2/P3 from code review).
 *
 * All tests use sub-3-second timeouts. NEVER wait for the 60s default.
 *
 * Coverage:
 *  - T1: input.timeout preferred when present (overrides config.timeout)
 *  - T2: config.timeout used when input.timeout missing
 *  - T3: default 60_000ms when both missing (mock tool resolves fast, no timeout)
 *  - T4: error message contains INTEGER seconds (Math.round, no decimal point)
 *  - T5: input.timeout precedence over config.timeout (different values)
 *  - T6 (P3): setTimeout handle cleared after Promise.race resolves
 */
import { describe, it, expect, beforeEach, jest } from 'vitest';
import { ToolNode, ToolRegistry, Tool } from './tool-node';
import type { NodeDefinition, NodeExecutionContext } from '../types';
import type { EventBus } from '../engine/event-bus';

const mockEventBus = {
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
} as Partial<EventBus> as EventBus;

const mockRegistry = {
  getTool: jest.fn<(name: string) => Tool | undefined>(),
  hasTool: jest.fn<(name: string) => boolean>(),
} as {
  getTool: ReturnType<typeof jest.fn>;
  hasTool: ReturnType<typeof jest.fn>;
};

/**
 * Mock tool that resolves/rejects after a configurable delay.
 * Lets us simulate "slow" tools without ever waiting near 60s.
 */
function makeSlowTool(name: string, sleepMs: number): Tool {
  return {
    name,
    execute: (_input: any) =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ output: `slept-${sleepMs}-ms` }), sleepMs);
      }),
  };
}

describe('ToolNode timeout configuration', () => {
  let nodeDefinition: NodeDefinition;
  let executionContext: NodeExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    nodeDefinition = {
      id: 'node-timeout-test',
      type: 'tool',
      name: 'Timeout Test Node',
      config: {
        tool: 'slow-tool',
        input: { message: 'hello' },
      },
    };

    executionContext = {
      runId: 'run-timeout-test',
      sessionId: 'session-timeout-test',
      workflowName: 'timeout-test-workflow',
      nodeId: 'node-timeout-test',
      input: {},
      previousOutputs: new Map(),
      nodeOutputs: new Map(),
      config: nodeDefinition.config,
      debug: false,
      eventBus: mockEventBus,
      askUser: () => {
        throw new Error('askUser not implemented');
      },
      templateResolver: {
        resolveValue: (v: unknown) => v,
      } as any,
    } as unknown as NodeExecutionContext;

    mockRegistry.hasTool = jest.fn().mockReturnValue(true);
  });

  it('T1: input.timeout is preferred when present (rejects ~input.timeout ms)', async () => {
    // Mock tool sleeps 1500ms — should NOT resolve before timeout fires
    const slowTool = makeSlowTool('slow-tool', 1500);
    mockRegistry.getTool = jest.fn().mockReturnValue(slowTool);

    // input.timeout = 200ms — must override default 60s
    nodeDefinition.config.input = { message: 'hello', timeout: 200 };
    executionContext.config = nodeDefinition.config;

    const toolNode = new ToolNode(nodeDefinition, mockRegistry as unknown as ToolRegistry);

    const start = Date.now();
    const result = await toolNode.execute(executionContext);
    const elapsed = Date.now() - start;

    // Verify timeout fired (not the tool's natural resolve at 1500ms)
    expect(result.error).toBeDefined();
    expect(String(result.error?.message ?? result.error)).toMatch(/timeout/);
    // Verify rejection happened around input.timeout (200ms), well before tool's 1500ms resolve
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1200);
  }, 3000);

  it('T2: config.timeout used when input.timeout is missing', async () => {
    // Mock tool sleeps 1500ms — should NOT resolve before timeout fires
    const slowTool = makeSlowTool('slow-tool', 1500);
    mockRegistry.getTool = jest.fn().mockReturnValue(slowTool);

    // No input.timeout, but config.timeout = 200ms
    nodeDefinition.config.input = { message: 'hello' };
    nodeDefinition.config.timeout = 200;
    executionContext.config = nodeDefinition.config;

    const toolNode = new ToolNode(nodeDefinition, mockRegistry as unknown as ToolRegistry);

    const start = Date.now();
    const result = await toolNode.execute(executionContext);
    const elapsed = Date.now() - start;

    expect(result.error).toBeDefined();
    expect(String(result.error?.message ?? result.error)).toMatch(/timeout/);
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1200);
  }, 3000);

  it('T3: default 60_000ms when both missing (mock tool resolves naturally)', async () => {
    // Mock tool sleeps 200ms — must resolve naturally before default 60s timeout
    const fastTool = makeSlowTool('fast-tool', 200);
    mockRegistry.getTool = jest.fn().mockReturnValue(fastTool);

    // No timeout config anywhere
    nodeDefinition.config.input = { message: 'hello' };
    delete (nodeDefinition.config as any).timeout;
    executionContext.config = nodeDefinition.config;

    const toolNode = new ToolNode(nodeDefinition, mockRegistry as unknown as ToolRegistry);

    const start = Date.now();
    const result = await toolNode.execute(executionContext);
    const elapsed = Date.now() - start;

    // Should NOT timeout — tool resolves naturally
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('slept-200-ms');
    // Should resolve around 200ms (tool's sleep), nowhere near 60_000ms
    expect(elapsed).toBeLessThan(1500);
  }, 3000);

  it('T4: error message contains INTEGER seconds (Math.round, no decimals)', async () => {
    // Mock tool sleeps 3000ms
    const slowTool = makeSlowTool('slow-tool', 3000);
    mockRegistry.getTool = jest.fn().mockReturnValue(slowTool);

    // input.timeout = 1750ms → must round to 2 seconds in error message
    nodeDefinition.config.input = { message: 'hello', timeout: 1750 };
    executionContext.config = nodeDefinition.config;

    const toolNode = new ToolNode(nodeDefinition, mockRegistry as unknown as ToolRegistry);

    const result = await toolNode.execute(executionContext);

    expect(result.error).toBeDefined();
    const msg = String(result.error?.message ?? result.error);
    // Must contain "after 2 seconds" (integer, rounded)
    expect(msg).toMatch(/after 2 seconds/);
    // Must NOT contain decimal seconds like "1.75"
    expect(msg).not.toMatch(/\d+\.\d+\s+seconds/);
  }, 3000);

  it('T5: input.timeout has higher priority than config.timeout', async () => {
    // Mock tool sleeps 1500ms
    const slowTool = makeSlowTool('slow-tool', 1500);
    mockRegistry.getTool = jest.fn().mockReturnValue(slowTool);

    // input.timeout = 200ms (preferred), config.timeout = 60_000 (must be ignored)
    nodeDefinition.config.input = { message: 'hello', timeout: 200 };
    nodeDefinition.config.timeout = 60_000;
    executionContext.config = nodeDefinition.config;

    const toolNode = new ToolNode(nodeDefinition, mockRegistry as unknown as ToolRegistry);

    const start = Date.now();
    const result = await toolNode.execute(executionContext);
    const elapsed = Date.now() - start;

    expect(result.error).toBeDefined();
    expect(String(result.error?.message ?? result.error)).toMatch(/timeout/);
    // If priority is correct, must reject ~200ms — NOT wait for config.timeout (60s)
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1200);
  }, 3000);

  it('T6 (P3): setTimeout handle is cleared after tool resolves naturally', async () => {
    // Track active timers via a small setTimeout/clearTimeout spy.
    // We instrument AFTER the ToolNode module is loaded (no module reload needed).
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;

    const liveTimers = new Map<unknown, number>();
    const spySetTimeout = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((
        cb: (...args: any[]) => void,
        ms?: number,
        ...args: any[]
      ) => {
        const handle = (realSetTimeout as any)(cb, ms, ...args);
        liveTimers.set(handle, ms ?? 0);
        return handle as any;
      }) as any);
    const spyClearTimeout = jest
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((
        handle: unknown,
        ..._args: any[]
      ) => {
        liveTimers.delete(handle);
        return (realClearTimeout as any)(handle);
      }) as any);

    try {
      // Mock tool resolves in 100ms (faster than 60s default)
      const fastTool = makeSlowTool('fast-tool', 100);
      mockRegistry.getTool = jest.fn().mockReturnValue(fastTool);

      nodeDefinition.config.input = { message: 'hello' };
      delete (nodeDefinition.config as any).timeout;
      executionContext.config = nodeDefinition.config;

      const toolNode = new ToolNode(nodeDefinition, mockRegistry as unknown as ToolRegistry);

      const result = await toolNode.execute(executionContext);

      // Tool should resolve naturally
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('slept-100-ms');

      // Give a microtask tick to allow any sync clearTimeout to run
      await Promise.resolve();

      // Find the timeout-handle we registered with the LONGEST delay
      // (it must be the timeoutPromise's setTimeout, configured to 60s).
      // It must have been cleared by the finally-block in ToolNode.
      const longRunningHandles = [...liveTimers.entries()]
        .filter(([_, ms]) => (ms as number) >= 60_000)
        .map(([handle]) => handle);

      // If the timeout handle is still in liveTimers, that's a leak.
      // Note: in Node-style runtimes, clearTimeout on an already-fired timer is a no-op,
      // and the timer is removed from the event loop but our tracking Map only removes
      // on clearTimeout. Since our spy mock fires-and-keeps, the meaningful assertion
      // is: clearTimeout MUST have been called with a handle.
      const clearTimeoutCalls = spyClearTimeout.mock.calls.length;
      const clearTimeoutArgs = spyClearTimeout.mock.calls.map(c => c[0]);

      expect(clearTimeoutCalls).toBeGreaterThanOrEqual(1);
      // Each clearTimeout arg must be a real setTimeout handle (truthy).
      for (const arg of clearTimeoutArgs) {
        expect(arg).toBeDefined();
        expect(arg).not.toBeNull();
      }
      // The remaining long-running timer (if any) should be the timeout-handle
      // that was supposed to be cleared — but since clearTimeout is verified above,
      // and clearTimeout mock removes it from liveTimers, this list should be empty.
      expect(longRunningHandles.length).toBe(0);
    } finally {
      spySetTimeout.mockRestore();
      spyClearTimeout.mockRestore();
    }
  }, 3000);
});