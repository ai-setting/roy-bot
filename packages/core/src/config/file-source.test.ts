import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { FileSource } from "./file-source";

describe("FileSource", () => {
  const testDir = path.join(__dirname, ".test-file-source");
  const testFile = path.join(testDir, "config.json");

  beforeEach(async () => {
    // 创建测试目录
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // 清理测试目录
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("read returns undefined for non-existent key", async () => {
    const source = new FileSource(testFile);
    const value = source.read("nonExistent");
    expect(value).toBeUndefined();
  });

  test("read loads value from JSON file", async () => {
    // 初始化文件
    await fs.writeFile(testFile, JSON.stringify({ name: "roy", age: 30 }), "utf-8");

    const source = new FileSource(testFile);
    expect(source.read("name")).toBe("roy");
    expect(source.read("age")).toBe(30);
  });

  test("read returns nested value using dot notation", async () => {
    await fs.writeFile(
      testFile,
      JSON.stringify({ user: { profile: { name: "alice" } } }),
      "utf-8"
    );

    const source = new FileSource(testFile);
    expect(source.read("user.profile.name")).toBe("alice");
  });

  test("write saves value to JSON file", async () => {
    const source = new FileSource(testFile);
    const result = source.write("name", "roy");
    expect(result).toBe(true);

    // 等待防抖延迟完成
    await new Promise((r) => setTimeout(r, 150));

    const content = await fs.readFile(testFile, "utf-8");
    const data = JSON.parse(content);
    expect(data.name).toBe("roy");
  });

  test("write updates existing value", async () => {
    await fs.writeFile(testFile, JSON.stringify({ name: "old" }), "utf-8");

    const source = new FileSource(testFile);
    source.write("name", "new");

    // 等待防抖延迟完成
    await new Promise((r) => setTimeout(r, 150));

    const content = await fs.readFile(testFile, "utf-8");
    const data = JSON.parse(content);
    expect(data.name).toBe("new");
  });

  test("write creates nested structure for dot notation keys", async () => {
    const source = new FileSource(testFile);
    source.write("user.profile.name", "bob");

    // 等待防抖延迟完成
    await new Promise((r) => setTimeout(r, 150));

    const content = await fs.readFile(testFile, "utf-8");
    const data = JSON.parse(content);
    expect(data.user.profile.name).toBe("bob");
  });

  test("list returns all key-value pairs", async () => {
    await fs.writeFile(testFile, JSON.stringify({ name: "roy", age: 30, active: true }), "utf-8");

    const source = new FileSource(testFile);
    const entries = source.list();

    expect(entries).toContainEqual({ key: "name", value: "roy" });
    expect(entries).toContainEqual({ key: "age", value: 30 });
    expect(entries).toContainEqual({ key: "active", value: true });
  });

  test("list returns flattened nested structure", async () => {
    await fs.writeFile(
      testFile,
      JSON.stringify({ user: { name: "roy", age: 30 } }),
      "utf-8"
    );

    const source = new FileSource(testFile);
    const entries = source.list();

    expect(entries).toContainEqual({ key: "user.name", value: "roy" });
    expect(entries).toContainEqual({ key: "user.age", value: 30 });
  });

  test("watch monitors file changes", async () => {
    await fs.writeFile(testFile, JSON.stringify({ name: "roy" }), "utf-8");

    const source = new FileSource(testFile);
    const events: any[] = [];

    const unwatch = source.watch((event) => {
      events.push(event);
    });

    // 等待 watcher 启动并稳定
    await new Promise((r) => setTimeout(r, 200));

    // 修改文件（部分 fs 实现先触发 change 再触发 rename）
    await fs.writeFile(testFile, JSON.stringify({ name: "alice" }), "utf-8");

    // 给 watcher 足够的时间触发 + reload 50ms 防抖
    await new Promise((r) => setTimeout(r, 500));

    unwatch();

    expect(events.length).toBeGreaterThan(0);
  });

  test("watch returns unsubscribe function", async () => {
    const source = new FileSource(testFile);
    const callback = vi.fn();

    const unwatch = source.watch(callback);
    unwatch();

    await fs.writeFile(testFile, JSON.stringify({ name: "changed" }), "utf-8");
    await new Promise((r) => setTimeout(r, 200));

    expect(callback).not.toHaveBeenCalled();
  });

  test("has correct name and priority", () => {
    const source = new FileSource(testFile);
    expect(source.name).toBe("file");
    expect(source.priority).toBe(10);
  });

  test("delete removes key from file", async () => {
    await fs.writeFile(testFile, JSON.stringify({ name: "roy", age: 30 }), "utf-8");

    const source = new FileSource(testFile);
    const result = source.delete("name");
    expect(result).toBe(true);

    // 等待防抖延迟完成
    await new Promise((r) => setTimeout(r, 150));

    const content = await fs.readFile(testFile, "utf-8");
    const data = JSON.parse(content);
    expect(data.name).toBeUndefined();
    expect(data.age).toBe(30);
  });

  test("delete returns false for non-existent key", async () => {
    await fs.writeFile(testFile, JSON.stringify({ name: "roy" }), "utf-8");

    const source = new FileSource(testFile);
    const result = source.delete("nonExistent");
    expect(result).toBe(false);
  });

  test("should parse JSONC file with single-line comments", async () => {
    const jsoncFile = path.join(testDir, "config.jsonc");
    const content = `{
      // API Configuration
      "apiKey": "test-key",
      "model": "gpt-4o"
    }`;
    await fs.writeFile(jsoncFile, content, "utf-8");

    const source = new FileSource(jsoncFile);
    expect(source.read("apiKey")).toBe("test-key");
    expect(source.read("model")).toBe("gpt-4o");
  });

  test("should parse JSONC file with multi-line comments", async () => {
    const jsoncFile = path.join(testDir, "config.jsonc");
    const content = `{
      /* This is a
         multi-line comment */
      "name": "test"
    }`;
    await fs.writeFile(jsoncFile, content, "utf-8");

    const source = new FileSource(jsoncFile);
    expect(source.read("name")).toBe("test");
  });

  test("should substitute env vars in config values", async () => {
    process.env.TEST_API_KEY = "my-secret-key";
    const envFile = path.join(testDir, "env-config.json");
    await fs.writeFile(envFile, JSON.stringify({ apiKey: "${TEST_API_KEY}" }), "utf-8");

    const source = new FileSource(envFile);
    expect(source.read("apiKey")).toBe("my-secret-key");

    delete process.env.TEST_API_KEY;
  });

  test("should substitute env vars with defaults", async () => {
    delete process.env.NONEXISTENT_KEY;
    const envFile = path.join(testDir, "env-defaults.json");
    await fs.writeFile(envFile, JSON.stringify({ key: "${NONEXISTENT_KEY:-default-value}" }), "utf-8");

    const source = new FileSource(envFile);
    expect(source.read("key")).toBe("default-value");
  });

  test("should handle combined JSONC and env vars", async () => {
    process.env.CFG_HOST = "localhost";
    process.env.CFG_PORT = "8080";
    const combinedFile = path.join(testDir, "combined.jsonc");
    const content = `{
      // Server configuration
      "host": "\${CFG_HOST}",  // from env
      "port": "\${CFG_PORT}",
      "name": "app"
    }`;
    await fs.writeFile(combinedFile, content, "utf-8");

    const source = new FileSource(combinedFile);
    expect(source.read("host")).toBe("localhost");
    expect(source.read("port")).toBe("8080");
    expect(source.read("name")).toBe("app");

    delete process.env.CFG_HOST;
    delete process.env.CFG_PORT;
  });

  test("should preserve non-string values during env substitution", async () => {
    const mixedFile = path.join(testDir, "mixed.json");
    await fs.writeFile(mixedFile, JSON.stringify({ 
      count: "${UNDEFINED_VAR:-42}",
      enabled: true,
      rate: 0.95
    }), "utf-8");

    const source = new FileSource(mixedFile);
    expect(source.read("count")).toBe("42");  // env var resolved to string
    expect(source.read("enabled")).toBe(true);
    expect(source.read("rate")).toBe(0.95);
  });

  test("should resolve protocol references when resolver is provided", async () => {
    // 创建被引用的文件
    const authFile = path.join(testDir, "auth.json");
    await fs.writeFile(authFile, JSON.stringify({
      api: { key: "secret-key-from-file", url: "https://api.example.com" }
    }), "utf-8");

    // 创建主配置文件
    const mainFile = path.join(testDir, "main.json");
    await fs.writeFile(mainFile, JSON.stringify({
      apiKey: "${file://" + authFile + "#api.key}",
      apiUrl: "${file://" + authFile + "#api.url}"
    }), "utf-8");

    // 使用绝对路径的 file:// 协议
    const { ProtocolResolver } = require("./protocol-resolver");
    const resolver = new ProtocolResolver();
    const source = new FileSource(mainFile, resolver);

    expect(source.read("apiKey")).toBe("secret-key-from-file");
    expect(source.read("apiUrl")).toBe("https://api.example.com");
  });

  test("should resolve file:// protocol references", async () => {
    // 创建引用文件
    const refFile = path.join(testDir, "ref.json");
    await fs.writeFile(refFile, JSON.stringify({
      token: "file-token-xxx",
      secret: "file-secret"
    }), "utf-8");

    // 创建主配置文件
    const mainFile = path.join(testDir, "app.json");
    await fs.writeFile(mainFile, JSON.stringify({
      token: "${file://ref.json#token}",
      secret: "${file://ref.json#secret}"
    }), "utf-8");

    // 使用 file:// 协议
    const { ProtocolResolver } = require("./protocol-resolver");
    const resolver = new ProtocolResolver({
      xdgDataHome: testDir,
    });
    const source = new FileSource(mainFile, resolver);

    expect(source.read("token")).toBe("file-token-xxx");
    expect(source.read("secret")).toBe("file-secret");
  });

  test("should resolve env:// protocol references", async () => {
    process.env.PROTOCOL_TEST_VAR = "protocol-env-value";

    const envFile = path.join(testDir, "env.json");
    await fs.writeFile(envFile, JSON.stringify({
      value: "${env://PROTOCOL_TEST_VAR}",
      other: "static"
    }), "utf-8");

    const { ProtocolResolver } = require("./protocol-resolver");
    const resolver = new ProtocolResolver();
    const source = new FileSource(envFile, resolver);

    expect(source.read("value")).toBe("protocol-env-value");
    expect(source.read("other")).toBe("static");

    delete process.env.PROTOCOL_TEST_VAR;
  });

  test("should handle combined env and protocol references", async () => {
    process.env.DEFAULT_DB_HOST = "db.example.com";

    // 创建引用文件
    const refFile = path.join(testDir, "ref.json");
    await fs.writeFile(refFile, JSON.stringify({
      apiKey: "secret-api-key"
    }), "utf-8");

    const combinedFile = path.join(testDir, "combined.json");
    await fs.writeFile(combinedFile, JSON.stringify({
      host: "${env://DEFAULT_DB_HOST:-localhost}",
      apiKey: "${file://ref.json#apiKey:-no-key}"
    }), "utf-8");

    const { ProtocolResolver } = require("./protocol-resolver");
    const resolver = new ProtocolResolver({
      xdgDataHome: testDir,
    });
    const source = new FileSource(combinedFile, resolver);

    expect(source.read("host")).toBe("db.example.com");
    expect(source.read("apiKey")).toBe("secret-api-key");

    delete process.env.DEFAULT_DB_HOST;
  });
});
