/**
 * @fileoverview deriveIdempotencyKey 单测（Task #4137 P1）
 *
 * 验证：
 * - 派生 key 长度 ≤ 50 字符（飞书 lark-cli 限制）
 * - 同 input 多次派生 → 同 key（hash 内容）
 * - 不同 input → 不同 key
 * - 部分字段 undefined/null → 不污染 source
 */

import { describe, test, expect } from "bun:test";
import { deriveIdempotencyKey } from "./idempotency-key";

describe("deriveIdempotencyKey (Task #4137 P1)", () => {
  test("派生 key 长度 ≤ 50 字符", () => {
    const key = deriveIdempotencyKey(["chat", "oc_xxx", "any content here"]);
    expect(key.length).toBeLessThanOrEqual(50);
    expect(key.startsWith("roy-")).toBe(true);
  });

  test("同 input 多次派生 → 同 key（hash 内容）", () => {
    const a = deriveIdempotencyKey(["chat", "oc_xxx", "hello world"]);
    const b = deriveIdempotencyKey(["chat", "oc_xxx", "hello world"]);
    expect(a).toBe(b);
  });

  test("不同 input → 不同 key", () => {
    const a = deriveIdempotencyKey(["chat", "oc_xxx", "hello world"]);
    const b = deriveIdempotencyKey(["chat", "oc_yyy", "hello world"]);
    expect(a).not.toBe(b);
  });

  test("undefined / null 字段被跳过（不污染 source）", () => {
    const a = deriveIdempotencyKey(["chat", "oc_xxx", "hello"]);
    const b = deriveIdempotencyKey(["chat", "oc_xxx", undefined, "hello"]);
    expect(a).toBe(b);
    const c = deriveIdempotencyKey(["chat", "oc_xxx", null, "hello"]);
    expect(a).toBe(c);
  });

  test("数字字段 stringify 后参与拼接", () => {
    const a = deriveIdempotencyKey(["notify", 123, "completed"]);
    const b = deriveIdempotencyKey(["notify", "123", "completed"]);
    expect(a).toBe(b);
  });

  test("★ Task #4137 P1：完整 content（不先截断）参与 hash — 前 30 字符相同的两条不同消息必须派生不同 key", () => {
    // 两条不同消息，前 30 字符完全相同（"调研报告 — 类 A TOP 5 项目速览："）
    // 但 length 不同 → 完整内容 hash 后必须得到不同 key
    const sharedPrefix = "调研报告 — 类 A TOP 5 项目速览：";
    const msgA = sharedPrefix + "项目1 项目2 项目3";
    const msgB = sharedPrefix + "项目1 项目2 项目3 项目4 项目5"; // 多了 2 项
    expect(msgA.slice(0, 30)).toBe(msgB.slice(0, 30)); // 前 30 字符确实相同
    const a = deriveIdempotencyKey(["chat", "oc_xxx", msgA]);
    const b = deriveIdempotencyKey(["chat", "oc_xxx", msgB]);
    expect(a).not.toBe(b);
  });
});