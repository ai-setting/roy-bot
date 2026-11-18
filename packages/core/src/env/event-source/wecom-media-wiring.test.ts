/**
 * @fileoverview Task #5199 — handleWsFrame 媒体落盘接线测试
 *
 * ## 为什么测（DS review MAJOR M1 后补）
 *
 * DS review 指出：mediaFiles 注入接线此前无测试覆盖。
 * 本文件验证 handleWsFrame 的完整接线：
 * - 图片消息 → 媒体下载落盘 → payload.mediaFiles / metadata.mediaFiles
 *   **在事件分发前**已注入（await 语义，DS review M1 修复）；
 * - 下载失败 → mediaFiles 不注入，事件照常分发（best-effort）。
 */

import { describe, expect, test, afterEach, mock } from "bun:test";
import { createCipheriv, randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WECOM_CLI_ES_TYPE,
  wecomCliHandler,
} from "./wecom-cli-handler";
import type { WecomMediaFetcher } from "./wecom-media";
import {
  setWecomMediaDir,
  __resetWecomMediaDirForTest,
} from "./wecom-media";
import type { EventSourceConfig, EventSourceEvent } from "./types";

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

const IMAGE_MSG_FRAME = (aeskey: string) => ({
  cmd: "aibot_msg_callback",
  headers: { req_id: "req-media-1" },
  body: {
    msgid: "MSG-WIRE-1",
    aibotid: "AIBOT123",
    chattype: "single",
    from: { userid: "zhangsan" },
    msgtype: "image",
    image: { url: "https://media.example.com/enc", aeskey },
  },
});

/** Task #5313：群聊图片帧（带 chatid，用于跨群隔离验证） */
const GROUP_IMAGE_MSG_FRAME = (
  aeskey: string,
  opts: { msgid: string; chatid: string },
) => ({
  cmd: "aibot_msg_callback",
  headers: { req_id: `req-${opts.msgid}` },
  body: {
    msgid: opts.msgid,
    aibotid: "AIBOT123",
    chattype: "group",
    chatid: opts.chatid,
    from: { userid: "zhangsan" },
    msgtype: "image",
    image: { url: "https://media.example.com/enc", aeskey },
  },
});

function makeWsConfig(): EventSourceConfig {
  return {
    id: "es-wecom-media-wire",
    name: "wecom-media-wire",
    type: WECOM_CLI_ES_TYPE,
    botId: "B1",
    secret: "S1",
  } as EventSourceConfig;
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

// =============================================================================
// handleWsFrame 接线
// =============================================================================

describe("handleWsFrame — 媒体落盘接线", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("图片消息：分发前 mediaFiles 已注入 payload + metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-wire-"));
    tmpDirs.push(dir);
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);

    // mock globalThis.fetch（defaultWecomMediaFetcher 走全局 fetch）
    globalThis.fetch = (async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-disposition": 'filename="photo.png"' },
      })) as typeof fetch;

    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    await (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame(IMAGE_MSG_FRAME(aesKey));

    expect(received.length).toBe(1);
    const evt = received[0];
    // ★ DS review M1：分发时 mediaFiles 必须已注入
    const mediaFiles = (evt.payload as Record<string, unknown>).mediaFiles as
      | string[]
      | undefined;
    expect(Array.isArray(mediaFiles)).toBe(true);
    expect(mediaFiles!.length).toBe(1);
    expect(mediaFiles![0]).toContain("MSG-WIRE-1");
    expect(existsSync(mediaFiles![0])).toBe(true);
    expect(Buffer.compare(readFileSync(mediaFiles![0]), PNG_BYTES)).toBe(0);
    // metadata 同步注入
    expect(
      (evt.metadata as Record<string, unknown>).mediaFiles,
    ).toEqual(mediaFiles);
  });

  test("下载失败：mediaFiles 不注入，事件照常分发", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    await (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame(IMAGE_MSG_FRAME(makeAesKey()));

    // 事件照常分发（best-effort：媒体缺失不拖垮消息）
    expect(received.length).toBe(1);
    const evt = received[0];
    expect(
      (evt.payload as Record<string, unknown>).mediaFiles,
    ).toBeUndefined();
    // 文本仍是 media:downloading 占位（引用存在但下载失败）
    expect((evt.payload as Record<string, unknown>).message).toContain(
      "[image](media:downloading)",
    );
  });
});

// =============================================================================
// Task #5313 — 跨群媒体隔离（mediaFiles 落在 <chatId>/ 子目录）
// =============================================================================

describe("handleWsFrame — 跨群媒体隔离（Task #5313）", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    __resetWecomMediaDirForTest();
  });

  test("群聊消息：mediaFiles 路径落在 <mediaDir>/<chatId>/ 下", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-wire-chatid-"));
    tmpDirs.push(dir);
    setWecomMediaDir(dir);
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);
    globalThis.fetch = (async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-disposition": 'filename="photo.png"' },
      })) as typeof fetch;

    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    await (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame(
      GROUP_IMAGE_MSG_FRAME(aesKey, {
        msgid: "MSG-GRP-1",
        chatid: "wrCHAT_GROUP_A",
      }),
    );

    const mediaFiles = (received[0].payload as Record<string, unknown>)
      .mediaFiles as string[];
    expect(mediaFiles.length).toBe(1);
    expect(mediaFiles[0].startsWith(join(dir, "wrCHAT_GROUP_A"))).toBe(true);
    expect(existsSync(mediaFiles[0])).toBe(true);
  });

  test("单聊消息：chatId 由 senderId 兜底，媒体同样落 <chatId>/ 子目录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-wire-single-"));
    tmpDirs.push(dir);
    setWecomMediaDir(dir);
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);
    globalThis.fetch = (async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-disposition": 'filename="photo.png"' },
      })) as typeof fetch;

    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    await (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame(IMAGE_MSG_FRAME(aesKey)); // 单聊帧：无 chatid，from.userid=zhangsan

    const mediaFiles = (received[0].payload as Record<string, unknown>)
      .mediaFiles as string[];
    // parseWecomFrame：chatId = rawChatId ?? senderId → 单聊用 userid 兜底，
    // 因此同样落子目录（不会挤在扁平根目录里）。
    expect(mediaFiles[0].startsWith(join(dir, "zhangsan"))).toBe(true);
    expect(existsSync(mediaFiles[0])).toBe(true);
  });

  test("两个群各自落自己的子目录，互不可见（同 msgid 也不串）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-wire-chatid2-"));
    tmpDirs.push(dir);
    setWecomMediaDir(dir);
    const aesKey = makeAesKey();
    const encrypted = encryptFixture(PNG_BYTES, aesKey);
    globalThis.fetch = (async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-disposition": 'filename="photo.png"' },
      })) as typeof fetch;

    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    const handle = (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame.bind(inst);

    await handle(
      GROUP_IMAGE_MSG_FRAME(aesKey, {
        msgid: "MSG-SAME-ID",
        chatid: "wrCHAT_GROUP_A",
      }),
    );
    await handle(
      GROUP_IMAGE_MSG_FRAME(aesKey, {
        msgid: "MSG-SAME-ID",
        chatid: "wrCHAT_GROUP_B",
      }),
    );

    const pathA = ((received[0].payload as Record<string, unknown>)
      .mediaFiles as string[])[0];
    const pathB = ((received[1].payload as Record<string, unknown>)
      .mediaFiles as string[])[0];
    expect(pathA).not.toBe(pathB);
    expect(pathA.startsWith(join(dir, "wrCHAT_GROUP_A"))).toBe(true);
    expect(pathB.startsWith(join(dir, "wrCHAT_GROUP_B"))).toBe(true);
  });
});
