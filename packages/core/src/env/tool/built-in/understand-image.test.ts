/**
 * @fileoverview understand_image 工具测试
 *
 * TDD RED: 测试先于实现。
 * - 工具元数据（name、schema 必填）
 * - 成功路径（mock LLM 返回固定文本）
 * - 失败路径（图片不存在 / LLM 调用抛错）
 * - @ 前缀剥除
 *
 * LLM 调用通过模块级 setUnderstandImageLLMProvider() 注入（参考 setToolConfigComponent），
 * 这样测试用 mock，生产由 AgentComponent 注入真实 LLM。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import {
  understandImageTool,
  setUnderstandImageLLMProvider,
  resetUnderstandImageLLMProvider,
} from "./understand-image";
import type { ContentPart, LLMMessage } from "../../llm/types";

const testDir = join("/tmp", `understand-image-test-${Date.now()}`);

/**
 * Mock LLM provider — 返回固定文本；可选 throw
 */
function createMockLLMProvider(opts: {
  response?: string;
  throwOnInvoke?: Error;
} = {}) {
  const calls: { messages: LLMMessage[] }[] = [];
  return {
    calls,
    provider: async (messages: LLMMessage[]): Promise<string> => {
      calls.push({ messages });
      if (opts.throwOnInvoke) {
        throw opts.throwOnInvoke;
      }
      return opts.response ?? "mock LLM response";
    },
  };
}

describe("understandImageTool", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await resetUnderstandImageLLMProvider();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await resetUnderstandImageLLMProvider();
  });

  describe("metadata", () => {
    test("should have name 'understand_image'", () => {
      expect(understandImageTool.name).toBe("understand_image");
    });

    test("should require prompt and image_source as strings", () => {
      const schema = understandImageTool.parameters as z.ZodObject<{
        prompt: z.ZodString;
        image_source: z.ZodString;
      }>;

      expect(schema.shape.prompt).toBeInstanceOf(z.ZodString);
      expect(schema.shape.image_source).toBeInstanceOf(z.ZodString);

      // 缺一不可
      const noPrompt = schema.safeParse({ image_source: "/tmp/x.png" });
      expect(noPrompt.success).toBe(false);

      const noImage = schema.safeParse({ prompt: "describe" });
      expect(noImage.success).toBe(false);

      // type checks
      const okBoth = schema.safeParse({
        prompt: "describe",
        image_source: "/tmp/x.png",
      });
      expect(okBoth.success).toBe(true);
    });

    test("should reject non-string values", () => {
      const schema = understandImageTool.parameters as z.ZodObject<{
        prompt: z.ZodString;
        image_source: z.ZodString;
      }>;

      const badPrompt = schema.safeParse({
        prompt: 123,
        image_source: "/tmp/x.png",
      });
      expect(badPrompt.success).toBe(false);

      const badImage = schema.safeParse({
        prompt: "describe",
        image_source: { url: "/tmp/x.png" },
      });
      expect(badImage.success).toBe(false);
    });

    test("should have a non-empty description", () => {
      expect(typeof understandImageTool.description).toBe("string");
      expect(understandImageTool.description.length).toBeGreaterThan(10);
    });
  });

  describe("execution — success path", () => {
    test("should return LLM response as output", async () => {
      const mock = createMockLLMProvider({ response: "It is a puppy" });
      setUnderstandImageLLMProvider(mock.provider);

      // 创建一个最小有效 PNG 文件 (1x1 transparent)
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const imagePath = join(testDir, "test.png");
      await writeFile(imagePath, pngBytes);

      const result = await understandImageTool.execute(
        { prompt: "describe the image", image_source: imagePath },
        {}
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("It is a puppy");
      expect(result.error).toBeUndefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.execution_time_ms).toBeGreaterThanOrEqual(0);

      // LLM 应被以 messages[] 形式调用，其中包含 text + image ContentPart
      expect(mock.calls.length).toBe(1);
      const sentMessages = mock.calls[0].messages;
      expect(sentMessages.length).toBeGreaterThan(0);
      const userMsg = sentMessages[0];
      expect(userMsg.role).toBe("user");
      // content 必为 ContentPart[]
      expect(Array.isArray(userMsg.content)).toBe(true);
      const parts = userMsg.content as ContentPart[];
      expect(parts.length).toBe(2);
      expect(parts[0]).toEqual({ type: "text", text: "describe the image" });
      expect(parts[1].type).toBe("image");
      expect((parts[1] as { type: "image"; image: string | Uint8Array }).image).toBeInstanceOf(Uint8Array);
    });

    test("should handle URL image sources", async () => {
      const mock = createMockLLMProvider({ response: "url ok" });
      setUnderstandImageLLMProvider(mock.provider);

      // data: URL (tiny 1x1 png inline) — 避免真实网络请求
      const dataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

      const result = await understandImageTool.execute(
        { prompt: "what is this?", image_source: dataUrl },
        {}
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("url ok");
      expect(mock.calls.length).toBe(1);
      const parts = mock.calls[0].messages[0].content as ContentPart[];
      expect(parts[1].type).toBe("image");
      const imgPart = parts[1] as { type: "image"; image: string | Uint8Array };
      // URL / data: 保持 string
      expect(typeof imgPart.image).toBe("string");
    });

    test("should strip '@' prefix from image_source", async () => {
      const mock = createMockLLMProvider({ response: "@ ok" });
      setUnderstandImageLLMProvider(mock.provider);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const imagePath = join(testDir, "at-prefix.png");
      await writeFile(imagePath, pngBytes);

      const result = await understandImageTool.execute(
        { prompt: "describe", image_source: `@${imagePath}` },
        {}
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("@ ok");
      expect(mock.calls.length).toBe(1);
    });
  });

  describe("execution — failure paths", () => {
    test("should return error when LLM provider not set", async () => {
      // 注意：beforeEach 已 reset
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const imagePath = join(testDir, "no-llm.png");
      await writeFile(imagePath, pngBytes);

      const result = await understandImageTool.execute(
        { prompt: "describe", image_source: imagePath },
        {}
      );

      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toContain("LLM provider");
    });

    test("should return error when image file does not exist", async () => {
      const mock = createMockLLMProvider({ response: "would-be response" });
      setUnderstandImageLLMProvider(mock.provider);

      const missing = join(testDir, "does-not-exist.png");
      const result = await understandImageTool.execute(
        { prompt: "describe", image_source: missing },
        {}
      );

      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toMatch(/not exist|no such file|ENOENT|parseImageInput/);
      // LLM 没被调用（图片读取失败后短路）
      expect(mock.calls.length).toBe(0);
    });

    test("should return error when LLM invocation throws", async () => {
      const mock = createMockLLMProvider({
        throwOnInvoke: new Error("LLM provider down"),
      });
      setUnderstandImageLLMProvider(mock.provider);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const imagePath = join(testDir, "llm-throw.png");
      await writeFile(imagePath, pngBytes);

      const result = await understandImageTool.execute(
        { prompt: "describe", image_source: imagePath },
        {}
      );

      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toMatch(/LLM provider down/);
      expect(mock.calls.length).toBe(1);
    });
  });
});
