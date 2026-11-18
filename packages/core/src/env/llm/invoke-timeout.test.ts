import { describe, test, expect } from "bun:test";
import { withTimeout, TimeoutError } from "./invoke";

describe("LLM 超时控制", () => {
  
  describe("withTimeout", () => {
    test("应该正常完成不超时的操作", async () => {
      const result = await withTimeout(
        Promise.resolve("success"),
        1000
      );
      
      expect(result).toBe("success");
    });
    
    test("应该在超时时抛出 TimeoutError", async () => {
      await expect(
        withTimeout(
          new Promise<string>((resolve) => setTimeout(() => resolve("done"), 500)),
          100 // 100ms 超时，但操作需要 500ms
        )
      ).rejects.toThrow("LLM invocation timeout after 100ms");
    });
    
    test("应该支持自定义错误消息", async () => {
      await expect(
        withTimeout(
          new Promise<string>((resolve) => setTimeout(() => resolve("done"), 500)),
          100,
          "Custom timeout message"
        )
      ).rejects.toThrow("Custom timeout message");
    });
    
    test("应该支持取消超时", async () => {
      const result = await withTimeout(
        new Promise<string>((resolve) => setTimeout(() => resolve("done"), 50)),
        1000 // 1000ms 超时，操作只需要 50ms
      );
      
      expect(result).toBe("done");
    });
  });
  
  describe("TimeoutError", () => {
    test("应该有正确的名称和消息", () => {
      const error = new TimeoutError("test message", 100);
      
      expect(error.name).toBe("TimeoutError");
      expect(error.message).toBe("test message");
      expect(error.timeout).toBe(100);
    });
  });
});
