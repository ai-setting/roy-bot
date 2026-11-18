import { defineConfig } from "bunup";

// Build config for @ai-setting/roy-bot-core
// Monorepo setup: each package has its own config to avoid path resolution issues
export default defineConfig({
  name: "@ai-setting/roy-bot-core",
  entry: [
    "src/index.ts",
    "src/**/index.ts",
    "src/utils/**/index.ts",
    // Task #4624 — source *files* that hosts import as deep sub-paths.
    // Node's `exports` arrays do not fall back from `dist/<p>/index.js` to
    // `dist/<p>.js`, so each of these needs a real emitted `.js` target.
    "src/env/error-reply.ts",
    "src/env/lark-mention-utils.ts",
    "src/env/tool/types.ts",
    "src/env/event-source/event-store.ts",
    // ★ Task #5364 修复（#5360 遗留）：CLI 按深路径导入这两个模块，
    //   但此前未注册进 entry / exports ⇒ dist 里没有对应 .js
    //   ⇒ `node dist/bin/roy-bot.js` 启动即 ERR_MODULE_NOT_FOUND。
    "src/env/event-source/wecom-respond-registry.ts",
    "src/env/event-source/wecom-session-card-sender.ts",
    "src/env/task/plugins/wecom-session-card-store.ts",
    "src/env/event-source/cli-command-handler.ts",
    "src/env/event-source/event-source-handlers.ts",
    "src/env/event-source/idempotency-key.ts",
    "src/env/task/delegate/delegate-tool.ts",
    "src/env/log-trace/logger.ts",
    "src/env/agent/agent-component.ts",
    "src/env/task/plugins/lark-card-patch-notifier.ts",
    "src/test-utils/child-process-mock.ts",
  ],
  sourceBase: "src", // Preserve source directory structure in output
  splitting: true,
  packages: "external",
  minify: false,
  dts: false, // 禁用 bunup dts 生成，使用 tsc 代替
});
