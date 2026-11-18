/**
 * @fileoverview 测试外部传入 EnvironmentService 的功能
 * 
 * 验证 createActCommand 和 createInteractiveCommand 支持外部传入 envService
 */

import { describe, expect, test, vi } from "vitest";
import { createActCommand } from "./act";
import { createInteractiveCommand as createInteractive } from "./run";

// Mock EnvironmentService
const mockEnvService = {
  create: vi.fn(),
  getEnvironment: vi.fn().mockReturnValue({
    registerComponent: vi.fn(),
    getComponent: vi.fn(),
    subscribeTo: vi.fn().mockReturnValue(() => {}),
    init: vi.fn(),
    start: vi.fn(),
  }),
  getSession: vi.fn().mockReturnValue({
    getActiveSession: vi.fn(),
    setActiveSession: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    setSummaryComponents: vi.fn(),
  }),
  getLLM: vi.fn().mockReturnValue({
    getContextThresholdConfig: vi.fn().mockReturnValue({
      contextWindow: 100000,
      thresholdRatio: 0.8,
    }),
  }),
  dispose: vi.fn(),
};

describe("createActCommand with external EnvironmentService", () => {
  test("should create command without external envService", () => {
    const command = createActCommand();
    expect(command).toBeDefined();
    expect(command.command).toBe("act [message]");
    expect(command.handler).toBeDefined();
  });

  test("should create command with external envService", () => {
    const command = createActCommand(mockEnvService as any);
    expect(command).toBeDefined();
    expect(command.command).toBe("act [message]");
    expect(command.handler).toBeDefined();
  });
});

describe("createInteractiveCommand with external EnvironmentService", () => {
  test("should create command without external envService", () => {
    const command = createInteractive();
    expect(command).toBeDefined();
    expect(command.command).toBe("interactive");
    expect(command.handler).toBeDefined();
  });

  test("should create command with external envService", () => {
    const command = createInteractive(mockEnvService as any);
    expect(command).toBeDefined();
    expect(command.command).toBe("interactive");
    expect(command.handler).toBeDefined();
  });
});
