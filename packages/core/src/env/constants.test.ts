import { describe, test, expect } from "bun:test";
import { 
  AgentEvents,
  AgentErrorMessages,
  ToolEvents,
  ToolErrorMessages,
  LLMErrorMessages,
  ComponentEvents,
  isAgentEvent,
  isToolEvent,
} from "./constants";

describe("常量定义", () => {
  
  describe("AgentEvents", () => {
    test("应该定义正确的事件名称", () => {
      expect(AgentEvents.RUN_START).toBe("agent.run.start");
      expect(AgentEvents.RUN_COMPLETE).toBe("agent.run.complete");
      expect(AgentEvents.RUN_ERROR).toBe("agent.run.error");
      expect(AgentEvents.TOOL_CALLED).toBe("agent.tool.called");
      expect(AgentEvents.TOOL_RESULT).toBe("agent.tool.result");
      expect(AgentEvents.LLM_REQUEST).toBe("agent.llm.request");
      expect(AgentEvents.LLM_RESPONSE).toBe("agent.llm.response");
    });
  });
  
  describe("ToolEvents", () => {
    test("应该定义正确的事件名称", () => {
      expect(ToolEvents.EXECUTE_START).toBe("tool.execute.start");
      expect(ToolEvents.EXECUTE_COMPLETE).toBe("tool.execute.complete");
      expect(ToolEvents.EXECUTE_ERROR).toBe("tool.execute.error");
      expect(ToolEvents.REGISTERED).toBe("tool.registered");
    });
  });
  
  describe("ComponentEvents", () => {
    test("应该定义正确的事件名称", () => {
      expect(ComponentEvents.INIT_START).toBe("component.init.start");
      expect(ComponentEvents.INIT_COMPLETE).toBe("component.init.complete");
      expect(ComponentEvents.STOP).toBe("component.stop");
    });
  });
  
  describe("错误消息函数", () => {
    test("AgentErrorMessages 应该生成正确的消息", () => {
      expect(AgentErrorMessages.notFound("my-agent")).toBe("Agent not found: my-agent");
      expect(AgentErrorMessages.alreadyRunning("my-agent")).toBe("Agent my-agent is already running");
    });
    
    test("ToolErrorMessages 应该生成正确的消息", () => {
      expect(ToolErrorMessages.notFound("readFile")).toBe("Tool not found: readFile");
      expect(ToolErrorMessages.disabled("writeFile")).toBe("Tool writeFile is disabled");
    });
    
    test("LLMErrorMessages 应该生成正确的消息", () => {
      expect(LLMErrorMessages.providerNotFound("openai")).toBe("LLM provider not found: openai");
      expect(LLMErrorMessages.apiKeyMissing("anthropic")).toBe("API key missing for provider: anthropic");
    });
  });
  
  describe("类型守卫", () => {
    test("isAgentEvent 应该正确识别 Agent 事件", () => {
      expect(isAgentEvent("agent.run.start")).toBe(true);
      expect(isAgentEvent("tool.execute.start")).toBe(false);
    });
    
    test("isToolEvent 应该正确识别 Tool 事件", () => {
      expect(isToolEvent("tool.execute.start")).toBe(true);
      expect(isToolEvent("agent.run.start")).toBe(false);
    });
  });
});
