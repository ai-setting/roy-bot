import { describe, it, expect, beforeEach } from "vitest";
import { CodeCheckManager, createCodeCheckManager } from "./code-check-manager";

describe("CodeCheckManager", () => {
  describe("getCommand", () => {
    it("should return default command for TypeScript files", () => {
      const manager = createCodeCheckManager({});
      const cmd = manager.getCommand("test.ts");
      expect(cmd).toContain("tsc --noEmit");
    });

    it("should return null for unsupported extensions", () => {
      const manager = createCodeCheckManager({});
      const cmd = manager.getCommand("test.txt");
      expect(cmd).toBeNull();
    });

    it("should use custom command when provided", () => {
      const manager = createCodeCheckManager({
        commands: { ".ts": "custom-tsc {file}" },
      });
      const cmd = manager.getCommand("test.ts");
      expect(cmd).toBe("custom-tsc {file}");
    });
  });

  describe("checkFile", () => {
    it("should return empty result for unsupported files", async () => {
      const manager = createCodeCheckManager({});
      const result = await manager.checkFile("test.txt");
      expect(result.success).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("cache", () => {
    it("should cache results", async () => {
      const manager = createCodeCheckManager({});
      await manager.checkFile("test.txt");
      const cached = manager.getCached("test.txt");
      expect(cached).toBeDefined();
    });

    it("should clear cache", () => {
      const manager = createCodeCheckManager({});
      manager.clearCache();
      expect(manager.getCached("test.txt")).toBeUndefined();
    });
  });
});
