import { defineConfig } from "bunup";

// Build config for @ai-setting/roy-bot-cli
// Monorepo setup: each package has its own config to avoid path resolution issues
// CLI needs two entry points: main SDK and bin script
export default defineConfig({
  name: "@ai-setting/roy-bot-cli",
  entry: ["src/index.ts", "src/bin/roy-bot.ts"],
  splitting: false,
  packages: "external",
  // Task #4957: pin the bundle target explicitly. bunup defaults to
  // "node" today, but the 1.7.72 release artifact drifted to
  // target "bun" (`// @bun` pragma + `import.meta.require`) while
  // the bin shebang stayed `#!/usr/bin/env node` — under plain node
  // every DB-backed subcommand died with `__require is not a
  // function`. Pinning "node" guarantees the artifact always
  // matches the node shebang regardless of bunup/bun versions.
  target: "node",
  // Task #2280: ink REPL 集成 — react/ink 这些是 peer 依赖，需要 external
  // 避免 bunup 把 react/jsx-runtime 重复打包到一个文件里（导致 hook 状态丢失）
  external: [
    // Task #4278: @opentui packages carry a native Zig core with
    // per-platform optional binaries (R7). They must stay external so
    // standalone builds don't try to inline every platform's .node/.so.
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "react",
    "react-dom",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "ink",
    "ink-text-input",
    "react-devtools-core",
  ],
  minify: false,
  dts: false,
});
