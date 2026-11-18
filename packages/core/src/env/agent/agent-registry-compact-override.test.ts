/**
 * @fileoverview AgentRegistry — 内置 compact / compact-hint agent 不被用户级 YAML 覆盖（Task #4933）
 *
 * 背景（实测发现的 MAJOR 缺口）：
 *   AgentRegistry.registerCompactAgent() 首行是 `if (this.agents.has(name)) return;`
 *   而 initRegistry() 的顺序是：
 *     1. `await this.registry.load()`            ← 先加载 ~/.local/share/roy-bot/agents/*.yaml
 *     2. `this.registry.registerCompactAgent()`  ← 后注册内置 compact（被 has() 守卫跳过）
 *   → 用户级 agents/compact.yaml **完全 SHADOW 内置定义**。
 *
 *   用户 yaml 若不写 allowedTools → agent-component.ts:1308
 *     `if (allowedTools !== undefined && allowedTools !== null)` 不成立 → **不做白名单过滤**
 *   → 压缩 agent 拿到全量 Roy 工具集，与 C 方案「无工具纯自然语言直出」语义冲突，
 *     且会显著拖慢压缩、增加误调用风险。
 *
 * 期望行为：用户级 yaml **可以覆盖展示性字段**（description / systemPromptRef），
 *   但**不得改变工具白名单语义** —— 内置 compact / compact-hint 的 allowedTools=[] 必须保持。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistry } from "./agent-registry";

const createMockConfigComponent = (config: Record<string, unknown> = {}) => ({
  get: vi.fn((key: string) => config[key]),
  set: vi.fn(),
  registerSource: vi.fn(),
  load: vi.fn(),
  watch: vi.fn(),
});

describe("AgentRegistry — 内置 compact agent 不被用户 YAML 覆盖工具白名单 (Task #4933)", () => {
  let registry: AgentRegistry;
  let mockFs: any;
  let mockFsPromises: any;

  beforeEach(() => {
    mockFs = { existsSync: vi.fn(() => true) };
    mockFsPromises = {
      readdir: vi.fn(async () => [
        { name: "compact.yaml", isDirectory: () => false },
      ]),
      readFile: vi.fn(async () => [
        "name: compact",
        "type: sub",
        "description: 用户级覆盖的描述",
        "systemPromptRef: compact",
        "deniedTools: []",
        "maxIterations: 3",
        "filterHistory: false",
      ].join("\n")),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      unlink: vi.fn(),
    };

    registry = new AgentRegistry({
      configComponent: createMockConfigComponent() as any,
      resolvePromptComponent: () => null,
      fs: mockFs,
      fsPromises: mockFsPromises,
    } as any);
  });

  it("用户级 compact.yaml 未写 allowedTools 时，注册内置后 allowedTools 仍为 []", async () => {
    // 1. 先加载用户级 yaml（复现 initRegistry 的第一步）
    await registry.loadFromDirectory("/tmp/fake-agents-dir");

    // 2. 用户 yaml 确实被加载了
    const afterLoad = registry.get("compact");
    expect(afterLoad).toBeDefined();
    expect(afterLoad!.description).toContain("用户级覆盖的描述");

    // 3. 注册内置 compact（复现 initRegistry 的第二步）
    registry.registerCompactAgent();

    // 4. ★ 核心断言：工具白名单必须仍是 []（不得被用户 yaml 掏空）
    const afterRegister = registry.get("compact");
    expect(afterRegister).toBeDefined();
    expect(afterRegister!.allowedTools).toEqual([]);
  });

  it("用户级 yaml 显式写了 allowedTools 时也不得放宽内置 compact 的工具集", async () => {
    mockFsPromises.readFile = vi.fn(async () => [
      "name: compact",
      "type: sub",
      "description: 用户级覆盖的描述",
      "systemPromptRef: compact",
      "allowedTools: ['bash', 'read_file']",
      "deniedTools: []",
      "maxIterations: 3",
      "filterHistory: false",
    ].join("\n"));

    await registry.loadFromDirectory("/tmp/fake-agents-dir");
    registry.registerCompactAgent();

    const cp = registry.get("compact");
    expect(cp!.allowedTools).toEqual([]);
  });

  it("用户级 yaml 不得覆盖内置 compact-hint 的工具白名单", async () => {
    mockFsPromises.readdir = vi.fn(async () => [
      { name: "compact-hint.yaml", isDirectory: () => false },
    ]);
    mockFsPromises.readFile = vi.fn(async () => [
      "name: compact-hint",
      "type: sub",
      "description: 用户级覆盖的 hint 描述",
      "systemPromptRef: compact-hint",
      "deniedTools: []",
      "maxIterations: 3",
      "filterHistory: false",
    ].join("\n"));

    await registry.loadFromDirectory("/tmp/fake-agents-dir");
    registry.registerCompactHintAgent();

    const hint = registry.get("compact-hint");
    expect(hint).toBeDefined();
    expect(hint!.allowedTools).toEqual([]);
  });

  it("非压缩类 agent 仍可被用户 yaml 正常覆盖（不回归）", async () => {
    mockFsPromises.readdir = vi.fn(async () => [
      { name: "my-agent.yaml", isDirectory: () => false },
    ]);
    mockFsPromises.readFile = vi.fn(async () => [
      "name: my-agent",
      "type: sub",
      "description: 我的 agent",
      "systemPromptRef: roy",
      "allowedTools: ['bash']",
    ].join("\n"));

    await registry.loadFromDirectory("/tmp/fake-agents-dir");

    const mine = registry.get("my-agent");
    expect(mine).toBeDefined();
    expect(mine!.description).toBe("我的 agent");
    expect(mine!.allowedTools).toEqual(["bash"]);
  });
});
