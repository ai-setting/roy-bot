/**
 * @fileoverview Task #5364 —— dist 产物深路径可解析性守护
 *
 * ## 为什么这个文件必须存在（这是本轮发现的真实生产缺陷）
 *
 * CLI 的 bundle 用 `packages: "external"` 构建，所以它**保留**
 * `@ai-setting/roy-bot-core/env/xxx` 这样的深路径 import，运行时由 node
 * 的 exports 映射解析。
 *
 * core 的 exports 里只有两条通配（一段、二段），各自映射到 dist 下的
 * index.js；而**三段路径**
 * （`env/event-source/xxx`、`env/task/plugins/xxx`）没有通配能命中，
 * 必须逐个显式声明 —— 且必须在 bunup 的 `entry` 里声明，否则 dist 里
 * 根本不会生成那个 `.js`。
 *
 * 漏声明的后果不是「降级」，而是**进程启动即崩溃**：
 * `node dist/bin/roy-bot.js --version` → ERR_MODULE_NOT_FOUND。
 * #5360 交付时 `wecom-session-card-sender` / `wecom-respond-registry`
 * 就处在这个状态（构建成功，但 dist 缺文件）。
 *
 * ## 本文件怎么守
 *
 * 静态读取 `packages/core/package.json` 的 `exports`，逐个验证：
 *   1. 每条显式 exports 的 import 目标文件真实存在
 *   2. CLI bundle 里出现的所有 core 深路径 specifier 都在 exports 里有映射
 *      （不允许靠通配「猜」一个不存在的 index.js）
 *
 * 这样任何人删掉一条 exports 或漏加 bunup entry（导致构建不产出该文件），
 * 测试会变红，而不是等用户升级后发现 CLI 起不来。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// 本文件在 packages/core/src/env/event-source/ ⇒ 上溯 4 层到 packages/core
const CORE_ROOT = resolve(import.meta.dir, "../../..");
const REPO_ROOT = resolve(CORE_ROOT, "../..");
const CORE_PKG = join(CORE_ROOT, "package.json");
const CORE_DIST = join(CORE_ROOT, "dist");
const CLI_DIST = join(REPO_ROOT, "packages/cli/dist");

interface ExportsMap {
  [key: string]: { import?: string; types?: string; default?: string } | string;
}

function readExports(): ExportsMap {
  const pkg = JSON.parse(readFileSync(CORE_PKG, "utf8")) as {
    exports: ExportsMap;
  };
  return pkg.exports;
}

/** 是否是「显式声明的单文件映射」（区别于 `./*` 这类通配） */
function isExplicit(key: string): boolean {
  return !key.includes("*") && key !== "." && key !== "./package.json";
}

// ============================================================================
// A. 既然 dist 存在，就逐条验证 exports 的 import 目标真的生成了
// ============================================================================

describe("core dist 与 package.json exports 一致", () => {
  const exportsMap = readExports();
  const explicit = Object.entries(exportsMap).filter(([k]) => isExplicit(k));
  const distBuilt = existsSync(join(CORE_DIST, "index.js"));

  if (!distBuilt) {
    test.skip("dist 未构建，跳过（CI 里由 build 步骤保证）", () => {});
    return;
  }

  test(`★ 每条显式 exports 的 import 目标文件都存在（共 ${explicit.length} 条）`, () => {
    const missing: string[] = [];
    for (const [, v] of explicit) {
      const target = typeof v === "string" ? v : v.import;
      if (!target) continue;
      if (!existsSync(join(CORE_ROOT, target))) {
        missing.push(target);
      }
    }
    // 这条断言就是「dist 能不能启动」的最短判据
    expect(missing).toEqual([]);
  });

  test("★ CLI bundle 里每个 core 深路径都解析到真实存在的文件（按 node 语义）", () => {
    // ★ DS review R1 MAJOR-3 修复 —— 这里曾有两个错误，必须同时说清：
    //
    // 【错误 1】旧版兜底里有一条 `dist/<sub>.js`。node 的 exports 通配
    //   **永远**只生成 `dist/<sub>/index.js`（`./*` → `dist/*/index.js`），
    //   不会落到 `dist/<sub>.js`。所以这条候选既不可能命中，又会在
    //   「单文件模块漏加 exports 键」时凭它而判 PASS —— 守卫形同虚设。
    //
    // 【错误 2】`import.meta.resolve` **不校验文件存在**（实测：解析到
    //   不存在的 index.js 也返回成功）。所以判「能否加载」只能靠 existsSync。
    //
    // ⇒ 判据：显式键 → 它声明的 target；无显式键 → node 实际会拼出的
    //   `dist/<sub>/index.js`。两者取其一存在即通过（目录模块走通配是合
    //   法用法，例如 env/workflow/tools）；都不存在 ⇒ 运行时必崩 ⇒ 红。
    const cliEntry = join(CLI_DIST, "index.js");
    if (!existsSync(cliEntry)) return; // CLI 未构建

    const code = readFileSync(cliEntry, "utf8");
    const specs = new Set<string>();
    for (const m of code.matchAll(
      /["']@ai-setting\/roy-bot-core\/([A-Za-z0-9/_@.-]+)["']/g,
    )) {
      specs.add(m[1]);
    }
    expect(specs.size).toBeGreaterThan(0);

    const unresolvable: string[] = [];
    for (const sub of specs) {
      const explicit = exportsMap[`./${sub}`];
      const target =
        typeof explicit === "string"
          ? explicit
          : (explicit as { import?: string } | undefined)?.import;
      // 无显式键 ⇒ 通配唯一可能的落点（不含 dist/<sub>.js —— 那条不存在）
      const resolved = target
        ? join(CORE_ROOT, target)
        : join(CORE_DIST, sub, "index.js");
      if (!existsSync(resolved)) unresolvable.push(`${sub} -> ${resolved}`);
    }
    expect(unresolvable).toEqual([]);
  });

  test("★ 本轮两个关键模块已显式声明且文件存在（回归护栏）", () => {
    const required = [
      "./env/event-source/wecom-session-card-sender",
      "./env/task/plugins/wecom-session-card-store",
      // #5360 遗留：它一直在 CLI bundle 里，但直到本轮才补上 dist 产物
      "./env/event-source/wecom-respond-registry",
    ];
    for (const key of required) {
      expect(exportsMap[key]).toBeDefined();
      const target =
        typeof exportsMap[key] === "string"
          ? (exportsMap[key] as string)
          : (exportsMap[key] as { import?: string }).import;
      expect(target).toBeDefined();
      expect(existsSync(join(REPO_ROOT, "packages/core", target!))).toBe(true);
    }
  });
});