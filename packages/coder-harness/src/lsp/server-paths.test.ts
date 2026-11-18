/**
 * @fileoverview server-paths 测试：通过 require.resolve 推导 npm 包入口路径
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import { resolvePackageEntry } from "./server-paths";

describe("resolvePackageEntry", () => {
  it("应该能解析出 @ai-setting/markdown-language-server 的本地入口文件", () => {
    const entry = resolvePackageEntry(
      "@ai-setting/markdown-language-server",
      "out/node/main.js"
    );
    expect(entry).toBeTruthy();
    expect(fs.existsSync(entry!)).toBe(true);
    expect(entry!.endsWith("out/node/main.js")).toBe(true);
  });

  it("对不存在的包返回 null", () => {
    const entry = resolvePackageEntry(
      "@nonexistent/totally-fake-package-12345",
      "main.js"
    );
    expect(entry).toBeNull();
  });
});
