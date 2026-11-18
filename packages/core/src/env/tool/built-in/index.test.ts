/**
 * @fileoverview getAllBuiltInTools() 索引测试
 *
 * 验证内置工具注册：
 * - understand_image 必须出现在默认工具列表中
 * - query_background_process 也必须出现（让 default agent 通过 ToolComponent 拿到）
 * - 工具名称唯一性
 */

import { describe, test, expect } from "bun:test";
import * as BuiltInTools from "./index";
import * as QueryBackgroundProcessToolModule from "./query-background-process-tool";
import {
  getAllBuiltInTools,
  understandImageTool,
  queryBackgroundProcessTool,
  compactSessionTool,
} from "./index";

describe("getAllBuiltInTools", () => {
  test("should include understand_image tool", () => {
    const tools = getAllBuiltInTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("understand_image");
  });

  test("understandImageTool export should equal registered instance", () => {
    const tools = getAllBuiltInTools();
    const registered = tools.find((t) => t.name === "understand_image");
    expect(registered).toBe(understandImageTool);
  });

  test("understandImageTool should be a multimodal vision tool", () => {
    expect(understandImageTool.metadata?.category).toBe("ai");
    expect(understandImageTool.metadata?.tags).toContain("multimodal");
    expect(understandImageTool.metadata?.tags).toContain("vision");
    expect(understandImageTool.metadata?.tags).toContain("image");
  });

  test("all built-in tools should have unique names", () => {
    const tools = getAllBuiltInTools();
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("deprecated BackgroundTaskManager injection APIs should not be exported", () => {
    for (const apiName of [
      "setQueryBackgroundProcessManager",
      "getQueryBackgroundProcessManager",
      "resetQueryBackgroundProcessManager",
    ]) {
      expect(apiName in QueryBackgroundProcessToolModule).toBe(false);
      expect(apiName in BuiltInTools).toBe(false);
    }
  });

  test("should include query_background_process tool (default-agent only)", () => {
    const tools = getAllBuiltInTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("query_background_process");
  });

  test("queryBackgroundProcessTool export should equal registered instance", () => {
    const tools = getAllBuiltInTools();
    const registered = tools.find((t) => t.name === "query_background_process");
    expect(registered).toBe(queryBackgroundProcessTool);
  });

  test("queryBackgroundProcessTool should be a task-category tool restricted to default agent", () => {
    expect(queryBackgroundProcessTool.metadata?.category).toBe("task");
    expect(queryBackgroundProcessTool.metadata?.tags).toContain("background");
    expect(queryBackgroundProcessTool.metadata?.allowedAgentTypes).toEqual(["default"]);
    expect(queryBackgroundProcessTool.permission?.level).toBe("safe");
  });

  test("should include compact_session tool (default-agent only, Task #4982)", () => {
    const tools = getAllBuiltInTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("compact_session");
  });

  test("compactSessionTool export should equal registered instance", () => {
    const tools = getAllBuiltInTools();
    const registered = tools.find((t) => t.name === "compact_session");
    expect(registered).toBe(compactSessionTool);
  });

  test("compactSessionTool should be a task-category tool restricted to default agent", () => {
    expect(compactSessionTool.metadata?.category).toBe("task");
    expect(compactSessionTool.metadata?.tags).toContain("compact");
    expect(compactSessionTool.metadata?.allowedAgentTypes).toEqual(["default"]);
    expect(compactSessionTool.permission?.level).toBe("safe");
  });
});
