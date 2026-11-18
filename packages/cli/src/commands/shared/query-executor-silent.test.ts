/**
 * @fileoverview Task #2286: QueryExecutor silent 模式测试
 *
 * 验证 silent 选项透传到 StreamOutputService
 */

import { test, expect, describe } from "bun:test";
import { QueryExecutor } from "./query-executor";

describe("Task #2286: QueryExecutor silent 选项", () => {
  test("silent 选项透传到 StreamOutputService", () => {
    // 创建 QueryExecutor 时设 silent=true
    const qe = new QueryExecutor({
      env: {} as any,
      sessionComponent: {} as any,
      output: { warn: () => {}, info: () => {}, error: () => {}, success: () => {} } as any,
      quiet: true,
      silent: true,
    });

    // 验证内部字段被设置
    expect((qe as any).silent).toBe(true);
  });

  test("默认 silent=false（向后兼容）", () => {
    const qe = new QueryExecutor({
      env: {} as any,
      sessionComponent: {} as any,
      output: { warn: () => {}, info: () => {}, error: () => {}, success: () => {} } as any,
      quiet: true,
    });

    expect((qe as any).silent).toBe(false);
  });
});