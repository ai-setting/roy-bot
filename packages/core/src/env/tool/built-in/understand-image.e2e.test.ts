/**
 * @fileoverview understand_image AgentComponent 集成测试
 *
 * 验证 AgentComponent.refreshDependencies() 正确注入了 LLM provider，
 * 让 understand_image 工具能通过真实的 LLMComponent 路径调用多模态 LLM。
 *
 * 注：本测试不调用真实 LLM API，只验证 provider 注入逻辑。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  understandImageTool,
  getUnderstandImageLLMProvider,
  setUnderstandImageLLMProvider,
  resetUnderstandImageLLMProvider,
} from "./understand-image";

describe("understandImageTool + provider injection", () => {
  beforeEach(() => {
    resetUnderstandImageLLMProvider();
  });

  test("provider starts as null (no injection yet)", () => {
    expect(getUnderstandImageLLMProvider()).toBeNull();
  });

  test("setUnderstandImageLLMProvider registers provider", () => {
    const provider = async () => "test response";
    setUnderstandImageLLMProvider(provider);
    expect(getUnderstandImageLLMProvider()).toBe(provider);
  });

  test("setUnderstandImageLLMProvider(null) clears provider", () => {
    setUnderstandImageLLMProvider(async () => "test");
    expect(getUnderstandImageLLMProvider()).not.toBeNull();
    setUnderstandImageLLMProvider(null);
    expect(getUnderstandImageLLMProvider()).toBeNull();
  });

  test("tool returns 'no provider' error when not initialized", async () => {
    const result = await understandImageTool.execute(
      { prompt: "describe", image_source: "/tmp/nonexistent.png" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("LLM provider");
  });

  test("tool returns parsed text when provider is set", async () => {
    setUnderstandImageLLMProvider(async () => "It's a happy dog in a park");

    // 1x1 PNG 字节
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const { writeFile, mkdir, rm } = await import("fs/promises");
    const { join } = await import("path");
    const testDir = join("/tmp", `understand-image-e2e-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const imagePath = join(testDir, "test.png");
    await writeFile(imagePath, pngBytes);

    try {
      const result = await understandImageTool.execute(
        { prompt: "describe", image_source: imagePath },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe("It's a happy dog in a park");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
