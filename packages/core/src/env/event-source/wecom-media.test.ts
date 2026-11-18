/**
 * @fileoverview Task #5199 — 企微媒体（图片）下载解密落盘测试
 *
 * ## 为什么测这些点
 *
 * 企微长连接模式下 `image`/`file`/`video` 消息只带 `image_url`（加密媒体
 * 下载地址，**5 分钟内有效**）+ `aeskey`，不落盘的话 agent 只能看到
 * `[image]` 占位符（用户实测：发图片 → 机器人回复「没获取到图片内容」）。
 *
 * 解密协议（官方文档 101463 + SDK 源码取证，Task #5142）：
 * - **AES-256-CBC**，PKCS#7 填充到 **32 字节倍数**（不是 Node 默认的 16），
 *   所以必须 `setAutoPadding(false)` + 手动去填充；
 * - **IV = aeskey 前 16 字节**（aeskey 是 Base64 编码的 32 字节密钥）；
 * - 下载 URL 5 分钟内有效 → 下载失败必须如实报错，不能假装成功。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { createCipheriv, randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, sep } from "path";
import {
  decryptWecomMedia,
  saveWecomMediaFile,
  WECOM_MEDIA_DIR,
  __resetWecomMediaDirForTest,
  setWecomMediaDir,
} from "./wecom-media";

// =============================================================================
// 测试夹具：用「加密方向」构造合法的密文（解密的镜像操作）
// =============================================================================

/** 生成 base64 编码的 32 字节 aeskey（对齐企微协议） */
function makeAesKey(): string {
  return randomBytes(32).toString("base64");
}

/**
 * 用 AES-256-CBC + PKCS#7(32字节块) 加密明文 —— 解密函数的镜像。
 * IV = key 前 16 字节（与解密侧约定一致）。
 */
function encryptFixture(plaintext: Buffer, aesKeyB64: string): Buffer {
  const key = Buffer.from(aesKeyB64, "base64");
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  // PKCS#7 填充到 32 字节倍数
  const blockSize = 32;
  const padLen = blockSize - (plaintext.length % blockSize);
  const padded = Buffer.concat([
    plaintext,
    Buffer.alloc(padLen, padLen),
  ]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wecom-media-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  __resetWecomMediaDirForTest();
});

// =============================================================================
// 1. decryptWecomMedia — AES-256-CBC 解密
// =============================================================================

describe("decryptWecomMedia", () => {
  test("正确解密：AES-256-CBC + IV=key前16字节 + PKCS#7(32字节块)去填充", () => {
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);
    const decrypted = decryptWecomMedia(encrypted, aesKey);
    expect(Buffer.compare(decrypted, PNG_BYTES)).toBe(0);
  });

  test("明文长度恰为 32 字节倍数时也正确（padLen==32 全块填充）", () => {
    const aesKey = makeAesKey();
    const exact = randomBytes(64); // 64 = 32*2，需整块填充 32 字节
    const encrypted = encryptFixture(exact, aesKey);
    const decrypted = decryptWecomMedia(encrypted, aesKey);
    expect(Buffer.compare(decrypted, exact)).toBe(0);
  });

  test("错误密钥时抛错（不静默返回垃圾数据）", () => {
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);
    const wrongKey = makeAesKey();
    expect(() => decryptWecomMedia(encrypted, wrongKey)).toThrow();
  });

  test("空 buffer / 空 aeskey 抛错", () => {
    const aesKey = makeAesKey();
    expect(() => decryptWecomMedia(Buffer.alloc(0), aesKey)).toThrow();
    expect(() => decryptWecomMedia(PNG_BYTES, "")).toThrow();
  });

  test("padding 值非法（>32 或 0）时抛错", () => {
    // 构造一个解密后末字节是 0 的密文：明文 32 字节 + 填充 32 →
    // 手工把最后一个字节改成 0（模拟损坏）
    const aesKey = makeAesKey();
    const plaintext = randomBytes(32);
    const encrypted = encryptFixture(plaintext, aesKey);
    encrypted[encrypted.length - 1] = 0; // 破坏 padding
    expect(() => decryptWecomMedia(encrypted, aesKey)).toThrow();
  });
});

// =============================================================================
// 2. saveWecomMediaFile — 落盘
// =============================================================================

describe("saveWecomMediaFile", () => {
  test("落盘到 /tmp/wecom-media/ 且文件内容一致", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-IMG-1",
      filename: "photo.png",
      buffer: PNG_BYTES,
    });
    expect(path.startsWith(dir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(Buffer.compare(readFileSync(path), PNG_BYTES)).toBe(0);
  });

  test("文件名含 msgid 前缀（防多消息同名覆盖）", async () => {
    setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-IMG-2",
      filename: "photo.png",
      buffer: PNG_BYTES,
    });
    expect(path).toContain("MSG-IMG-2");
  });

  test("无 filename 时用 msgid 兜底", async () => {
    setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-IMG-3",
      buffer: PNG_BYTES,
    });
    expect(path).toContain("MSG-IMG-3");
  });

  test("路径穿越防护：filename 带 ../ 时不逃出媒体目录", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-IMG-4",
      filename: "../../etc/passwd",
      buffer: PNG_BYTES,
    });
    expect(path.startsWith(dir)).toBe(true);
  });

  test("默认媒体目录是 /tmp/wecom-media", () => {
    expect(WECOM_MEDIA_DIR).toBe("/tmp/wecom-media");
  });
});

// =============================================================================
// 3. Task #5313 — 按 chatId 分层（跨群媒体隔离）
// =============================================================================

describe("saveWecomMediaFile — 按 chatId 分层（Task #5313）", () => {
  test("传 chatId 时落到 <mediaDir>/<chatId>/ 子目录", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-G-1",
      filename: "photo.png",
      chatId: "wrCHATAAA",
      buffer: PNG_BYTES,
    });
    expect(path.startsWith(join(dir, "wrCHATAAA"))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(Buffer.compare(readFileSync(path), PNG_BYTES)).toBe(0);
  });

  test("跨群隔离：同 msgid + 同文件名，不同 chatId 落不同路径且互不覆盖", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const a = await saveWecomMediaFile({
      msgid: "MSG-SAME",
      filename: "photo.png",
      chatId: "wrCHAT_GROUP_A",
      buffer: Buffer.from("AAA"),
    });
    const b = await saveWecomMediaFile({
      msgid: "MSG-SAME",
      filename: "photo.png",
      chatId: "wrCHAT_GROUP_B",
      buffer: Buffer.from("BBB"),
    });
    expect(a).not.toBe(b);
    expect(a.startsWith(join(dir, "wrCHAT_GROUP_A"))).toBe(true);
    expect(b.startsWith(join(dir, "wrCHAT_GROUP_B"))).toBe(true);
    expect(readFileSync(a).toString()).toBe("AAA");
    expect(readFileSync(b).toString()).toBe("BBB");
  });

  test("chatId 路径穿越防护：带 / 或 .. 时不逃出媒体目录", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-TRAV",
      filename: "photo.png",
      chatId: "../../etc",
      buffer: PNG_BYTES,
    });
    // 路径必须仍在媒体根目录之内（不得出现 .. 段）
    // 注意用 dir + 分隔符判断，避免 /tmp/wecom-x 与 /tmp/wecom-x-evil 误判
    expect(path.startsWith(dir + sep)).toBe(true);
    expect(dirname(path)).toBe(join(dir, "______etc"));
    expect(path.includes("..")).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("缺省 chatId 时保持旧行为（直接落媒体根目录，兼容 #5199）", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const path = await saveWecomMediaFile({
      msgid: "MSG-LEGACY",
      filename: "photo.png",
      buffer: PNG_BYTES,
    });
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toBe(join(dir, "MSG-LEGACY_photo.png"));
  });
});
