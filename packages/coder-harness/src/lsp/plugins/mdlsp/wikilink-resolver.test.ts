/**
 * @fileoverview WikilinkResolver 测试 - TDD RED 阶段
 * 
 * 测试维基链接 [[EntityName]] 的提取和验证
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WikilinkResolver, type WikilinkEntity } from "./wikilink-resolver";

describe("WikilinkResolver", () => {
  let resolver: WikilinkResolver;

  beforeEach(() => {
    resolver = new WikilinkResolver();
  });

  describe("extractWikilinks", () => {
    it("should extract simple wikilink", () => {
      const content = "See [[FunctionName]] for details.";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(1);
      expect(entities[0].entityName).toBe("FunctionName");
      expect(entities[0].raw).toBe("[[FunctionName]]");
      expect(entities[0].namespace).toBeUndefined();
    });

    it("should extract namespaced wikilink", () => {
      const content = "See [[module/ClassName]] for details.";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(1);
      expect(entities[0].entityName).toBe("ClassName");
      expect(entities[0].namespace).toBe("module");
    });

    it("should extract multiple wikilinks", () => {
      const content = "[[Entity1]] and [[Entity2]]";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(2);
      expect(entities[0].entityName).toBe("Entity1");
      expect(entities[1].entityName).toBe("Entity2");
    });

    it("should return empty for no wikilinks", () => {
      const content = "No wikilinks here.";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(0);
    });

    it("should extract wikilink with underscores and hyphens", () => {
      const content = "See [[my_function_name]] or [[MyClass-Name]]";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(2);
      expect(entities[0].entityName).toBe("my_function_name");
      expect(entities[1].entityName).toBe("MyClass-Name");
    });
  });

  describe("getRange", () => {
    it("should return correct range for single line wikilink", () => {
      const content = "Line 1\nLine 2 [[Target]]";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(1);
      expect(entities[0].range.start.line).toBe(1);
      expect(entities[0].range.end.line).toBe(1);
    });

    it("should return correct character positions", () => {
      const content = "Start [[Target]] end";
      const entities = resolver.extractWikilinks(content);
      
      expect(entities).toHaveLength(1);
      expect(entities[0].range.start.character).toBe(6);
      expect(entities[0].range.end.character).toBe(6 + "[[Target]]".length);
    });
  });

  describe("validateEntityName", () => {
    it("should validate valid entity name", () => {
      expect(resolver.validateEntityName("FunctionName")).toBe(true);
      expect(resolver.validateEntityName("my_function")).toBe(true);
      expect(resolver.validateEntityName("MyClass")).toBe(true);
    });

    it("should reject invalid entity name", () => {
      expect(resolver.validateEntityName("")).toBe(false);
      expect(resolver.validateEntityName("123")).toBe(false);
    });
  });
});
