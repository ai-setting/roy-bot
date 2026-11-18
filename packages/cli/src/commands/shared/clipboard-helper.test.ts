/**
 * @fileoverview clipboard-helper 测试
 *
 * TDD RED: 验证 readClipboardImage() 在不同平台/环境下的行为
 *
 * 关键设计：
 * - 单元测试不调真实 xclip/pngpaste，全部通过 env var 覆盖
 * - ROY_CLIPBOARD_MOCK_PATH 指向 fake 图片 → 读 buffer + sniff mime
 * - ROY_CLIPBOARD_MOCK_FAIL=true → 返回 null
 * - 真实环境（test env）下：child_process.exec 被 mock 掉
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readClipboardImage, isClipboardMockActive, type ClipboardReadResult } from "./clipboard-helper";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "clipboard-test-"));
}

function pngMagicBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

// ---------------------------------------------------------------------------
// isClipboardMockActive — 检查是否处于 mock 模式
// ---------------------------------------------------------------------------

describe("isClipboardMockActive", () => {
  const originalEnv = process.env.ROY_CLIPBOARD_MOCK_PATH;
  const originalFail = process.env.ROY_CLIPBOARD_MOCK_FAIL;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ROY_CLIPBOARD_MOCK_PATH;
    else process.env.ROY_CLIPBOARD_MOCK_PATH = originalEnv;
    if (originalFail === undefined) delete process.env.ROY_CLIPBOARD_MOCK_FAIL;
    else process.env.ROY_CLIPBOARD_MOCK_FAIL = originalFail;
  });

  test("returns true when ROY_CLIPBOARD_MOCK_PATH is set", () => {
    process.env.ROY_CLIPBOARD_MOCK_PATH = "/tmp/fake.png";
    expect(isClipboardMockActive()).toBe(true);
  });

  test("returns true when ROY_CLIPBOARD_MOCK_FAIL is set", () => {
    process.env.ROY_CLIPBOARD_MOCK_FAIL = "true";
    expect(isClipboardMockActive()).toBe(true);
  });

  test("returns false when neither env var is set", () => {
    delete process.env.ROY_CLIPBOARD_MOCK_PATH;
    delete process.env.ROY_CLIPBOARD_MOCK_FAIL;
    expect(isClipboardMockActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readClipboardImage — mock 模式 (env var)
// ---------------------------------------------------------------------------

describe("readClipboardImage (mock mode via env var)", () => {
  const originalEnv = process.env.ROY_CLIPBOARD_MOCK_PATH;
  const originalFail = process.env.ROY_CLIPBOARD_MOCK_FAIL;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmp();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ROY_CLIPBOARD_MOCK_PATH;
    else process.env.ROY_CLIPBOARD_MOCK_PATH = originalEnv;
    if (originalFail === undefined) delete process.env.ROY_CLIPBOARD_MOCK_FAIL;
    else process.env.ROY_CLIPBOARD_MOCK_FAIL = originalFail;
    delete process.env.ROY_CLIPBOARD_MOCK;
  });

  test("returns buffer + png mime when ROY_CLIPBOARD_MOCK_PATH points to a PNG", async () => {
    const png = path.join(tmpDir, "fake.png");
    await fs.writeFile(png, pngMagicBuffer());
    process.env.ROY_CLIPBOARD_MOCK_PATH = png;

    const result = await readClipboardImage();
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("image/png");
    expect(result!.buffer.length).toBeGreaterThan(0);
    // verify it's a real PNG by checking magic bytes
    expect(result!.buffer[0]).toBe(0x89);
    expect(result!.buffer[1]).toBe(0x50);
  });

  test("returns null when ROY_CLIPBOARD_MOCK_FAIL=true", async () => {
    process.env.ROY_CLIPBOARD_MOCK_FAIL = "true";
    const result = await readClipboardImage();
    expect(result).toBeNull();
  });

  test("returns null when ROY_CLIPBOARD_MOCK_PATH points to non-existent file", async () => {
    process.env.ROY_CLIPBOARD_MOCK_PATH = path.join(tmpDir, "nope.png");
    const result = await readClipboardImage();
    expect(result).toBeNull();
  });

  test("returns null when ROY_CLIPBOARD_MOCK_PATH points to a non-image file", async () => {
    const txt = path.join(tmpDir, "fake.txt");
    await fs.writeFile(txt, "hello");
    process.env.ROY_CLIPBOARD_MOCK_PATH = txt;
    const result = await readClipboardImage();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readClipboardImage — 真实模式 (env var 未设置, 调 xclip/pngpaste)
// ---------------------------------------------------------------------------

describe("readClipboardImage (real mode — child_process is mocked)", () => {
  // mock child_process.exec so we never actually shell out
  let execSpy: ReturnType<typeof vi.spyOn>;
  let cpModule: typeof import("node:child_process");

  beforeEach(async () => {
    delete process.env.ROY_CLIPBOARD_MOCK_PATH;
    delete process.env.ROY_CLIPBOARD_MOCK_FAIL;

    // mock child_process.exec
    // 必须 import 后再 spyOn,确保和生产代码用的是同一份 module reference
    cpModule = await import("node:child_process");
    execSpy = vi.spyOn(cpModule, "exec");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns null when clipboard tool not available (ENOENT)", async () => {
    // simulate xclip/pngpaste not installed
    execSpy.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      const err = new Error("spawn xclip ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      if (typeof _opts === "function") _opts(err);
      else if (callback) callback(err, "", "");
      return {} as any;
    });

    const result = await readClipboardImage();
    expect(result).toBeNull();
  });

  test("returns null when exec returns empty stdout (no image in clipboard)", async () => {
    execSpy.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      if (typeof _opts === "function") _opts(null, "", "");
      else if (callback) callback(null, "", "");
      return {} as any;
    });

    const result = await readClipboardImage();
    expect(result).toBeNull();
  });

  test("returns buffer + sniffed mime when xclip/pngpaste returns image bytes", async () => {
    const pngBytes = pngMagicBuffer();
    execSpy.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      // callback(err, stdout, stderr) — exec with options-as-callback uses (err, stdout, stderr)
      if (typeof _opts === "function") _opts(null, pngBytes, "");
      else if (callback) callback(null, pngBytes, "");
      return {} as any;
    });

    const result = await readClipboardImage();
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("image/png");
    expect(result!.buffer.length).toBeGreaterThan(0);
  });
});
