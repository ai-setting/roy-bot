import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { EnvSource } from "./env-source";

describe("EnvSource", () => {
  // 保存原始环境变量
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 重置环境变量
    process.env = { ...originalEnv };
    // 删除测试相关变量
    delete process.env.TEST_VAR;
    delete process.env.NESTED_VAR;
    delete process.env["USER.PROFILE.NAME"];
    delete process.env.PREFIX_TEST_ONE;
    delete process.env.PREFIX_TEST_TWO;
  });

  afterEach(() => {
    // 恢复原始环境变量
    process.env = originalEnv;
  });

  test("read returns undefined for non-existent key", () => {
    const source = new EnvSource();
    const value = source.read("NON_EXISTENT_VAR");
    expect(value).toBeUndefined();
  });

  test("read returns value from environment variable", () => {
    process.env.TEST_VAR = "hello world";
    
    const source = new EnvSource();
    expect(source.read("TEST_VAR")).toBe("hello world");
  });

  test("read converts key to uppercase", () => {
    process.env.TEST_VAR = "value";
    
    const source = new EnvSource();
    expect(source.read("test_var")).toBe("value");
    expect(source.read("TEST_VAR")).toBe("value");
  });

  test("read supports prefix matching", () => {
    process.env.MY_APP_DEBUG = "true";
    process.env.MY_APP_PORT = "8080";
    process.env.OTHER_VAR = "ignored";
    
    const source = new EnvSource({ prefix: "MY_APP_" });
    expect(source.read("DEBUG")).toBe("true");
    expect(source.read("PORT")).toBe("8080");
    expect(source.read("OTHER_VAR")).toBeUndefined();
  });

  test("read returns original key if prefix doesn't match", () => {
    process.env.MY_APP_DEBUG = "true";
    
    const source = new EnvSource({ prefix: "OTHER_" });
    expect(source.read("DEBUG")).toBeUndefined();
    expect(source.read("MY_APP_DEBUG")).toBeUndefined();
  });

  test("read returns string value by default", () => {
    process.env.TEST_STRING = "hello";
    process.env.TEST_NUMBER = "42";
    
    const source = new EnvSource();
    expect(source.read("TEST_STRING")).toBe("hello");
    expect(source.read("TEST_NUMBER")).toBe("42");
  });

  test("read applies transform function", () => {
    process.env.TEST_BOOL = "true";
    process.env.TEST_NUM = "42";
    
    const source = new EnvSource({
      transform: (value, key) => {
        if (key.endsWith("_BOOL")) return value === "true";
        if (key.endsWith("_NUM")) return parseInt(value, 10);
        return value;
      },
    });
    
    expect(source.read("TEST_BOOL")).toBe(true);
    expect(source.read("TEST_NUM")).toBe(42);
  });

  test("write sets environment variable", () => {
    const source = new EnvSource();
    const result = source.write("TEST_VAR", "new value");
    expect(result).toBe(true);
    expect(process.env.TEST_VAR).toBe("new value");
  });

  test("write applies prefix", () => {
    const source = new EnvSource({ prefix: "APP_" });
    source.write("DEBUG", "true");
    expect(process.env.APP_DEBUG).toBe("true");
  });

  test("write applies transform function", () => {
    const source = new EnvSource({
      transform: (value) => String(value),
    });
    source.write("TEST_NUM", 42);
    expect(process.env.TEST_NUM).toBe("42");
  });

  test("write converts key to uppercase", () => {
    const source = new EnvSource();
    source.write("test_var", "value");
    expect(process.env.TEST_VAR).toBe("value");
  });

  test("delete removes environment variable", () => {
    process.env.TEST_VAR = "value";
    
    const source = new EnvSource();
    const result = source.delete("TEST_VAR");
    expect(result).toBe(true);
    expect(process.env.TEST_VAR).toBeUndefined();
  });

  test("delete returns false for non-existent key", () => {
    const source = new EnvSource();
    const result = source.delete("NON_EXISTENT");
    expect(result).toBe(false);
  });

  test("delete applies prefix", () => {
    process.env.APP_TEST = "value";
    
    const source = new EnvSource({ prefix: "APP_" });
    const result = source.delete("TEST");
    expect(result).toBe(true);
    expect(process.env.APP_TEST).toBeUndefined();
  });

  test("list returns all environment variables", () => {
    process.env.TEST_ONE = "1";
    process.env.TEST_TWO = "2";
    process.env.OTHER = "3";
    
    const source = new EnvSource();
    const entries = source.list();
    
    const testEntries = entries.filter((e) => e.key.startsWith("TEST_"));
    expect(testEntries).toContainEqual({ key: "TEST_ONE", value: "1" });
    expect(testEntries).toContainEqual({ key: "TEST_TWO", value: "2" });
  });

  test("list applies prefix filter", () => {
    process.env.MY_APP_DEBUG = "true";
    process.env.MY_APP_PORT = "8080";
    process.env.OTHER_VAR = "ignored";
    
    const source = new EnvSource({ prefix: "MY_APP_" });
    const entries = source.list();
    
    expect(entries).toContainEqual({ key: "DEBUG", value: "true" });
    expect(entries).toContainEqual({ key: "PORT", value: "8080" });
    expect(entries).not.toContainEqual(
      expect.objectContaining({ key: "OTHER_VAR" })
    );
  });

  test("list removes prefix from keys", () => {
    process.env.APP_DEBUG = "true";
    
    const source = new EnvSource({ prefix: "APP_" });
    const entries = source.list();
    
    expect(entries).toContainEqual({ key: "DEBUG", value: "true" });
    expect(entries).not.toContainEqual(
      expect.objectContaining({ key: "APP_DEBUG" })
    );
  });

  test("watch monitors environment changes", async () => {
    const source = new EnvSource({ pollInterval: 50 });
    const events: any[] = [];
    
    const unwatch = source.watch((event) => {
      events.push(event);
    });
    
    // 等待 watcher 初始化
    await new Promise((r) => setTimeout(r, 100));
    
    // 修改环境变量
    process.env.TEST_VAR = "changed";
    
    // 等待事件触发（需要轮询间隔）
    await new Promise((r) => setTimeout(r, 150));
    
    unwatch();
    
    expect(events.length).toBeGreaterThan(0);
  });

  test("watch returns unsubscribe function", async () => {
    const source = new EnvSource({ pollInterval: 50 });
    let called = false;
    const wrappedCallback = (event: any) => { called = true; };
    
    const unwatch = source.watch(wrappedCallback);
    
    // 等待 watcher 初始化
    await new Promise((r) => setTimeout(r, 100));
    
    unwatch();
    
    process.env.TEST_VAR = "changed";
    
    // 等待事件触发（需要轮询间隔）
    await new Promise((r) => setTimeout(r, 150));
    
    expect(called).toBe(false);
  });

  test("has correct name and priority", () => {
    const source = new EnvSource();
    expect(source.name).toBe("env");
    expect(source.priority).toBe(20);
  });

  test("default priority is higher than file source", () => {
    const envSource = new EnvSource();
    expect(envSource.priority).toBe(20);
  });

  test("transform receives key and value", () => {
    process.env.TEST_VAR = "original";

    let receivedKey = "";
    let receivedValue = "";

    const source = new EnvSource({
      transform: (value, key) => {
        receivedKey = key;
        receivedValue = value;
        return value.toUpperCase();
      },
    });

    const result = source.read("TEST_VAR");
    expect(result).toBe("ORIGINAL");
    expect(receivedKey).toBe("TEST_VAR");
    expect(receivedValue).toBe("original");
  });
});

/**
 * Bug #2186 Bug 2 RED tests: env var typo should not be silently ignored
 *
 * Root cause: When user writes e.g. `LLM_DEAFAULT_PROVIDER=typo`,
 * envKeyToConfigKey still resolves it to a (typo'd) config key like
 * `llm.deafault.provider`, so it's silently added to configComponent.
 * The LLM code reads `llm.defaultProvider` (camelCase) and never sees the typo.
 *
 * Fix direction: EnvSource gains a `validateUnrecognizedEnvVars()` method that
 * iterates process.env, reverse-maps via envKeyToConfigKey, and warns about
 * any envKey whose resolved configKey is not in `knownKeys`.
 */
describe("EnvSource: Bug #2186 Bug 2 (warn about unrecognized env vars)", () => {
  beforeEach(() => {
    delete process.env["LLM_BOGUS_KEY"];
    delete process.env["LLM_DEAFAULT_PROVIDER"];
    delete process.env["LLM_DEFAULT_PROVIDER"];
    delete process.env["LLM_PROVIDERS_OPENAI_API_KEY"];
  });

  test("Bug2 RED: validateUnrecognizedEnvVars logs warning for typo'd env var", () => {
    process.env["LLM_BOGUS_KEY"] = "foo";

    const warnings: string[] = [];
    const source = new EnvSource({ prefix: "LLM" });

    const result = source.validateUnrecognizedEnvVars({
      componentName: "llm",
      knownKeys: new Set([
        "llm.defaultProvider",
        "llm.providers",
      ]),
      logger: { warn: (msg: string) => warnings.push(msg) },
    });

    // LLM_BOGUS_KEY resolves to llm.bogus.key via envKeyToConfigKey
    // which is NOT in knownKeys, so it should be flagged
    expect(result).toContain("LLM_BOGUS_KEY");
    expect(warnings.some(w => w.includes("LLM_BOGUS_KEY"))).toBe(true);
  });

  test("Bug2 RED: validateUnrecognizedEnvVars does NOT warn for known keys", () => {
    process.env["LLM_DEFAULT_PROVIDER"] = "openai";           // → llm.default.provider
    process.env["LLM_PROVIDERS_OPENAI_API_KEY"] = "sk-xxx";   // → llm.providers.openai.api.key

    const warnings: string[] = [];
    const source = new EnvSource({ prefix: "LLM" });

    const result = source.validateUnrecognizedEnvVars({
      componentName: "llm",
      knownKeys: new Set([
        "llm.default",              // covers llm.default.* (incl. .provider, .provider.*)
        "llm.providers",            // covers llm.providers.*
      ]),
      logger: { warn: (msg: string) => warnings.push(msg) },
    });

    expect(result).not.toContain("LLM_DEFAULT_PROVIDER");
    expect(result).not.toContain("LLM_PROVIDERS_OPENAI_API_KEY");
    expect(warnings.length).toBe(0);
  });

  test("Bug2 RED: validateUnrecognizedEnvVars skips env vars not matching prefix", () => {
    process.env["NOT_LLM_VAR"] = "ignored";
    process.env["ANOTHER_BOGUS"] = "should-be-ignored";

    const warnings: string[] = [];
    const source = new EnvSource({ prefix: "LLM" });

    const result = source.validateUnrecognizedEnvVars({
      componentName: "llm",
      knownKeys: new Set(),
      logger: { warn: (msg: string) => warnings.push(msg) },
    });

    expect(warnings.length).toBe(0);
    expect(result).toEqual([]);
  });

  test("Bug2 RED: validateUnrecognizedEnvVars is safe when knownKeys is empty (no false positives)", () => {
    // Edge case: empty knownKeys → no warning should fire for typos
    // (caller's responsibility to provide known keys)
    process.env["LLM_DEFAULT_PROVIDER"] = "openai";

    const warnings: string[] = [];
    const source = new EnvSource({ prefix: "LLM" });

    const result = source.validateUnrecognizedEnvVars({
      componentName: "llm",
      knownKeys: new Set(),
      logger: { warn: (msg: string) => warnings.push(msg) },
    });

    expect(warnings.length).toBe(0);
  });
});
