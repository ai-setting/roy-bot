import { defineConfig } from "bunup";

// Build config for @ai-setting/roy-bot-ontology-harness
// Monorepo setup: each package has its own config to avoid path resolution issues
export default defineConfig({
  name: "@ai-setting/roy-bot-ontology-harness",
  entry: ["src/index.ts"],
  splitting: false,
  // 只 external 内部 workspace 包；第三方包打进产物。
  // 与 coder-harness 一致：不能用 packages: "external"，否则
  // @ai-setting/* 会被 __require() 调用，在 ESM 下失效。
  external: [
    "@ai-setting/roy-bot-core",
    "@ai-setting/roy-bot-coder-harness",
  ],
  minify: false,
  dts: false,
});
