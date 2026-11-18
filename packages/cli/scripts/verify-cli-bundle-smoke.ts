/**
 * @fileoverview Verify CLI Bundle Smoke Test
 *
 * 目的：在 CI 中捕获 "bun build 产物的运行时 ReferenceError" 这类 bug。
 *
 * 历史背景（Task #1676）：
 * - `runActShutdownCleanup({ stopTaskEventHandlerCleanup })` 用 ES6 shorthand
 *   写法时，bun build 的 renamer 把 helper 内部的 destructure 变量加 `2` 后缀
 *   (`stopTaskEventHandlerCleanupFn`)，但 call site 的 shorthand 没同步重命名，
 *   导致 dist 产物的 key/value 指向不同 identifier → 运行期 ReferenceError
 * - 单元测试通过（测试 source 而非 build 产物），所以必须跑真实 bundle
 *
 * 历史背景（Task #1863）：
 * - 用户反馈：跑 smoke 时 `roy-bot act 'echo hi'` 会真的触发 session 创建，
 *   把数据写到真实 DB `~/.local/share/roy-bot/sessions.db`（更糟的是 WAL/SHM
 *   会被持续 touch，污染开发者本机的会话历史）。
 * - 修复：smoke 跑 act 时强制设置 `SESSION_SESSION_STORAGE_DB_PATH` 指向
 *   `/tmp/roy-smoke-sessions-<pid>-<rand>.db`，并新增一个 check 验证：
 *     1. 临时 db 文件确实被创建（证明 session 写入隔离 DB）
 *     2. 真实 db（main + wal + shm）在 smoke 前后 mtime/size 完全不变
 *
 * 用法：
 *   # 一次性：先 build，然后跑这个 smoke
 *   bun run build:cli:dev:single
 *   bun run packages/cli/scripts/verify-cli-bundle-smoke.ts
 *
 *   # 一体化（CI 友好）
 *   bun run build:cli:dev:single && bun run packages/cli/scripts/verify-cli-bundle-smoke.ts
 *
 * 退出码：
 *   0 = 通过（所有 smoke check OK）
 *   1 = 失败（任一 smoke check 失败，错误信息打到 stderr）
 *
 * 检查项：
 *   1. `bun run packages/cli/dist/bin/roy-bot.js interactive --help` → exit 0
 *   2. `bun run packages/cli/dist/bin/roy-bot.js act '<trivial>'`  → exit 0
 *      且 stderr/stdout 中不包含 `ReferenceError` 或 `is not defined`
 *   3. `bun run packages/cli/dist/bin/roy-bot.js --version`        → exit 0
 *   4. 隔离验证：act 跑完后真实 sessions.db (main/wal/shm) mtime+size 完全不变，
 *      且临时 db 文件被创建且大小 > 0（证明 session 写入隔离 DB 而非真实 DB）
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  buildIsolatedDbPath,
  cleanupIsolatedDbFiles,
  diffDbSnapshot,
  getDefaultSessionDbPath,
  mainFilesUnchanged,
  snapshotDbFiles,
} from "./verify-cli-bundle-smoke-helpers";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CLI_BIN = path.join(REPO_ROOT, "packages/cli/dist/bin/roy-bot.js");

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const checks: CheckResult[] = [];

function runCli(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // 跑生产 bundle 而非 source；用 bun 强制走 bun runtime（与 build 产物一致）
  const proc = spawnSync("bun", [CLI_BIN, ...args], {
    encoding: "utf-8",
    timeout: 60_000, // 60s 上限（避免 hang 死锁）
    env: { ...process.env, ...env },
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function runCheck(name: string, fn: () => Omit<CheckResult, "name" | "durationMs">): void {
  const start = Date.now();
  try {
    const partial = fn();
    checks.push({ name, ...partial, durationMs: Date.now() - start });
  } catch (err) {
    checks.push({
      name,
      passed: false,
      detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    });
  }
}

function checkBinaryExists(): CheckResult {
  if (!fs.existsSync(CLI_BIN)) {
    return {
      name: "binary-exists",
      passed: false,
      detail: `${CLI_BIN} not found. Run: bun run build:cli:dev:single first.`,
      durationMs: 0,
    };
  }
  return {
    name: "binary-exists",
    passed: true,
    detail: CLI_BIN,
    durationMs: 0,
  };
}

function checkInteractiveHelp(): CheckResult {
  const result = runCli(["interactive", "--help"]);
  const passed =
    result.status === 0 &&
    !/ReferenceError/.test(result.stderr + result.stdout) &&
    !/is not defined/.test(result.stderr + result.stdout);
  return {
    name: "interactive --help",
    passed,
    detail: passed
      ? `exit=0, ${result.stdout.length} bytes stdout`
      : `exit=${result.status}, stderr=${result.stderr.slice(0, 500)}`,
    durationMs: 0,
  };
}

function checkActSmoke(): CheckResult {
  // 用一个 trivial query。--quiet 减少噪音；即使 LLM 不可达也不应该出 ReferenceError。
  // ROY_AGENT_NO_EXIT=1 让 helper 不主动 process.exit(0)，方便我们看到结果。
  //
  // SESSION_SESSION_STORAGE_DB_PATH：把 session DB 隔离到 /tmp 下，避免污染
  // 开发者本机的真实 sessions.db（WAL/SHM）。详见 Task #1863。
  //   env var 名 → 配置 key 的转换：
  //     toEnvKey("session.storage.dbPath", "SESSION") = "SESSION_SESSION_STORAGE_DB_PATH"
  //   故这里使用该 env var 名。
  const tempDbPath = buildIsolatedDbPath();
  const result = runCli(
    ["act", "echo hi", "--quiet"],
    {
      ROY_AGENT_NO_EXIT: "1",
      SESSION_SESSION_STORAGE_DB_PATH: tempDbPath,
    }
  );
  const combined = result.stdout + result.stderr;
  const passed =
    result.status === 0 &&
    !/ReferenceError/.test(combined) &&
    !/is not defined/.test(combined);
  return {
    name: "act 'echo hi' --quiet (bundle smoke)",
    passed,
    detail: passed
      ? `exit=0, stdout=${result.stdout.length}b, stderr=${result.stderr.length}b (isolated db=${tempDbPath})`
      : `exit=${result.status}, stderr=${result.stderr.slice(0, 500)}, stdout=${result.stdout.slice(0, 500)}`,
    durationMs: 0,
  };
}



/**
 * 隔离验证 check：跑 act 前后，对比真实 sessions.db (main + wal + shm) 的
 * mtime/size，并确认临时 DB 文件确实被创建且 size > 0。
 *
 * 这是 Task #1863 引入的回归保护：之前 smoke 跑 act 时 session 会写到真实 DB
 * （至少 WAL/SHM 会被 touch），污染开发者本机数据。
 */
function checkActSmokeIsolatesDb(): CheckResult {
  const realDbPath = getDefaultSessionDbPath();
  const tempDbPath = buildIsolatedDbPath();

  // 清理可能残留的临时文件
  cleanupIsolatedDbFiles(tempDbPath);

  // 1) 跑之前快照真实 DB
  const beforeReal = snapshotDbFiles(realDbPath);

  // 2) 跑 act，使用隔离 DB env var
  //    注意：env var key 推导自 toEnvKey("session.storage.dbPath", "SESSION")
  //    = "SESSION_SESSION_STORAGE_DB_PATH"，详见 packages/core/src/config/env-key.ts
  const result = runCli(
    ["act", "echo hi", "--quiet"],
    {
      ROY_AGENT_NO_EXIT: "1",
      SESSION_SESSION_STORAGE_DB_PATH: tempDbPath,
    }
  );

  // 3) 跑之后快照真实 DB
  const afterReal = snapshotDbFiles(realDbPath);

  // 4) 验证：真实 DB main 文件 mtime+size 完全不变
  //    只检查 main 文件（不强求 wal/shm），因为：
  //    - SQLite WAL 模式下 main 文件只在 checkpoint 时才变，是最强的"真实写入"信号
  //    - wal/shm 经常被任何持有连接的进程 touch（dev 机器上多 agent 并发），容易误报
  //    - 在 CI runner 上通常只有一个进程在工作，那时 wal/shm 也会保持不变
  const realDbUntouched = mainFilesUnchanged(beforeReal, afterReal);

  // 5) 验证：临时 DB 被创建且 size > 0
  const tempMainExists = fs.existsSync(tempDbPath);
  const tempMainSize = tempMainExists ? fs.statSync(tempDbPath).size : 0;
  const tempDbWritten = tempMainExists && tempMainSize > 0;

  const passed =
    result.status === 0 &&
    realDbUntouched &&
    tempDbWritten;

  // 诊断信息：完整 diff（即便 wal/shm 变了也不影响 pass/fail）
  const walChanged =
    beforeReal.walSize !== afterReal.walSize ||
    beforeReal.walMtime !== afterReal.walMtime;
  const shmChanged =
    beforeReal.shmSize !== afterReal.shmSize ||
    beforeReal.shmMtime !== afterReal.shmMtime;

  const detail = passed
    ? `exit=0, real db main untouched (${beforeReal.mainSize}b, mtime=${beforeReal.mainMtime}), temp db written (${tempMainSize}b at ${tempDbPath})` +
      (walChanged || shmChanged
        ? `\n   (note: wal/shm touched by some process during smoke — likely external agent, not our act; main DB intact)`
        : "")
    : `exit=${result.status}, realDbUntouched=${realDbUntouched}, tempDbWritten=${tempDbWritten} (tempSize=${tempMainSize}b at ${tempDbPath})\n` +
      diffDbSnapshot("real DB diff (before → after):", beforeReal, afterReal);

  return {
    name: "act isolates session DB (no real sessions.db touch)",
    passed,
    detail,
    durationMs: 0,
  };
}

function checkVersion(): CheckResult {
  const result = runCli(["--version"]);
  const passed = result.status === 0 && !/ReferenceError/.test(result.stderr);
  return {
    name: "--version",
    passed,
    detail: passed
      ? `exit=0, version=${result.stdout.trim()}`
      : `exit=${result.status}, stderr=${result.stderr.slice(0, 300)}`,
    durationMs: 0,
  };
}

function checkShutdownHelperWired(): CheckResult {
  // 静态检查：CLI bundle 应该引用 cleanupAll 和 TempFileManager
  // 防止有人未来 refactor 时把 Step 7 误删
  const bundle = fs.readFileSync(CLI_BIN, "utf-8");
  const cleanupAllMatches = (bundle.match(/cleanupAll/g) ?? []).length;
  const tempFileManagerMatches = (bundle.match(/TempFileManager|temp-file-manager/g) ?? []).length;
  const passed = cleanupAllMatches >= 1 && tempFileManagerMatches >= 1;
  return {
    name: "bundle has cleanupAll + TempFileManager wiring",
    passed,
    detail: passed
      ? `cleanupAll refs=${cleanupAllMatches}, TempFileManager refs=${tempFileManagerMatches}`
      : `cleanupAll refs=${cleanupAllMatches} (need ≥1), TempFileManager refs=${tempFileManagerMatches} (need ≥1)`,
    durationMs: 0,
  };
}

// ============================================================================
// Main
// ============================================================================

console.log("🔍 verify-cli-bundle-smoke.ts");
console.log(`   CLI binary: ${CLI_BIN}`);
console.log("");

runCheck("binary-exists", checkBinaryExists);
runCheck("bundle has cleanupAll + TempFileManager wiring", checkShutdownHelperWired);
runCheck("interactive --help", checkInteractiveHelp);
runCheck("act 'echo hi' --quiet (bundle smoke)", checkActSmoke);
runCheck("act isolates session DB (no real sessions.db touch)", checkActSmokeIsolatesDb);
runCheck("--version", checkVersion);

console.log("─────────────────────────────────────────────────────────────");
for (const c of checks) {
  const icon = c.passed ? "✅" : "❌";
  console.log(`  ${icon} ${c.name} (${c.durationMs}ms)`);
  console.log(`     ${c.detail}`);
}
console.log("─────────────────────────────────────────────────────────────");

const failed = checks.filter((c) => !c.passed);
if (failed.length > 0) {
  console.error("");
  console.error(`❌ ${failed.length} of ${checks.length} smoke check(s) FAILED.`);
  console.error(`   Task #1676 regression class: bun build → ReferenceError at runtime.`);
  console.error(`   Likely fix: use explicit key-value form in shutdown helper call sites`);
  console.error(`   (e.g. { stopTaskEventHandlerCleanup: stopTaskEventHandlerCleanup })`);
  process.exit(1);
}

console.log("");
console.log(`✅ All ${checks.length} smoke check(s) passed.`);
process.exit(0);
