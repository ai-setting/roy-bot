/**
 * @fileoverview act.ts 多模态 CLI 集成测试
 *
 * TDD RED: 验证 `roy-bot act --image` 全链路
 *
 * 覆盖：
 * 1. ActOptions 包含 image?: string | string[] 字段
 * 2. yargs --image (-i) 接受单个/多个/混 URL+本地
 * 3. handler 把 --image 转 ContentPart[] 后调 handleQueryWithContext
 * 4. context-handler.handleQueryWithContext / env.handle_query / agent-component.run
 *    签名都接受 string | ContentPart[]（编译时 + 运行时）
 * 5. 0 张图时仍按 string 调用（backward compat）
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yargs from "yargs";
import type { ContentPart } from "@ai-setting/roy-bot-core";
import {
  ContextHandlerService,
} from "../services/context-handler.service";
import { QueryExecutor } from "./shared/query-executor";
import {
  assembleMultimodalMessage,
  parseActImageArgs,
} from "./shared/multimodal-message";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "act-multimodal-test-"));
}

function pngMagicBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

// ---------------------------------------------------------------------------
// parseActImageArgs — yargs 原始输入归一化
// ---------------------------------------------------------------------------

describe("act --image: parseActImageArgs", () => {
  test("single --image value", () => {
    expect(parseActImageArgs("./a.png")).toEqual(["./a.png"]);
  });

  test("multiple --image values", () => {
    expect(parseActImageArgs(["./a.png", "./b.jpg"])).toEqual([
      "./a.png",
      "./b.jpg",
    ]);
  });

  test("mix of local path and http URL", () => {
    expect(parseActImageArgs(["./local.png", "https://x.example/y.jpg"])).toEqual([
      "./local.png",
      "https://x.example/y.jpg",
    ]);
  });

  test("undefined → empty array (backward compat)", () => {
    expect(parseActImageArgs(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assembleMultimodalMessage — text + image[] → ContentPart[] | string
// ---------------------------------------------------------------------------

describe("act --image: assembleMultimodalMessage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmp();
  });

  test("0 images: returns string (backward compat — no async overhead)", () => {
    const out = assembleMultimodalMessage("describe this", []);
    expect(typeof out).toBe("string");
    expect(out).toBe("describe this");
  });

  test("1 local image: returns ContentPart[] with text + image", async () => {
    const png = path.join(tmpDir, "a.png");
    await fs.writeFile(png, pngMagicBuffer());

    const out = await assembleMultimodalMessage("describe", [png]);
    expect(Array.isArray(out)).toBe(true);
    const parts = out as ContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: "describe" });
    expect(parts[1].type).toBe("image");
  });

  test("multiple local images: order preserved (text first, then images)", async () => {
    const a = path.join(tmpDir, "a.png");
    const b = path.join(tmpDir, "b.png");
    await fs.writeFile(a, pngMagicBuffer());
    await fs.writeFile(b, pngMagicBuffer());

    const out = await assembleMultimodalMessage("compare", [a, b]);
    const parts = out as ContentPart[];
    expect(parts.length).toBe(3);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image");
    expect(parts[2].type).toBe("image");
  });

  test("URL strings pass through unchanged (not coerced to Buffer)", async () => {
    const url = "https://example.com/cat.jpg";
    const out = await assembleMultimodalMessage("describe", [url]);
    const parts = out as ContentPart[];
    expect(parts[1]).toEqual({ type: "image", image: url });
  });
});

// ---------------------------------------------------------------------------
// Signature upgrade — context-handler.handleQueryWithContext accepts ContentPart[]
// ---------------------------------------------------------------------------

describe("act --image: ContextHandlerService.handleQueryWithContext signature", () => {
  test("accepts string (backward compat)", async () => {
    const handleSpy = vi
      .spyOn(ContextHandlerService.prototype, "handleQueryWithContext")
      .mockResolvedValue("ok");

    const env: any = { handle_query: vi.fn().mockResolvedValue("ok") };
    const ch = new ContextHandlerService(env, {} as any, { maxRetries: 0 });

    const result = await ch.handleQueryWithContext("plain text", { sessionId: "s" });
    expect(result).toBe("ok");
    expect(handleSpy.mock.calls[0][0]).toBe("plain text");

    handleSpy.mockRestore();
  });

  test("accepts ContentPart[] (multimodal path)", async () => {
    const payload: ContentPart[] = [
      { type: "text", text: "describe" },
      { type: "image", image: "https://x.example/y.png" },
    ];
    const handleSpy = vi
      .spyOn(ContextHandlerService.prototype, "handleQueryWithContext")
      .mockResolvedValue("ok-multimodal");

    const env: any = { handle_query: vi.fn().mockResolvedValue("ok") };
    const ch = new ContextHandlerService(env, {} as any, { maxRetries: 0 });

    const result = await ch.handleQueryWithContext(payload, { sessionId: "s" });
    expect(result).toBe("ok-multimodal");
    const [forwarded] = handleSpy.mock.calls[0];
    expect(forwarded).toEqual(payload);

    handleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Signature upgrade — QueryExecutor.execute accepts ContentPart[]
// ---------------------------------------------------------------------------

describe("act --image: QueryExecutor.execute signature", () => {
  let queryExecutor: QueryExecutor;
  let mockEnv: any;
  let mockSessionComponent: any;
  let handleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const unsub = vi.fn();
    mockEnv = {
      subscribeTo: vi.fn().mockReturnValue(unsub),
      getComponent: vi.fn(),
      pushEnvEvent: vi.fn(),
    };
    mockSessionComponent = { compact: vi.fn() };

    handleSpy = vi
      .spyOn(ContextHandlerService.prototype, "handleQueryWithContext")
      .mockResolvedValue("ok");

    queryExecutor = new QueryExecutor({
      env: mockEnv,
      sessionComponent: mockSessionComponent,
      output: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), log: vi.fn(), configure: vi.fn() } as any,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queryExecutor.dispose();
  });

  test("accepts string and forwards to handleQueryWithContext as string", async () => {
    await queryExecutor.execute("hello", "s1");
    const [forwarded] = handleSpy.mock.calls[0];
    expect(forwarded).toBe("hello");
  });

  test("accepts ContentPart[] and forwards as-is (no string coercion)", async () => {
    const payload: ContentPart[] = [
      { type: "text", text: "describe" },
      { type: "image", image: "https://x.example/a.png" },
    ];
    await queryExecutor.execute(payload, "s2");
    const [forwarded] = handleSpy.mock.calls[0];
    expect(Array.isArray(forwarded)).toBe(true);
    expect(forwarded).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// yargs parse — act --image (-i) flag
// ---------------------------------------------------------------------------

describe("act --image: yargs flag parsing", () => {
  // 直接重建 act 的 builder 抽取部分,避免 yargs 全局副作用
  function buildActYargs() {
    return yargs.default([])
      .command(
        "act [message]",
        "describe",
        (y: any) =>
          y
            .positional("message", { type: "string" })
            .option("image", {
              alias: "i",
              type: "array",
              string: true,
            }),
        () => {}
      );
  }

  test("--image single value", async () => {
    const parser = buildActYargs();
    const argv = await parser.parseAsync(["act", "describe", "--image", "./a.png"]);
    expect(argv.image).toEqual(["./a.png"]);
    expect(argv.i).toEqual(["./a.png"]); // alias
  });

  test("--image multiple values", async () => {
    const parser = buildActYargs();
    const argv = await parser.parseAsync([
      "act",
      "describe",
      "--image", "./a.png",
      "--image", "./b.jpg",
    ]);
    expect(argv.image).toEqual(["./a.png", "./b.jpg"]);
  });

  test("-i alias works", async () => {
    const parser = buildActYargs();
    const argv = await parser.parseAsync(["act", "describe", "-i", "./a.png"]);
    expect(argv.image).toEqual(["./a.png"]);
  });

  test("no --image flag: argv.image is undefined", async () => {
    const parser = buildActYargs();
    const argv = await parser.parseAsync(["act", "describe"]);
    expect(argv.image).toBeUndefined();
  });
});
