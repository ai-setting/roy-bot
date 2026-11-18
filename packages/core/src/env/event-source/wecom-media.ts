/**
 * @fileoverview Task #5199 — 企微媒体（图片/文件）下载解密落盘
 *
 * ## 背景（用户实测问题）
 *
 * 企微长连接模式下 `image`/`file`/`video` 消息只带：
 * - `image_url`（或 `image.voice_url` 等）：加密媒体下载地址，
 *   **5 分钟内有效**；
 * - `aeskey`：Base64 编码的 AES 密钥。
 *
 * 此前 WecomWsBridge 只透传消息文本（图片 → `[image]` 占位符），
 * agent 看不到图片内容（用户反馈：「收到图片但没获取到图片内容」）。
 *
 * ## 解密协议（官方文档 101463 + SDK 源码取证，Task #5142）
 *
 * - **AES-256-CBC**，PKCS#7 填充到 **32 字节倍数**（不是 Node 默认 16），
 *   必须 `setAutoPadding(false)` + 手动去填充（对齐官方 SDK decryptFile）；
 * - **IV = aeskey 解码后的前 16 字节**（aeskey 是 Base64 的 32 字节密钥）；
 * - 下载 URL 5 分钟内有效 → 下载失败如实报错。
 *
 * @see wecom-cli-handler.ts（extractText 图片分支注入落盘路径）
 * @see wecom-media.test.ts
 */

import { createDecipheriv } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";

// =============================================================================
// 常量与可注入配置
// =============================================================================

/** 默认媒体落盘目录 */
export const WECOM_MEDIA_DIR = "/tmp/wecom-media";

/** PKCS#7 块大小（企微协议：填充到 32 字节倍数，非 Node 默认 16） */
const WECOM_MEDIA_BLOCK_SIZE = 32;

/** 运行时可覆盖的媒体目录（测试注入；生产用默认值） */
let mediaDirOverride: string | undefined;

/** 测试注入媒体目录（生产勿用） */
export function setWecomMediaDir(dir: string): string {
  mediaDirOverride = dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 测试重置（恢复默认目录） */
export function __resetWecomMediaDirForTest(): void {
  mediaDirOverride = undefined;
}

/** 当前生效的媒体目录 */
export function getWecomMediaDir(): string {
  return mediaDirOverride ?? WECOM_MEDIA_DIR;
}

// =============================================================================
// 解密
// =============================================================================

/**
 * 解密企微媒体（AES-256-CBC，PKCS#7 32 字节块）。
 *
 * 对齐官方 SDK `decryptFile`（@wecom/aibot-node-sdk dist/index.cjs.js）：
 * 1. aesKey 是 Base64 编码的 32 字节密钥；
 * 2. IV = key 前 16 字节；
 * 3. `setAutoPadding(false)`（Node 默认按 16 字节块去填充会 bad decrypt）；
 * 4. 手动校验并去除 PKCS#7 填充（padLen ∈ [1,32]，全部字节一致）。
 *
 * @param encrypted 加密的媒体数据
 * @param aesKeyBase64 Base64 编码的 aeskey（来自消息体 image.aeskey 等）
 * @returns 解密后的明文 Buffer
 * @throws 参数非法 / 密钥错误 / padding 损坏时抛错（不静默返回垃圾数据）
 */
export function decryptWecomMedia(
  encrypted: Buffer,
  aesKeyBase64: string,
): Buffer {
  if (!encrypted || encrypted.length === 0) {
    throw new Error("decryptWecomMedia: encrypted buffer is empty");
  }
  if (!aesKeyBase64 || typeof aesKeyBase64 !== "string") {
    throw new Error("decryptWecomMedia: aesKey must be a non-empty string");
  }

  const key = Buffer.from(aesKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `decryptWecomMedia: aesKey must decode to 32 bytes (got ${key.length})`,
    );
  }
  const iv = key.subarray(0, 16);

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  // 手动去除 PKCS#7 填充（32 字节块）
  const padLen = decrypted[decrypted.length - 1];
  if (padLen < 1 || padLen > WECOM_MEDIA_BLOCK_SIZE || padLen > decrypted.length) {
    throw new Error(
      `decryptWecomMedia: invalid PKCS#7 padding value: ${padLen}`,
    );
  }
  for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
    if (decrypted[i] !== padLen) {
      throw new Error(
        "decryptWecomMedia: invalid PKCS#7 padding (bytes mismatch)",
      );
    }
  }
  return decrypted.subarray(0, decrypted.length - padLen);
}

// =============================================================================
// 媒体引用提取 + 下载落盘（Task #5199）
// =============================================================================

/** 从消息体提取出的媒体引用 */
export interface WecomMediaRef {
  /** 媒体类型（image / file / video / voice） */
  kind: "image" | "file" | "video" | "voice";
  /** 加密媒体下载地址（5 分钟内有效） */
  url: string;
  /** Base64 编码的 AES 密钥 */
  aeskey: string;
  /** 原始文件名（file 类型才有） */
  filename?: string;
}

/** 单个媒体字段（image / file / video / voice 共有形状） */
interface WecomMediaField {
  url?: unknown;
  aeskey?: unknown;
  filename?: unknown;
}

/** 从单个媒体字段提取引用（缺 url/aeskey 跳过） */
function refFromField(
  kind: WecomMediaRef["kind"],
  field: WecomMediaField | undefined,
): WecomMediaRef | null {
  if (!field || typeof field !== "object") return null;
  const url = typeof field.url === "string" ? field.url : undefined;
  const aeskey = typeof field.aeskey === "string" ? field.aeskey : undefined;
  if (!url || !aeskey) return null;
  return {
    kind,
    url,
    aeskey,
    filename: typeof field.filename === "string" ? field.filename : undefined,
  };
}

/**
 * 从企微消息体提取媒体引用（image / file / video / voice）。
 *
 * - 单媒体消息：body.image / body.file / body.video / body.voice；
 * - mixed 消息：遍历 body.mixed.msg_item[]，收集所有媒体 item；
 * - 缺 url 或缺 aeskey 的 item 跳过（不产生坏引用）。
 */
export function extractWecomMediaRefs(
  body: Record<string, unknown>,
): WecomMediaRef[] {
  const refs: WecomMediaRef[] = [];
  const msgType = String(body.msgtype ?? "");

  const single = refFromField(
    msgType as WecomMediaRef["kind"],
    body[msgType] as WecomMediaField | undefined,
  );
  if (single) refs.push(single);

  if (msgType === "mixed") {
    const mixed = body.mixed as { msg_item?: unknown[] } | undefined;
    for (const item of mixed?.msg_item ?? []) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const itemType = String(it.msgtype ?? "");
      const ref = refFromField(
        itemType as WecomMediaRef["kind"],
        it[itemType] as WecomMediaField | undefined,
      );
      if (ref) refs.push(ref);
    }
  }

  return refs;
}

/** 下载器返回值（测试注入用） */
export interface WecomMediaFetchResult {
  ok: boolean;
  status: number;
  buffer: Buffer;
  /** 从 Content-Disposition 解析的文件名（可选） */
  filename?: string;
}

/** 下载器签名（生产用全局 fetch；测试注入 mock） */
export type WecomMediaFetcher = (
  url: string,
) => Promise<WecomMediaFetchResult>;

/** 生产默认下载器：全局 fetch → arraybuffer + Content-Disposition 文件名 */
async function defaultWecomMediaFetcher(
  url: string,
): Promise<WecomMediaFetchResult> {
  const resp = await fetch(url);
  const status = resp.status;
  if (!resp.ok) {
    return { ok: false, status, buffer: Buffer.alloc(0) };
  }
  const ab = await resp.arrayBuffer();
  const disposition = resp.headers.get("content-disposition") ?? "";
  let filename: string | undefined;
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (utf8Match) {
    filename = decodeURIComponent(utf8Match[1]);
  } else {
    const m = disposition.match(/filename="?([^";\s]+)"?/i);
    if (m) filename = decodeURIComponent(m[1]);
  }
  return {
    ok: true,
    status,
    buffer: Buffer.from(ab),
    filename,
  };
}

/** fetchAndSaveWecomMedia 入参 */
export interface FetchWecomMediaInput {
  msgid: string;
  url: string;
  aeskey: string;
  kind: WecomMediaRef["kind"];
  /** 下载器（测试注入；缺省用全局 fetch） */
  fetcher?: WecomMediaFetcher;
  /** 原始文件名（可选） */
  filename?: string;
  /**
   * ★ Task #5313：会话 id —— 落盘子目录，实现跨群媒体隔离。
   * 缺省时保持旧行为（直接落媒体根目录）。
   */
  chatId?: string;
}

/**
 * 下载企微加密媒体 → 解密 → 落盘，返回本地路径。
 *
 * - 下载失败（HTTP 非 200）→ 抛错（URL 5 分钟有效，失败必须可见）；
 * - 解密失败（aeskey 错误/数据损坏）→ 抛错（不落垃圾文件）；
 * - 成功 → saveWecomMediaFile 落盘（msgid_filename）。
 */
export async function fetchAndSaveWecomMedia(
  input: FetchWecomMediaInput,
): Promise<string> {
  const fetcher = input.fetcher ?? defaultWecomMediaFetcher;
  const result = await fetcher(input.url);
  if (!result.ok) {
    throw new Error(
      "fetchAndSaveWecomMedia: download failed (HTTP " + result.status + ")" +
        " for msgid=" + input.msgid + " url=" + input.url.slice(0, 120),
    );
  }
  const decrypted = decryptWecomMedia(result.buffer, input.aeskey);
  return saveWecomMediaFile({
    msgid: input.msgid,
    filename: input.filename ?? result.filename,
    buffer: decrypted,
    chatId: input.chatId,
  });
}

// =============================================================================
// 落盘
// =============================================================================

/** saveWecomMediaFile 入参 */
export interface SaveWecomMediaInput {
  /** 消息 ID（文件名前缀，防同名覆盖） */
  msgid: string;
  /** 原始文件名（可缺省，用 msgid 兜底） */
  filename?: string;
  /** 解密后的媒体数据 */
  buffer: Buffer;
  /**
   * ★ Task #5313：会话 id —— 落盘到 `<mediaDir>/<safeChatId>/` 子目录。
   *
   * 背景：此前所有会话共用一个扁平目录，mediaFiles 只按 msgid 区分，
   * agent 扫目录时会把别的群的历史图片当成本条消息的附件。
   * 按 chatId 分层后跨群天然隔离（整目录清理也更容易）。
   *
   * 缺省（undefined）→ 保持旧行为，直接落媒体根目录。
   */
  chatId?: string;
}

/**
 * 把解密后的媒体数据落盘到媒体目录。
 *
 * - 目录：默认 `/tmp/wecom-media`（测试可注入）；传 chatId 时落到
 *   `<mediaDir>/<chatId>/` 子目录（Task #5313 跨群隔离）；
 * - 文件名：`<msgid>_<basename(filename)>`（路径穿越防护：
 *   只取 basename，`../../etc/passwd` → `passwd`）；
 * - 目录不存在时自动创建。
 *
 * @returns 落盘的绝对路径
 */
export async function saveWecomMediaFile(
  input: SaveWecomMediaInput,
): Promise<string> {
  const root = getWecomMediaDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });

  // ★ DS review MINOR-1：msgid 同样做路径穿越防护
  //   （只留字母数字与安全符号，其余替换为 '_'）
  const safeMsgid = input.msgid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const safeName = input.filename
    ? basename(input.filename)
    : `${safeMsgid}.bin`;

  // ★ Task #5313：按 chatId 分层（跨群媒体隔离）。
  //   chatId 同样做路径穿越防护：只留字母数字与安全符号
  //   （`../../etc` → `______etc`，必然留在 root 内）。
  const safeChatId = input.chatId
    ? input.chatId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)
    : undefined;
  const dir = safeChatId ? join(resolve(root), safeChatId) : resolve(root);
  if (safeChatId) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filePath = join(dir, `${safeMsgid}_${safeName}`);

  writeFileSync(filePath, input.buffer);
  return filePath;
}
