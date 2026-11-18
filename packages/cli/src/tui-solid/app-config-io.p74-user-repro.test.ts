/**
 * @fileoverview Task #5138 P7.4 —— 用户真机 /model bug 复刻测试。
 *
 * 用户现场实锤（截图 /tmp/user-model-report.png + config 1-22 行）：
 *   1. `⚠ post-write mismatch: got GLM-5.3-Flash/tong`（两次）
 *   2. 状态栏 / usage 行无模型名
 *   3. /model 弹窗不高亮当前全局 default
 *
 * 用户现场 config 形态（~/.roy-bot/config.jsonc 1-22 行，只读参考）：
 *   - tab 缩进混用 + 大量注释化的 defaultModel/defaultProvider 行
 *   - llm.defaultModel = "tong/GLM-5.3-Flash"（**full id**，含 `/`）
 *   - llm.providers.tong.models = [... 裸名 "GLM-5.3-Flash"]
 *   - 部分 provider **无 models[] 只有 full-id defaultModel**
 *
 * ⚠️ 隔离铁律：config 目录经 homeDir 注入 mkdtemp 临时目录，
 *   零触碰真实 ~/.roy-bot。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readModelsFromConfig,
  setDefaultModel,
} from "./app-config-io.js";
import { parseModelDialogId } from "./dialog-state.js";

let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "p74-repro-"));
  await fs.mkdir(path.join(home, ".roy-bot"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const CONFIG_FILE = () => path.join(home, ".roy-bot", "config.jsonc");

/** 读回 config（jsonc 含注释 → 用 jsonc-parser parse）。 */
async function readCfg(): Promise<any> {
  const { parse } = await import("jsonc-parser");
  const text = await fs.readFile(CONFIG_FILE(), "utf-8");
  const errors: unknown[] = [];
  const cfg = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new Error("config corrupt after write");
  return cfg;
}

/** 用户现场复刻：tab 缩进 + 注释化 defaultModel 行 + full-id 值。 */
const USER_SHAPED_CONFIG = `{
\t"llm": {
\t\t//"defaultModel": "MiniMax-M3.1-Flash",
\t\t//"defaultProvider": "minimax",
\t\t//"defaultModel": "deepseek-v4.1-flash",
\t\t//"defaultProvider": "opencodego",
\t\t"defaultModel": "tong/GLM-5.3-Flash",
\t\t"defaultProvider": "tong",
\t\t"temperature": 1,
\t\t"maxTokens": 8192,
\t\t"topP": 1,
\t\t"stream": true,
\t\t"providers": {
\t\t   "ali": {
\t\t\t"provider": "openai-compatible",
\t\t\t"name": "qwen",
\t\t\t"models": [
\t\t\t  "qwen3-coder-plus",
\t\t\t  "qwen3.8-max-preview"
\t\t\t],
\t\t\t"defaultModel": "qwen3.8-max-preview"
\t\t   },
\t\t   "minimax": {
\t\t\t"provider": "openai-compatible",
\t\t\t"name": "MiniMax",
\t\t\t"defaultModel": "MiniMax-M3.1-Flash",
\t\t\t"temperature": 1
\t\t   },
\t\t   "tong": {
\t\t\t"provider": "openai-compatible",
\t\t\t"name": "GLM",
\t\t\t"models": [
\t\t\t  "deepseek-v4-flash-s1",
\t\t\t  "GLM-5.2-W4A8",
\t\t\t  "GLM-5.3-Flash"
\t\t\t],
\t\t\t"defaultModel": "GLM-5.2-W4A8",
\t\t\t"temperature": 0.7
\t\t   }
\t\t},
\t\t"fallbackModels": [
\t\t  "minimax/MiniMax-M3.1-Flash",
\t\t  "tong/deepseek-v4-flash-s1"
\t\t]
\t},
\t"session": {
\t\t"compactModel": "minimax/MiniMax-M3.1-Flash"
\t}
}`;

describe("app-config-io — user-shaped config (P7.4 bug1 bug3)", () => {
  beforeEach(async () => {
    await fs.writeFile(CONFIG_FILE(), USER_SHAPED_CONFIG);
  });

  it("T1 regression-lock: select-default full chain on user-shaped config writes full id, no mismatch", async () => {
    // readModelsFromConfig → item.id → parseModelDialogId → setDefaultModel
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);

    const entry = read.models.find(
      (m) => m.provider === "tong" && m.model === "GLM-5.3-Flash",
    );
    expect(entry).toBeDefined();
    const itemId = `${entry!.provider}/${entry!.model}`;

    const parsed = parseModelDialogId(itemId);
    expect(parsed).toEqual({ provider: "tong", model: "GLM-5.3-Flash" });

    const r = await setDefaultModel(home, parsed!.provider, parsed!.model);
    expect(r.ok).toBe(true); // ← 用户现场这行报了 mismatch

    const after = await readCfg();
    expect(after.llm.defaultModel).toBe("tong/GLM-5.3-Flash");
    expect(after.llm.defaultProvider).toBe("tong");
    // 注释化的历史 defaultModel 行必须保留
    const text = await fs.readFile(CONFIG_FILE(), "utf-8");
    expect(text).toContain("//\"defaultModel\": \"MiniMax-M3.1-Flash\"");
    // tab 缩进形态保留（首行 llm 仍是 tab 缩进）
    expect(text).toContain('\t"llm": {');
  });

  it("T2 RED: full-id provider defaultModel must not double-prefix the dialog item id", async () => {
    // ⚠️ DS review r2 M1（本条原为假防御）：fallback 分支（provider 无
    //   models[] 只有 defaultModel）若 defaultModel 是 **full id**
    //   （"minimax/MiniMax-M3.1-Flash"），旧实现原样落库 ⇒
    //   RunScreen item.id = "minimax/minimax/MiniMax-M3.1-Flash"（双前缀）
    //   → parseModelDialogId → model="minimax/MiniMax-M3.1-Flash"
    //   → setDefaultModel 写 "minimax/minimax/MiniMax-M3.1-Flash" 进 config
    //   （用户 bug1 的同类形态仍可复现）。
    // 期望：fallback 分支剥离自身 provider 前缀 ⇒ model 为裸名。
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "tong/GLM-5.3-Flash",
\t\t"defaultProvider": "tong",
\t\t"providers": {
\t\t   "tong": { "models": ["GLM-5.3-Flash"], "defaultModel": "GLM-5.2-W4A8" },
\t\t   "minimax": { "defaultModel": "minimax/MiniMax-M3.1-Flash" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const mm = read.models.find((m) => m.provider === "minimax");
    expect(mm).toBeDefined();
    // model 字段必须是裸名（无自身 provider 前缀）
    expect(mm!.model).toBe("MiniMax-M3.1-Flash");

    // 全链防御：item.id → parse → setDefault 后 config 值无双前缀
    const itemId = `${mm!.provider}/${mm!.model}`;
    const parsed = parseModelDialogId(itemId);
    const r = await setDefaultModel(home, parsed!.provider, parsed!.model);
    expect(r.ok).toBe(true);
    const after = await readCfg();
    expect(after.llm.defaultModel).toBe("minimax/MiniMax-M3.1-Flash");
    expect(after.llm.defaultModel.startsWith("minimax/minimax/")).toBe(false);
  });

  it("T3 RED: entries expose current global default (llm.defaultModel)", async () => {
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    // 全局 default = "tong/GLM-5.3-Flash"；tong.models 裸名 "GLM-5.3-Flash"
    // 与它匹配（provider 段 + model 段）→ 该条目应标记 isCurrentDefault
    const entry = read.models.find(
      (m) => m.provider === "tong" && m.model === "GLM-5.3-Flash",
    );
    expect(entry?.isCurrentDefault).toBe(true);
    // 其它条目不应标记
    const other = read.models.find(
      (m) => m.provider === "tong" && m.model === "GLM-5.2-W4A8",
    );
    expect(other?.isCurrentDefault).toBeFalsy();
    // provider 级 default（ali→qwen3.8-max-preview）不是全局 default
    const ali = read.models.find(
      (m) => m.provider === "ali" && m.model === "qwen3.8-max-preview",
    );
    expect(ali?.isProviderDefault).toBe(true);
    expect(ali?.isCurrentDefault).toBeFalsy();
  });

  it("T4 RED: models[] entries written as full id are normalised too (DS r3 MINOR-1)", async () => {
    // models[] 分支与 fallback 分支同源：models 里写 full id 时，
    // 不剥离 ⇒ item.id 双前缀 ⇒ 写回双前缀 + 高亮恒失效。
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "minimax/MiniMax-M3.1-Flash",
\t\t"defaultProvider": "minimax",
\t\t"providers": {
\t\t   "minimax": { "models": ["minimax/MiniMax-M3.1-Flash"], "defaultModel": "minimax/MiniMax-M3.1-Flash" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const mm = read.models.find((m) => m.provider === "minimax");
    expect(mm!.model).toBe("MiniMax-M3.1-Flash");
    // 全局 default 也是 full id ⇒ 归一化后应命中高亮
    expect(mm!.isCurrentDefault).toBe(true);

    const itemId = `${mm!.provider}/${mm!.model}`;
    const parsed = parseModelDialogId(itemId);
    const r = await setDefaultModel(home, parsed!.provider, parsed!.model);
    expect(r.ok).toBe(true);
    const after = await readCfg();
    expect(after.llm.defaultModel).toBe("minimax/MiniMax-M3.1-Flash");
  });

  it("T5 RED: multi-segment model name matches its provider (DS r3 MINOR-2)", async () => {
    // "openrouter/org/model" → provider=openrouter、model="org/model"
    // ⇒ models[] 里写 "org/model" 时应精确命中高亮。
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "openrouter/org/model",
\t\t"defaultProvider": "openrouter",
\t\t"providers": {
\t\t   "openrouter": { "models": ["org/model", "org/other"], "defaultModel": "org/other" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const hit = read.models.find((m) => m.model === "org/model");
    expect(hit?.provider).toBe("openrouter");
    expect(hit?.isCurrentDefault).toBe(true);
    const miss = read.models.find((m) => m.model === "org/other");
    expect(miss?.isCurrentDefault).toBeFalsy();
  });

  it("T6 RED: bare defaultModel + defaultProvider falls back to that provider (DS r3 MINOR-3)", async () => {
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "solo",
\t\t"defaultProvider": "p",
\t\t"providers": {
\t\t   "p": { "models": ["solo", "other"], "defaultModel": "other" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const solo = read.models.find((m) => m.model === "solo");
    expect(solo?.isCurrentDefault).toBe(true);
    // provider 级 default 不是全局 default
    const other = read.models.find((m) => m.model === "other");
    expect(other?.isProviderDefault).toBe(true);
    expect(other?.isCurrentDefault).toBeFalsy();
  });

  it("T7 RED: provider default written as full id still marks the bare entry (DS r4 MINOR-1)", async () => {
    // providers.x = { models: ["MiniMax-M3.1-Flash"], defaultModel: "x/MiniMax-M3.1-Flash" }
    // ⇒ 原值比较 e.defaultModel === m 为 false ⇒ provider default badge 丢失（假阴性）。
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "x/MiniMax-M3.1-Flash",
\t\t"defaultProvider": "x",
\t\t"providers": {
\t\t   "x": { "models": ["MiniMax-M3.1-Flash"], "defaultModel": "x/MiniMax-M3.1-Flash" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const entry = read.models.find((m) => m.provider === "x");
    expect(entry?.model).toBe("MiniMax-M3.1-Flash");
    expect(entry?.isProviderDefault).toBe(true);
  });

  it("T8 RED: a foreign provider prefix is preserved so the write-back is idempotent (DS r4 MINOR-3)", async () => {
    // providers.tong.models = ["minimax/MiniMax-M3.1-Flash"] —— 前缀是**别的**
    // provider ⇒ 不剥离 ⇒ model 保持原值 ⇒ 写回不变形（round-trip 幂等）。
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "tong/GLM-5.3-Flash",
\t\t"defaultProvider": "tong",
\t\t"providers": {
\t\t   "tong": { "models": ["minimax/MiniMax-M3.1-Flash", "GLM-5.3-Flash"], "defaultModel": "GLM-5.3-Flash" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const foreign = read.models.find((m) => m.model === "minimax/MiniMax-M3.1-Flash");
    expect(foreign).toBeDefined();
    // 自身前缀不匹配 ⇒ 原样保留
    expect(foreign!.model).toBe("minimax/MiniMax-M3.1-Flash");
  });

  it("T9 RED: bare and full-id spellings of the same model collapse to one entry (DS r4 MINOR-2)", async () => {
    await fs.writeFile(
      CONFIG_FILE(),
      `{
\t"llm": {
\t\t"defaultModel": "tong/GLM-5.3-Flash",
\t\t"defaultProvider": "tong",
\t\t"providers": {
\t\t   "tong": { "models": ["GLM-5.3-Flash", "tong/GLM-5.3-Flash"], "defaultModel": "GLM-5.3-Flash" }
\t\t}
\t}
}`,
    );
    const read = await readModelsFromConfig(home);
    expect(read.ok).toBe(true);
    const tong = read.models.filter((m) => m.provider === "tong");
    expect(tong).toHaveLength(1);
    expect(tong[0].model).toBe("GLM-5.3-Flash");
  });
});
