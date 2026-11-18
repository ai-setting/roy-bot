/**
 * @fileoverview MarkdownLSPClient 测试：覆盖关键路径
 *
 * 验证两件事：
 *  1) `setupNotificationHandlers()` 注册了 `markdown/parse` 请求处理器，
 *     且该处理器用 markdown-it 把 `{ uri, text }` tokenize 后返回。
 *  2) `afterInitialized()` 发送 `workspace/didChangeConfiguration`，
 *     settings 里 `markdown.validate.enabled === true`。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "child_process";
import { MarkdownLSPClient } from "./markdown-client";
import type { LSPServerInfo } from "../types/linter";

// 复用项目里既有的 mock 三件套范式（参考 lsp/client.test.ts）
function makeMockProcess(): ChildProcess {
  const noopStream = {
    on: vi.fn(),
    cork: vi.fn(),
    uncork: vi.fn(),
    destroy: vi.fn(),
    end: vi.fn(),
    setDefaultEncoding: vi.fn(),
    writev: vi.fn(),
    _destroy: vi.fn(),
    closed: false,
    destroyed: false,
  };
  return {
    pid: 99999,
    stdout: { ...noopStream, readable: true } as any,
    stdin: { ...noopStream, writable: true, write: vi.fn() } as any,
    on: vi.fn(),
    kill: vi.fn(),
    connected: true,
  } as unknown as ChildProcess;
}

const markdownServerInfo: LSPServerInfo = {
  id: "markdown",
  extensions: [".md", ".markdown"],
  rootPattern: ["package.json"],
  command: ["node", "/fake/main.js"],
  args: ["--stdio"],
};

describe("MarkdownLSPClient", () => {
  let client: MarkdownLSPClient;
  let proc: ChildProcess;
  let onRequestSpy: ReturnType<typeof vi.fn>;
  let sendNotificationSpy: ReturnType<typeof vi.fn>;
  let sendRequestSpy: ReturnType<typeof vi.fn>;
  let markdownParseHandler: ((params: any) => unknown) | undefined;

  beforeEach(() => {
    proc = makeMockProcess();
    client = new MarkdownLSPClient(proc, markdownServerInfo, "file:///tmp/ws");

    // 注入 mock 的 connection，覆盖 vscode-jsonrpc 真实创建出来的那个，
    // 这样我们就能在不真正启动 LSP 进程的情况下断言协议交互。
    onRequestSpy = vi.fn((method: string, handler: any) => {
      if (method === "markdown/parse") markdownParseHandler = handler;
    });
    sendNotificationSpy = vi.fn().mockResolvedValue(undefined);
    sendRequestSpy = vi.fn().mockResolvedValue({});

    (client as any).connection = {
      onRequest: onRequestSpy,
      onNotification: vi.fn(),
      sendRequest: sendRequestSpy,
      sendNotification: sendNotificationSpy,
      listen: vi.fn(),
    };

    // 再次显式触发 setup（构造函数里默认 connection 还不是 mock 时已跑过一次）
    (client as any).setupNotificationHandlers();
  });

  describe("setupNotificationHandlers", () => {
    it("注册 markdown/parse 请求处理器", () => {
      const methods = onRequestSpy.mock.calls.map((c) => c[0]);
      expect(methods).toContain("markdown/parse");
    });

    it("注册 markdown/fs/* 一组关键 fs 处理器", () => {
      const methods = onRequestSpy.mock.calls.map((c) => c[0]);
      // 这一组是 server 正确产出 link diagnostic 必需的
      expect(methods).toContain("markdown/fs/stat");
      expect(methods).toContain("markdown/fs/readFile");
      expect(methods).toContain("markdown/fs/readDirectory");
      expect(methods).toContain("markdown/fs/watcher/create");
      expect(methods).toContain("markdown/fs/watcher/delete");
      expect(methods).toContain("markdown/findMarkdownFilesInWorkspace");
      expect(methods).toContain("workspace/diagnostic/refresh");
    });

    it("markdown/parse 处理器返回 markdown-it tokens 数组（非空 markdown 文本时）", async () => {
      expect(markdownParseHandler).toBeDefined();
      const tokens = await markdownParseHandler!({
        uri: "file:///tmp/a.md",
        text: "# Hello\n\nworld",
      });
      expect(Array.isArray(tokens)).toBe(true);
      expect((tokens as unknown[]).length).toBeGreaterThan(0);
    });

    it("markdown/parse 处理器在 text 缺失时返回空数组", async () => {
      const tokens = await markdownParseHandler!({ uri: "file:///x.md" });
      expect(tokens).toEqual([]);
    });

    it("markdown/fs/stat 对存在的文件返回 type=File，对不存在的返回 null", async () => {
      const statHandler = onRequestSpy.mock.calls.find(
        (c) => c[0] === "markdown/fs/stat"
      )?.[1] as (p: { uri: string }) => Promise<unknown>;
      expect(statHandler).toBeDefined();

      // 一定存在的文件：本测试文件自身
      const selfUri = `file://${__filename}`;
      const resultExist = (await statHandler({ uri: selfUri })) as {
        type: number;
        size: number;
      } | null;
      expect(resultExist).not.toBeNull();
      expect(resultExist!.type).toBe(1); // FileType.File

      // 不存在的文件
      const resultMissing = await statHandler({
        uri: "file:///tmp/__definitely_does_not_exist_md_lsp_test__",
      });
      expect(resultMissing).toBeNull();
    });

    it("markdown/fs/readFile 对存在的文件返回 byte 数组", async () => {
      const readFileHandler = onRequestSpy.mock.calls.find(
        (c) => c[0] === "markdown/fs/readFile"
      )?.[1] as (p: { uri: string }) => Promise<unknown>;
      expect(readFileHandler).toBeDefined();

      const selfUri = `file://${__filename}`;
      const result = (await readFileHandler({ uri: selfUri })) as number[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("afterInitialized", () => {
    it("发送 workspace/didChangeConfiguration，且 markdown.validate.enabled 为 true", async () => {
      await (client as any).afterInitialized();
      // 找出 didChangeConfiguration 的调用
      const call = sendNotificationSpy.mock.calls.find(
        (c) => c[0] === "workspace/didChangeConfiguration"
      );
      expect(call).toBeDefined();
      const settings = call![1].settings;
      expect(settings?.markdown?.validate?.enabled).toBe(true);
      // 至少这几项基础检查打开（参考 vscode-markdown-languageserver 的官方推荐配置）
      expect(settings?.markdown?.validate?.fileLinks?.enabled).toBeDefined();
      expect(settings?.markdown?.validate?.referenceLinks?.enabled).toBeDefined();
      expect(settings?.markdown?.validate?.unusedLinkDefinitions?.enabled).toBeDefined();
    });
  });
});
