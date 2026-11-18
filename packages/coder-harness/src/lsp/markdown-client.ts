/**
 * @fileoverview MarkdownLSPClient
 *
 * `vscode-markdown-languageserver` 与其他 LSP 服务器有几点关键不同：
 *
 *  1) **委派词法分析给客户端**：server 通过 `markdown/parse` 请求让客户端
 *     用 markdown-it tokenize 文本并返回 tokens；客户端不实现这个 handler
 *     的话，server 端无法 tokenize，也就不会产出任何 diagnostics。
 *
 *  2) **默认禁用所有校验**：必须通过 `workspace/didChangeConfiguration`
 *     发送 `markdown.validate.*` 设置后才会激活诊断。
 *
 *  3) **委派文件系统给客户端**：server 通过一组 `markdown/fs/*` 请求让客户端
 *     读取文件 / 列目录 / 检查文件存在性（用于验证相对链接是否有效），
 *     不实现这些 handler 时 server 把每个跨文件请求当成失败处理，
 *     有些诊断会不准确甚至不发送。
 *
 * 因此本子类做三件事：
 *  - 重写 `setupNotificationHandlers()`：先调父类，再注册 `markdown/parse`
 *    + `markdown/fs/*` 一组 + `workspace/diagnostic/refresh`
 *  - 重写 `afterInitialized()`：发送 `markdown.validate.*` 全开的配置
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import MarkdownIt from "markdown-it";
import { URI } from "vscode-uri";
import { LSPClient } from "./client";

/**
 * 客户端使用的 markdown-it 实例（懒加载）。
 * markdown-it 是同步、几十微秒级别，全局复用一个实例即可。
 */
let _md: MarkdownIt | null = null;
function getMarkdownIt(): MarkdownIt {
  if (!_md) _md = new MarkdownIt();
  return _md;
}

/**
 * `markdown.validate.*` 的默认配置：把所有基础检查都打开。
 * 与 `vscode-markdown-languageserver` 自带的测试脚本保持一致（见上游 test-lsp-diagnostics.js）。
 */
const DEFAULT_VALIDATE_SETTINGS = {
  markdown: {
    validate: {
      enabled: true,
      referenceLinks: { enabled: "error" as const },
      fragmentLinks: { enabled: "error" as const },
      fileLinks: {
        enabled: "error" as const,
        markdownFragmentLinks: "inherit" as const,
      },
      ignoredLinks: [] as string[],
      unusedLinkDefinitions: { enabled: "warning" as const },
      duplicateLinkDefinitions: { enabled: "warning" as const },
    },
  },
};

/**
 * vscode `FileType` 枚举常量（独立常量，避免引入 vscode 类型依赖）
 *   Unknown = 0
 *   File = 1
 *   Directory = 2
 *   SymbolicLink = 64
 */
const FT_FILE = 1;
const FT_DIRECTORY = 2;
const FT_SYMLINK = 64;

function fileTypeForStats(st: fsSync.Stats): number {
  if (st.isSymbolicLink()) return FT_SYMLINK;
  if (st.isFile()) return FT_FILE;
  if (st.isDirectory()) return FT_DIRECTORY;
  return 0;
}

function uriToFsPath(uriStr: string): string {
  return URI.parse(uriStr).fsPath;
}

export class MarkdownLSPClient extends LSPClient {
  /**
   * 重写：父类先注册 publishDiagnostics 等通用处理器，
   * 我们再追加 markdown 专属请求处理器。
   */
  protected setupNotificationHandlers(): void {
    super.setupNotificationHandlers();

    // === 文本解析 ===
    this.connection.onRequest(
      "markdown/parse",
      (params: { uri: string; text?: string }) => {
        const text = typeof params?.text === "string" ? params.text : "";
        if (!text) return [];
        return getMarkdownIt().parse(text, {});
      }
    );

    // === 文件系统访问（server 委派给客户端）===
    this.connection.onRequest(
      "markdown/fs/stat",
      async (params: { uri: string }) => {
        try {
          const st = await fs.stat(uriToFsPath(params.uri));
          return {
            type: fileTypeForStats(st),
            ctime: st.ctimeMs,
            mtime: st.mtimeMs,
            size: st.size,
          };
        } catch {
          // server 把 null 当作"不存在"处理（见 workspace.ts 的 statBypassingCache）
          return null;
        }
      }
    );

    this.connection.onRequest(
      "markdown/fs/readFile",
      async (params: { uri: string }) => {
        try {
          const buf = await fs.readFile(uriToFsPath(params.uri));
          return Array.from(buf);
        } catch {
          return [];
        }
      }
    );

    this.connection.onRequest(
      "markdown/fs/readDirectory",
      async (params: { uri: string }) => {
        try {
          const entries = await fs.readdir(uriToFsPath(params.uri), {
            withFileTypes: true,
          });
          return entries.map((e) => [
            e.name,
            e.isSymbolicLink()
              ? FT_SYMLINK
              : e.isFile()
                ? FT_FILE
                : e.isDirectory()
                  ? FT_DIRECTORY
                  : 0,
          ]);
        } catch {
          return [];
        }
      }
    );

    // server 端会注册 fs watcher 用来在文件变化时刷新；agent 场景下
    // 我们不打算长期 watch（每次工具调用都会被重新触发诊断），所以这里
    // 仅 ack，让 server 不报 unhandled method。
    this.connection.onRequest("markdown/fs/watcher/create", () => null);
    this.connection.onRequest("markdown/fs/watcher/delete", () => null);

    // 工作区内的 markdown 文件枚举：当前仅返回空，避免在大型仓库里做
    // 全盘扫描；server 仍会通过 fs/stat 检查具体引用，不依赖此返回值。
    this.connection.onRequest(
      "markdown/findMarkdownFilesInWorkspace",
      () => []
    );

    // server 在内部状态变化时会主动要求客户端 refresh 拉取诊断；
    // 我们用 push 模型，所以直接 ack。
    this.connection.onRequest("workspace/diagnostic/refresh", () => null);
  }

  /**
   * 重写：在 server `initialized` 完成、且现有 `initializationOptions`
   * 已被父类发出之后，再追加 markdown 专属的 validate 配置；
   * 否则 server 端默认是关闭的，不会发任何 diagnostic。
   */
  protected async afterInitialized(): Promise<void> {
    await this.connection.sendNotification(
      "workspace/didChangeConfiguration",
      { settings: DEFAULT_VALIDATE_SETTINGS }
    );
  }
}
