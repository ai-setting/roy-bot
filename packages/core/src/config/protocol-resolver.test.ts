import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import path from "path";
import os from "os";
import { ProtocolResolver } from "./protocol-resolver";

// 测试用的临时目录
const testDir = path.join(__dirname, ".test-protocol-resolver");

describe("ProtocolResolver", () => {
  let resolver: any;

  beforeEach(async () => {
    // 创建测试目录
    await fs.promises.mkdir(testDir, { recursive: true });
    
    // 创建实例
    resolver = new ProtocolResolver({
      xdgDataHome: testDir,
    });
  });

  afterEach(async () => {
    // 清理测试目录
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("parse", () => {
    test("should parse file:// protocol reference", () => {
      const ref = "${file://config/app.json#api.key}";
      const result = resolver.parse(ref);
      
      expect(result).not.toBeNull();
      expect(result?.protocol).toBe("file");
      expect(result?.path).toBe("config/app.json");
      expect(result?.key).toBe("api.key");
      expect(result?.raw).toBe(ref);
    });

    test("should parse env:// protocol reference", () => {
      const ref = "${env://HOME}";
      const result = resolver.parse(ref);
      
      expect(result).not.toBeNull();
      expect(result?.protocol).toBe("env");
      expect(result?.path).toBe("HOME");
      expect(result?.key).toBe("");
    });

    test("should return null for non-protocol string", () => {
      expect(resolver.parse("plain text")).toBeNull();
      expect(resolver.parse("${VAR}")).toBeNull();
      expect(resolver.parse("")).toBeNull();
    });

    test("should return null for unsupported protocol", () => {
      expect(resolver.parse("${http://example.com}")).toBeNull();
      expect(resolver.parse("${custom://path}")).toBeNull();
    });
  });

  describe("isProtocolRef", () => {
    test("should return true for valid protocol reference", () => {
      expect(resolver.isProtocolRef("${file://path#key}")).toBe(true);
      expect(resolver.isProtocolRef("${env://VAR}")).toBe(true);
    });

    test("should return false for non-protocol string", () => {
      expect(resolver.isProtocolRef("plain text")).toBe(false);
      expect(resolver.isProtocolRef("${VAR}")).toBe(false);
      expect(resolver.isProtocolRef("")).toBe(false);
    });
  });

  describe("resolve", () => {
    test("should resolve env:// protocol from environment variable", () => {
      process.env.TEST_RESOLVER_VAR = "test-value";
      
      const result = resolver.resolve("${env://TEST_RESOLVER_VAR}");
      
      expect(result).not.toBeNull();
      expect(result?.value).toBe("test-value");
      expect(result?.source).toBe("env");
      
      delete process.env.TEST_RESOLVER_VAR;
    });

    test("should resolve file:// protocol from JSON file", async () => {
      const configPath = path.join(testDir, "config.json");
      await fs.promises.writeFile(configPath, JSON.stringify({
        api: { key: "my-api-key", url: "https://api.example.com" }
      }), "utf-8");

      const result = resolver.resolve("${file://config.json#api.key}");
      
      expect(result).not.toBeNull();
      expect(result?.value).toBe("my-api-key");
      expect(result?.source).toBe("file");
    });

    test("should resolve file:// with nested key", async () => {
      const configPath = path.join(testDir, "config.json");
      await fs.promises.writeFile(configPath, JSON.stringify({
        server: { host: "localhost", port: 8080 }
      }), "utf-8");

      const result = resolver.resolve("${file://config.json#server.host}");
      
      expect(result).not.toBeNull();
      expect(result?.value).toBe("localhost");
    });

    test("should resolve file:// with absolute path", async () => {
      const absPath = path.join(testDir, "abs-config.json");
      await fs.promises.writeFile(absPath, JSON.stringify({ key: "abs-value" }), "utf-8");

      // 使用字符串拼接避免模板字符串解析问题
      const ref = "${file://" + absPath + "#key}";
      const result = resolver.resolve(ref);
      
      expect(result?.value).toBe("abs-value");
    });

    test("should resolve file:// with ~ path", async () => {
      const homeDir = os.homedir();
      const tildePath = path.join(homeDir, ".test-resolver-config.json");
      await fs.promises.writeFile(tildePath, JSON.stringify({ key: "tilde-value" }), "utf-8");

      const result = resolver.resolve("${file://~/.test-resolver-config.json#key}");
      
      expect(result?.value).toBe("tilde-value");

      // 清理
      await fs.promises.unlink(tildePath).catch(() => {});
    });

    test("should return undefined for non-existent file key", async () => {
      const configPath = path.join(testDir, "config.json");
      await fs.promises.writeFile(configPath, JSON.stringify({ exists: true }), "utf-8");

      const result = resolver.resolve("${file://config.json#nonexistent}");
      
      expect(result?.value).toBeUndefined();
    });

    test("should return null for non-existent file", () => {
      const result = resolver.resolve("${file://nonexistent.json#key}");
      
      expect(result?.value).toBeUndefined();
    });

    test("should return null for non-protocol string", () => {
      expect(resolver.resolve("plain text")).toBeNull();
      expect(resolver.resolve("${VAR}")).toBeNull();
    });
  });

  describe("XDG_DATA_HOME resolution", () => {
    test("should resolve relative paths based on XDG_DATA_HOME", async () => {
      const subDir = path.join(testDir, "subdir");
      await fs.promises.mkdir(subDir, { recursive: true });
      
      const configPath = path.join(subDir, "config.json");
      await fs.promises.writeFile(configPath, JSON.stringify({ key: "xdg-value" }), "utf-8");

      const result = resolver.resolve("${file://subdir/config.json#key}");
      
      expect(result?.value).toBe("xdg-value");
    });

    test("should use default XDG_DATA_HOME when not specified", () => {
      const xdgHome = ProtocolResolver.getDefaultXDGDataHome();
      
      expect(xdgHome).toContain(".local/share");
    });
  });

  describe("file content handling", () => {
    test("should handle plain text file content", async () => {
      const textPath = path.join(testDir, "plain.txt");
      await fs.promises.writeFile(textPath, "plain text content", "utf-8");

      // 对于纯文本文件，返回全部内容
      const ref = "${file://" + textPath + "#$}";
      const result = resolver.resolve(ref);
      
      expect(result?.value).toBe("plain text content");
    });

    test("should return entire object for empty key", async () => {
      const configPath = path.join(testDir, "config.json");
      await fs.promises.writeFile(configPath, JSON.stringify({ nested: { data: "value" } }), "utf-8");

      const result = resolver.resolve("${file://config.json#$}");
      
      expect(result?.value).toEqual({ nested: { data: "value" } });
    });
  });
});

describe("ProtocolResolver with custom readFileFn", () => {
  test("should use injected readFileFn", () => {
    const customRead = () => '{"injected": "value"}';
    
    const resolver = new ProtocolResolver({
      readFileFn: customRead,
    });

    const result = resolver.resolve('${file://anypath.json#injected}');
    
    expect(result?.value).toBe("value");
  });
});
