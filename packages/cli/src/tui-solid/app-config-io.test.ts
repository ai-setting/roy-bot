/**
 * @fileoverview Task #5116 P7.1 —— app-config-io 测试。
 *
 * ⚠️ **隔离铁律**：所有用例都在 mkdtemp 临时 HOME 里跑，
 * 绝不读写真实 ~/.roy-bot（那里是生产密钥）。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readAuthProviders,
  upsertAuthProvider,
  redactApiKey,
  readModelsFromConfig,
  setDefaultModel,
} from "./app-config-io.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "p71-io-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const AUTH_DIR = () => path.join(home, ".roy-bot");
const AUTH_FILE = () => path.join(AUTH_DIR(), "auth.json");
const CONFIG_FILE = () => path.join(AUTH_DIR(), "config.jsonc");

describe("app-config-io — redactApiKey", () => {
  it("keeps only the last 4 chars", () => {
    expect(redactApiKey("sk-1234567890abcdef")).toBe("••••cdef");
  });
  it("fully masks short keys", () => {
    expect(redactApiKey("sk-1234")).toBe("••••••••");
    expect(redactApiKey("")).toBe("••••••••");
  });
});

describe("app-config-io — readAuthProviders", () => {
  it("returns an empty list when the file does not exist", async () => {
    const r = await readAuthProviders(home);
    expect(r.ok).toBe(true);
    expect(r.providers).toEqual([]);
  });

  it("lists providers with apiKey + baseURL", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      AUTH_FILE(),
      JSON.stringify({
        providers: {
          openai: { apiKey: "sk-openai-secret", baseURL: "https://api.openai.com/v1" },
          deepseek: { apiKey: "sk-deep-key", baseURL: "https://api.deepseek.com" },
        },
      }),
    );
    const r = await readAuthProviders(home);
    expect(r.ok).toBe(true);
    expect(r.providers).toHaveLength(2);
    const openai = r.providers.find((p) => p.name === "openai");
    expect(openai?.apiKey).toBe("sk-openai-secret");
    expect(openai?.baseURL).toBe("https://api.openai.com/v1");
  });

  it("tolerates a corrupt file (ok=false, no throw)", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(AUTH_FILE(), "{ not json !!!");
    const r = await readAuthProviders(home);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("tolerates a non-object file", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(AUTH_FILE(), "[1,2,3]");
    const r = await readAuthProviders(home);
    expect(r.ok).toBe(false);
  });
});

describe("app-config-io — upsertAuthProvider", () => {
  it("creates a new provider in an existing file", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      AUTH_FILE(),
      JSON.stringify({ _note: "keep me", providers: { openai: { apiKey: "a", baseURL: "b" } } }),
    );
    const r = await upsertAuthProvider(home, {
      name: "newprov",
      apiKey: "sk-new",
      baseURL: "https://x.example",
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(AUTH_FILE(), "utf-8"));
    // 未知字段保留
    expect(onDisk._note).toBe("keep me");
    expect(onDisk.providers.openai.apiKey).toBe("a");
    expect(onDisk.providers.newprov.apiKey).toBe("sk-new");
  });

  it("updates an existing provider (created=false)", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      AUTH_FILE(),
      JSON.stringify({ providers: { openai: { apiKey: "old", baseURL: "u" } } }),
    );
    const r = await upsertAuthProvider(home, { name: "openai", apiKey: "new", baseURL: "u" });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    const onDisk = JSON.parse(await fs.readFile(AUTH_FILE(), "utf-8"));
    expect(onDisk.providers.openai.apiKey).toBe("new");
  });

  it("creates the directory tree when auth.json is missing", async () => {
    const r = await upsertAuthProvider(home, { name: "fresh", apiKey: "k", baseURL: "u" });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(AUTH_FILE(), "utf-8"));
    expect(onDisk.providers.fresh).toEqual({ apiKey: "k", baseURL: "u" });
  });

  it("refuses to overwrite a corrupt file", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(AUTH_FILE(), "CORRUPT{{{");
    const r = await upsertAuthProvider(home, { name: "x", apiKey: "k", baseURL: "u" });
    expect(r.ok).toBe(false);
    expect((await fs.readFile(AUTH_FILE(), "utf-8")).startsWith("CORRUPT")).toBe(true);
  });

  it("rejects invalid provider names", async () => {
    for (const bad of ["", "a b", "../evil", "prov/.."]) {
      const r = await upsertAuthProvider(home, { name: bad, apiKey: "k", baseURL: "u" });
      expect(r.ok).toBe(false);
    }
    // 没有任何文件被创建
    await expect(fs.access(AUTH_FILE())).rejects.toBeTruthy();
  });

  it("leaves no tmp files behind (atomic write cleanup)", async () => {
    await upsertAuthProvider(home, { name: "x", apiKey: "k", baseURL: "u" });
    const entries = await fs.readdir(AUTH_DIR());
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
  });

  it("writes valid JSON that the read side parses back", async () => {
    await upsertAuthProvider(home, { name: "loop", apiKey: "k", baseURL: "u" });
    const r = await readAuthProviders(home);
    expect(r.ok).toBe(true);
    expect(r.providers.map((p) => p.name)).toContain("loop");
  });
});

describe("app-config-io — readModelsFromConfig", () => {
  it("lists models from llm.providers.{name}.models[]", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE(),
      `{
  // config with comments
  "llm": {
    "defaultModel": "m1",
    "providers": {
      "alpha": {
        "models": ["m1", "m2"],
        "defaultModel": "m2"
      },
      "beta": {
        "defaultModel": "solo"
      }
    }
  }
}`,
    );
    const r = await readModelsFromConfig(home);
    expect(r.ok).toBe(true);
    expect(r.models).toHaveLength(3);
    const alpha = r.models.filter((m) => m.provider === "alpha");
    expect(alpha.map((m) => m.model)).toEqual(["m1", "m2"]);
    // isProviderDefault 标记
    expect(alpha.find((m) => m.model === "m2")?.isProviderDefault).toBe(true);
    expect(alpha.find((m) => m.model === "m1")?.isProviderDefault).toBe(false);
    // 无 models 数组 ⇒ 用 defaultModel 单条
    // （★ P7.4：isCurrentDefault 字段新增——llm.defaultModel="m1"
    //   无 "/" 且无 defaultProvider ⇒ 无全局 default ⇒ 全 false）
    const beta = r.models.filter((m) => m.provider === "beta");
    expect(beta).toEqual([
      { provider: "beta", model: "solo", isProviderDefault: true, isCurrentDefault: false },
    ]);
  });

  it("tolerates JSONC comments", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE(),
      `{
  // comment line
  "llm": { "providers": { "p": { "models": ["x"] /* inline */ } } }
}`,
    );
    const r = await readModelsFromConfig(home);
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([
      { provider: "p", model: "x", isProviderDefault: false, isCurrentDefault: false },
    ]);
  });

  it("returns ok=false on corrupt config", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(CONFIG_FILE(), "{ bad [");
    const r = await readModelsFromConfig(home);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("app-config-io — setDefaultModel (JSONC comment-preserving write-back)", () => {
  it("rewrites defaultModel/defaultProvider and keeps comments", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    const original = `{
  // global llm block — do not lose me
  "llm": {
    //"defaultModel": "old-disabled",
    "defaultModel": "deepseek-v4.1-flash", // trailing comment stays
    "defaultProvider": "opencodego",
    "temperature": 1,
    "providers": {
      "alpha": { "models": ["deepseek-v4.1-flash"] }
    }
  }
}`;
    await fs.writeFile(CONFIG_FILE(), original);

    const r = await setDefaultModel(home, "alpha", "deepseek-v4.1-flash");
    expect(r.ok).toBe(true);

    const after = await fs.readFile(CONFIG_FILE(), "utf-8");
    // 注释保留（独立行 + 尾注释 + 注释掉的旧值行）
    expect(after).toContain("// global llm block — do not lose me");
    expect(after).toContain("// trailing comment stays");
    expect(after).toContain('//"defaultModel": "old-disabled"');
    // 值已写入（★ P7.3 F2：完整 id 格式 provider/model）
    expect(after).toContain('"defaultModel": "alpha/deepseek-v4.1-flash"');
    expect(after).toContain('"defaultProvider": "alpha"');
    // 其余字段没丢
    expect(after).toContain('"temperature": 1');
  });

  it("inserts missing defaultModel into the llm block", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE(),
      `{
  // keep
  "llm": { "temperature": 1 }
}`,
    );
    const r = await setDefaultModel(home, "p", "m");
    expect(r.ok).toBe(true);
    const after = await fs.readFile(CONFIG_FILE(), "utf-8");
    expect(after).toContain("// keep");
    expect(after).toContain('"temperature": 1');
    // 回读校验：parseJSONC 验证
    const { readModelsFromConfig } = await import("./app-config-io.js");
    const models = await readModelsFromConfig(home);
    expect(models.ok).toBe(true);
  });

  it("refuses to run on a corrupt config (no write)", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(CONFIG_FILE(), "BROKEN[[[");
    const r = await setDefaultModel(home, "p", "m");
    expect(r.ok).toBe(false);
    expect(await fs.readFile(CONFIG_FILE(), "utf-8")).toBe("BROKEN[[[");
  });

  it("round-trips: set then read sees the model present", async () => {
    await fs.mkdir(AUTH_DIR(), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE(),
      `{ "llm": { "providers": { "pp": { "models": ["one", "two"] } } } }`,
    );
    const r = await setDefaultModel(home, "pp", "two");
    expect(r.ok).toBe(true);
    // parse JSONC to confirm values
    const text = await fs.readFile(CONFIG_FILE(), "utf-8");
    const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
    // ★ P7.3 F2：完整 id 格式（首个 / 恒为 provider 段）
    expect(parsed.llm.defaultModel).toBe("pp/two");
    expect(parsed.llm.defaultProvider).toBe("pp");
  });
});
