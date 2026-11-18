/**
 * Task #5117 (M1) — headless run 摘要行渲染器测试
 *
 * 方案 docs/task-4954-run-output-simplification-plan.md §4.1-2 / §3.4 / §3.5：
 *   stdout 只出「机器可读的摘要行」，stderr 承接诊断。
 *   四类前缀：[event] / [result] / [lifecycle] / [fatal]。
 *
 * TDD RED：先写测试（渲染器尚不存在 → 编译失败/断言失败），
 * 再实现 packages/cli/src/commands/run-headless-summary.ts 转 GREEN。
 */

import { describe, test, expect, spy, mock } from "bun:test";
import { RunHeadlessSummary } from "./run-headless-summary";

/** 收集 stdout 行的 helper */
function captureStdout() {
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const stub = mock((chunk: any): boolean => {
    lines.push(String(chunk));
    return true;
  });
  process.stdout.write = stub as any;
  return {
    lines,
    restore() {
      process.stdout.write = origWrite;
    },
  };
}

describe("RunHeadlessSummary — 输出协议 (Task #5117 M1)", () => {
  test("event() 输出 [event] 前缀摘要行到 stdout", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.event("id_20014ea2_0f9628d0", "event-source.event.lark-cli", "飞书消息已接收（chat=oc_xxx）");
      expect(cap.lines.join("")).toContain("[event] id_20014ea2_0f9628d0 event-source.event.lark-cli");
      expect(cap.lines.join("")).toContain("飞书消息已接收（chat=oc_xxx）");
    } finally {
      cap.restore();
    }
  });

  test("result() 输出 [result] 前缀摘要行（含 status / 耗时 / tokens）", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.result({
        sessionId: "session_abc",
        status: "ok",
        durationMs: 4210,
        promptTokens: 3530,
        completionTokens: 219,
        totalTokens: 3749,
        summary: "已处理 1 条飞书消息",
      });
      const out = cap.lines.join("");
      expect(out).toContain("[result] session_abc ok");
      expect(out).toContain("4210ms");
      expect(out).toContain("prompt=3530");
      expect(out).toContain("completion=219");
      expect(out).toContain("total=3749");
      expect(out).toContain("已处理 1 条飞书消息");
    } finally {
      cap.restore();
    }
  });

  test("result() 缺省 tokens 时省略 token 段（不输出 undefined/null）", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.result({
        sessionId: "session_x",
        status: "error",
        durationMs: 120,
        summary: "执行失败: boom",
      });
      const out = cap.lines.join("");
      expect(out).toContain("[result] session_x error 120ms");
      expect(out).toContain("执行失败: boom");
      expect(out).not.toContain("prompt=undefined");
      expect(out).not.toContain("total=null");
    } finally {
      cap.restore();
    }
  });

  test("lifecycleStarted() / lifecycleStopped() 输出 [lifecycle] es-started / es-stopped", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.lifecycleStarted("id_timer_main");
      s.lifecycleStopped("id_timer_main");
      const out = cap.lines.join("");
      expect(out).toContain("[lifecycle] es-started id_timer_main");
      expect(out).toContain("[lifecycle] es-stopped id_timer_main");
    } finally {
      cap.restore();
    }
  });

  test("fatal() 输出 [fatal] 到 stdout（协议的一部分）", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.fatal("事件源组件缺失，无法继续");
      expect(cap.lines.join("")).toContain("[fatal] 事件源组件缺失，无法继续");
    } finally {
      cap.restore();
    }
  });

  test("event() 多行摘要压成单行（换行替换为空格）", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.event("src", "type", "第一行\n第二行\n第三行");
      const out = cap.lines.join("").trim();
      expect(out).not.toContain("\n第二行");
      expect(out).toContain("第一行 第二行 第三行");
    } finally {
      cap.restore();
    }
  });

  test("每条摘要恰好一行（以 \\n 结尾，不含裸换行污染协议）", () => {
    const cap = captureStdout();
    try {
      const s = new RunHeadlessSummary();
      s.lifecycleStarted("a");
      s.event("a", "t", "x");
      // 每次调用恰好产生一个 "\n" 结尾的行
      const joined = cap.lines.join("");
      const rows = joined.split("\n").filter((r) => r.trim() !== "");
      expect(rows.length).toBe(2);
    } finally {
      cap.restore();
    }
  });
});
