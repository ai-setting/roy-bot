/**
 * @fileoverview CrossLangResolver 测试 - TDD RED 阶段
 * 
 * 测试跨语言实体引用解析功能
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CrossLangResolver, type CrossLangQuery, type CrossLangResult } from "./cross-lang-resolver";
import type { LanguageLSPPlugin } from "../base-plugin";

// Mock plugin interface
const mockPlugin = (name: string, hasSymbol: boolean): LanguageLSPPlugin => ({
  name,
  description: `Mock ${name} plugin`,
  extensions: [],
  languageIds: [],
  getStatus: () => ({ name }),
  dispose: vi.fn().mockResolvedValue(undefined),
  getDiagnostics: vi.fn().mockResolvedValue([]),
  getSymbols: vi.fn().mockImplementation(async () => {
    if (hasSymbol) {
      return [{ name: "TestSymbol", kind: 1 }];
    }
    return [];
  }),
});

describe("CrossLangResolver", () => {
  let resolver: CrossLangResolver;

  beforeEach(() => {
    resolver = new CrossLangResolver();
  });

  describe("constructor", () => {
    it("should create resolver instance", () => {
      expect(resolver).toBeDefined();
    });
  });

  describe("registerLanguage", () => {
    it("should register a language plugin", () => {
      const plugin = mockPlugin("typescript", true);
      resolver.registerLanguage("typescript", plugin);
      // Verify by checking if the language is registered
      expect((resolver as any).plugins.has("typescript")).toBe(true);
    });
  });

  describe("resolveEntity", () => {
    it("should resolve entity from registered language", async () => {
      const plugin = mockPlugin("typescript", true);
      resolver.registerLanguage("typescript", plugin);

      const result = await resolver.resolveEntity("TestSymbol", "typescript");
      
      expect(result).toBeDefined();
      expect(result?.found).toBe(true);
    });

    it("should return not found for unregistered entity", async () => {
      const plugin = mockPlugin("typescript", false);
      resolver.registerLanguage("typescript", plugin);

      const result = await resolver.resolveEntity("NonExistent", "typescript");
      
      expect(result).toBeDefined();
      expect(result?.found).toBe(false);
    });

    it("should throw for unregistered language", async () => {
      await expect(
        resolver.resolveEntity("TestSymbol", "unknown")
      ).rejects.toThrow("Language plugin not registered");
    });
  });

  describe("resolveAllLanguages", () => {
    it("should search across all registered languages", async () => {
      const tsPlugin = mockPlugin("typescript", true);
      const pyPlugin = mockPlugin("python", true);
      
      resolver.registerLanguage("typescript", tsPlugin);
      resolver.registerLanguage("python", pyPlugin);

      const results = await resolver.resolveAllLanguages("TestSymbol");
      
      expect(results.length).toBe(2);
      expect(results.every((r: CrossLangResult) => r.found)).toBe(true);
    });

    it("should return empty array when no languages registered", async () => {
      const results = await resolver.resolveAllLanguages("TestSymbol");
      expect(results).toEqual([]);
    });
  });

  describe("isEntityDefined", () => {
    it("should return true for defined entity", async () => {
      const plugin = mockPlugin("typescript", true);
      resolver.registerLanguage("typescript", plugin);

      const isDefined = await resolver.isEntityDefined("TestSymbol", "typescript");
      expect(isDefined).toBe(true);
    });

    it("should return false for undefined entity", async () => {
      const plugin = mockPlugin("typescript", false);
      resolver.registerLanguage("typescript", plugin);

      const isDefined = await resolver.isEntityDefined("NonExistent", "typescript");
      expect(isDefined).toBe(false);
    });
  });
});
