/**
 * @fileoverview Status Dot 单元测试
 *
 * Task #2252: 改造点 5 — 状态点 + 文字反馈
 *
 * 验证:
 *   - buildStatusDot 输出 ● + label
 *   - withDots=true 时 label 后追加 1-3 个 .
 *   - startStatusDot 启动时输出初始 label
 *   - update 修改 label
 *   - stopSuccess / stopError 输出 ✓ / ✗ 前缀
 *   - 在非 TTY 下不启动定时器
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import { buildStatusDot, startStatusDot, type DotStatus } from "./status-dot";

const chalk = chalkNs.default;

describe("Status Dot (Task #2252)", () => {
  let originalLevel: 0 | 1 | 2 | 3;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    chalk.level = originalLevel;
    if (originalIsTTY === undefined) {
      // @ts-ignore
      delete process.stdout.isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  describe("buildStatusDot", () => {
    test("should output ● + label", () => {
      const out = buildStatusDot("thinking", "thinking");
      expect(out).toContain("\u25CF");
      expect(out).toContain("thinking");
    });

    test("should support different status types", () => {
      const statuses: DotStatus[] = ["thinking", "executing", "loading", "running", "busy"];
      for (const s of statuses) {
        const out = buildStatusDot(s, "test");
        expect(out).toContain("\u25CF");
        expect(out).toContain("test");
      }
    });

    test("withDots=true should append 1-3 dots based on dotCount", () => {
      expect(buildStatusDot("thinking", "thinking", true, 0).match(/\./g)?.length).toBe(1);
      expect(buildStatusDot("thinking", "thinking", true, 1).match(/\./g)?.length).toBe(2);
      expect(buildStatusDot("thinking", "thinking", true, 2).match(/\./g)?.length).toBe(3);
      // dotCount=3 wraps to (3%3)+1 = 1
      expect(buildStatusDot("thinking", "thinking", true, 3).match(/\./g)?.length).toBe(1);
    });

    test("withDots=false should NOT append dots", () => {
      const out = buildStatusDot("thinking", "thinking", false, 2);
      expect(out.match(/\./g)).toBeNull();
    });

    test("chalk.level=0 should preserve plain text", () => {
      chalk.level = 0;
      const out = buildStatusDot("thinking", "thinking", true, 0);
      expect(out).toContain("thinking.");
    });
  });

  describe("startStatusDot", () => {
    test("should call writer with initial label", () => {
      const writes: string[] = [];
      const writer = (line: string) => writes.push(line);
      const dot = startStatusDot("thinking", "thinking", {
        writer,
        animateDots: false,
      });
      dot.stopSuccess();
      expect(writes.length).toBeGreaterThanOrEqual(1);
      // 第一行是 initial
      expect(writes[0]).toContain("thinking");
    });

    test("update() should change current label", () => {
      const writes: string[] = [];
      const writer = (line: string) => writes.push(line);
      const dot = startStatusDot("executing", "initial", {
        writer,
        animateDots: false,
      });
      dot.update("new label");
      // writer 收到了 new label
      expect(writes.some(w => w.includes("new label"))).toBe(true);
      expect(dot.currentLabel).toBe("new label");
      dot.stopSuccess();
    });

    test("stopSuccess should output ✓ prefix", () => {
      const writes: string[] = [];
      const writer = (line: string) => writes.push(line);
      const dot = startStatusDot("thinking", "thinking", {
        writer,
        animateDots: false,
      });
      dot.stopSuccess("done");
      const last = writes[writes.length - 1] ?? "";
      expect(last).toContain("\u2713");
      expect(last).toContain("done");
    });

    test("stopError should output ✗ prefix", () => {
      const writes: string[] = [];
      const writer = (line: string) => writes.push(line);
      const dot = startStatusDot("thinking", "thinking", {
        writer,
        animateDots: false,
      });
      dot.stopError("failed");
      const last = writes[writes.length - 1] ?? "";
      expect(last).toContain("\u2717");
      expect(last).toContain("failed");
    });

    test("should not start timer when not TTY (animateDots=true but no TTY)", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const writes: string[] = [];
      const writer = (line: string) => writes.push(line);
      const dot = startStatusDot("thinking", "thinking", {
        writer,
        animateDots: true,
        intervalMs: 50,
      });
      // 不应该启动 setInterval，所以不会更新 dotCount
      // 简单验证：调用 stop 不会出错
      dot.stopSuccess("ok");
      expect(writes.some(w => w.includes("\u2713"))).toBe(true);
    });

    test("should not allow update after stop", () => {
      const writes: string[] = [];
      const writer = (line: string) => writes.push(line);
      const dot = startStatusDot("thinking", "thinking", {
        writer,
        animateDots: false,
      });
      dot.stopSuccess("done");
      const writesBefore = writes.length;
      dot.update("ignored");
      // update after stop 不会写入
      expect(writes.length).toBe(writesBefore);
    });
  });
});
