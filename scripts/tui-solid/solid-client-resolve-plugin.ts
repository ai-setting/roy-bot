/**
 * solid-client-resolve-plugin.ts — 构建期把 `solid-js` 强制解析到 **client** 运行时，
 * 并为我们自己的 Solid 源文件启用真正的 Solid JSX 转译（Task #4278 R8 收口）。
 *
 * ## R8 根因（bun 1.3.14 实测归因，纠正片2 报告的错误结论）
 *
 * ### 半边 A：解析错（SSR 运行时）
 *
 * `solid-js@1.9.17` 的 `exports["."]`：
 *
 * ```jsonc
 * { "worker": {...server.js},
 *   "browser": {"import":"./dist/solid.js"},   // client 运行时
 *   "node":    {"import":"./dist/server.js"},  // SSR 构建  ← bun 默认命中
 *   "deno":    {...server.js},
 *   "import":  "./dist/solid.js" }             // 兜底，被 node 抢先
 * ```
 *
 * bun 默认命中 `node` → `dist/server.js`（SSR）→ effect 队列不 flush、
 * `onMount` 是 no-op。修法：`solidClientResolvePlugin()` 在 `Bun.build` 期用
 * `onResolve` 把裸 specifier 重写到显式 **client** 产物并 inline。
 *
 * ### 半边 B：JSX 转译错（急求值）—— 只有 A 修好也还是死的！
 *
 * **bun 内置的 JSX transform 是"急求值"（React 风格）**，Solid 需要
 * `babel-preset-solid` 生成**惰性 prop getter + `effect(() => setProp(...))`**：
 *
 * ```js
 * // ❌ bun 内置（永不更新）
 * jsxDEV("text", { content: "TXT=" + txt() }, ...)
 * // ✅ Solid 转译（响应式）
 * effect((_$p) => setProp(_el$2, "content", "TXT=" + txt(), _$p));
 * ```
 *
 * `@opentui/solid/bun-plugin` 提供该转译，**但同时注册全局的
 * `node_modules/solid-js/dist/server.js → solid.js` onLoad**；在 `roy-bot run`
 * （Ink/React）链路里它会干扰 bun 内置 tsx loader → 实测把
 * `interactive-ink-escape-e2e-task-2297` 从 PASS 打成 FAIL（片1 踩过）。
 *
 * 所以本模块另提供 **`scopedSolidTransformPlugin()`**：只对**我们自己的 Solid
 * 源文件**（`packages/cli/src/tui-solid/**` 等）跑 Solid 转译，**不触碰
 * node_modules** → run 链路零影响。
 *
 * 实测（真 `Bun.build({packages:"external"})` + 真 dist + 真 pty）：
 * 键入 `hello` 回显、`onMount`/`createEffect` 真执行、根目录与 `packages/cli`
 * 两种 cwd 均通过。
 */

import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

export interface SolidClientResolvePluginOptions {
  /**
   * 解析基准目录（一般为仓库根）。用于 `createRequire` 定位
   * `solid-js` / `@opentui/solid` 的真实安装路径。
   */
  rootDir: string;
  /** 是否把 `entities`（`@opentui/solid` 的传递依赖）保留为 external。 */
  entitiesExternal?: boolean;
}

/** 从 @opentui/solid 包根目录推导出的绝对路径集合。 */
function resolveTargets(rootDir: string) {
  const require = createRequire(path.join(rootDir, "noop.js"));
  const solidClient = require.resolve("solid-js/dist/solid.js");
  const solidStore = require.resolve("solid-js/store/dist/store.js");
  // `@opentui/solid` 在 bun 下的 exports 会命中 `index.bun.js`（内部 import 裸
  // `solid-js`）；我们要 `index.js`（内部 import `solid-js/dist/solid.js`）。
  const ossRoot = path.dirname(require.resolve("@opentui/solid"));
  return {
    solidClient,
    solidStore,
    ossRoot,
    ossIndexJs: path.join(ossRoot, "index.js"),
    ossJsxRuntime: path.join(ossRoot, "jsx-runtime.js"),
    ossJsxDevRuntime: path.join(ossRoot, "jsx-dev-runtime.js"),
    ossPreloadNode: path.join(ossRoot, "scripts/preload.node.js"),
  };
}

/**
 * 「solid-js / @opentui/solid → client 运行时」的 `Bun.build` 插件。
 *
 * 直接塞进 `Bun.build({ plugins: [...] })`。
 */
export function solidClientResolvePlugin(opts: SolidClientResolvePluginOptions) {
  const t = resolveTargets(opts.rootDir);
  const log = (msg: string) => {
    if (process.env.ROY_SOLID_RESOLVE_DEBUG === "1") console.log(`[solid-client-resolve] ${msg}`);
  };

  return {
    name: "roy-solid-client-resolve",
    setup(build: any) {
      // solid-js 主入口（裸 specifier）：我们 tui-solid/* 源码与
      // @opentui/solid/index.bun.js 内部都会命中。
      build.onResolve({ filter: /^solid-js$/ }, (args: any) => {
        log(`solid-js ← ${args.importer || args.namespace}`);
        return { path: t.solidClient };
      });
      // 已显式写成深路径的（@opentui/solid/index.js 内部）：统一归到同一份，
      // 避免出现两份 client 运行时实例（Solid 的 owner/context 会分裂）。
      build.onResolve({ filter: /^solid-js\/dist\/[^/]+\.js$/ }, () => ({ path: t.solidClient }));
      build.onResolve({ filter: /^solid-js\/store$/ }, () => ({ path: t.solidStore }));
      build.onResolve({ filter: /^solid-js\/store\/dist\/[^/]+\.js$/ }, () => ({ path: t.solidStore }));

      // @opentui/solid —— 必须走 index.js（其内部 import client 构建）。
      build.onResolve({ filter: /^@opentui\/solid$/ }, (args: any) => {
        log(`@opentui/solid ← ${args.importer || args.namespace}`);
        return { path: t.ossIndexJs };
      });
      build.onResolve({ filter: /^@opentui\/solid\/jsx-runtime$/ }, () => ({ path: t.ossJsxRuntime }));
      build.onResolve({ filter: /^@opentui\/solid\/jsx-dev-runtime$/ }, () => ({ path: t.ossJsxDevRuntime }));
      build.onResolve({ filter: /^@opentui\/solid\/preload$/ }, () => ({ path: t.ossPreloadNode }));

      if (opts.entitiesExternal) {
        build.onResolve({ filter: /^entities$/ }, () => {
          const require = createRequire(path.join(opts.rootDir, "noop.js"));
          return { path: require.resolve("entities"), external: true };
        });
      }
    },
  };
}

/**
 * 作用域受限的 Solid JSX 转译插件（build 期）。
 *
 * 复用 `@opentui/solid` 官方的 babel-preset-solid 转译（`transformSolidSource`），
 * 但**只**对我们自己的 Solid 源文件生效 —— 绝不触碰 `node_modules`，以免影响
 * `roy-bot run`（Ink/React）链路。
 *
 * @param opts.scopeDirs 只对这些**路径片段**下的 `.tsx/.jsx/.ts/.js` 跑转译
 * @param opts.moduleName jsxImportSource 名（默认 `@opentui/solid`）
 */
export function scopedSolidTransformPlugin(opts: {
  scopeDirs: string[];
  moduleName?: string;
  /** createRequire 基准目录（仓库根），用于定位 @opentui/solid 安装路径。 */
  resolveFrom: string;
}) {
  const moduleName = opts.moduleName ?? "@opentui/solid";
  const escaped = opts.scopeDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const scopeRe = new RegExp(`(?:${escaped.join("|")})[^/\\\\]*\\.[cm]?[jt]sx?$`);
  const log = (msg: string) => {
    if (process.env.ROY_SOLID_RESOLVE_DEBUG === "1") console.log(`[scoped-solid-jsx] ${msg}`);
  };

  return {
    name: "roy-scoped-solid-jsx-build",
    setup(build: any) {
      let transformSolidSource:
        | ((code: string, o: { filename: string; moduleName?: string }) => Promise<string>)
        | null = null;

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args: any) => {
        const p: string = args.path;
        if (p.includes("/node_modules/") || p.includes("\\node_modules\\")) return undefined;
        if (!scopeRe.test(p)) return undefined;

        if (!transformSolidSource) {
          // 该文件未在 @opentui/solid 的 `exports` 里导出 → 只能用绝对路径加载。
          const require = createRequire(path.join(opts.resolveFrom, "noop.js"));
          const ossRoot = path.dirname(require.resolve("@opentui/solid"));
          const mod = await import(path.join(ossRoot, "scripts/solid-transform.js"));
          transformSolidSource = mod.transformSolidSource;
        }
        const code = await readFile(p, "utf8");
        log(`transpile ${p}`);
        const contents = await transformSolidSource(code, { filename: p, moduleName });
        return { contents, loader: "js" };
      });
    },
  };
}

export default solidClientResolvePlugin;
