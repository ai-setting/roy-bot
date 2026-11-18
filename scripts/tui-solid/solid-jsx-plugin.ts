/**
 * solid-jsx-plugin.ts — 作用域受限的 Solid JSX 转译 + solid-js runtime 重定向
 * （Task #4278 片1 地基核心）
 *
 * ## 背景：JSX 转译的两条路径不对称（bun 1.3.14 实测）
 *
 * | 路径 | 是否按 per-file 嵌套 tsconfig 选 jsxImportSource |
 * |---|---|
 * | `bun build`（`build-cli-dev.ts` / `Bun.build`） | ✅ 认（按文件所在目录就近取 tsconfig） |
 * | `bun run <file.tsx>`（dev 运行时） | ❌ **不认**，一律用根 tsconfig 的 `jsx:"react"` |
 *
 * 因此：
 *   - **打包路径**由 `packages/cli/src/tui-solid/tsconfig.json`（jsxImportSource =
 *     `@opentui/solid`）保证 —— interactive 链路出 Solid JSX、Ink 链路出 React JSX。
 *     `roy-bot interactive` 跑的就是这个 bundle。
 *   - **`bun run <源码>` 路径**需要 `registerScopedSolidTransform()` 把
 *     tui-solid/*.tsx 转成 Solid JSX（否则退回 React JSX 而崩）。
 *
 * ## 两个注册项，危险度不同（实测区分）
 *
 * 1. **solid-js runtime 重定向**（`registerSolidRuntimeRedirect`）——
 *    bun 会把 `solid-js` 解析到 `dist/server.js`（SSR 构建）。重定向到 `dist/solid.js`
 *    （client 构建）后 Solid 才能正常渲染。实测：**安全**，注册后
 *    `interactive-ink-escape-e2e-task-2297` 仍 PASS，interactive 也能正常启动。
 *    → 默认启用。
 *
 * 2. **tsx Solid 转译**（`registerScopedSolidTransform`）——
 *    在 `bun run` 下注册**任何**全局 tsx onLoad（含 `@opentui/solid` 官方 preload）
 *    都会干扰 bun 内置 tsx loader：实测把上面那个 e2e 子进程 runner 从 PASS 打成
 *    FAIL（runner 不打印任何东西）。且「不匹配返回 undefined」也救不了（undefined
 *    会压过内置 loader）。→ 改为**显式 opt-in**（`ROY_SOLID_JSX=1`），
 *    默认不注册，保证「run 链路 + 全量测试零影响」。
 *
 * ⚠️ 注册 tsx 转译时必须用**窄 filter**（每个 scope 目录一条），让非 scope 文件
 * 根本不进我们的 onLoad。
 */
import { plugin as registerBunPlugin } from "bun";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

/**
 * Solid 作用域目录（路径片段）。只放**真正用 Solid JSX** 的目录；
 * `tui/`（Ink）绝不能在列。
 */
export const SOLID_SCOPE_DIRS = [
  "/packages/cli/src/tui-solid/",
  "/scripts/tui-solid/",
  "/scripts/poc-opentui-solid/",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 为每个 scope 目录生成一条窄 filter（只匹配该目录下的 tsx/jsx 源文件）。 */
export function scopeFilters(): RegExp[] {
  return SOLID_SCOPE_DIRS.map(
    (dir) => new RegExp(escapeRe(dir) + "[^/\\\\]*\\.[cm]?[jt]sx$"),
  );
}

export function isSolidScoped(path: string): boolean {
  if (path.includes("/node_modules/")) return false;
  return SOLID_SCOPE_DIRS.some((dir) => path.includes(dir));
}

const KEY_REDIRECT = "__ROY_SOLID_RUNTIME_REDIRECT__";
const KEY_TRANSFORM = "__ROY_SCOPED_SOLID_TRANSFORM__";

/**
 * 注册 solid-js server→client runtime 重定向（默认启用，实测安全）。
 * @returns true 表示本次调用真正注册了。
 */
export function registerSolidRuntimeRedirect(): boolean {
  const state = globalThis as any;
  if (state[KEY_REDIRECT]) return false;
  state[KEY_REDIRECT] = true;

  const inner = createSolidTransformPlugin();
  registerBunPlugin({
    name: "roy-solid-runtime-redirect",
    setup(build) {
      (inner.setup as any)({
        onLoad(filter: any, cb: any) {
          const filterRe = String(filter?.filter ?? "");
          // 只接管 node_modules 下 solid-js 的两个 server 构建重定向；
          // 源码 tsx 交给 bun 内置转译（不动）。
          // 注意：filter 是 regex 源码字符串（含 [/\\] 转义），故不能字面匹配
          // "node_modules/solid-js"；分别判两个片段即可。
          if (filterRe.includes("node_modules") && filterRe.includes("solid-js")) {
            build.onLoad(filter, (args: any) => cb(args));
          }
        },
      });
    },
  });
  return true;
}

/**
 * 注册作用域受限的 Solid tsx 转译（opt-in：`ROY_SOLID_JSX=1`）。
 * @returns true 表示本次调用真正注册了。
 */
export function registerScopedSolidTransform(): boolean {
  const state = globalThis as any;
  if (state[KEY_TRANSFORM]) return false;
  state[KEY_TRANSFORM] = true;

  const inner = createSolidTransformPlugin();
  registerBunPlugin({
    name: "roy-scoped-solid-jsx",
    setup(build) {
      (inner.setup as any)({
        onLoad(filter: any, cb: any) {
          const filterRe = String(filter?.filter ?? "");
          if (filterRe.includes("node_modules")) {
            // runtime 重定向由 registerSolidRuntimeRedirect 负责；此处跳过避免重复。
            return;
          }
          // Task #4278 片5 — filter shape matters to bun's *test* loader.
          //
          // Under `bun test`, registering a per-scope **plain** filter
          // (`/\/packages\/cli\/src\/tui-solid\/.*\.tsx$/`) is a no-op: the
          // hook is accepted but never invoked, so Solid JSX silently stays on
          // bun's React-style transform (`jsxDEV(...)` → non-reactive props).
          // The official `@opentui/solid` plugin instead ships a **negative
          // lookahead** filter, and *that* shape does get invoked by the test
          // loader. We therefore register one lookahead filter (matching every
          // non-node_modules JSX file) and narrow to SOLID_SCOPE_DIRS *inside*
          // the callback — behaviourally identical, but now actually reached.
          //
          // `bun run <file>` still does not invoke onLoad at all (that is why
          // the preload stays opt-in and the build path uses
          // solid-client-resolve-plugin.ts instead).
          const lookaheadTsx = /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/;
          build.onLoad({ filter: lookaheadTsx }, async (args: any) => {
            if (!isSolidScoped(args.path)) return undefined;
            const result = await cb(args);
            if (!result || typeof result !== "object") {
              throw new Error(
                `[roy-scoped-solid-jsx] transform produced no result for ${args.path}`,
              );
            }
            return result;
          });
        },
      });
    },
  });
  return true;
}

/** 兼容旧名（= registerScopedSolidTransform）。 */
export const registerScopedSolidPlugin = registerScopedSolidTransform;
