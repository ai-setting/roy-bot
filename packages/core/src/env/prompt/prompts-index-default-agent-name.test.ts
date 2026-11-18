/**
 * TDD Test: Default Prompt Agent Name Template
 *
 * 目标：让 builtInPrompts["default"] 里的 4 处 "Roy" 可被 {{agent_name}} 占位符替换
 * - 不传 agent_name → 默认值 "Roy"（向后兼容）
 * - 传 agent_name="Alice" → 渲染后含 "Alice" 不含 "Roy"
 * - 占位符 {{agent_name}} 应被完全替换（不应残留）
 *
 * Task: 优化 interactive 启动支持 --default-agent-name 参数
 */

import { describe, expect, test } from "bun:test";
import {
  builtInPrompts,
  renderDefaultPrompt,
} from "./prompts-index";

describe("builtInPrompts['default'] agent_name template", () => {
  test("uses {{agent_name}} placeholder instead of hardcoded 'Roy' at name positions", () => {
    // The template must use the {{agent_name}} placeholder rather than
    // hardcoding "Roy" in the identity section, so callers can customize
    // the agent name at render time.
    const promptTemplate = builtInPrompts["default"];
    expect(promptTemplate).toContain("{{agent_name}}");
    // The identity section must not contain hardcoded "Roy"
    expect(promptTemplate).not.toContain("名称**: Roy");
  });

  test("renderDefaultPrompt('Roy') preserves 'Roy' as a valid identity name", () => {
    // Backwards-compatibility: existing callers passing 'Roy' get the same
    // prompt as before the placeholder refactor.
    const rendered = renderDefaultPrompt("Roy");
    expect(rendered).toContain("Roy");
    // All placeholders should be replaced (no leftovers)
    expect(rendered).not.toContain("{{agent_name}}");
  });

  test("renderDefaultPrompt('Alice') replaces 'Roy' with 'Alice' in identity positions", () => {
    // When a non-default name is provided, the rendered prompt should
    // contain the new name and no longer have any literal "Roy" at
    // identity positions (the tool-description mentions of "Roy" in
    // delegate_task examples may still exist, but the identity lines do not).
    const rendered = renderDefaultPrompt("Alice");
    expect(rendered).toContain("Alice");
    expect(rendered).not.toMatch(/\bRoy\b/);
    expect(rendered).not.toContain("{{agent_name}}");
  });

  test("renderDefaultPrompt() defaults to 'Roy' when called without arguments", () => {
    // Default behavior: no argument → "Roy" (backwards compatible).
    const rendered = renderDefaultPrompt();
    expect(rendered).toContain("Roy");
    expect(rendered).not.toContain("{{agent_name}}");
  });

  test("renderDefaultPrompt replaces every occurrence of {{agent_name}}", () => {
    // The default template references {{agent_name}} in multiple sections
    // (intro, identity, mission). All must be substituted, not just the first.
    const rendered = renderDefaultPrompt("Zoe");
    // No leftover placeholders
    expect(rendered).not.toContain("{{agent_name}}");
    // The new name appears multiple times (count >= 3 for the default template)
    const matches = rendered.match(/Zoe/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});