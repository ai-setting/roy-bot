/**
 * @fileoverview Task #5129 P7.3 F1 —— config 读侧路径统一测试。
 *
 * 背景（#5125 DS review M1）：EnvironmentService 读
 * `$XDG_CONFIG_HOME/roy-bot`，app-config-io 读 `~/.roy-bot`
 * ⇒ XDG 场景下「boot 读」与「弹窗读写」指两个文件。
 * 统一：app-config-io 引入 `resolveUserConfigDir()`（与
 * environment.service.ts `getUserConfigDir()` 同语义），
 * IO 函数 homeDir 参数改为可选（未传 = 走 resolve）。
 *
 * ⚠️ 隔离铁律：XDG env 用完必删（beforeEach 设 / afterEach 清），
 * 绝不指向真实目录。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveUserConfigDir,
  readModelsFromConfig,
} from "./app-config-io.js";

const REAL_HOMEDIR = os.homedir();
let xdgDir: string;

beforeEach(async () => {
  xdgDir = await fs.mkdtemp(path.join(os.tmpdir(), "p73-xdg-"));
  process.env.XDG_CONFIG_HOME = xdgDir;
});

afterEach(async () => {
  delete process.env.XDG_CONFIG_HOME;
  await fs.rm(xdgDir, { recursive: true, force: true });
});

describe("app-config-io — resolveUserConfigDir (P7.3 F1)", () => {
  it("prefers $XDG_CONFIG_HOME/roy-bot when set", () => {
    expect(resolveUserConfigDir()).toBe(path.join(xdgDir, "roy-bot"));
  });

  it("falls back to ~/.roy-bot when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(resolveUserConfigDir()).toBe(path.join(REAL_HOMEDIR, ".roy-bot"));
  });

  it("falls back to ~/.roy-bot when XDG_CONFIG_HOME is empty string", () => {
    process.env.XDG_CONFIG_HOME = "";
    expect(resolveUserConfigDir()).toBe(path.join(REAL_HOMEDIR, ".roy-bot"));
  });

  it("explicit homeDir argument still wins (test isolation contract)", () => {
    expect(resolveUserConfigDir("/explicit/home")).toBe("/explicit/home");
  });
});

describe("app-config-io — readModelsFromConfig uses resolveUserConfigDir (P7.3 F1)", () => {
  it("reads config from $XDG_CONFIG_HOME/roy-bot when homeDir not given", async () => {
    const cfgDir = path.join(xdgDir, "roy-bot");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, "config.jsonc"),
      JSON.stringify({
        llm: {
          defaultModel: "xdg-model",
          defaultProvider: "xdg-prov",
          providers: { "xdg-prov": { models: ["xdg-model"], defaultModel: "xdg-model" } },
        },
      }),
    );
    const r = await readModelsFromConfig();
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([
      { provider: "xdg-prov", model: "xdg-model", isProviderDefault: true, isCurrentDefault: true },
    ]);
  });

  it("explicit homeDir keeps reading ~/.roy-bot layout (no XDG leak)", async () => {
    // 显式 homeDir ⇒ 仍读 <homeDir>/.roy-bot/config.jsonc
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "p73-home-"));
    try {
      await fs.mkdir(path.join(home, ".roy-bot"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".roy-bot", "config.jsonc"),
        JSON.stringify({
          llm: { providers: { p: { models: ["m1"] } } },
        }),
      );
      const r = await readModelsFromConfig(home);
      expect(r.ok).toBe(true);
      expect(r.models.some((m) => m.model === "m1")).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("app-config-io — production call shape (P7.3 M1, DS review)", () => {
  it("no-arg readModelsFromConfig reads XDG config dir directly (not ~/.roy-bot)", async () => {
    // RunScreen 生产默认链：resolveUserConfigDir() → 无参 IO 函数。
    // reviewer 实测的 bug：生产走了 os.homedir() 显式参数 → 弹窗
    // 读 ~/.roy-bot 而 boot 读 XDG。本用例锁死「无参 = XDG 配置
    // 目录本身（不再拼 .roy-bot）」这一生产形态。
    const cfgDir = path.join(xdgDir, "roy-bot");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, "config.jsonc"),
      JSON.stringify({
        llm: { providers: { p: { models: ["prod-shape-model"] } } },
      }),
    );
    // 无参 = 生产形态（RunScreen 不传 homeDir prop 时
    // 传 resolveUserConfigDir() 的返回值）
    const r = await readModelsFromConfig(resolveUserConfigDir());
    expect(r.ok).toBe(true);
    expect(r.models.some((m) => m.model === "prod-shape-model")).toBe(true);

    // 反向：显式家目录 ≠ 生产形态（仅测试注入）——XDG 下显式
    // homeDir 不会看到 XDG 配置（两个不同文件）。
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "p73-m1-"));
    try {
      const r2 = await readModelsFromConfig(fakeHome);
      expect(r2.ok).toBe(false); // fakeHome/.roy-bot/config.jsonc 不存在
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("app-config-io — no-XDG production shape (r3 review 建议)", () => {
  // ── Task #5411 修复（2026-11-12）────────────────────────────────────
  // ❌ 旧写法（事故根因，已在 17:14:36 删掉真实 ~/.roy-bot 导致
  //    auth.json / config.jsonc / event-sources.json 全丢，见 #5410）：
  //      const dir = resolveUserConfigDir();   // 无 XDG ⇒ 真实 ~/.roy-bot
  //      await fs.mkdir(dir, { recursive: true });
  //      await fs.writeFile(path.join(dir, "config.jsonc"), ...);
  //      finally { await fs.rm(dir, { recursive: true, force: true }); }  // 💀
  //    `force: true` 让破坏完全静默（测试全绿、CI 通过、生产配置消失）。
  //
  // ✅ 新写法：bun 的 os.homedir() 在**进程启动时**固定（运行期改
  //    process.env.HOME 无效 —— 已实测），所以在**子进程**里跑，用
  //    env.HOME 注入临时 home + 显式 unset XDG_CONFIG_HOME。
  //    ⇒ 真实 ~/.roy-bot 零接触，且仍然锁死「无 XDG ⇒ <home>/.roy-bot」
  //      这一被 r2 MAJOR-1 打回过的形态。
  it("no-XDG: resolveUserConfigDir() falls back to <home>/.roy-bot and IO reads it", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "p73-noxdg-home-"));
    try {
      const cfgDir = path.join(fakeHome, ".roy-bot");
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(
        path.join(cfgDir, "config.jsonc"),
        JSON.stringify({ llm: { providers: { p: { models: ["noxdg-model"] } } } }),
      );

      const scriptPath = path.join(fakeHome, "probe.ts");
      await fs.writeFile(
        scriptPath,
        [
          `import { resolveUserConfigDir, readModelsFromConfig } from ${JSON.stringify(
            path.resolve(import.meta.dir, "app-config-io.ts"),
          )};`,
          `const dir = resolveUserConfigDir();`,
          `const r = await readModelsFromConfig();`,
          `console.log("@@PROBE@@" + JSON.stringify({ dir, r }));`,
        ].join("\n"),
      );

      // 关键：把 HOME 指到临时目录，并不设 XDG_CONFIG_HOME
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (k === "XDG_CONFIG_HOME" || k === "HOME") continue;
        env[k] = v;
      }
      env.HOME = fakeHome;

      const proc = Bun.spawnSync(["bun", scriptPath], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = proc.stdout.toString();
      const line = out.split("\n").find((l) => l.startsWith("@@PROBE@@"));
      expect(line).toBeDefined();
      const probe = JSON.parse(line!.slice("@@PROBE@@".length));

      // ① resolveUserConfigDir() 回退到「子进程的 home/.roy-bot」
      expect(probe.dir).toBe(path.join(fakeHome, ".roy-bot"));
      // ② 且真的从那里读到了配置（锁死 r2 MAJOR-1 的幻影目录回归）
      expect(probe.r.ok).toBe(true);
      expect(probe.r.models.some((m: { model: string }) => m.model === "noxdg-model")).toBe(true);
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("app-config-io — 测试隔离护栏（Task #5411，#5410 事故防复发）", () => {
  it("本文件跑完后真实 ~/.roy-bot 仍存在且关键配置文件完整", async () => {
    // 事故形态：某测试 fs.rm(真实配置目录, {recursive, force})
    // ⇒ 目录整个消失，配置全丢且**完全静默**。
    // 本用例是「事后哨兵」：只要本文件任何用例碰了真实目录，这里就红。
    //
    // ⚠️ 用 process.env.HOME 而不是 os.homedir()：并行跑整目录时，
    //    RunScreen.p72-hotmodel.test.tsx / RunScreen.p73-followup.test.tsx
    //    会在模块级 mock.module("node:os", homedir: () => currentHome) 且
    //    **从不还原**（currentHome 初始为 ""）⇒ 同进程其他文件的
    //    os.homedir() 会返回空串，哨兵会假红。env.HOME 不受该 mock 影响。
    const realDir = path.join(process.env.HOME ?? REAL_HOMEDIR, ".roy-bot");
    const st = await fs.stat(realDir).catch(() => null);
    expect(st).not.toBeNull();
    expect(st!.isDirectory()).toBe(true);

    // 关键文件：存在则必须非空（不存在不算失败 —— 全新机器可能没配）
    for (const f of ["config.jsonc", "auth.json", "event-sources.json"]) {
      const p = path.join(realDir, f);
      const fst = await fs.stat(p).catch(() => null);
      if (fst !== null) {
        expect(fst.size).toBeGreaterThan(0);
      }
    }
  });
});

