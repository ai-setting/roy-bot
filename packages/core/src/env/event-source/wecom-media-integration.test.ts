/**
 * @fileoverview Task #5199 — 企微图片消息「下载落盘 + 文本注入」测试
 *
 * ## 契约（用户实测问题的修复）
 *
 * 用户发图片 → 以前 agent 只看到 `[image]` 占位符（媒体没落盘）。
 * 修复后：
 * 1. `extractWecomMediaRefs(body)` 从消息体提取媒体引用
 *    （image / file / video / voice 的 url + aeskey）；
 * 2. `fetchWecomMedia`（可注入 fetcher）下载 + 解密 + 落盘；
 * 3. `extractText` 图片分支产出 `[image](media:<path>)` 形态，
 *    agent 用 understand_image 读本地路径即可看图。
 *
 * fetcher 注入是为了测试不真发 HTTP（下载 URL 5 分钟有效，
 * 真网验证由 e2e 覆盖）。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { createCipheriv, randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractWecomMediaRefs,
  fetchAndSaveWecomMedia,
  setWecomMediaDir,
  __resetWecomMediaDirForTest,
} from "./wecom-media";
import { parseWecomFrame } from "./wecom-cli-handler";

// =============================================================================
// 夹具
// =============================================================================

function makeAesKey(): string {
  return randomBytes(32).toString("base64");
}

function encryptFixture(plaintext: Buffer, aesKeyB64: string): Buffer {
  const key = Buffer.from(aesKeyB64, "base64");
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const padLen = 32 - (plaintext.length % 32);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wecom-media-int-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  __resetWecomMediaDirForTest();
});

// =============================================================================
// 1. extractWecomMediaRefs
// =============================================================================

describe("extractWecomMediaRefs", () => {
  test("image 消息：提取 url + aeskey", () => {
    const refs = extractWecomMediaRefs({
      msgtype: "image",
      image: { url: "https://media.example.com/abc", aeskey: "KEY==" },
    });
    expect(refs.length).toBe(1);
    expect(refs[0].url).toBe("https://media.example.com/abc");
    expect(refs[0].aeskey).toBe("KEY==");
    expect(refs[0].kind).toBe("image");
  });

  test("file 消息：提取 url + aeskey + filename", () => {
    const refs = extractWecomMediaRefs({
      msgtype: "file",
      file: {
        url: "https://media.example.com/f1",
        aeskey: "KEY1==",
        filename: "report.pdf",
      },
    });
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe("file");
    expect(refs[0].filename).toBe("report.pdf");
  });

  test("text 消息：无媒体引用", () => {
    const refs = extractWecomMediaRefs({
      msgtype: "text",
      text: { content: "hello" },
    });
    expect(refs.length).toBe(0);
  });

  test("mixed 消息：提取每个媒体 item", () => {
    const refs = extractWecomMediaRefs({
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "看这个" } },
          { msgtype: "image", image: { url: "https://m.example/1", aeskey: "K1==" } },
          { msgtype: "image", image: { url: "https://m.example/2", aeskey: "K2==" } },
        ],
      },
    });
    expect(refs.length).toBe(2);
  });

  test("缺 url 或缺 aeskey 的 item 跳过（不产生坏引用）", () => {
    const refs = extractWecomMediaRefs({
      msgtype: "image",
      image: { aeskey: "ONLYKEY==" },
    });
    expect(refs.length).toBe(0);
  });
});

// =============================================================================
// 2. fetchAndSaveWecomMedia — 下载 + 解密 + 落盘（fetcher 注入）
// =============================================================================

describe("fetchAndSaveWecomMedia", () => {
  test("下载密文 → 解密 → 落盘，返回本地路径", async () => {
    const dir = setWecomMediaDir(makeTmpDir());
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);

    const path = await fetchAndSaveWecomMedia({
      msgid: "MSG-E2E-1",
      url: "https://media.example.com/enc",
      aeskey: aesKey,
      kind: "image",
      fetcher: async () => ({
        ok: true,
        status: 200,
        buffer: encrypted,
        filename: "photo.png",
      }),
    });

    expect(path.startsWith(dir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(Buffer.compare(readFileSync(path), PNG_BYTES)).toBe(0);
    expect(path.endsWith(".png")).toBe(true);
  });

  test("下载失败（HTTP 非 200）时抛错（URL 5 分钟有效，失败要可见）", async () => {
    setWecomMediaDir(makeTmpDir());
    expect(
      fetchAndSaveWecomMedia({
        msgid: "MSG-E2E-2",
        url: "https://media.example.com/expired",
        aeskey: makeAesKey(),
        kind: "image",
        fetcher: async () => ({
          ok: false,
          status: 404,
          buffer: Buffer.alloc(0),
        }),
      }),
    ).rejects.toThrow();
  });

  test("解密失败（错误 aeskey）时抛错", async () => {
    setWecomMediaDir(makeTmpDir());
    const encrypted = encryptFixture(PNG_BYTES, makeAesKey());
    expect(
      fetchAndSaveWecomMedia({
        msgid: "MSG-E2E-3",
        url: "https://media.example.com/enc",
        aeskey: makeAesKey(), // 错误的 key
        kind: "image",
        fetcher: async () => ({
          ok: true,
          status: 200,
          buffer: encrypted,
        }),
      }),
    ).rejects.toThrow();
  });
});

// =============================================================================
// 3. parseWecomFrame 集成：图片消息文本带落盘路径
// =============================================================================

describe("parseWecomFrame — 图片消息文本", () => {
  test("image 消息文本 = [image](media:待落盘) 占位（含 mediaRefs 元数据）", () => {
    const frame = {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-img-1" },
      body: {
        msgid: "MSG-IMG-10",
        aibotid: "AIBOT123",
        chattype: "single",
        from: { userid: "zhangsan" },
        msgtype: "image",
        image: {
          url: "https://media.example.com/abc",
          aeskey: "KEY==",
        },
      },
    };
    const parsed = parseWecomFrame(frame);
    expect(parsed).not.toBeNull();
    // 文本不再是裸 "[image]" —— 带 media 占位标记
    expect(parsed!.text).toContain("[image]");
    expect(parsed!.text).not.toBe("[image]");
  });
});
