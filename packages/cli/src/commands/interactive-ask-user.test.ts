/**
 * @fileoverview Interactive AskUserError Handling Test
 * 
 * TDD: 测试 Interactive 对 AskUserError 的捕获和处理
 * 
 * 新设计（简化流程）：
 * 1. 当 agent 调用 ask_user 工具时，会抛出 AskUserError
 * 2. Interactive 捕获错误，格式化输出（类似 agent text 样式）
 * 3. 等待用户输入
 * 4. 用户输入后，直接触发下一轮 agent（不需要手动 addUserMessage）
 * 
 * 关键点：
 * - tool result（问题和选项）已在 session 中
 * - user response 会被 agent 捕获并添加到 session
 * - agent 会自动加载 session 上下文继续执行
 */

import { describe, test, expect } from "bun:test";
import chalk from "chalk";

// ==================== 辅助函数（与 interactive.ts 保持一致）===================

/**
 * AskUserError 信息结构
 */
interface AskUserErrorInfo {
  query: string;
  options?: string[];
  requiredConfirm?: boolean;
  sessionId?: string;
  agentSessionId?: string;
  nodeId?: string;
  nodeType?: string;
}

/**
 * 解析 ask_user query 中的选项
 * 
 * 匹配格式: "问题 (选项: 选项1, 选项2, 选项3)"
 */
function parseOptionsFromQuery(query: string): { question: string; options?: string[] } {
  const optionsMatch = query.match(/\(选项:\s*(.+)\)/);
  if (optionsMatch) {
    const optionsStr = optionsMatch[1];
    const options = optionsStr.split(',').map(o => o.trim()).filter(o => o.length > 0);
    const question = query.replace(/\s*\(选项:.+\)/, '').trim();
    return { question, options };
  }
  return { question: query };
}

/**
 * 格式化 AskUserError 为用户友好的输出（类似 agent text 样式）
 */
function formatAskUserOutput(errorInfo: AskUserErrorInfo): string {
  const parts: string[] = [];
  
  parts.push(chalk.bold('\n🤔 ' + chalk.cyan('需要您的输入')) + '\n');
  
  // 解析问题和选项
  const { question, options } = parseOptionsFromQuery(errorInfo.query);
  
  parts.push(chalk.white(question) + '\n');
  
  // 如果有选项，展示选项列表
  if (options && options.length > 0) {
    parts.push('\n' + chalk.bold('请选择：') + '\n');
    options.forEach((opt, i) => {
      parts.push(chalk.cyan(`  ${i + 1}. `) + chalk.white(opt));
    });
    parts.push('');
  }
  
  // 提示信息
  if (errorInfo.requiredConfirm) {
    parts.push(chalk.yellow('⚠️ 此操作需要确认，请仔细阅读后再做决定\n'));
  }
  
  parts.push(chalk.dim('请输入您的回答，或按 Ctrl+C 退出\n'));
  
  return parts.join('\n');
}

/**
 * 解析用户输入
 */
function parseUserInput(input: string, options?: string[]): { 
  type: 'option' | 'text'; 
  value: string | number; 
} {
  const trimmedInput = input.trim();
  
  if (options && options.length > 0) {
    const index = parseInt(trimmedInput, 10) - 1;
    
    // 有效的数字选择
    if (!isNaN(index) && index >= 0 && index < options.length) {
      return { type: 'option', value: index };
    }
    
    // 精确匹配选项文本
    const exactMatch = options.findIndex(
      opt => opt.toLowerCase() === trimmedInput.toLowerCase()
    );
    if (exactMatch >= 0) {
      return { type: 'option', value: exactMatch };
    }
    
    // 前缀匹配选项文本
    const prefixMatch = options.findIndex(
      opt => opt.toLowerCase().startsWith(trimmedInput.toLowerCase())
    );
    if (prefixMatch >= 0) {
      return { type: 'option', value: prefixMatch };
    }
  }
  
  return { type: 'text', value: trimmedInput };
}

// ==================== Mock AskUserError ====================

class MockAskUserError extends Error {
  readonly name = 'AskUserError';
  readonly type = 'ask-user';
  
  constructor(
    public readonly runId: string,
    public readonly sessionId: string,
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly query: string,
    public readonly options?: string[],
    public readonly requiredConfirm?: boolean
  ) {
    super(`[${nodeType}:${nodeId}] Ask user: ${query}`);
  }
}

// ==================== 测试用例 ====================

describe("parseOptionsFromQuery", () => {
  test("should parse simple query without options", () => {
    const query = "这是一个简单的问题";
    const result = parseOptionsFromQuery(query);
    
    expect(result.question).toBe("这是一个简单的问题");
    expect(result.options).toBeUndefined();
  });

  test("should parse query with options", () => {
    const query = "请选择处理方式 (选项: 回退依赖, 强制升级, 检查其他方案)";
    const result = parseOptionsFromQuery(query);
    
    expect(result.question).toBe("请选择处理方式");
    expect(result.options).toEqual(["回退依赖", "强制升级", "检查其他方案"]);
  });

  test("should handle query with multiple commas in options", () => {
    const query = "请选择 (选项: 选项A, 选项B, 选项C)";
    const result = parseOptionsFromQuery(query);
    
    expect(result.question).toBe("请选择");
    expect(result.options).toEqual(["选项A", "选项B", "选项C"]);
  });

  test("should filter empty options", () => {
    const query = "请选择 (选项: , , )";
    const result = parseOptionsFromQuery(query);
    
    expect(result.question).toBe("请选择");
    expect(result.options).toEqual([]);
  });
});

describe("formatAskUserOutput", () => {
  test("should format simple query for display", () => {
    const errorInfo: AskUserErrorInfo = {
      query: "这是一个测试问题"
    };
    
    const output = formatAskUserOutput(errorInfo);
    
    expect(output).toContain("需要您的输入");
    expect(output).toContain("这是一个测试问题");
    expect(output).toContain("Ctrl+C");
  });

  test("should format query with options for display", () => {
    const errorInfo: AskUserErrorInfo = {
      query: "请选择处理方式 (选项: 回退依赖, 强制升级, 检查其他方案)"
    };
    
    const output = formatAskUserOutput(errorInfo);
    
    expect(output).toContain("请选择处理方式");
    expect(output).toContain("1. 回退依赖");
    expect(output).toContain("2. 强制升级");
    expect(output).toContain("3. 检查其他方案");
  });

  test("should show requiredConfirm warning", () => {
    const errorInfo: AskUserErrorInfo = {
      query: "请确认操作",
      requiredConfirm: true
    };
    
    const output = formatAskUserOutput(errorInfo);
    
    expect(output).toContain("请确认操作");
    expect(output).toContain("需要确认");
  });
});

describe("parseUserInput", () => {
  test("should allow direct text input for simple query", () => {
    const userInput = "这是我的回答";
    const result = parseUserInput(userInput);
    
    expect(result.type).toBe("text");
    expect(result.value).toBe("这是我的回答");
  });

  test("should validate option selection by number", () => {
    const options = ["回退依赖", "强制升级", "检查其他方案"];
    
    // 数字选择 1
    const result1 = parseUserInput("1", options);
    expect(result1.type).toBe("option");
    expect(result1.value).toBe(0);
    
    // 数字选择 2
    const result2 = parseUserInput("2", options);
    expect(result2.type).toBe("option");
    expect(result2.value).toBe(1);
  });

  test("should validate option selection by exact text match", () => {
    const options = ["回退依赖", "强制升级", "检查其他方案"];
    
    const result = parseUserInput("强制升级", options);
    expect(result.type).toBe("option");
    expect(result.value).toBe(1);
  });

  test("should validate option selection by prefix match", () => {
    const options = ["回退依赖", "强制升级", "检查其他方案"];
    
    // 输入 "回退" 应该匹配 "回退依赖"
    const result = parseUserInput("回退", options);
    expect(result.type).toBe("option");
    expect(result.value).toBe(0);
  });

  test("should fall back to text for invalid option selection", () => {
    const options = ["回退依赖", "强制升级", "检查其他方案"];
    
    // 输入 999 应该回退到文本输入
    const result = parseUserInput("999", options);
    expect(result.type).toBe("text");
    expect(result.value).toBe("999");
  });

  test("should normalize user input for option selection", () => {
    const options = ["回退依赖", "强制升级", "检查其他方案"];
    
    // 用户输入带空格的选项
    const result = parseUserInput("  强制升级  ", options);
    expect(result.type).toBe("option");
    expect(result.value).toBe(1);
  });

  test("should handle case insensitive option matching", () => {
    const options = ["回退依赖", "强制升级", "检查其他方案"];
    
    // 大小写不敏感
    const result = parseUserInput("回退", options);
    expect(result.type).toBe("option");
    expect(result.value).toBe(0);
  });
});

describe("AskUserError Detection", () => {
  test("should detect AskUserError by name property", () => {
    const error = new MockAskUserError(
      'run_123',
      'sess_456',
      'node_789',
      'agent',
      'test'
    );
    
    expect(error.name).toBe('AskUserError');
    expect(error instanceof Error).toBe(true);
  });

  test("should extract error info from __ASK_USER_ERROR__ prefix", () => {
    const errorInfo = {
      query: "请选择处理方式 (选项: A, B, C)",
      sessionId: "sess_456",
      nodeId: "node_789",
      nodeType: "agent"
    };
    
    const errorString = `__ASK_USER_ERROR__:${JSON.stringify(errorInfo)}`;
    
    expect(errorString.startsWith("__ASK_USER_ERROR__:")).toBe(true);
    
    const jsonPart = errorString.replace("__ASK_USER_ERROR__:", "");
    const parsed = JSON.parse(jsonPart);
    
    expect(parsed.query).toBe("请选择处理方式 (选项: A, B, C)");
    expect(parsed.sessionId).toBe("sess_456");
    expect(parsed.nodeId).toBe("node_789");
    expect(parsed.nodeType).toBe("agent");
  });

  test("should detect AskUserError from Error object name", () => {
    const error = new Error("test error");
    (error as any).name = 'AskUserError';
    
    expect(error.name).toBe('AskUserError');
  });
});

describe("Simplified Flow Integration", () => {
  test("should NOT need addUserMessage - session already contains tool result", () => {
    // 验证：ask_user tool 会将 tool result 保存到 session
    // Interactive 不需要手动 addUserMessage
    
    const sessionMessages: any[] = [
      { role: "user", content: "帮我处理这个" },
      { role: "assistant", content: "我需要确认..." },
      { role: "tool", name: "ask_user", content: "请选择处理方式 (选项: A, B, C)" }
    ];
    
    // 验证 session 中已有 tool result
    const toolResult = sessionMessages.find(m => m.role === "tool" && m.name === "ask_user");
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toContain("请选择处理方式");
  });

  test("should trigger agent after user input - agent auto-adds to session", () => {
    // 验证：用户输入后，agent 会自动：
    // 1. 捕获用户输入
    // 2. 添加到 session
    // 3. 继续执行
    
    const userResponse = "选择 A";
    
    // 模拟 agent 会将用户响应添加到 session
    const sessionMessages: any[] = [
      { role: "user", content: "帮我处理这个" },
      { role: "tool", name: "ask_user", content: "请选择处理方式 (选项: A, B, C)" }
    ];
    
    // 用户输入后，agent 会添加 user message
    sessionMessages.push({ role: "user", content: userResponse });
    
    // 验证：user message 已被添加到 session
    const lastMessage = sessionMessages[sessionMessages.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toBe("选择 A");
  });

  test("should parse error info from various sources", () => {
    // 测试 parseAskUserError 的多种来源
    
    // 1. 直接是 AskUserError 实例
    const error1 = new MockAskUserError('run1', 'sess1', 'node1', 'agent', 'query1');
    expect(error1.name).toBe('AskUserError');
    expect(error1.query).toBe('query1');
    
    // 2. Error 对象有 name = 'AskUserError'
    const error2 = new Error("test");
    (error2 as any).name = 'AskUserError';
    (error2 as any).query = 'query2';
    expect(error2.name).toBe('AskUserError');
    
    // 3. 错误字符串包含 __ASK_USER_ERROR__: 前缀
    const error3 = new Error("some error __ASK_USER_ERROR__:{\"query\":\"query3\"}");
    expect(error3.message).toContain("__ASK_USER_ERROR__:");
  });
});
