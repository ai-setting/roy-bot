/**
 * @fileoverview Task #5129 P7.3 F2-followup —— 热切换持久化格式测试。
 *
 * 背景（取证实证）：P7.1 的 setDefaultModel 把 llm.defaultModel
 * 写成**裸 model**（无 provider 前缀）。单段名（fake-b）重启后
 * llm.resolveRequest 按首个 "/" 切 provider 无歧义；**多段名**
 * （OpenRouter 风格 org/model）重启后会被误切
 * （providerId="org-fake" → API key not found，实测复现）。
 *
 * 修复：setDefaultModel 写 **完整 id** `${provider}/${model}`
 * —— 与 boot config 的 defaultModel 格式一致（"fake/org-fake/model-a"
 * 首个 / 恒为 provider 段，多段模型名安全）。
 * interactive.ts 的内存层 set("llm.defaultModel") 同步改为完整 id。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setDefaultModel } from "./app-config-io.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "p73-persist-"));
  await fs.mkdir(path.join(home, ".roy-bot"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const CONFIG_FILE = () => path.join(home, ".roy-bot", "config.jsonc");

describe("app-config-io — setDefaultModel writes FULL provider/model id (P7.3 F2)", () => {
  it("persists llm.defaultModel as 'provider/model' (multi-segment safe)", async () => {
    await fs.writeFile(
      CONFIG_FILE(),
      JSON.stringify({
        llm: {
          defaultModel: "fake/org-fake/model-a",
          defaultProvider: "fake",
          providers: {
            fake: { models: ["fake/org-fake/model-a", "fake/org-fake/model-b"] },
          },
        },
      }),
    );

    const r = await setDefaultModel(home, "fake", "org-fake/model-b");
    expect(r.ok).toBe(true);

    const after = JSON.parse(await fs.readFile(CONFIG_FILE(), "utf-8"));
    // 完整 id —— 首个 "/" 恒为 provider 段
    expect(after.llm.defaultModel).toBe("fake/org-fake/model-b");
    expect(after.llm.defaultProvider).toBe("fake");
  });

  it("single-segment model also gets the prefix", async () => {
    await fs.writeFile(
      CONFIG_FILE(),
      JSON.stringify({
        llm: {
          defaultModel: "fake/fake-a",
          defaultProvider: "fake",
          providers: { fake: { models: ["fake/fake-a"] } },
        },
      }),
    );
    const r = await setDefaultModel(home, "fake", "fake-b");
    expect(r.ok).toBe(true);
    const after = JSON.parse(await fs.readFile(CONFIG_FILE(), "utf-8"));
    expect(after.llm.defaultModel).toBe("fake/fake-b");
  });
});
