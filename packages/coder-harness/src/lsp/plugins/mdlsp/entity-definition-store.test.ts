/**
 * @fileoverview EntityDefinitionStore 测试 - TDD RED 阶段
 * 
 * 测试实体定义存储功能
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EntityDefinitionStore, type EntityDefinition } from "./entity-definition-store";

describe("EntityDefinitionStore", () => {
  let store: EntityDefinitionStore;

  beforeEach(() => {
    store = new EntityDefinitionStore();
  });

  describe("constructor", () => {
    it("should create store instance", () => {
      expect(store).toBeDefined();
    });
  });

  describe("addDefinition", () => {
    it("should add entity definition", () => {
      const definition: EntityDefinition = {
        name: "TestFunction",
        kind: "function",
        language: "typescript",
        filePath: "/src/test.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 15 },
        },
      };

      store.addDefinition(definition);

      expect(store.has("TestFunction", "typescript")).toBe(true);
    });

    it("should handle multiple definitions for same name", () => {
      const def1: EntityDefinition = {
        name: "overloaded",
        kind: "function",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      };

      const def2: EntityDefinition = {
        name: "overloaded",
        kind: "function",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
      };

      store.addDefinition(def1);
      store.addDefinition(def2);

      const definitions = store.getAll("overloaded", "typescript");
      expect(definitions.length).toBe(2);
    });
  });

  describe("has", () => {
    it("should return true for existing definition", () => {
      store.addDefinition({
        name: "MyClass",
        kind: "class",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      expect(store.has("MyClass", "typescript")).toBe(true);
    });

    it("should return false for non-existing definition", () => {
      expect(store.has("NonExistent", "typescript")).toBe(false);
    });

    it("should return false for different language", () => {
      store.addDefinition({
        name: "MyFunc",
        kind: "function",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      expect(store.has("MyFunc", "python")).toBe(false);
    });
  });

  describe("get", () => {
    it("should return definition for existing entity", () => {
      store.addDefinition({
        name: "MyVariable",
        kind: "variable",
        language: "python",
        filePath: "/src/test.py",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      const def = store.get("MyVariable", "python");
      expect(def).toBeDefined();
      expect(def?.name).toBe("MyVariable");
      expect(def?.kind).toBe("variable");
    });

    it("should return undefined for non-existing entity", () => {
      const def = store.get("NonExistent", "typescript");
      expect(def).toBeUndefined();
    });
  });

  describe("getAll", () => {
    it("should return all definitions for entity name", () => {
      store.addDefinition({
        name: "func",
        kind: "function",
        language: "typescript",
        filePath: "/src/a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      store.addDefinition({
        name: "func",
        kind: "function",
        language: "typescript",
        filePath: "/src/b.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      const definitions = store.getAll("func", "typescript");
      expect(definitions.length).toBe(2);
    });
  });

  describe("removeDefinition", () => {
    it("should remove definition", () => {
      store.addDefinition({
        name: "ToRemove",
        kind: "class",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      store.removeDefinition("ToRemove", "typescript");

      expect(store.has("ToRemove", "typescript")).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all definitions", () => {
      store.addDefinition({
        name: "A",
        kind: "class",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      store.addDefinition({
        name: "B",
        kind: "function",
        language: "python",
        filePath: "/src/test.py",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      store.clear();

      expect(store.has("A", "typescript")).toBe(false);
      expect(store.has("B", "python")).toBe(false);
    });
  });

  describe("getLanguages", () => {
    it("should return registered languages", () => {
      store.addDefinition({
        name: "A",
        kind: "class",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      store.addDefinition({
        name: "B",
        kind: "function",
        language: "python",
        filePath: "/src/test.py",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      const languages = store.getLanguages();
      expect(languages).toContain("typescript");
      expect(languages).toContain("python");
    });
  });

  describe("size", () => {
    it("should return correct count", () => {
      expect(store.size()).toBe(0);

      store.addDefinition({
        name: "A",
        kind: "class",
        language: "typescript",
        filePath: "/src/test.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      });

      expect(store.size()).toBe(1);
    });
  });
});
