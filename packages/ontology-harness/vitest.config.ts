import { defineConfig } from "vitest/config";
import path from "node:path";

// 让 vitest 直接解析 workspace 源码，避免依赖未构建的 dist。
// 注意：只别名 coder-harness 到 src；core 仍走其 package main(dist)，
// 与 coder-harness 自身的测试解析方式保持一致。
export default defineConfig({
  resolve: {
    alias: {
      "@ai-setting/roy-bot-coder-harness": path.resolve(
        __dirname,
        "../coder-harness/src/index.ts"
      ),
    },
  },
});
