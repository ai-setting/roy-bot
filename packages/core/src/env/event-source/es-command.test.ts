/**
 * @fileoverview Task #5302 — `es` command 测试
 *
 * `##command##: es <sub>` 管理 event-sources.json：
 *   - es list                列出事件源
 *   - es add <name> <type>   新增（enabled=true）
 *   - es del <name|id>       删除
 *   - es mod <name|id> k=v   修改字段（enabled/name/interval/cron/profile）
 *
 * 文件路径从 ctx.configPath（config.jsonc）同目录推导 event-sources.json。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CommandRegistry,
  getGlobalCommandRegistry,
  handleCommandMessage,
} from "./command-registry";
import { esCommand } from "./es-command";

let tmpDir: string;
let configPath: string;
let esFile: string;

function readEsFile(): { version: string; sources: any[] } {
  const text = fs.readFileSync(esFile, "utf-8");
  return JSON.parse(text);
}

function writeEsFile(sources: any[]): void {
  fs.mkdirSync(path.dirname(esFile), { recursive: true });
  fs.writeFileSync(
    esFile,
    JSON.stringify({ version: "1.0.0", sources }, null, 2),
    "utf-8"
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "es-cmd-5302-"));
  configPath = path.join(tmpDir, "config.jsonc");
  esFile = path.join(tmpDir, "event-sources.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRegistry(): CommandRegistry {
  const r = new CommandRegistry();
  r.register(esCommand);
  return r;
}

describe("es command (Task #5302)", () => {
  test("esCommand 定义完整（name/usage/execute）", () => {
    expect(esCommand.name).toBe("es");
    expect(esCommand.usage).toContain("es");
    expect(typeof esCommand.execute).toBe("function");
  });

  test("list：空文件（不存在）→ ok，提示无事件源", async () => {
    const r = makeRegistry();
    const res = await r.dispatch("es", ["list"], { configPath, rawText: "" });
    expect(res.ok).toBe(true);
    expect(res.output?.text).toBeTruthy();
    expect(res.output?.card).toBeTruthy(); // 双形态
  });

  test("list：有源 → 文本含 name/type/enabled", async () => {
    writeEsFile([
      {
        id: "src-1",
        name: "lark-main",
        type: "lark-cli",
        enabled: true,
      },
    ]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["list"], { configPath, rawText: "" });
    expect(res.ok).toBe(true);
    expect(res.output!.text).toContain("lark-main");
    expect(res.output!.text).toContain("lark-cli");
  });

  test("add：新增源并持久化（enabled=true）", async () => {
    const r = makeRegistry();
    const res = await r.dispatch("es", ["add", "wecom-x", "wecom-cli"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(true);
    const data = readEsFile();
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].name).toBe("wecom-x");
    expect(data.sources[0].type).toBe("wecom-cli");
    expect(data.sources[0].enabled).toBe(true);
    expect(data.sources[0].id).toBeTruthy();
  });

  test("add：重名 → 失败且不重复写入", async () => {
    writeEsFile([
      { id: "a", name: "dup", type: "lark-cli", enabled: true },
    ]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["add", "dup", "timer"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(false);
    expect(readEsFile().sources).toHaveLength(1);
  });

  test("add：缺参数 → 失败并带用法", async () => {
    const r = makeRegistry();
    const res = await r.dispatch("es", ["add"], { configPath, rawText: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("es add");
  });

  test("del：按 name 删除", async () => {
    writeEsFile([
      { id: "a", name: "gone", type: "lark-cli", enabled: true },
      { id: "b", name: "keep", type: "timer", enabled: true },
    ]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["del", "gone"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(true);
    const names = readEsFile().sources.map((s: any) => s.name);
    expect(names).toEqual(["keep"]);
  });

  test("del：未知名 → 失败", async () => {
    writeEsFile([{ id: "a", name: "x", type: "lark-cli", enabled: true }]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["del", "nope"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(false);
  });

  test("mod：enabled=false 生效", async () => {
    writeEsFile([{ id: "a", name: "x", type: "lark-cli", enabled: true }]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["mod", "x", "enabled=false"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(true);
    expect(readEsFile().sources[0].enabled).toBe(false);
  });

  test("mod：未知字段 → 失败", async () => {
    writeEsFile([{ id: "a", name: "x", type: "lark-cli", enabled: true }]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["mod", "x", "bogus=1"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(false);
  });

  test("mod：未知源 → 失败", async () => {
    const r = makeRegistry();
    writeEsFile([]);
    const res = await r.dispatch("es", ["mod", "nope", "enabled=false"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(false);
  });

  test("未知子命令 → 失败并带用法", async () => {
    const r = makeRegistry();
    const res = await r.dispatch("es", ["bogus"], { configPath, rawText: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("es");
  });

  test("飞书路径：##command##: es list 走 handleCommandMessage 分发", async () => {
    writeEsFile([
      { id: "a", name: "lark-main", type: "lark-cli", enabled: true },
    ]);
    const res = await handleCommandMessage("##command##: es list", {
      configPath,
    });
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
    expect(res!.output!.text).toContain("lark-main");
  });

  test("es 命令已注册进全局注册表", () => {
    // 触发全局注册表初始化
    expect(getGlobalCommandRegistry().has("es")).toBe(true);
  });
});

// ============================================================================
// ★ Task #5302 DS review 修复（MAJOR-1/2 + MINOR-3/4/6）
// ============================================================================

describe("DS review 修复", () => {
  test("MAJOR-1：mod 拒绝 command/url 字段（不可注入命令面）", async () => {
    writeEsFile([{ id: "a", name: "x", type: "lark-cli", enabled: true }]);
    const r = makeRegistry();
    for (const field of ["command", "url"]) {
      const res = await r.dispatch("es", ["mod", "x", `${field}=rm -rf /`], {
        configPath,
        rawText: "",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain(field);
    }
    // 磁盘未被污染
    expect(readEsFile().sources[0].command).toBeUndefined();
    expect(readEsFile().sources[0].url).toBeUndefined();
  });

  test("MAJOR-2：损坏的 event-sources.json → ok:false 而非抛异常", async () => {
    fs.mkdirSync(path.dirname(esFile), { recursive: true });
    fs.writeFileSync(esFile, "{ this is not json", "utf-8");
    const r = makeRegistry();
    const res = await r.dispatch("es", ["list"], { configPath, rawText: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  test("MAJOR-2：写失败 → ok:false 而非抛异常（root 下也稳定）", async () => {
    // 不用 chmod（root 下无效）：把目标「目录」位置占成一个文件 →
    // mkdirSync/writeFileSync 必定失败，与运行用户无关。
    const blockedDir = path.join(tmpDir, "blocked");
    fs.writeFileSync(blockedDir, "i am a file", "utf-8");
    const r = makeRegistry();
    const res = await r.dispatch("es", ["add", "n", "timer"], {
      configPath: path.join(blockedDir, "config.jsonc"),
      rawText: "",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  test("MINOR-4：mod 改 name 为已存在的名字 → 拒绝（防重名歧义）", async () => {
    writeEsFile([
      { id: "a", name: "one", type: "lark-cli", enabled: true },
      { id: "b", name: "two", type: "timer", enabled: true },
    ]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["mod", "one", "name=two"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(false);
    const names = readEsFile().sources.map((s: any) => s.name);
    expect(names).toEqual(["one", "two"]);
  });

  test("MINOR-6：enabled 强制布尔化（enabled=1 不写成 number 1）", async () => {
    writeEsFile([{ id: "a", name: "x", type: "lark-cli", enabled: true }]);
    const r = makeRegistry();
    const res = await r.dispatch("es", ["mod", "x", "enabled=1"], {
      configPath,
      rawText: "",
    });
    expect(res.ok).toBe(true);
    expect(typeof readEsFile().sources[0].enabled).toBe("boolean");
    expect(readEsFile().sources[0].enabled).toBe(true);
  });

  test("MINOR-6：enabled=0 / enabled=no → false", async () => {
    writeEsFile([{ id: "a", name: "x", type: "lark-cli", enabled: true }]);
    const r = makeRegistry();
    await r.dispatch("es", ["mod", "x", "enabled=0"], { configPath, rawText: "" });
    expect(readEsFile().sources[0].enabled).toBe(false);
  });

  test("MINOR-3：写文件用 temp+rename（无残留 .tmp）", async () => {
    const r = makeRegistry();
    await r.dispatch("es", ["add", "z", "timer"], { configPath, rawText: "" });
    const leftovers = fs
      .readdirSync(path.dirname(esFile))
      .filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
