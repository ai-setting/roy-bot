/**
 * Task #2164 (Phase 4 TDD, RED phase) — pre-emptive builtInSubAgentNames inclusion.
 *
 * 核心 divergence vs reference #2146 (closes M1 from #2151 BEFORE it happens):
 * - reference: M1 fix 是出 review 后才发现需要加, 临时补丁加上
 * - beta: 直接在 list.ts 内置名册加上 workflow-runner, 防 hidden from agents list
 */
import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("ListCommand builtInSubAgentNames (Task #2164)", () => {
  const listTsPath = path.join(
    __dirname,
    "list.ts",
  );

  test("list.ts contains 'workflow-runner' in builtInSubAgentNames set", () => {
    // 由于 ListCommand 内部构造方式复杂 (Yargs + OutputService), 直接读源码验证
    // builtInSubAgentNames set 的成员关系, 避免过度 mock.
    const source = fs.readFileSync(listTsPath, "utf-8");
    expect(source).toMatch(/builtInSubAgentNames[\s\S]*workflow-runner/);
    // sanity: 还包含原有的 roy / general / explore
    expect(source).toContain("\"general\"");
    expect(source).toContain("\"explore\"");
    expect(source).toContain("\"roy\"");
  });
});

describe("ListCommand builtInSubAgentNames + agent registry consistency (Task #2486)", () => {
  const listTsPath = path.join(__dirname, "list.ts");
  const registryTsPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "core",
    "src",
    "env",
    "agent",
    "agent-registry.ts",
  );

  test("AgentRegistry description 中 workflow_name 关键词 + list.ts 内置名册同步", () => {
    // 防回归: AgentRegistry description 改了 workflow_name 必传契约,
    // list.ts 必须仍然把 workflow-runner 列在 builtInSubAgentNames (用户可见)
    const listSource = fs.readFileSync(listTsPath, "utf-8");
    const registrySource = fs.readFileSync(registryTsPath, "utf-8");

    expect(listSource).toMatch(/builtInSubAgentNames[\s\S]*workflow-runner/);
    // registry 描述必须含 workflow_name 关键词
    expect(registrySource).toMatch(/workflow_name|workflow name/);
  });
});
