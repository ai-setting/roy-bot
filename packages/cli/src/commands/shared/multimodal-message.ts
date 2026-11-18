/**
 * @fileoverview assembleMultimodalMessage — 把 (text + image[]) 拼装为 ContentPart[]
 *
 * 用于 CLI `act --image` 一次性注入多张图片。
 *
 * 设计取舍：
 * - 文本在前、图在后（沿用 opencode stream.transport.ts:1227 的 parts 顺序）
 * - URL / data:base64 透传，本地路径走 parseImageInput 读 Buffer
 * - 空图片数组时保持 string 不变（backward compat）
 */

import type { ContentPart } from "@ai-setting/roy-bot-core";
import { parseImageInput } from "@ai-setting/roy-bot-core";

/**
 * 把 yargs --image 原始输入归一化为 string[]。
 * - undefined → []
 * - string → [string]
 * - string[] → 过滤空值 + 去重
 */
export function parseActImageArgs(
  raw: string | string[] | undefined
): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return raw.length > 0 ? [raw] : [];
  }
  if (!Array.isArray(raw)) return [];

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

/**
 * 拼装多模态 user message。
 * - 0 张图：同步返回原 text（保持 string，backward compat）
 * - ≥1 张图：异步返回 [{ type: 'text', text }, ...images]
 *
 * 注意：返回类型为 `string | Promise<ContentPart[]>`，让 0 张图时避免 microtask 开销。
 */
export function assembleMultimodalMessage(
  text: string,
  imageArgs: string[]
): string | Promise<ContentPart[]> {
  if (!imageArgs || imageArgs.length === 0) {
    return text;
  }

  // 并行加载所有图片
  const imageParts = Promise.all(
    imageArgs.map((raw) => parseImageInput(raw))
  ).then((parts) => [
    { type: "text" as const, text },
    ...parts,
  ]);

  return imageParts;
}