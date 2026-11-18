/**
 * @fileoverview Media utils — magic-byte mime sniffing, media-type gate, image-input parsing
 *
 * 借鉴 opencode 设计：
 * - ATTACH_FILE_MAX_BYTES = 10 MiB（防止 base64 内存爆炸）
 * - sniffAttachmentMime 优先 magic bytes，其次扩展名（mime-types），最后 application/octet-stream
 * - parseImageInput 支持本地路径 / http(s) URL / data:base64 URL
 *
 * 设计取舍：
 * - 不引入 mime-types npm 依赖，自己用常见扩展名映射兜底（轻量级）
 * - isMediaType 用 startsWith gate：image/audio/video/application/pdf
 * - image/svg+xml 不算 media（LLM 多用位图，SVG 太特殊）
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ContentPart } from "../env/llm/types";

// ============================================================================
// Constants
// ============================================================================

/**
 * 附件最大字节数（10 MiB）。
 * 借鉴 opencode 的 ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024（run.ts:59）。
 * 超过即拒收，避免 base64 编码后内存爆炸。
 */
export const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024;

// ============================================================================
// Magic byte detection
// ============================================================================

/**
 * 判断 buffer 前 N 字节是否等于 magic signature
 */
function startsWith(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

/**
 * 通过 magic bytes 检测 mime type。
 * 顺序：PNG → JPEG → GIF → WebP → PDF → BMP
 * 都不匹配则 fallback 到扩展名推断，都没则 application/octet-stream
 *
 * @param buffer 文件内容（Buffer 或 Uint8Array）
 * @param fallbackName 可选的文件名，用于扩展名 fallback（如 "image.png"）
 * @returns mime type 字符串
 */
export function sniffMimeType(buffer: Uint8Array, fallbackName?: string): string {
  return sniffMimeFromBuffer(buffer, fallbackName);
}

/**
 * 内部分发：buffer magic bytes + 可选文件名 fallback
 */
function sniffMimeFromBuffer(buffer: Uint8Array, fallbackName?: string): string {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 (37|39) 61
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  // BMP: 42 4D
  if (startsWith(buffer, [0x42, 0x4d])) {
    return "image/bmp";
  }
  // PDF: 25 50 44 46 2D
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  // WebP: RIFF....WEBP (offset 8)
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }

  // fallback 到扩展名
  if (fallbackName) {
    const ext = path.extname(fallbackName).toLowerCase();
    const extMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".pdf": "application/pdf",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
    };
    const mapped = extMap[ext];
    if (mapped) return mapped;
  }

  return "application/octet-stream";
}

// ============================================================================
// isMediaType — gate for LLM-acceptable media
// ============================================================================

/**
 * 判断 mime 是否为 LLM 支持的多模态媒体（image / audio / video / pdf）。
 *
 * image/svg+xml 故意排除：SVG 是矢量图，LLM 多用 vision 处理位图；
 * 如未来需要可加入白名单。
 */
export function isMediaType(mime: string): boolean {
  if (typeof mime !== "string") return false;
  const m = mime.toLowerCase();
  return (
    m.startsWith("image/") ||
    m.startsWith("audio/") ||
    m.startsWith("video/") ||
    m === "application/pdf"
  );
}

// ============================================================================
// parseImageInput — accept local path / http(s) URL / data:base64 URL
// ============================================================================

const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

/**
 * 解析图像输入并归一化为 ContentPart。
 *
 * 三种输入形式：
 * 1. 本地路径：读取文件、sniff mime、超 10 MiB 抛错、返回 { type: 'image', image: Buffer }
 * 2. http(s) URL：原样返回 { type: 'image', image: url }，由下游 AI SDK 处理
 * 3. data:base64 URL：原样返回 { type: 'image', image: dataUrl }
 *
 * @param input 图像输入字符串
 * @returns ContentPart（必为 image 类型）
 */
export async function parseImageInput(input: string): Promise<ContentPart> {
  if (!input || typeof input !== "string" || input.trim().length === 0) {
    throw new Error("parseImageInput: input is empty");
  }

  const trimmed = input.trim();

  // http(s) URL — pass through
  if (HTTP_URL_RE.test(trimmed)) {
    return { type: "image", image: trimmed };
  }

  // data: URL — pass through (AI SDK handles base64 decoding)
  if (DATA_URL_RE.test(trimmed)) {
    return { type: "image", image: trimmed };
  }

  // 本地路径 — 读取文件并 sniff
  return await parseLocalImagePath(trimmed);
}

/**
 * 读取本地图片路径为 ContentPart。
 * - 大小硬上限 ATTACH_FILE_MAX_BYTES
 * - 用 sniffMimeType 验证是图片
 */
async function parseLocalImagePath(filePath: string): Promise<ContentPart> {
  // 先 stat 看大小，避免读到一半 OOM
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    throw new Error(
      `parseImageInput: cannot stat file '${filePath}': ${(err as Error).message}`
    );
  }

  if (!stat.isFile()) {
    throw new Error(`parseImageInput: not a regular file: ${filePath}`);
  }

  if (stat.size > ATTACH_FILE_MAX_BYTES) {
    throw new Error(
      `parseImageInput: file '${filePath}' exceeds 10 MiB limit ` +
        `(${stat.size} bytes > ${ATTACH_FILE_MAX_BYTES} bytes)`
    );
  }

  // 读取 buffer
  const buffer = await fs.readFile(filePath);

  // sniff mime
  const mime = sniffMimeType(buffer, filePath);

  // 校验是图片 mime（其他类型如 pdf/zip 不应走 image part）
  if (!mime.startsWith("image/")) {
    throw new Error(
      `parseImageInput: file '${filePath}' is not an image (detected ${mime}). ` +
        `Use ContentPart type 'file' for non-image attachments.`
    );
  }

  return { type: "image", image: buffer };
}

// ============================================================================
// sniffImageMime — multi-source image MIME detection (Task #2888 follow-up)
// ============================================================================

/**
 * Multi-source image MIME detection used by adapter-pi-ai.ts toPiMessages().
 *
 * Hardcoding `mimeType: "image/*"` upstream made every vision provider
 * return HTTP 400 ("media type \"image/*\" not supported"). This helper
 * sniffs from 4 sources, in priority order:
 *
 *   1. Explicit `mediaType` if it's already specific (not "image/*")
 *   2. `data:` URL prefix (e.g. `data:image/jpeg;base64,...`)
 *   3. HTTP(S) URL suffix (.jpg/.jpeg/.png/.gif/.webp/.bmp)
 *   4. Buffer magic bytes (JPEG / PNG / GIF / WebP / BMP)
 *
 * If NONE of these succeed, throws an explicit error instead of silently
 * emitting the `"image/*"` wildcard.
 *
 * @param image  Uint8Array buffer / data: URL / http(s) URL
 * @param explicitMediaType  optional caller-provided MIME (e.g. from LLMMessage)
 * @returns  detected MIME string (e.g. "image/jpeg")
 * @throws  Error with clear message when MIME cannot be determined
 */
export function sniffImageMime(
  image: Uint8Array | string,
  explicitMediaType?: string,
): string {
  // 1. Explicit specific MIME (not "image/*" wildcard)
  if (
    explicitMediaType &&
    typeof explicitMediaType === "string" &&
    explicitMediaType !== "image/*" &&
    explicitMediaType.length > 0
  ) {
    return explicitMediaType;
  }

  // 2. data: URL prefix → extract MIME
  if (typeof image === "string" && image.startsWith("data:")) {
    const match = image.match(/^data:([^;,]+)/);
    if (match && match[1]) {
      return match[1];
    }
  }

  // 3. HTTP(S) URL suffix → infer from extension
  if (typeof image === "string" && /^https?:\/\//i.test(image)) {
    const m = image.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    const ext = m?.[1]?.toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "bmp") return "image/bmp";
  }

  // 4. Buffer magic bytes → sniffMimeType
  if (image instanceof Uint8Array) {
    const detected = sniffMimeFromBuffer(image);
    if (detected && detected !== "application/octet-stream") {
      return detected;
    }
  }

  // No source matched — throw clear error (NOT silent wildcard)
  const desc =
    typeof image === "string"
      ? `URL "${image.slice(0, 60)}${image.length > 60 ? "..." : ""}"`
      : `buffer (${image.length} bytes, no recognized magic bytes)`;
  throw new Error(
    `sniffImageMime: cannot determine image MIME from ${desc}. ` +
      `Provide an explicit mediaType (e.g. "image/jpeg") or use a data: URL with explicit MIME prefix.`,
  );
}