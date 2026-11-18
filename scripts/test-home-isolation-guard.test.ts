/**
 * @fileoverview Task #5411 —— 测试文件「删真实配置目录」护栏（#5410 事故防复发）。
 *
 * ## 事故
 * 2026-11-12 17:14:36，`bun test packages/cli` 跑完后用户 `~/.roy-bot`
 * 整个目录消失，auth.json / config.jsonc / event-sources.json /
 * wecom-credentials* 全部丢失。根因：
 *
 *   packages/cli/src/tui-solid/app-config-io.resolve-dir.test.ts:147
 *     const dir = resolveUserConfigDir();            // 无 XDG ⇒ 真实 ~/.roy-bot
 *     await fs.writeFile(path.join(dir, "config.jsonc"), ...);
 *     finally { await fs.rm(dir, { recursive: true, force: true }); }  // 💀
 *
 * `force: true` 让破坏**完全静默**：测试全绿、CI 通过、生产配置消失。
 *
 * ## 护栏规则（本文件是「可执行的 lint」）
 * 对每个 `*.test.ts` / `*.spec.ts`，判定是否「危险拆解」：
 *   A. 存在把 **home 目录** 引入的表达式：
 *        - 无参 / 仅 env 的 `resolveUserConfigDir(...)`
 *        - 无参 `getUserConfigDir(...)`
 *        - `os.homedir()` / `homedir()`
 *        - `path.join(<上述>, ".roy-bot")`
 *      绑定到一个变量 X（或直接内联使用）；
 *   B. 且 X 被当作 `rm(` / `rmSync(` / `unlink(` 的**删除目标**；
 *   C. 且 X 的来源不带隔离（同一赋值语句里没有 `mkdtemp`）。
 * ⇒ 报错。修法：`mkdtemp` + 子进程注入 `HOME` / `XDG_CONFIG_HOME`
 *   （见 app-config-io.resolve-dir.test.ts 里的新写法）。
 *
 * 允许的安全形态（不报）：
 *   - 只做**只读断言**（`expect(resolveUserConfigDir()).toBe(...)`）
 *   - 删除目标来自 `mkdtemp(...)` 临时目录
 *   - 删除目标是显式传入的 fake home（`readModelsFromConfig(home)` 那类）
 */

import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 扫描实现
// ---------------------------------------------------------------------------

/** 一行里是否把「真实 home 配置目录」引入了。返回被绑定的变量名（内联则返回 "<inline>"）。 */
function matchHomeSource(line: string): string | null {
  const src = line;
  const homePatterns = [
    /resolveUserConfigDir\s*\(\s*\)/,
    /getUserConfigDir\s*\(\s*\)/,
    /\bos\.homedir\s*\(\s*\)/,
    /(?<![.\w])homedir\s*\(\s*\)/,
  ];
  const hitsHomeDir = homePatterns.some((p) => p.test(src));
  const hitsJoined = /\.roy-bot["'`]/.test(src);
  if (!hitsHomeDir && !hitsJoined) return null;
  // 只是注释行 → 不算（文档里会引用事故代码）
  const trimmed = src.trim();
  if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
    return null;
  }
  const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(src);
  if (assign) return assign[1];
  return "<inline>";
}

/** 删除类调用：返回该行里出现的「删除目标表达式」的候选变量名（可能多个）。 */
function matchRemovalTargets(line: string): string[] {
  const out: string[] = [];
  const trimmed = line.trim();
  if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return out;
  const calls = /(?:\.|\b)(?:rm|rmSync|unlink|unlinkSync)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = calls.exec(line)) !== null) {
    // 取第一个参数（到配对的逗号/右括号，简化处理一层嵌套）
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < line.length; i += 1) {
      const c = line[i];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) break;
    }
    const arg = line.slice(start, i);
    // 变量名候选
    for (const id of arg.match(/[A-Za-z_$][\w$]*/g) ?? []) out.push(id);
    // 内联 home 表达式
    if (/resolveUserConfigDir\s*\(\s*\)|getUserConfigDir\s*\(\s*\)|\bhomedir\s*\(\s*\)/.test(arg)) {
      out.push("<inline>");
    }
  }
  return out;
}

export interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/** 扫描一个目录下的所有测试文件，返回危险拆解清单。 */
export async function scanForUnsafeHomeTeardown(rootDir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const testFiles: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".worktrees") {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(test|spec)\.tsx?$/.test(e.name)) testFiles.push(full);
    }
  }
  await walk(rootDir);

  const SELF = path.basename(new URL(import.meta.url).pathname);
  for (const file of testFiles) {
    // 跳过护栏自身：它的 fixture 字符串就是「事故代码原文」，会被自己抓到。
    if (path.basename(file) === SELF) continue;
    const content = await fs.readFile(file, "utf-8").catch(() => "");
    if (!content) continue;
    const lines = content.split("\n");

    // 第一遍：收集「home 来源变量」→ 是否在 mkdtemp 隔离语句里
    const homeVars = new Map<string, { line: number; isolated: boolean }>();
    for (let i = 0; i < lines.length; i += 1) {
      const v = matchHomeSource(lines[i]);
      if (v === null) continue;
      const isolated = /mkdtemp/.test(lines[i]);
      if (v === "<inline>") {
        homeVars.set(`<inline>@${i}`, { line: i, isolated });
      } else if (!homeVars.has(v)) {
        homeVars.set(v, { line: i, isolated });
      }
    }
    if (homeVars.size === 0) continue;

    // 第二遍：找删除调用，看目标是否命中 home 变量
    for (let i = 0; i < lines.length; i += 1) {
      // 同一行标记 `home-guard-ignore` 可显式豁免（需在 review 里说明理由）
      if (lines[i].includes("home-guard-ignore")) continue;
      for (const target of matchRemovalTargets(lines[i])) {
        const key = target === "<inline>" ? `<inline>@${i}` : target;
        const info = homeVars.get(key);
        if (!info) continue;
        if (info.isolated) continue;
        violations.push({
          file: path.relative(rootDir, file),
          line: i + 1,
          text: lines[i].trim(),
          reason:
            `\`${target}\` 来自真实 home 配置目录（第 ${info.line + 1} 行），` +
            `却被当作删除目标。请改用 mkdtemp + 子进程注入 HOME/XDG_CONFIG_HOME。`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 护栏自测
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "..");

describe("Task #5411 — 真实 home 配置目录不得被测试删除（lint 护栏）", () => {
  it("全仓 packages/ + scripts/ 零违规", async () => {
    const [a, b] = await Promise.all([
      scanForUnsafeHomeTeardown(path.join(REPO_ROOT, "packages")),
      scanForUnsafeHomeTeardown(path.join(REPO_ROOT, "scripts")),
    ]);
    const all = [...a, ...b];
    if (all.length > 0) {
      console.error(
        "❌ 检测到「删真实 home 配置目录」的危险测试代码：\n" +
          all.map((v) => `  ${v.file}:${v.line}\n    ${v.text}\n    → ${v.reason}`).join("\n"),
      );
    }
    expect(all).toEqual([]);
  }, 60_000);

  it("护栏自证：事故形态样本必须被抓到（RED 能力）", async () => {
    const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "guard-5411-"));
    try {
      // 事故文件的最小复刻（#5410 根因原样）
      await fs.writeFile(
        path.join(tmp, "accident.test.ts"),
        [
          'import { promises as fs } from "node:fs";',
          'import * as os from "node:os";',
          'import * as path from "node:path";',
          "const REAL_HOMEDIR = os.homedir();",
          "it('no-XDG', async () => {",
          "  const dir = resolveUserConfigDir();",
          '  await fs.writeFile(path.join(dir, "config.jsonc"), "{}");',
          "  await fs.rm(dir, { recursive: true, force: true });",
          "});",
        ].join("\n"),
      );
      // 安全文件：mkdtemp 临时目录 + 只读断言
      await fs.writeFile(
        path.join(tmp, "safe.test.ts"),
        [
          'import { promises as fs } from "node:fs";',
          'import * as os from "node:os";',
          'import * as path from "node:path";',
          "it('safe', async () => {",
          '  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "x-"));',
          "  expect(resolveUserConfigDir()).toBe(path.join(os.homedir(), '.roy-bot'));",
          "  await fs.rm(tmpDir, { recursive: true, force: true });",
          "});",
        ].join("\n"),
      );

      const found = await scanForUnsafeHomeTeardown(tmp);
      // 必须且只能抓到 accident.test.ts 的 fs.rm(dir)
      expect(found.length).toBe(1);
      expect(found[0].file).toBe("accident.test.ts");
      expect(found[0].line).toBe(8);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
