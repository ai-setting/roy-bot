/**
 * @fileoverview Env String Split Tests for defaultAgent allowedTools/deniedTools
 *
 * 覆盖目标 (Task #2024 follow-up)：
 * 验证当 defaultAgent.allowedTools / deniedTools 来自环境变量（env path）时，
 * ConfigComponent.get() 返回的是 raw string，需要在 registerConfig 中 split 为数组。
 *
 * Bug 根因：
 *   - EnvSource 没有 transform；env 变量 `AGENT_DEFAULT_AGENT_ALLOWED_TOOLS=toolbox`
 *     被 configComponent.get() 原样返回为 string "toolbox"
 *   - 原代码 `as string[] | undefined` 是编译期谎言
 *   - 运行时 `allowedTools.includes(t.name)` 实际是 `String.prototype.includes`（子串匹配），
 *     而非 `Array.prototype.includes`（精确元素匹配）
 *   - 关键：String.prototype.includes(needle) 是 "haystack.contains(needle)"，
 *     即 "longer env value contains tool name as substring" → 误匹配
 *
 * Bug 表现（已用 demo 验证）：
 *   - 白名单 env="toolbox" + tools=[toolbox, tool, o, t, l] →
 *       "tool","o","t","l" 错误放行（都是 "toolbox" 的子串）
 *   - 黑名单 env="rmdir" + tools=[rmdir, rm, r, format] →
 *       "rm","r" 错误被拒（都是 "rmdir" 的子串）
 *
 * 本测试设计原则：
 *   故意使用 "env 值是较长的字符串 + 工具名是其子串" 的命名来暴露 substring bug
 *
 * 期望：
 *   - 修复前 (RED): 6 个测试全部 FAIL，证明 substring bug 真实存在
 *   - 修复后 (GREEN): 6 个测试全部 PASS
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Tool } from "../tool/types";
import { ToolComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Test Helpers
// ============================================================================

function makeTool(name: string): Tool {
  return {
    name,
    description: `test tool ${name}`,
    execute: vi.fn(),
  } as unknown as Tool;
}

function makeMockToolComponent(tools: Tool[]): ToolComponent {
  return {
    listTools: vi.fn(() => tools),
    getTool: vi.fn((name: string) => tools.find(t => t.name === name)),
    execute: vi.fn(),
  } as unknown as ToolComponent;
}

function makeMockEnv(configComponent: ConfigComponent, toolComponent?: ToolComponent) {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      if (name === "tool") return toolComponent;
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config" || (!!toolComponent && name === "tool")),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as ReturnType<typeof Object> & { getComponent: ReturnType<typeof vi.fn> };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("AgentComponent - Env String Split (Task #2024 follow-up)", () => {
  let tempDir: string;
  let emptyAgentsDir: string;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-envsplit-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });

    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);
  });

  afterEach(() => {
    delete process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS;
    delete process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS;
    try { fsSync.rmSync(tempDir, { recursive: true }); } catch {}
  });

  // ==========================================================================
  // RED-1: 白名单 — env 值较长时，名字是子串的工具被错误放行
  //   关键：String.prototype.includes 方向 = "longString".includes(shortName) → true
  //   env = "toolbox"，tools 包含 "tool", "o", "t", "l"（都是 "toolbox" 的子串）
  // ==========================================================================
  it("RED-1: env allowedTools='toolbox' should NOT pass tool/o/t/l (substring bug)", async () => {
    process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS = "toolbox";

    const toolComp = makeMockToolComponent([
      makeTool("toolbox"), // 期望通过
      makeTool("tool"),    // 期望拒绝（"tool" 是 "toolbox" 的子串 → substring bug 会让 includes 返回 true）
      makeTool("o"),       // 期望拒绝
      makeTool("t"),       // 期望拒绝
      makeTool("l"),       // 期望拒绝
      makeTool("x"),       // 期望拒绝
    ]);
    const env = makeMockEnv(configComponent, toolComp);

    const ac = new AgentComponent();
    await ac.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    await ac.refreshDependencies();

    ac.registerAgent("red1-agent", { type: "primary" });
    const agent = ac.getAgent("red1-agent")!;
    const tools = ac.getAvailableTools(agent);
    const names = tools.map(t => t.name).sort();

    // 精确匹配应只通过 "toolbox"
    expect(names).toEqual(["toolbox"]);
  });

  // ==========================================================================
  // RED-2: 黑名单 — env 值较长时，名字是子串的工具被错误拒绝
  //   env = "rmdir"，tools 包含 "rm", "r"（都是 "rmdir" 的子串）
  // ==========================================================================
  it("RED-2: env deniedTools='rmdir' should NOT deny rm/r (substring bug)", async () => {
    process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS = "rmdir";

    const toolComp = makeMockToolComponent([
      makeTool("rmdir"),     // 期望被拒
      makeTool("rm"),        // 期望保留（"rm" 是 "rmdir" 的子串 → substring bug 会让它被拒）
      makeTool("r"),         // 期望保留
      makeTool("format"),    // 期望保留
    ]);
    const env = makeMockEnv(configComponent, toolComp);

    const ac = new AgentComponent();
    await ac.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    await ac.refreshDependencies();

    ac.registerAgent("red2-agent", { type: "primary" });
    const agent = ac.getAgent("red2-agent")!;
    const tools = ac.getAvailableTools(agent);
    const names = tools.map(t => t.name).sort();

    // 精确匹配应只拒绝 "rmdir"
    expect(names).toEqual(["format", "r", "rm"]);
  });

  // ==========================================================================
  // RED-3: 白名单多元素 — env 值含多个长字符串 + 较短工具名是其子串
  //   env = "tool_a,tool_b"，tools 包含 "tool"（是 "tool_a" 的子串但不是精确匹配元素）
  // ==========================================================================
  it("RED-3: env allowedTools='tool_a,tool_b' should NOT pass 'tool' or 'o' (substring bug)", async () => {
    process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS = "tool_a,tool_b";

    const toolComp = makeMockToolComponent([
      makeTool("tool_a"),   // 期望通过
      makeTool("tool_b"),   // 期望通过
      makeTool("tool"),     // 期望拒绝（"tool" 是 "tool_a" 的子串 → substring bug 会让它通过）
      makeTool("o"),        // 期望拒绝
      makeTool("tool_c"),   // 期望拒绝（精确不匹配）
    ]);
    const env = makeMockEnv(configComponent, toolComp);

    const ac = new AgentComponent();
    await ac.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    await ac.refreshDependencies();

    ac.registerAgent("red3-agent", { type: "primary" });
    const agent = ac.getAgent("red3-agent")!;
    const tools = ac.getAvailableTools(agent);
    const names = tools.map(t => t.name).sort();

    expect(names).toEqual(["tool_a", "tool_b"]);
  });

  // ==========================================================================
  // RED-4: 黑名单多元素 — env 值含多个长字符串 + 较短工具名是其子串
  //   env = "foo,bar"，tools 包含 "f", "b"（"f" 是 "foo" 的子串，"b" 是 "bar" 的子串）
  //   同时测试嵌套子串 "oo", "ar" 等
  // ==========================================================================
  it("RED-4: env deniedTools='foo,bar' should NOT deny 'f'/'b'/'oo'/'ar' (substring bug)", async () => {
    process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS = "foo,bar";

    const toolComp = makeMockToolComponent([
      makeTool("foo"),     // 期望被拒
      makeTool("bar"),     // 期望被拒
      makeTool("f"),       // 期望保留（"f" 是 "foo" 的子串）
      makeTool("b"),       // 期望保留（"b" 是 "bar" 的子串）
      makeTool("oo"),      // 期望保留（"oo" 是 "foo" 的子串）
      makeTool("ar"),      // 期望保留（"ar" 是 "bar" 的子串）
      makeTool("baz"),     // 期望保留
    ]);
    const env = makeMockEnv(configComponent, toolComp);

    const ac = new AgentComponent();
    await ac.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    await ac.refreshDependencies();

    ac.registerAgent("red4-agent", { type: "primary" });
    const agent = ac.getAgent("red4-agent")!;
    const tools = ac.getAvailableTools(agent);
    const names = tools.map(t => t.name).sort();

    expect(names).toEqual(["ar", "b", "baz", "f", "oo"]);
  });

  // ==========================================================================
  // RED-5: 边缘 — 含空格 + 多个值
  //   env = " alpha , beta " 应被 split 成 ["alpha", "beta"]（trim + 过滤空）
  //   验证 split 正确性
  // ==========================================================================
  it("RED-5: env allowedTools with spaces should split and trim correctly", async () => {
    process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS = " alpha , beta ";

    const toolComp = makeMockToolComponent([
      makeTool("alpha"),  // 期望通过
      makeTool("beta"),   // 期望通过
      makeTool("gamma"),  // 期望拒绝
      makeTool("a"),      // 期望拒绝（"a" 是 "alpha" 的子串 → 修复后被拒）
    ]);
    const env = makeMockEnv(configComponent, toolComp);

    const ac = new AgentComponent();
    await ac.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    await ac.refreshDependencies();

    ac.registerAgent("red5-agent", { type: "primary" });
    const agent = ac.getAgent("red5-agent")!;
    const tools = ac.getAvailableTools(agent);
    const names = tools.map(t => t.name).sort();

    // 期望 ["alpha", "beta"] 通过白名单
    expect(names).toEqual(["alpha", "beta"]);
  });

  // ==========================================================================
  // RED-6: 组合 — 白名单 + 黑名单同时来自 env
  //   验证两者都用 string 输入时都能正确 split 且互不干扰
  // ==========================================================================
  it("RED-6: env allowedTools + deniedTools combined (both strings)", async () => {
    process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS = "alpha,beta";
    process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS = "beta_secret";

    const toolComp = makeMockToolComponent([
      makeTool("alpha"),         // 期望通过
      makeTool("beta"),          // 期望通过
      makeTool("beta_secret"),   // 期望被拒（deniedTools 包含）
      makeTool("a"),             // 期望被拒（"a" 是 "alpha" 的子串 → substring bug 会让 a 通过白名单）
      makeTool("gamma"),         // 期望被拒（allowedTools 不包含）
    ]);
    const env = makeMockEnv(configComponent, toolComp);

    const ac = new AgentComponent();
    await ac.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    await ac.refreshDependencies();

    ac.registerAgent("red6-agent", { type: "primary" });
    const agent = ac.getAgent("red6-agent")!;
    const tools = ac.getAvailableTools(agent);
    const names = tools.map(t => t.name).sort();

    expect(names).toEqual(["alpha", "beta"]);
  });
});
