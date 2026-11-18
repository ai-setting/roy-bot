/**
 * @fileoverview SummaryAgent parseHintResponse 测试
 * 
 * TDD 规范：覆盖 LLM 可能返回的各种输出格式
 * 
 * 测试 parseCompactHintResponse 函数的解析逻辑
 * 
 * Hint 阶段输出格式：JSON with guidance_prompt key
 * 需要兼容各种 LLM 输出格式
 */

import { describe, expect, test } from "bun:test";
import { parseCompactHintResponse } from "./summary-agent";

// ============================================================================
// 测试数据：各种 LLM 输出场景
// ============================================================================

/**
 * 场景1: JSON with guidance_prompt key (标准格式)
 * 新格式：包含 Work type, Progress, CRITICAL to preserve, Focus extraction on
 */
const LLM_OUTPUT_JSON_STANDARD = `{
  "guidance_prompt": "Bug investigation: User is debugging LSP diagnostics not updating after file edits. Progress: identified root cause (getDiagnostics needs to read latest file content and trigger didChange notification), implemented fix, CI verified. CRITICAL to preserve: the fix implementation details (file path, code changes), that 2 agent-node-integration tests still fail due to test assertion timing issue (expects 'running' but completes in ~78ms) - this is unrelated to LSP work. Focus extraction on: root cause analysis, fix implementation, known remaining test issues."
}`;

/**
 * 场景2: JSON with explanation (text + json 混合)
 */
const LLM_OUTPUT_JSON_WITH_EXPLANATION = `Based on my analysis of the conversation, here is the guidance prompt:

{
  "guidance_prompt": "Feature development: User is implementing JWT authentication for auth-service. Progress: designed auth flow, implemented token refresh logic, middleware partially done. CRITICAL to preserve: auth flow decisions (token storage, refresh strategy), completed middleware components, modules pending implementation. Focus extraction on: architectural decisions, completed components, pending work."
}

This guidance will help generate a more focused checkpoint.`;

/**
 * 场景3: JSON wrapped in ```json ```
 */
const LLM_OUTPUT_JSON_CODE_BLOCK = `Here's the analysis:

\`\`\`json
{
  "guidance_prompt": "Refactoring: User is migrating data layer to repository pattern. Progress: migrated UserRepository and OrderRepository, 3 more pending. CRITICAL to preserve: pattern decisions (interface definitions, dependency injection approach), completed repositories, modules pending migration. Focus extraction on: pattern implementation details, completed vs pending modules."
}
\`\`\`

Let me know if you need any adjustments.`;

/**
 * 场景4: JSON wrapped in plain ``` ```
 */
const LLM_OUTPUT_JSON_PLAIN_CODE_BLOCK = `\`\`\`
{
  "guidance_prompt": "Bug investigation. User is debugging intermittent 500 errors on /api/users endpoint. CRITICAL to preserve: suspected root cause (race condition), metrics added, remaining investigation steps. Focus on: root cause analysis and next steps."
}
\`\`\``;

/**
 * 场景5: Markdown code block with language hint
 */
const LLM_OUTPUT_MARKDOWN_CODE_BLOCK = `### Guidance Prompt

\`\`\`markdown
Feature development. User is implementing JWT authentication. CRITICAL to preserve: auth flow decisions.
\`\`\``;

/**
 * 场景5a: 纯 markdown code block（无语言标识）
 */
const LLM_OUTPUT_PLAIN_CODE_BLOCK_PLAIN = `\`\`\`
Feature development. User is implementing JWT authentication. CRITICAL to preserve: auth flow decisions.
\`\`\``;

/**
 * 场景6: 纯文本（无 JSON）- 降级处理
 */
const LLM_OUTPUT_PLAIN_TEXT = `Bug investigation: User is debugging LSP diagnostics not updating after file edits. Progress: identified root cause, implemented fix. CRITICAL to preserve: fix implementation details, remaining test issues. Focus on: root cause analysis, fix implementation.`;

/**
 * 场景7: 带空白的 JSON
 */
const LLM_OUTPUT_JSON_WITH_WHITESPACE = `

{
    "guidance_prompt": "Bug investigation: User is debugging intermittent 500 errors on /api/users endpoint. Progress: identified root cause. CRITICAL to preserve: race condition findings, metrics added. Focus on: remaining investigation steps."
}

`;

/**
 * 场景8: JSON with additional fields
 */
const LLM_OUTPUT_JSON_WITH_EXTRA_FIELDS = `{
  "analysis": "The user is working on a feature implementation",
  "guidance_prompt": "Feature development: User is implementing JWT authentication. Progress: designed auth flow. CRITICAL to preserve: token storage strategy, refresh logic. Focus extraction on: architectural decisions.",
  "work_type": "feature",
  "priority": "high"
}`;

/**
 * 场景9: 超长 JSON
 */
const LLM_OUTPUT_JSON_LONG = `{
  "guidance_prompt": "Feature development: User is implementing JWT authentication for the auth-service. Progress: designed auth flow, implemented token refresh logic, middleware partially done. CRITICAL to preserve: auth flow decisions (token storage, refresh strategy), completed middleware components, modules pending implementation. Focus extraction on: architectural decisions, completed components, pending work. ${"x".repeat(300)}"
}`;

/**
 * 场景10: 空白内容
 */
const LLM_OUTPUT_EMPTY = "";

// ============================================================================
// TDD 测试：按场景覆盖
// ============================================================================

describe("SummaryAgent.parseCompactHintResponse", () => {
  
  describe("场景1: JSON 标准格式 (新格式)", () => {
    
    test("应正确解析 JSON 并提取 guidance_prompt", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_STANDARD);
      
      expect(result).toContain("Bug investigation");
      expect(result).toContain("Progress:");
      expect(result).toContain("CRITICAL to preserve:");
      expect(result).toContain("Focus extraction on:");
    });
    
  });
  
  describe("场景2: JSON with explanation (text + json 混合)", () => {
    
    test("应正确解析包含说明文本的 JSON", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_WITH_EXPLANATION);
      
      expect(result).toContain("Feature development");
      expect(result).toContain("Progress:");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
  });
  
  describe("场景3: JSON wrapped in ```json ```", () => {
    
    test("应正确解析 ```json ``` 包裹的 JSON", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_CODE_BLOCK);
      
      expect(result).toContain("Refactoring");
      expect(result).toContain("Progress:");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
  });
  
  describe("场景4: JSON wrapped in plain ``` ```", () => {
    
    test("应正确解析 ``` ``` 包裹的 JSON", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_PLAIN_CODE_BLOCK);
      
      expect(result).toContain("Bug investigation");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
  });
  
  describe("场景5: Markdown code block with language hint", () => {
    
    test("应正确解析 markdown 包裹的纯文本", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_MARKDOWN_CODE_BLOCK);
      
      // markdown ```...``` 提取内部内容，前面的文本会被保留
      expect(result).toContain("Feature development");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
  });
  
  describe("场景5a: 纯 code block（无语言标识）", () => {
    
    test("应正确提取 code block 内的纯文本", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_PLAIN_CODE_BLOCK_PLAIN);
      
      expect(result).toContain("Feature development");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
  });
  
  describe("场景6: 纯文本（无 JSON）- 降级处理", () => {
    
    test("纯文本应直接返回（作为降级方案）", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_PLAIN_TEXT);
      
      expect(result).toContain("Bug investigation");
      expect(result).toContain("Progress:");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
    test("纯文本应包含必要元素", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_PLAIN_TEXT);
      
      expect(result).toMatch(/Bug investigation|Feature development|Refactoring/i);
      expect(result).toMatch(/Progress:/i);
      expect(result).toMatch(/CRITICAL to preserve:/i);
    });
    
  });
  
  describe("场景7: 带空白的 JSON", () => {
    
    test("应正确解析带空白的 JSON", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_WITH_WHITESPACE);
      
      expect(result).toContain("Bug investigation");
      expect(result).toContain("Progress:");
      expect(result).toContain("CRITICAL to preserve:");
    });
    
  });
  
  describe("场景8: JSON with extra fields", () => {
    
    test("应忽略额外字段，只提取 guidance_prompt", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_WITH_EXTRA_FIELDS);
      
      expect(result).toContain("Feature development");
      expect(result).toContain("Progress:");
      expect(result).toContain("CRITICAL to preserve:");
      // 不应包含额外字段
      expect(result).not.toContain('"analysis"');
      expect(result).not.toContain('"work_type"');
    });
    
  });
  
  describe("场景9: 超长 JSON guidance_prompt", () => {
    
    test("超长内容应被截断到 500 字符", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_JSON_LONG);
      
      expect(result.length).toBe(503); // 500 + "..."
      expect(result.endsWith("...")).toBe(true);
      expect(result).toContain("Feature development");
    });
    
  });
  
  describe("场景10: 空白内容", () => {
    
    test("空字符串应返回降级提示", () => {
      const result = parseCompactHintResponse(LLM_OUTPUT_EMPTY);
      
      expect(result).toBe("[Hint extraction failed]");
    });
    
  });
  
  describe("边界情况", () => {
    
    test("纯空白应返回降级提示", () => {
      const result = parseCompactHintResponse("   \n\n  ");
      
      expect(result).toBe("[Hint extraction failed]");
    });
    
    test("带 guidance_prompt key 但值为空应返回降级提示", () => {
      const result = parseCompactHintResponse('{"guidance_prompt": ""}');
      
      expect(result).toBe("[Hint extraction failed]");
    });
    
    test("JSON 但缺少 guidance_prompt 字段应降级处理", () => {
      const result = parseCompactHintResponse('{"other_field": "some value"}');
      
      // 降级到纯文本处理
      expect(result).toBe('{"other_field": "some value"}');
    });
    
    test("无效 JSON 应降级处理", () => {
      const result = parseCompactHintResponse("This is not JSON at all");
      
      // 降级到纯文本处理
      expect(result).toBe("This is not JSON at all");
    });
    
    test("JSON 解析失败但有代码块应尝试提取", () => {
      const result = parseCompactHintResponse("```json\ninvalid json {}\n```");
      
      // 降级处理后可能是原始内容
      expect(typeof result).toBe("string");
    });
    
  });
  
});

// ============================================================================
// 补充测试：指导 Prompt 格式验证 (新格式)
// ============================================================================

describe("Compact Guidance Prompt 格式示例 (新格式)", () => {
  
  const goodExamples = [
    "Bug investigation: User is debugging LSP diagnostics not updating. Progress: identified root cause, implemented fix. CRITICAL to preserve: fix implementation details, remaining test issues. Focus extraction on: root cause analysis.",
    "Feature development: User is implementing JWT authentication. Progress: designed auth flow, implemented token refresh. CRITICAL to preserve: auth flow decisions, completed components. Focus extraction on: architectural decisions.",
    "Refactoring: User is migrating data layer to repository pattern. Progress: migrated UserRepository, 3 more pending. CRITICAL to preserve: pattern decisions, completed repositories. Focus extraction on: pattern implementation details.",
  ];
  
  test.each(goodExamples)("示例应包含必要元素", (example) => {
    const result = parseCompactHintResponse(example);
    
    // 应该包含工作类型关键词
    expect(result).toMatch(/Bug investigation:|Feature development:|Refactoring:/i);
    
    // 应该包含 Progress:
    expect(result).toMatch(/Progress:/i);
    
    // 应该包含 CRITICAL to preserve:
    expect(result).toMatch(/CRITICAL to preserve:/i);
    
    // 应该包含 Focus extraction on:
    expect(result).toMatch(/Focus extraction on:/i);
  });
  
});

// ============================================================================
// 输出约束测试
// ============================================================================

describe("LLM Output Format 约束", () => {
  
  describe("guidance_prompt key 验证", () => {
    
    test("正确格式的 JSON 应能被解析", () => {
      const jsonInput = '{"guidance_prompt": "Test prompt"}';
      const result = parseCompactHintResponse(jsonInput);
      
      expect(result).toBe("Test prompt");
    });
    
    test("带转义字符的 guidance_prompt 应正确解析", () => {
      const jsonInput = '{"guidance_prompt": "Test with \\"quotes\\" and \\\\ backslash"}';
      const result = parseCompactHintResponse(jsonInput);
      
      expect(result).toBe('Test with "quotes" and \\ backslash');
    });
    
    test("带换行符的 guidance_prompt 应正确解析", () => {
      const jsonInput = '{"guidance_prompt": "Line 1\\nLine 2"}';
      const result = parseCompactHintResponse(jsonInput);
      
      expect(result).toBe("Line 1\nLine 2");
    });
    
  });
  
});
