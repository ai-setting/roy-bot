/**
 * @fileoverview EntityReferenceChecker 测试 - TDD RED 阶段
 * 
 * 测试实体引用检查功能
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EntityReferenceChecker, type ReferenceCheckResult } from "./entity-reference-checker";
import type { WikilinkEntity } from "./wikilink-resolver";

describe("EntityReferenceChecker", () => {
  let checker: EntityReferenceChecker;

  beforeEach(() => {
    checker = new EntityReferenceChecker();
  });

  describe("constructor", () => {
    it("should create checker instance", () => {
      expect(checker).toBeDefined();
    });
  });

  describe("addEntity", () => {
    it("should add entity to registry", () => {
      checker.addEntity("TestFunc", "typescript", "/src/test.ts");

      expect(checker.isDefined("TestFunc", "typescript")).toBe(true);
    });

    it("should add entity with namespace", () => {
      checker.addEntity("module/ClassName", "typescript", "/src/module.ts");

      expect(checker.isDefined("ClassName", "typescript", "module")).toBe(true);
    });
  });

  describe("isDefined", () => {
    it("should return true for defined entity", () => {
      checker.addEntity("MyClass", "typescript", "/src/test.ts");

      expect(checker.isDefined("MyClass", "typescript")).toBe(true);
    });

    it("should return false for undefined entity", () => {
      expect(checker.isDefined("NonExistent", "typescript")).toBe(false);
    });

    it("should return false for different language", () => {
      checker.addEntity("MyFunc", "typescript", "/src/test.ts");

      expect(checker.isDefined("MyFunc", "python")).toBe(false);
    });

    it("should check with namespace", () => {
      checker.addEntity("utils/helper", "typescript", "/src/utils.ts");

      expect(checker.isDefined("helper", "typescript", "utils")).toBe(true);
      expect(checker.isDefined("helper", "typescript")).toBe(false); // without namespace
    });
  });

  describe("checkReference", () => {
    it("should return defined for existing entity", () => {
      checker.addEntity("DefinedFunc", "typescript", "/src/test.ts");

      const result = checker.checkReference("DefinedFunc", "typescript");

      expect(result.isDefined).toBe(true);
      expect(result.entityName).toBe("DefinedFunc");
    });

    it("should return undefined for non-existing entity", () => {
      const result = checker.checkReference("NonExistent", "typescript");

      expect(result.isDefined).toBe(false);
      expect(result.entityName).toBe("NonExistent");
      expect(result.message).toContain("not found");
    });

    it("should include file path in result", () => {
      checker.addEntity("MyFunc", "typescript", "/src/myfunc.ts");

      const result = checker.checkReference("MyFunc", "typescript");

      expect(result.filePath).toBe("/src/myfunc.ts");
    });
  });

  describe("checkWikilinkReferences", () => {
    it("should check multiple wikilink entities", () => {
      checker.addEntity("Func1", "typescript", "/src/func1.ts");
      checker.addEntity("Func2", "typescript", "/src/func2.ts");

      const wikilinks: WikilinkEntity[] = [
        { raw: "[[Func1]]", entityName: "Func1", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } },
        { raw: "[[Func2]]", entityName: "Func2", range: { start: { line: 0, character: 10 }, end: { line: 0, character: 18 } } },
      ];

      const results = checker.checkWikilinkReferences(wikilinks, "typescript");

      expect(results.length).toBe(2);
      expect(results.every((r) => r.isDefined)).toBe(true);
    });

    it("should mark undefined references", () => {
      const wikilinks: WikilinkEntity[] = [
        { raw: "[[Defined]]", entityName: "Defined", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } },
        { raw: "[[Undefined]]", entityName: "Undefined", range: { start: { line: 0, character: 12 }, end: { line: 0, character: 24 } } },
      ];

      checker.addEntity("Defined", "typescript", "/src/defined.ts");

      const results = checker.checkWikilinkReferences(wikilinks, "typescript");

      expect(results.length).toBe(2);
      expect(results[0].isDefined).toBe(true);
      expect(results[1].isDefined).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all registered entities", () => {
      checker.addEntity("A", "typescript", "/src/a.ts");
      checker.addEntity("B", "python", "/src/b.py");

      checker.clear();

      expect(checker.isDefined("A", "typescript")).toBe(false);
      expect(checker.isDefined("B", "python")).toBe(false);
    });
  });

  describe("getRegisteredLanguages", () => {
    it("should return registered languages", () => {
      checker.addEntity("A", "typescript", "/src/a.ts");
      checker.addEntity("B", "python", "/src/b.py");

      const languages = checker.getRegisteredLanguages();

      expect(languages).toContain("typescript");
      expect(languages).toContain("python");
    });
  });
});
