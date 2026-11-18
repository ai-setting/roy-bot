/**
 * @fileoverview QuietMode Service Tests
 * 
 * TDD: 测试统一的 QuietMode 服务
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { CliQuietModeService } from "./quiet-mode.service";

describe("CliQuietModeService", () => {
  let service: CliQuietModeService;

  beforeEach(() => {
    service = new CliQuietModeService();
  });

  afterEach(() => {
    // 重置 quiet 模式状态
    service.reset();
  });

  describe("singleton", () => {
    test("should return singleton instance", () => {
      const instance1 = CliQuietModeService.getInstance();
      const instance2 = CliQuietModeService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("setQuiet", () => {
    test("should enable quiet mode", () => {
      service.setQuiet(true);
      expect(service.isQuiet()).toBe(true);
    });

    test("should disable quiet mode", () => {
      service.setQuiet(true);
      service.setQuiet(false);
      expect(service.isQuiet()).toBe(false);
    });
  });

  describe("setQuietFromArgv", () => {
    test("should set quiet mode from argv when quiet is true", () => {
      const argv = { quiet: true };
      service.setQuietFromArgv(argv);
      expect(service.isQuiet()).toBe(true);
    });

    test("should not change quiet mode when quiet is false or undefined", () => {
      service.setQuiet(true);
      const argv = { quiet: false };
      service.setQuietFromArgv(argv);
      expect(service.isQuiet()).toBe(true);

      service.reset();
      const argv2 = {};
      service.setQuietFromArgv(argv2);
      expect(service.isQuiet()).toBe(false);
    });
  });

  describe("reset", () => {
    test("should reset quiet mode to false", () => {
      service.setQuiet(true);
      service.reset();
      expect(service.isQuiet()).toBe(false);
    });
  });
});

describe("CliQuietModeService integration", () => {
  let service: CliQuietModeService;

  beforeEach(() => {
    service = CliQuietModeService.getInstance();
    service.reset();
  });

  afterEach(() => {
    service.reset();
  });

  test("should enable quiet mode when -q flag is provided", () => {
    // sessions grep -q
    const argv = { quiet: true };
    service.setQuietFromArgv(argv);
    expect(service.isQuiet()).toBe(true);
  });

  test("should not enable quiet mode when -q flag is not provided", () => {
    // tasks list (no -q)
    const argv = {};
    service.setQuietFromArgv(argv);
    expect(service.isQuiet()).toBe(false);
  });

  test("should preserve quiet mode across command sequence when always enabled", () => {
    // 如果命令行参数一直带有 -q，quiet 模式应该保持
    service.setQuietFromArgv({ quiet: true });
    expect(service.isQuiet()).toBe(true);

    service.setQuietFromArgv({ quiet: true });
    expect(service.isQuiet()).toBe(true);
  });

  test("should reset quiet mode manually when needed", () => {
    service.setQuietFromArgv({ quiet: true });
    expect(service.isQuiet()).toBe(true);

    service.reset();
    expect(service.isQuiet()).toBe(false);
  });
});
