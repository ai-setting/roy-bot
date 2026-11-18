/**
 * @fileoverview Install Command - 插件安装管理
 *
 * 功能：
 * - roy-bot install <package> — 安装插件（执行 npm/pnpm install + 写入 plugins.json）
 * - roy-bot install list — 列出已安装插件
 * - roy-bot install remove <name> — 卸载插件（从 plugins.json 移除 + npm/pnpm uninstall）
 *
 * plugins.json 路径：
 *   - 全局: ~/.roy-bot/plugins.json
 *   - 项目: .roy/plugins.json
 */

import { CommandModule } from "yargs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { cleanupStalePluginCopies } from "./cleanup-stale-plugin-copies.js";

// ============================================================================
// Types
// ============================================================================

/**
 * 已安装的插件信息
 */
export interface InstalledPlugin {
  /** npm 包名 */
  packageName: string;
  /** 插件版本 */
  version: string;
  /** 插件名称（从 package.json 中提取的 name） */
  name: string;
  /** 插件描述 */
  description?: string;
}

/**
 * plugins.json 文件结构
 */
interface PluginsConfig {
  plugins: InstalledPlugin[];
}

// ============================================================================
// Constants
// ============================================================================

/** 插件配置文件路径 */
/** 安装范围 */
type InstallScope = "global" | "project";

/** 获取指定范围的配置目录 */
function getConfigDir(scope: InstallScope): string {
  return scope === "global"
    ? join(homedir(), ".roy-bot")
    : join(process.cwd(), ".roy");
}

/**
 * 检测默认安装范围
 * 如果项目 .roy/ 目录存在，默认安装到项目；否则安装到全局
 */
function detectDefaultScope(): InstallScope {
  const projectDir = join(process.cwd(), ".roy");
  return existsSync(projectDir) ? "project" : "global";
}

/** 获取指定范围的 plugins.json 路径 */
function getConfigPath(scope: InstallScope): string {
  return join(getConfigDir(scope), "plugins.json");
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 读取 plugins.json
 */
function loadPlugins(scope: InstallScope): InstalledPlugin[] {
  const configPath = getConfigPath(scope);
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const config: PluginsConfig = JSON.parse(raw);
      return config.plugins ?? [];
    }
  } catch {
    // 忽略读取错误
  }
  return [];
}

/**
 * 写入 plugins.json
 */
function savePlugins(plugins: InstalledPlugin[], scope: InstallScope): void {
  const configDir = getConfigDir(scope);
  const configPath = getConfigPath(scope);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const config: PluginsConfig = { plugins };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 剥离 npm 包名后的 @version 限定符（如 `@latest` / `@1.0.0` / `@^2.0.0`）。
 *
 * 用户在 CLI 里可能输入 `roy-bot install @ai-setting/foo@latest`，
 * 但 npm 实际安装到 node_modules 的目录是 `@ai-setting/foo/`（没有 `@latest` 后缀），
 * 所以 roy-bot 在拼 node_modules 路径前必须把 `@version` 去掉。
 *
 * 规则：
 * - `@scope/name` → `@scope/name`（第一个 `@` 表示 scope，不是 version）
 * - `@scope/name@1.0.0` → `@scope/name`
 * - `name@1.0.0` → `name`
 * - `name` → `name`
 *
 * 导出供测试调用。
 */
export function stripVersionSpec(packageName: string): string {
  // 从尾部找最后一个 `@`，但跳过首字符的 `@`（scope 标记）
  const atIdx = packageName.lastIndexOf("@");
  if (atIdx > 0) {
    return packageName.substring(0, atIdx);
  }
  return packageName;
}

/**
 * 读取已安装 npm 包的 package.json，获取包信息
 *
 * 搜索路径顺序（先命中先返回，Task #2899 修复顺序）：
 *   1. process.cwd()/node_modules/<packageName>/package.json  ← 最高优先级：项目本地依赖
 *   2. <parent>/node_modules/<packageName>/package.json       ← 父目录依赖
 *   3. process.cwd()/.roy/plugins/<packageName>/package.json  ← 项目 .roy/plugins 复制
 *   4. $(npm root -g)/<packageName>/package.json             ← npm global root 权威
 *   5. ~/.roy-bot/node_modules/<packageName>/package.json  ← 历史 cp 副本兜底
 *
 * **Task #2899 修复说明（version drift）**：
 * 之前 `~/.roy-bot/node_modules/` 排在 npm global root 之前，导致 roy-bot install --global
 * 升级时，readPackageInfo 命中旧版 cp 副本，写入 plugins.json 的 version 永远落后于
 * npm 真装的版本。修复方式：把 npm global root（权威）提到 cp 副本之前。
 *
 * **Task #1960 兼容说明**：
 * symlinked global install 场景下，npm 报告的 root (e.g. /usr/lib/node_modules) 与
 * roy-bot 历史默认寻找的 ~/.roy-bot/node_modules 不一致，因此两者都作为搜索路径。
 *
 * **Task #1993 兼容说明**：
 * 自动剥离 `@version` 限定符（@latest / @1.0.0），npm 实际把包装到 `<globalRoot>/@scope/pkg/`。
 *
 * 导出供测试调用。
 */
export function readPackageInfo(
  packageName: string,
  /** Task #5411: 可选覆盖 homedir（测试注入，避免写/删真实 ~/.roy-bot）。 */
  options?: { homedir?: string },
): { version: string; name: string; description?: string } | null {
  // 剥离 @version 限定符（如 @latest）。本地路径（以 / 或 . 开头）跳过此处理。
  const bareName = packageName.startsWith("/") || packageName.startsWith(".")
    ? packageName
    : stripVersionSpec(packageName);

  // 如果是本地路径，直接从源目录读取
  if (packageName.startsWith("/") || packageName.startsWith(".")) {
    const localPkgPath = join(packageName, "package.json");
    if (existsSync(localPkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(localPkgPath, "utf-8"));
        return {
          version: pkg.version ?? "0.0.0",
          name: pkg.name ?? packageName,
          description: pkg.description,
        };
      } catch (err) {
        console.warn(`⚠️  Failed to parse local package.json at '${localPkgPath}': ${err}`);
      }
    }
  }

  // 尝试在 node_modules 中查找
  const searchPaths = [
    // 1. 项目本地依赖（最高优先级：npm/pnpm install 装到项目 node_modules 的版本）
    join(process.cwd(), "node_modules", bareName, "package.json"),
    // 2. 父目录依赖
    resolve(process.cwd(), "..", "node_modules", bareName, "package.json"),
    // 3. 项目 .roy/plugins 复制（install --project 会 cp 过去）
    join(process.cwd(), ".roy", "plugins", bareName, "package.json"),
    // 4. npm global root 权威（Task #2899: 排到 cp 目录之前，避免 stale copy 抢占）
    //    symlinked global install 场景下，npm 报告 /usr/lib/node_modules，roy-bot 据此读取真实安装版本
    ...(() => {
      const globalRoot = getNpmGlobalRoot();
      return globalRoot ? [join(globalRoot, bareName, "package.json")] : [];
    })(),
    // 5. 历史 ~/.roy-bot/node_modules 兜底（旧版本 roy-bot install --global 会 cp 过来，
    //    新版本不再 cp，但保留作为历史 cp 副本的兜底 — 优先级最低，不抢先 npm global root）
    join(options?.homedir ?? homedir(), ".roy-bot", "node_modules", bareName, "package.json"),
  ];

  for (const pkgPath of searchPaths) {
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return {
          version: pkg.version ?? "0.0.0",
          name: pkg.name ?? bareName,
          description: pkg.description,
        };
      }
    } catch (err) {
      console.warn(`⚠️  Failed to parse package.json at '${pkgPath}': ${err}`);
      continue;
    }
  }

  console.warn(`⚠️  Could not find package.json for '${packageName}' (searched ${searchPaths.length} paths)`);
  return null;
}

/**
 * 获取 npm 全局 node_modules 根路径
 *
 * 通过 `npm root -g` 查询；status===0 且 stdout 非空时返回 trim 后的路径，否则返回 null。
 *
 * 用于 roy-bot install --global：symlinked global install 场景下，npm 报告的全局 root
 * (e.g. /usr/lib/node_modules) 与 roy-bot 默认寻找的 ~/.roy-bot/node_modules 不一致，
 * 因此 readPackageInfo 必须把 npm 报告的 root 作为兜底搜索路径。
 *
 * 导出供测试注入 mock spawnSync。
 */
export function getNpmGlobalRoot(): string | null {
  const result = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout) {
    return String(result.stdout).trim();
  }
  return null;
}

/**
 * 清理 ~/.roy-bot/node_modules/<packageName>/ 下的历史 cp 副本。
 *
 * **Task #2903 修复说明（stale cp cleanup）**：
 * Task #2899 删了 install --global 的 cp 逻辑，但没清理历史 cp 副本。
 * 当 PluginComponent `loadPluginFromPackage()` 用 `import(packageName)` 失败时，
 * 会 fallback 到 `~/.roy-bot/node_modules/<packageName>/` 加载 — 此时如果该目录
 * 残留 Task #2899 之前 cp 留下的旧版本（例如 v2.5.7），就会加载到陈旧入口，
 * 报 AdapterError。`install --global` 成功后必须显式清理这个兜底目录。
 *
 * 注意：
 * - scoped 包路径是 `~/.roy-bot/node_modules/@scope/pkg/`，直接 rmSync 即可
 * - 传入的 packageName 必须是已经 strip 过的（无 `@version` 后缀）
 * - 清理失败不阻塞 install 主流程（best-effort）
 * - 返回 true 表示清掉了 cp 副本，false 表示原本就没有
 *
 * **Task #2948 supersede**：
 * 这个函数只清理 `~/.roy-bot/node_modules/<pkg>/`。Plugin host 的 cwd-up
 * Node 模块解析会先命中 `<homedir>/node_modules/<pkg>/` 里的 stale 副本
 * （如 ~/node_modules/<pkg>/），这是用户实际报告的 stale 来源。
 * 新代码用 `cleanupStalePluginCopies()` 替代本函数，同时清理两个路径。
 * 本函数保留导出（向后兼容 + 旧测试断言），install --global handler 已
 * 改用 `cleanupStalePluginCopies()`。
 *
 * 导出供测试调用。
 */
export function cleanupStaleCpCopy(
  packageName: string,
  /** Task #5411: 可选覆盖 homedir（测试注入，避免删真实 ~/.roy-bot）。 */
  options?: { homedir?: string },
): boolean {
  const cpDir = join(options?.homedir ?? homedir(), ".roy-bot", "node_modules", packageName);
  if (!existsSync(cpDir)) {
    return false;
  }
  try {
    rmSync(cpDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`⚠️  Failed to clean stale cp copy at '${cpDir}': ${err}`);
    return false;
  }
}

/**
 * 验证 install --global 后实际可加载的版本与 plugins.json 声明的版本是否一致。
 *
 * **Task #2903 + #2907 + #2907-followup 修复说明**：
 * 1. readPackageInfo 先调用：npm global root 是权威源（Task #2899 修复了搜索顺序），
 *    即使 import() 失败也能读到真实版本。
 * 2. 版本对比 declared vs actual。
 *
 * **Task #2907 followup：删除 best-effort import 校验**：
 * 之前的实现会在版本匹配后做 `try { await import(packageName) }`，但 Node
 * 默认模块解析路径不含 npm global root，对全局安装的插件必然抛
 * ERR_MODULE_NOT_FOUND，导致每次 install --global 都输出一条无意义 warn。
 * 真实插件可加载性校验已经在 `PluginComponent.loadPluginFromPackage()`
 * （Task #2908 已加 npm global root fallback），不在本函数职责内。
 *
 * 返回：
 * - 一致 → { ok: true, actualVersion }
 * - readPackageInfo 找不到 → { ok: false, reason: 'no-version', actualVersion: null }
 * - 版本不一致 → { ok: false, reason: 'version-mismatch', actualVersion: actual }
 *
 * 注：保留 `"not-importable"` 在 union type 中是为防止调用方 (`install/index.ts:493`
 * 处) 忘了处理新增 reason 时编译报错；函数本体不再 return 它。
 *
 * 导出供测试调用。
 */
export async function verifyInstalledVersion(
  packageName: string,
  declaredVersion: string,
): Promise<
  | { ok: true; actualVersion: string }
  | { ok: false; reason: "not-importable" | "no-version" | "version-mismatch"; actualVersion: string | null }
> {
  // 1. readPackageInfo（最权威 — 直接读 npm global root 的 package.json）
  const actual = readPackageInfo(packageName);
  if (!actual || !actual.version) {
    return { ok: false, reason: "no-version", actualVersion: null };
  }

  // 2. 对比 declared vs actual
  if (actual.version !== declaredVersion) {
    return { ok: false, reason: "version-mismatch", actualVersion: actual.version };
  }

  // 一致：版本检查通过即可
  // 注：plugin 可加载性的真实校验在 PluginComponent.loadPluginFromPackage()
  //     （Task #2908 已加 npm global root fallback）
  return { ok: true, actualVersion: actual.version };
}

/**
 * 检测当前项目使用的包管理器
 */
function getPackageManagerCommand(): string {
  if (existsSync(join(process.cwd(), "pnpm-lock.yaml"))) {
    // pnpm workspace 需要 -w 标志
    if (existsSync(join(process.cwd(), "pnpm-workspace.yaml"))) {
      return "pnpm -w";
    }
    return "pnpm";
  }
  if (existsSync(join(process.cwd(), "yarn.lock"))) return "yarn";
  if (existsSync(join(process.cwd(), "bun.lock")) || existsSync(join(process.cwd(), "bun.lockb"))) return "bun";
  return "npm";
}

// ============================================================================
// Command: roy-bot install <package>
// ============================================================================

const InstallPackageCommand: CommandModule = {
  command: "$0 <package>",
  describe: "安装插件包",

  builder: (yargs) =>
    yargs
      .positional("package", {
        describe: "npm 包名（例如 @roy-bot/plugin-example）或本地路径",
        type: "string",
      })
      .option("global", {
        alias: "g",
        describe: "安装到全局 ~/.roy-bot/plugins.json",
        type: "boolean",
        conflicts: "project",
      })
      .option("project", {
        alias: "l",
        describe: "安装到项目 .roy/plugins.json（本地）",
        type: "boolean",
        conflicts: "global",
      })
      .help(),

  handler: async (argv) => {
    const packageName = argv.package as string;
    const scope: InstallScope = argv.project ? "project" : (argv.global ? "global" : detectDefaultScope());

    if (scope === "project") {
      console.log(`\n📦 Installing plugin: ${packageName} (project)\n`);

      // 如果是本地路径，先读取包信息获取解析后的包名
      let resolvedName: string;
      if (packageName.startsWith("/") || packageName.startsWith(".")) {
        const info = readPackageInfo(packageName);
        if (!info) {
          console.error(`\n❌ Could not read package info from '${packageName}'.\n`);
          process.exit(1);
        }
        resolvedName = info.name;

        const srcDir = resolve(packageName);
        if (!existsSync(srcDir)) {
          console.error(`\n❌ Local path '${srcDir}' does not exist.\n`);
          process.exit(1);
        }

        // 复制到 .roy/plugins/<resolvedName>/
        const pluginDir = join(process.cwd(), ".roy", "plugins", resolvedName);
        if (!existsSync(pluginDir)) {
          mkdirSync(pluginDir, { recursive: true });
        }
        const result = spawnSync("cp", ["-r", `${srcDir}/.`, pluginDir], {
          stdio: "inherit",
          shell: false,
        });
        if (result.status !== 0) {
          console.error(`\n❌ Failed to copy plugin from '${srcDir}'.\n`);
          process.exit(1);
        }
      } else {
        // npm 包：先安装到项目 node_modules
        const pm = getPackageManagerCommand();
        const pmParts = pm.split(" ").filter(Boolean);
        const result = spawnSync(pmParts[0], [...pmParts.slice(1), "install", packageName], {
          cwd: process.cwd(),
          stdio: "inherit",
          shell: false,
        });
        if (result.status !== 0) {
          console.error(`\n❌ Failed to install package '${packageName}'.\n`);
          process.exit(1);
        }

        // 读取包信息获取解析后的包名
        const info = readPackageInfo(packageName);
        if (!info) {
          console.error(`\n❌ Package '${packageName}' was installed but could not read package info.\n`);
          process.exit(1);
        }
        resolvedName = info.name;

        // 复制到 .roy/plugins/<resolvedName>/
        const pluginDir = join(process.cwd(), ".roy", "plugins", resolvedName);
        if (!existsSync(pluginDir)) {
          mkdirSync(pluginDir, { recursive: true });
        }
        const nmPath = join(process.cwd(), "node_modules", packageName);
        if (existsSync(nmPath)) {
            spawnSync("cp", ["-r", `${nmPath}/.`, pluginDir], { stdio: "inherit", shell: false });
        }
      }
    } else {
      // 全局安装：npm install -g
      // Task #2899: 不再 cp 到 ~/.roy-bot/node_modules/。
      // 旧版 cp 逻辑会留下 stale copy 抢占 readPackageInfo，导致 plugins.json 记的 version
      // 永远落后于 npm 真装的版本。npm 本身就是权威来源 — 见 readPackageInfo 搜索顺序。
      console.log(`\n📦 Installing plugin: ${packageName} (global)\n`);

      const result = spawnSync("npm", ["install", "-g", packageName], {
        stdio: "inherit",
        shell: false,
      });
      if (result.status !== 0) {
        console.error(`\n❌ Failed to install package '${packageName}' globally.\n`);
        process.exit(1);
      }

      // Task #2948: 清理所有 stale plugin 副本（cwd-up 解析落点 + 历史 cp 副本）
      // 之前 Task #2903 只清理 ~/.roy-bot/node_modules/<pkg>/，但 plugin host 的
      // cwd-up Node 模块解析会先命中 ~/node_modules/<pkg>/ 里的 stale 副本
      // （Task #2899 之前 npm install -g 触发的 cp 副作用），导致 plugins.json 声明
      // v2.5.9 但实际加载 v2.5.7。修复：扫描 <homedir>/node_modules/ + <homedir>/.roy-bot/node_modules/
      // 两处路径，对每个副本做版本对比：
      //   - local.version < globalVersion → backup 到 /tmp 后删除
      //   - local.version >= globalVersion → 保留（dev build 不动）
      //   - 不存在 → no-op
      //   - corrupted JSON → 当 stale 处理
      // Best-effort：失败 log warn，不影响 install 主流程。
      const tmpInfo = readPackageInfo(packageName);
      if (tmpInfo) {
        const cleanupResult = cleanupStalePluginCopies(tmpInfo.name, {
          globalVersion: tmpInfo.version,
          homedir: homedir(),
        });
        if (cleanupResult.cleaned.length > 0) {
          console.log(`\n🧹 Cleaned stale plugin copies:`);
          for (const path of cleanupResult.cleaned) {
            console.log(`   - ${path}`);
          }
          if (cleanupResult.backups.length > 0) {
            console.log(`\n📦 Backups (for manual recovery):`);
            for (const b of cleanupResult.backups) {
              console.log(`   ${b.originalPath} → ${b.backupPath}`);
            }
          }
          console.log();
        }
      }
    }


    // 读取包信息
    const info = readPackageInfo(packageName);
    if (!info) {
      console.error(`\n❌ Package '${packageName}' was installed but could not read package info.\n`);
      process.exit(1);
    }

    // 写入 plugins.json
    const plugins = loadPlugins(scope);

    // 检查是否已安装
    const resolvedPackageName = info.name;
    const existing = plugins.findIndex((p) => p.packageName === resolvedPackageName);
    const plugin: InstalledPlugin = {
      packageName: resolvedPackageName,
      version: info.version,
      name: info.name,
      description: info.description,
    };

    if (existing >= 0) {
      plugins[existing] = plugin;
      console.log(`\n✅ Updated plugin: ${plugin.packageName}@${plugin.version}\n`);
    } else {
      plugins.push(plugin);
      console.log(`\n✅ Installed plugin: ${plugin.packageName}@${plugin.version}\n`);
    }

    savePlugins(plugins, scope);

    // Task #2903: 后置一致性校验（防御性兜底 — 理论上 cleanupStaleCpCopy 之后
    // plugins.json 声明的 version 应当等于 npm global root 的 version；但如果仍
    // 不一致，warn 出来帮助用户诊断）
    if (scope === "global") {
      try {
        const verify = await verifyInstalledVersion(resolvedPackageName, plugin.version);
        if (verify.ok === false) {
          // 已被 narrow 到 { ok: false; reason: ...; actualVersion: string | null }
          console.warn(
            `\n⚠️  Post-install version drift detected for '${resolvedPackageName}':\n` +
            `   declared (plugins.json): ${plugin.version}\n` +
            `   actual (npm global root): ${verify.actualVersion ?? "(unknown)"}\n` +
            `   reason: ${verify.reason}\n` +
            `   请检查 ~/.roy-bot/node_modules/${resolvedPackageName}/ 是否残留陈旧 cp 副本\n`
          );
        }
      } catch (err) {
        // best-effort: 校验失败不影响 install 主流程
        console.warn(`⚠️  Post-install version check failed: ${err}`);
      }
    }
  },
};

// ============================================================================
// Command: roy-bot install list
// ============================================================================

const InstallListCommand: CommandModule = {
  command: "list",
  describe: "列出已安装的插件",

  builder: (yargs) =>
    yargs.help(),

  handler: () => {
    const globalPlugins = loadPlugins("global");
    const projectPlugins = loadPlugins("project");

    const hasAny = globalPlugins.length > 0 || projectPlugins.length > 0;

    if (!hasAny) {
      console.log("\n📦 No plugins installed.\n");
      console.log("  Run 'roy-bot install <package>' to install a plugin.\n");
      return;
    }

    if (globalPlugins.length > 0) {
      console.log(`\n🌍 Global Plugins (${globalPlugins.length})\n`);
      for (const plugin of globalPlugins) {
        console.log(`  ✓ ${plugin.packageName}@${plugin.version}`);
        if (plugin.description) {
          console.log(`    ${plugin.description}`);
        }
      }
    }

    if (projectPlugins.length > 0) {
      console.log(`\n📁 Project Plugins (${projectPlugins.length})\n`);
      for (const plugin of projectPlugins) {
        console.log(`  ✓ ${plugin.packageName}@${plugin.version}`);
        if (plugin.description) {
          console.log(`    ${plugin.description}`);
        }
      }
    }

    console.log();
  },
};

// ============================================================================
// Command: roy-bot install remove <name>
// ============================================================================

const InstallRemoveCommand: CommandModule = {
  command: "remove <name>",
  describe: "卸载插件",

  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "插件包名",
        type: "string",
        demandOption: true,
      })
      .option("global", {
        alias: "g",
        describe: "从全局 ~/.roy-bot/plugins.json 移除",
        type: "boolean",
        conflicts: "project",
      })
      .option("project", {
        alias: "l",
        describe: "从项目 .roy/plugins.json 移除（本地）",
        type: "boolean",
        conflicts: "global",
      })
      .help(),

  handler: (argv) => {
    const name = argv.name as string;
    const scope: InstallScope = argv.project ? "project" : (argv.global ? "global" : detectDefaultScope());

    const plugins = loadPlugins(scope);

    // 按包名或插件名匹配
    const index = plugins.findIndex(
      (p) => p.packageName === name || p.name === name
    );

    if (index === -1) {
      console.log(`\n⚠️  Plugin '${name}' not found in ${scope} installed plugins.\n`);
      process.exit(1);
    }

    const plugin = plugins[index];
    console.log(`\n🗑️  Removing plugin: ${plugin.packageName}@${plugin.version} (${scope})\n`);

    if (scope === "project") {
      // 项目移除：删除 .roy/plugins/<packageName>/ 目录
      const pluginDir = join(process.cwd(), ".roy", "plugins", plugin.packageName);
      if (existsSync(pluginDir)) {
        spawnSync("rm", ["-rf", pluginDir], { stdio: "inherit", shell: false });
        console.log(`  Removed plugin directory: ${pluginDir}`);
      }
    } else {
      // 全局移除：npm uninstall -g
      const result = spawnSync("npm", ["uninstall", "-g", plugin.packageName], {
        stdio: "inherit",
        shell: false,
      });
      if (result.status !== 0) {
        console.error(`\n❌ Failed to uninstall package '${plugin.packageName}' globally.\n`);
        process.exit(result.status ?? 1);
      }

      // 删除 ~/.roy-bot/node_modules/<packageName>/（Task #2899: 历史 cp 副本 best-effort 清理）
      // 注意：新版 install --global 已经不再 cp（npm 是权威），但旧版本 cp 过的副本可能仍在
      // 这里作为兜底清理：不影响主流程（npm uninstall -g 已成功），只是删除历史 cp 副本
      const globalNm = join(homedir(), ".roy-bot", "node_modules", plugin.packageName);
      if (existsSync(globalNm)) {
        spawnSync("rm", ["-rf", globalNm], { stdio: "inherit", shell: false });
      }
    }

    // 从配置中移除
    plugins.splice(index, 1);
    savePlugins(plugins, scope);

    console.log(`\n✅ Removed plugin: ${plugin.packageName}\n`);
  },
};

// ============================================================================
// Install Command Group
// ============================================================================

export const InstallCommand: CommandModule = {
  command: "install",
  describe: "插件安装管理 - 安装、列出、卸载插件",

  builder: (yargs) =>
    yargs
      .command(InstallPackageCommand)
      .command(InstallListCommand)
      .command(InstallRemoveCommand)
      .demandCommand()
      .help(),

  handler: () => {
    console.log("Use 'roy-bot install --help' for usage information");
  },
};
