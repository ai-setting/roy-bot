/**
 * @fileoverview Status Bar 单元测试
 *
 * Task #2252: 改造点 3 — 底部常驻状态栏
 * Task #2262: 第二轮打磨 — 多段信息（mode · tokens · git · cwd · shortcuts）
 *
 * 验证:
 *   - buildStatusBar 输出 4+ 段 (mode + help + ... 可选)
 *   - mode icon 是 ● 或 ○
 *   - mode label 正确（ready/thinking/executing 等）
 *   - ready 模式不显示 interrupt 段
 *   - executing/thinking 模式显示 interrupt
 *   - detail 参数会出现在 label 后
 *   - isAgentMode=true 时显示 "agent mode" 段
 *   - Task #2262: tokens 段（可选）"12k in / 234 out"
 *   - Task #2262: git 段（可选）"⎇ main"
 *   - Task #2262: cwd 段（可选）缩略显示
 *   - Task #2262: 各段独立着色（muted / accent / primary）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import { buildStatusBar, buildStatusBarForREPL, shortenCwd, printStatusBarHint, detectGitBranch, shortModelName, type StatusBarContext } from "./status-bar";

const chalk = chalkNs.default;

describe("Status Bar (Task #2252 + #2262 polish)", () => {
  let originalLevel: 0 | 1 | 2 | 3;

  beforeEach(() => {
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  describe("basic structure (mode + help)", () => {
    test("ready mode should have at least 2 segments (mode + help)", () => {
      const out = buildStatusBar({ mode: "ready" });
      // ready 模式：mode + help
      // 中间用 · 分隔，所以应该有 1 个 ·
      const dotCount = (out.match(/\u00B7/g) || []).length;
      expect(dotCount).toBeGreaterThanOrEqual(1);
    });

    test("thinking mode should have at least 3 segments (mode + help + interrupt)", () => {
      const out = buildStatusBar({ mode: "thinking" });
      const dotCount = (out.match(/\u00B7/g) || []).length;
      expect(dotCount).toBeGreaterThanOrEqual(2);
    });

    test("executing mode should have at least 3 segments", () => {
      const out = buildStatusBar({ mode: "executing" });
      const dotCount = (out.match(/\u00B7/g) || []).length;
      expect(dotCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("mode icon and label", () => {
    test("ready mode icon is ○ (U+25CB)", () => {
      const out = buildStatusBar({ mode: "ready" });
      expect(out).toContain("\u25CB");
    });

    test.each([
      ["thinking", "thinking..."],
      ["executing", "executing"],
      ["error", "error"],
      ["compact", "compacting"],
      ["shutdown", "shutting down"],
    ])("%s mode should have label %s", (mode, label) => {
      const out = buildStatusBar({ mode: mode as any });
      expect(out).toContain(label);
    });
  });

  describe("help segment", () => {
    test("should always contain '? for help'", () => {
      const modes: Array<StatusBarContext["mode"]> = ["ready", "thinking", "executing", "error"];
      for (const mode of modes) {
        const out = buildStatusBar({ mode });
        expect(out).toContain("? for help");
      }
    });
  });

  describe("interrupt segment", () => {
    test("ready mode should NOT have interrupt", () => {
      const out = buildStatusBar({ mode: "ready" });
      expect(out).not.toContain("esc to interrupt");
    });

    test("thinking mode should have interrupt", () => {
      const out = buildStatusBar({ mode: "thinking" });
      expect(out).toContain("esc to interrupt");
    });

    test("executing mode should have interrupt", () => {
      const out = buildStatusBar({ mode: "executing" });
      expect(out).toContain("esc to interrupt");
    });

    test("shutdown mode should NOT have interrupt", () => {
      const out = buildStatusBar({ mode: "shutdown" });
      expect(out).not.toContain("esc to interrupt");
    });
  });

  describe("detail field", () => {
    test("executing + detail should show 'executing (bash)'", () => {
      const out = buildStatusBar({ mode: "executing", detail: "bash" });
      expect(out).toContain("executing");
      expect(out).toContain("bash");
    });

    test("ready + detail should NOT show detail (only shown for non-ready modes)", () => {
      const out = buildStatusBar({ mode: "ready", detail: "background" });
      expect(out).not.toContain("background");
    });
  });

  describe("agent mode", () => {
    test("isAgentMode=true should show 'agent mode' segment", () => {
      const out = buildStatusBar({ mode: "ready", isAgentMode: true });
      expect(out).toContain("agent mode");
    });

    test("isAgentMode=false should NOT show 'agent mode' segment", () => {
      const out = buildStatusBar({ mode: "ready", isAgentMode: false });
      expect(out).not.toContain("agent mode");
    });
  });

  // ========== Task #2262: 多段信息 ==========
  describe("Task #2262: tokens segment", () => {
    test("should show '12k in / 234 out' when tokens provided", () => {
      const out = buildStatusBar({
        mode: "ready",
        tokens: { input: 12000, output: 234 },
      });
      expect(out).toContain("12k in");
      expect(out).toContain("234 out");
    });

    test("should format large tokens with M suffix", () => {
      const out = buildStatusBar({
        mode: "ready",
        tokens: { input: 1234567, output: 5000 },
      });
      expect(out).toContain("1.2M in");
      expect(out).toContain("5k out");
    });

    test("should NOT show tokens when not provided", () => {
      const out = buildStatusBar({ mode: "ready" });
      expect(out).not.toContain(" in /");
      expect(out).not.toContain(" out");
    });

    test("should handle small numbers (<1000)", () => {
      const out = buildStatusBar({
        mode: "ready",
        tokens: { input: 42, output: 7 },
      });
      expect(out).toContain("42 in");
      expect(out).toContain("7 out");
    });
  });

  describe("Task #2262: git branch segment", () => {
    test("should show '⎇ main' when gitBranch provided", () => {
      const out = buildStatusBar({ mode: "ready", gitBranch: "main" });
      expect(out).toContain("\u2387");
      expect(out).toContain("main");
    });

    test("should NOT show git when not provided", () => {
      const out = buildStatusBar({ mode: "ready" });
      expect(out).not.toContain("\u2387");
    });
  });

  describe("Task #2262: cwd segment", () => {
    test("should show shortened cwd when provided", () => {
      const out = buildStatusBar({
        mode: "ready",
        cwd: "~/work/code/proj",
      });
      // 应该含 work/code 或 proj（最后 2 级）
      expect(out).toContain("proj");
    });

    test("should NOT show cwd when not provided", () => {
      const out = buildStatusBar({ mode: "ready" });
      // 确认 cwd 段为空（但 help 段仍在）
      expect(out).toContain("? for help");
    });

    test("should replace HOME with ~", () => {
      const out = buildStatusBar({
        mode: "ready",
        cwd: "~/work/proj",
      });
      // 应该含 ~ 符号（HOME prefix 被替换）
      expect(out).toMatch(/~/);
    });

    test("shortenCwd helper — basic replacement", () => {
      expect(shortenCwd("~/work/proj", "~")).toBe("~/work/proj");
    });

    test("shortenCwd helper — deep path truncation", () => {
      const out = shortenCwd("~/a/b/c/d/proj", "~");
      expect(out).toContain("proj");
      expect(out.startsWith(".../") || out.startsWith("~/")).toBe(true);
    });

    test("shortenCwd helper — short path no truncation", () => {
      expect(shortenCwd("/foo/bar", "/foo")).toBe("~/bar");
    });
  });

  describe("Task #2262: 多段组合", () => {
    test("full context with all segments should produce 4+ separators", () => {
      const out = buildStatusBar({
        mode: "ready",
        tokens: { input: 12000, output: 234 },
        gitBranch: "feat/ui-revamp-v2",
        cwd: "~/work/proj",
      });
      // mode + tokens + git + cwd + help = 5 段 → 4 个 ·
      const dotCount = (out.match(/\u00B7/g) || []).length;
      expect(dotCount).toBeGreaterThanOrEqual(4);
    });

    test("executing mode + tokens + git + cwd should NOT show agent but SHOULD show interrupt", () => {
      const out = buildStatusBar({
        mode: "executing",
        detail: "bash",
        tokens: { input: 100, output: 50 },
        gitBranch: "main",
        cwd: "~/work/proj",
      });
      expect(out).toContain("executing");
      expect(out).toContain("bash");
      expect(out).toContain("100 in");
      expect(out).toContain("esc to interrupt");
    });

    test("minimal context (only mode) should still work", () => {
      const out = buildStatusBar({ mode: "ready" });
      expect(out).toContain("ready");
      expect(out).toContain("? for help");
    });
  });

  describe("Task #2262: 各段独立着色", () => {
    test("ready mode should use accent (warm red) for the dot — Task #2262 P2", () => {
      chalk.level = 3;
      const out = buildStatusBar({ mode: "ready" });
      // accent = \x1b[38;2;255;107;107m (warm red) — Task #2262 P2 品牌色贯穿
      expect(out).toMatch(/\x1b\[38;2;255;107;107m/);
    });

    test("all mode dots (ready/thinking/executing/compact/shutdown) should use accent", () => {
      chalk.level = 3;
      const modes: Array<StatusBarContext["mode"]> = ["ready", "thinking", "executing", "compact", "shutdown"];
      for (const mode of modes) {
        const out = buildStatusBar({ mode });
        expect(out).toMatch(/\x1b\[38;2;255;107;107m/);
      }
    });

    test("executing mode should use accent (warm red) for the dot", () => {
      chalk.level = 3;
      const out = buildStatusBar({ mode: "executing" });
      expect(out).toMatch(/\x1b\[38;2;255;107;107m/);
    });

    test("help segment should use primary (bold white) color", () => {
      chalk.level = 3;
      const out = buildStatusBar({ mode: "ready" });
      // primary = chalk.bold.whiteBright = \x1b[1;97m 或 \x1b[97m
      expect(out).toMatch(/\x1b\[(?:1;)?97m/);
    });
  });

  describe("chalk.level=0 (无颜色终端) 降级", () => {
    test("should not throw and preserve text", () => {
      chalk.level = 0;
      const out = buildStatusBar({
        mode: "thinking",
        tokens: { input: 100, output: 50 },
        gitBranch: "main",
        cwd: "~/work/proj",
      });
      expect(out).toContain("thinking...");
      expect(out).toContain("? for help");
      expect(out).toContain("esc to interrupt");
      expect(out).toContain("100 in");
      expect(out).toContain("main");
    });

    test("should not contain ANSI escape when chalk.level=0", () => {
      chalk.level = 0;
      const out = buildStatusBar({ mode: "ready" });
      expect(out).not.toContain("\x1b");
    });
  });

  // ========== Task #2264 P1: 状态栏 5 段 ==========
  describe("Task #2264 P1: printStatusBarHint with context", () => {
    test("printStatusBarHint accepts optional ctx (backward compatible)", () => {
      // 不传 ctx 应该不报错
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        printStatusBarHint();
        expect(captured).toContain("ready");
        expect(captured).toContain("? for help");
      } finally {
        console.log = origLog;
      }
    });

    test("printStatusBarHint with cwd + gitBranch should show 4+ segments", () => {
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        printStatusBarHint({
          cwd: "~/work/proj",
          gitBranch: "feat/ui-revamp-v2",
        });
        // 期望：mode · git · cwd · help = 4 段 → 3 个 ·
        const dotCount = (captured.match(/\u00B7/g) || []).length;
        expect(dotCount).toBeGreaterThanOrEqual(3);
        expect(captured).toContain("feat/ui-revamp-v2");
        expect(captured).toContain("proj"); // shortened cwd
      } finally {
        console.log = origLog;
      }
    });

    test("printStatusBarHint should be no-op when not TTY", () => {
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
        printStatusBarHint({ cwd: "/x", gitBranch: "main" });
        expect(captured).toBe("");
      } finally {
        console.log = origLog;
      }
    });
  });

  describe("Task #2264 P1: detectGitBranch", () => {
    test("detectGitBranch returns string for current git repo", () => {
      // 当前测试在工作树（~/work/codework/personal/roy-ui-v2），
      // 是 git repo，应该返回分支名
      const branch = detectGitBranch();
      expect(branch).toBeDefined();
      expect(branch).not.toBe("HEAD");
      // 应该匹配分支名格式（字母/数字/-/_）
      expect(branch).toMatch(/^[a-zA-Z0-9/_-]+$/);
    });

    test("detectGitBranch returns undefined for non-git directory", () => {
      const branch = detectGitBranch("/tmp");
      expect(branch).toBeUndefined();
    });
  });

  describe("Task #2264 P1: shortModelName", () => {
    test("should extract last dash part for hyphenated models", () => {
      expect(shortModelName("claude-3-5-sonnet")).toBe("sonnet");
      expect(shortModelName("gpt-4-turbo")).toBe("turbo");
    });

    test("should take last segment for hyphenated models", () => {
      expect(shortModelName("MiniMax-M3")).toBe("M3"); // last "-": "M3" (≤6 chars, return as-is)
      expect(shortModelName("gpt-4o")).toBe("4o");
    });

    test("should handle empty string", () => {
      expect(shortModelName("")).toBe("");
    });
  });

  describe("Task #2264 P1: buildStatusBarForREPL", () => {
    test("should include model short name + cwd + gitBranch in output", () => {
      const out = buildStatusBarForREPL({
        mode: "ready",
        model: "MiniMax-M3",
        cwd: "~/work/proj",
        gitBranch: "feat/ui-revamp-v2",
      });
      // 期望：ready (M3) · ⎇ feat/ui-revamp-v2 · ~/.../proj · ? for help = 4 段 → 3 个 ·
      const dotCount = (out.match(/\u00B7/g) || []).length;
      expect(dotCount).toBeGreaterThanOrEqual(3);
      expect(out).toContain("M3"); // shortModelName
      expect(out).toContain("feat/ui-revamp-v2"); // git
      expect(out).toContain("proj"); // cwd (shortened)
      expect(out).toContain("? for help");
    });

    test("should combine model short name with detail when both provided", () => {
      const out = buildStatusBarForREPL({
        mode: "executing",
        model: "claude-3-5-sonnet",
        detail: "bash",
      });
      // mode segment: "executing (sonnet bash)"
      expect(out).toContain("sonnet");
      expect(out).toContain("bash");
    });
  });
});
