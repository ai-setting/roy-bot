/**
 * @fileoverview understand_image — 多模态图片理解工具
 *
 * 对齐 MCP `understand_image` 工具的入参格式（image_source + prompt），
 * 但内部走 LLMComponent.invoke() 多模态调用路径。
 *
 * 设计取舍：
 * - 不直接 import LLMComponent（避免循环依赖 + 让单元测试注入 mock 即可）。
 *   改用模块级 setter（类似 `setToolConfigComponent`），由 AgentComponent 在
 *   LLMComponent 就绪后注入。
 * - 不注入 provider 时直接返回错误（fail-loud，避免静默空响应）。
 * - 图片解析复用 `parseImageInput` (P0)，支持 URL / data:base64 / 本地路径 / @ 前缀。
 * - 返回多模态 LLM 调用的文本结果。
 *
 * 实施位置：core 包内置工具，由 `loadBuiltInTools()` 自动注册到 default 和所有
 * 声明过 tools 的 agent。
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { ContentPart, LLMMessage } from "../../llm/types";
import { parseImageInput } from "../../../utils/media";

// ============================================================================
// LLM provider injection
// ============================================================================

/**
 * LLM 调用 provider 函数签名。
 *
 * AgentComponent 注入时会包装 LLMComponent.invoke() 调用：
 *   - 接收 messages[]（已组装为多模态 text + image content）
 *   - 返回 LLM 的文本响应
 *   - 不抛错由调用方处理
 *
 * 测试中以 mock 替代。
 */
export type UnderstandImageLLMProvider = (
  messages: LLMMessage[]
) => Promise<string>;

let injectedProvider: UnderstandImageLLMProvider | null = null;

/**
 * 设置 understand_image 工具使用的 LLM provider
 *
 * 通常由 AgentComponent 在 LLMComponent 就绪时调用。
 */
export function setUnderstandImageLLMProvider(
  provider: UnderstandImageLLMProvider | null
): void {
  injectedProvider = provider;
}

/**
 * 读取当前 provider（仅用于测试 / 诊断）。
 */
export function getUnderstandImageLLMProvider(): UnderstandImageLLMProvider | null {
  return injectedProvider;
}

/**
 * 重置 provider（仅用于测试 cleanup）。
 */
export async function resetUnderstandImageLLMProvider(): Promise<void> {
  injectedProvider = null;
}

// ============================================================================
// Source normalization
// ============================================================================

/**
 * 剥除 image_source 前导 `@` 前缀（与 MCP `understand_image` 工具的解析行为对齐）。
 *
 * `@` 在 MCP 工具规范里是"位置标记符"，而不是 URL scheme 的一部分。
 * 这里保持透明传递：去掉后让 parseImageInput 走 URL/本地路径/data: 分支。
 */
function normalizeImageSource(raw: string): string {
  if (typeof raw !== "string") return raw;
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

// ============================================================================
// Tool
// ============================================================================

/**
 * understand_image 工具
 *
 * 使用一个多模态 LLM 来分析图片内容。可用于：
 * - 看图描述（"What is in this image?"）
 * - OCR / 图文混排解析
 * - 视觉问答（VQA）
 *
 * 支持的 image_source：
 * - http(s) URL — 直接传给 LLM
 * - data:base64 URL — 直接传给 LLM
 * - 本地文件路径 — readFile 后以 buffer 形式传给 LLM
 * - `@`-prefixed 路径 — 同上，前缀被剥除
 */
export const understandImageTool: Tool = {
  name: "understand_image",
  description:
    "Analyze or describe the contents of an image using a multimodal LLM. " +
    "Provide a prompt describing what you want to extract or understand " +
    "(e.g. 'Describe this image in detail', 'Read the text in the receipt', " +
    "'What color is the car?'). The image_source can be an HTTP(S) URL, a " +
    "data:base64 URL, or a local file path (optionally prefixed with '@').",
  parameters: z.object({
    prompt: z
      .string()
      .min(1)
      .describe(
        "A text prompt describing what you want to analyze or extract from the image."
      ),
    image_source: z
      .string()
      .min(1)
      .describe(
        "The location of the image to analyze. Accepts HTTP(S) URL, data:base64 URL, or local file path. Optional '@' prefix is stripped."
      ),
  }),
  metadata: {
    category: "ai",
    tags: ["multimodal", "vision", "image", "llm", "ocr"],
    version: "1.0.0",
  },
  permission: {
    level: "safe",
  },
  execute: async (
    args: { prompt: string; image_source: string },
    _ctx: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const { prompt, image_source } = args;

    // 1. provider 可用性检查
    if (!injectedProvider) {
      return {
        success: false,
        output: "",
        error:
          "understand_image is not initialized: no LLM provider has been " +
          "registered. AgentComponent should call setUnderstandImageLLMProvider() " +
          "at agent startup.",
        metadata: { execution_time_ms: Date.now() - startTime },
      };
    }

    // 2. 解析图片（剥 @ 前缀 + sniff MIME + 读取 buffer for 本地路径）
    let imagePart: ContentPart;
    try {
      imagePart = await parseImageInput(normalizeImageSource(image_source));
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `failed to read image: ${(err as Error).message}`,
        metadata: { execution_time_ms: Date.now() - startTime },
      };
    }

    // 3. 组装 multimodal user message: text + image
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          imagePart,
        ],
      },
    ];

    // 4. 调用 LLM
    let responseText: string;
    try {
      responseText = await injectedProvider(messages);
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `LLM invocation failed: ${(err as Error).message}`,
        metadata: { execution_time_ms: Date.now() - startTime },
      };
    }

    return {
      success: true,
      output: responseText,
      metadata: {
        execution_time_ms: Date.now() - startTime,
      },
    };
  },
};
