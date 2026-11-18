/**
 * createLLMAdapter 工厂测试
 *
 * 验证：
 * 1. 默认（无环境变量）→ PiAiAdapter
 * 2. ROY_LLM_PROVIDER=pi-ai → PiAiAdapter
 * 3. ROY_LLM_PROVIDER=ai-sdk → AiSdkAdapter
 * 4. setLLMProvider() 覆盖优先级高于环境变量
 * 5. 非法 ROY_LLM_PROVIDER 值 → 抛错
 */
import { describe, test, expect, afterEach } from "bun:test";

describe("createLLMAdapter factory", () => {
  const originalEnv = process.env.ROY_LLM_PROVIDER;
  const { setLLMProvider, getLLMProviderOverride, createLLMAdapter } =
    require("./factory") as typeof import("./factory");

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ROY_LLM_PROVIDER;
    else process.env.ROY_LLM_PROVIDER = originalEnv;
    setLLMProvider(undefined);
  });

  test("默认（无环境变量）→ PiAiAdapter", () => {
    delete process.env.ROY_LLM_PROVIDER;
    setLLMProvider(undefined);
    const adapter = createLLMAdapter();
    expect(adapter.name).toBe("pi-ai");
  });

  test("ROY_LLM_PROVIDER=pi-ai → PiAiAdapter", () => {
    process.env.ROY_LLM_PROVIDER = "pi-ai";
    setLLMProvider(undefined);
    const adapter = createLLMAdapter();
    expect(adapter.name).toBe("pi-ai");
  });

  test("ROY_LLM_PROVIDER=ai-sdk → AiSdkAdapter", () => {
    process.env.ROY_LLM_PROVIDER = "ai-sdk";
    setLLMProvider(undefined);
    const adapter = createLLMAdapter();
    expect(adapter.name).toBe("ai-sdk");
  });

  test("setLLMProvider('ai-sdk') 覆盖环境变量", () => {
    process.env.ROY_LLM_PROVIDER = "pi-ai";
    setLLMProvider("ai-sdk");
    expect(getLLMProviderOverride()).toBe("ai-sdk");
    const adapter = createLLMAdapter();
    expect(adapter.name).toBe("ai-sdk");
  });

  test("非法 ROY_LLM_PROVIDER 值 → 抛错", () => {
    process.env.ROY_LLM_PROVIDER = "bogus";
    setLLMProvider(undefined);
    expect(() => createLLMAdapter()).toThrow(/Invalid ROY_LLM_PROVIDER/);
  });
});
