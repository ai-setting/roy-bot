import { defineConfig } from "bunup";

// Build config for @ai-setting/roy-bot-coder-harness
// Monorepo setup: each package has its own config to avoid path resolution issues
export default defineConfig({
  name: "@ai-setting/roy-bot-coder-harness",
  entry: ["src/index.ts"],
  splitting: false,
  // 排除内部包，只 external 第三方包
  // 注意：不能使用 packages: "external"，因为它会导致 @ai-setting/roy-bot-core
  // 被 __require() 调用，在 ESM 模块中无法工作
  external: [
    "@ai-setting/roy-bot-core",
  ],
  minify: false,
  dts: false,
});
