import { describe, test, expect } from "bun:test";
import { 
  AgentError, 
  ToolError, 
  LLMError, 
  ComponentError,
  ContextError,
  ErrorCodes,
  isRoyError,
  getErrorCode 
} from "./errors";

describe("错误类型体系", () => {
  
  describe("AgentError", () => {
    test("应该包含 code 和 details 属性", () => {
      const error = new AgentError(
        "Agent not found",
        ErrorCodes.AGENT_NOT_FOUND,
        { agentName: "test-agent" }
      );
      
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AgentError);
      expect(error.name).toBe("AgentError");
      expect(error.message).toBe("Agent not found");
      expect(error.code).toBe("AGENT_001");
      expect(error.details).toEqual({ agentName: "test-agent" });
    });
    
    test("应该支持不传 details", () => {
      const error = new AgentError("Test error", ErrorCodes.AGENT_RUN_FAILED);
      expect(error.details).toBeUndefined();
    });
  });
  
  describe("ToolError", () => {
    test("应该包含 code 和 toolName 属性", () => {
      const error = new ToolError(
        "Tool execution failed",
        ErrorCodes.TOOL_EXECUTION_FAILED,
        "readFile"
      );
      
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ToolError);
      expect(error.name).toBe("ToolError");
      expect(error.code).toBe("TOOL_003");
      expect(error.toolName).toBe("readFile");
    });
  });
  
  describe("LLMError", () => {
    test("应该包含 code 和 provider 属性", () => {
      const error = new LLMError(
        "LLM invocation failed",
        ErrorCodes.LLM_INVOCATION_FAILED,
        "openai"
      );
      
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LLMError);
      expect(error.name).toBe("LLMError");
      expect(error.code).toBe("LLM_002");
      expect(error.provider).toBe("openai");
    });
  });
  
  describe("ComponentError", () => {
    test("应该包含 code 和 componentName 属性", () => {
      const error = new ComponentError(
        "Component init failed",
        ErrorCodes.COMPONENT_INIT_FAILED,
        "agent"
      );
      
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ComponentError);
      expect(error.name).toBe("ComponentError");
      expect(error.code).toBe("COMP_002");
      expect(error.componentName).toBe("agent");
    });
  });
  
  describe("isRoyError", () => {
    test("应该识别 AgentError", () => {
      const error = new AgentError("test", ErrorCodes.AGENT_NOT_FOUND);
      expect(isRoyError(error)).toBe(true);
    });
    
    test("应该识别 ToolError", () => {
      const error = new ToolError("test", ErrorCodes.TOOL_NOT_FOUND, "tool");
      expect(isRoyError(error)).toBe(true);
    });
    
    test("不应该识别普通 Error", () => {
      const error = new Error("test");
      expect(isRoyError(error)).toBe(false);
    });
  });
  
  describe("getErrorCode", () => {
    test("应该返回 RoyError 的 code", () => {
      const error = new AgentError("test", ErrorCodes.AGENT_NOT_FOUND);
      expect(getErrorCode(error)).toBe("AGENT_001");
    });
    
    test("应该返回 undefined 对于普通 Error", () => {
      const error = new Error("test");
      expect(getErrorCode(error)).toBeUndefined();
    });
  });
  
  describe("ContextError", () => {
    test("应该包含 code、sessionId、usage 和 contextWindow 属性", () => {
      const usage = {
        promptTokens: 10000,
        completionTokens: 500,
        totalTokens: 10500,
      };
      const error = new ContextError(
        "Context threshold exceeded",
        ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
        "session-123",
        usage,
        128000
      );
      
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ContextError);
      expect(error.name).toBe("ContextError");
      expect(error.message).toBe("Context threshold exceeded");
      expect(error.code).toBe("CTX_001");
      expect(error.sessionId).toBe("session-123");
      expect(error.usage).toEqual(usage);
      expect(error.contextWindow).toBe(128000);
    });
    
    test("应该支持不传可选参数", () => {
      const error = new ContextError(
        "Context error",
        ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED
      );
      
      expect(error.sessionId).toBeUndefined();
      expect(error.usage).toBeUndefined();
      expect(error.contextWindow).toBeUndefined();
    });
    
    test("应该使用默认错误码", () => {
      const error = new ContextError("Context error");
      expect(error.code).toBe("CTX_001");
    });
  });
  
  describe("ErrorCodes - Context errors", () => {
    test("应该包含 CONTEXT_THRESHOLD_EXCEEDED", () => {
      expect(ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED).toBe("CTX_001");
    });
    
    test("应该包含 CONTEXT_COMPACTION_FAILED", () => {
      expect(ErrorCodes.CONTEXT_COMPACTION_FAILED).toBe("CTX_002");
    });
  });
});
