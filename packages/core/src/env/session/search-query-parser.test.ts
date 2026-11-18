/**
 * @fileoverview Search Query Parser Tests
 * 
 * TDD: Tests for parseSearchQuery function
 * 
 * 期望行为：
 * - 支持 AND 操作符（默认）
 * - 支持 OR 操作符
 * - 支持 NOT 操作符
 * - 支持引号短语匹配
 * - 大小写不敏感
 */

import { describe, test, expect } from "bun:test";

// 导入解析器模块
import { parseSearchQuery, matchesQuery, type ParsedQuery } from "./search-query-parser";

// ============================================================================
// parseSearchQuery Tests
// ============================================================================

describe("parseSearchQuery", () => {
  describe("基本关键字解析", () => {
    test("应该解析单个关键字", () => {
      const result = parseSearchQuery("test");
      
      expect(result.required).toContain("test");
      expect(result.required.length).toBe(1);
    });

    test("应该将空格分隔的关键字解析为 AND 关系", () => {
      const result = parseSearchQuery("hello world");
      
      expect(result.required).toContain("hello");
      expect(result.required).toContain("world");
      expect(result.required.length).toBe(2);
    });

    test("应该将多个关键字转为小写（大小写不敏感）", () => {
      const result = parseSearchQuery("HELLO World");
      
      expect(result.required).toContain("hello");
      expect(result.required).toContain("world");
    });
  });

  describe("AND 操作符", () => {
    test("应该支持显式 AND 操作符", () => {
      const result = parseSearchQuery("term1 AND term2");
      
      expect(result.required).toContain("term1");
      expect(result.required).toContain("term2");
    });

    test("应该忽略 AND 的大小写", () => {
      const result = parseSearchQuery("term1 and term2");
      
      expect(result.required).toContain("term1");
      expect(result.required).toContain("term2");
    });
  });

  describe("OR 操作符", () => {
    test("应该支持 OR 操作符", () => {
      const result = parseSearchQuery("term1 OR term2");
      
      expect(result.required).toContain("term1");
      expect(result.required).toContain("term2");
    });

    test("应该忽略 OR 的大小写", () => {
      const result = parseSearchQuery("term1 or term2");
      
      expect(result.required).toContain("term1");
      expect(result.required).toContain("term2");
    });
  });

  describe("NOT 操作符", () => {
    test("应该支持 NOT 操作符", () => {
      const result = parseSearchQuery("term1 NOT term2");
      
      expect(result.required).toContain("term1");
      expect(result.excluded).toContain("term2");
    });

    test("应该忽略 NOT 的大小写", () => {
      const result = parseSearchQuery("term1 not term2");
      
      expect(result.required).toContain("term1");
      expect(result.excluded).toContain("term2");
    });
  });

  describe("引号短语", () => {
    test("应该提取引号内的短语", () => {
      const result = parseSearchQuery('"exact phrase"');
      
      expect(result.phrases).toContain("exact phrase");
    });

    test("应该处理多个引号短语", () => {
      const result = parseSearchQuery('"phrase one" "phrase two"');
      
      expect(result.phrases).toContain("phrase one");
      expect(result.phrases).toContain("phrase two");
    });

    test("引号短语应该大小写不敏感", () => {
      const result = parseSearchQuery('"EXACT Phrase"');
      
      expect(result.phrases).toContain("exact phrase");
    });

    test("应该支持混合使用短语和关键字", () => {
      const result = parseSearchQuery('"exact phrase" keyword');
      
      expect(result.phrases).toContain("exact phrase");
      expect(result.required).toContain("keyword");
    });
  });

  describe("复杂查询", () => {
    test("应该支持 AND NOT 组合", () => {
      const result = parseSearchQuery("include AND NOT exclude");
      
      expect(result.required).toContain("include");
      expect(result.excluded).toContain("exclude");
    });

    test("应该支持多个 NOT", () => {
      const result = parseSearchQuery("term1 NOT term2 NOT term3");
      
      expect(result.required).toContain("term1");
      expect(result.excluded).toContain("term2");
      expect(result.excluded).toContain("term3");
    });

    test("应该忽略多余的空白字符", () => {
      const result = parseSearchQuery("  term1   AND   term2  ");
      
      expect(result.required).toContain("term1");
      expect(result.required).toContain("term2");
    });
  });

  describe("边界情况", () => {
    test("空查询应该返回空结果", () => {
      const result = parseSearchQuery("");
      
      expect(result.required).toEqual([]);
      expect(result.excluded).toEqual([]);
      expect(result.phrases).toEqual([]);
    });

    test("只包含空白字符的查询应该返回空结果", () => {
      const result = parseSearchQuery("   ");
      
      expect(result.required).toEqual([]);
    });

    test("只包含操作符的查询应该忽略无效部分", () => {
      const result = parseSearchQuery("AND OR NOT");
      
      // 只有操作符，没有实际关键字
      expect(result.required.length).toBe(0);
    });
  });

  describe("Unicode/CJK 字符支持", () => {
    test("应该支持中文字符作为关键字", () => {
      const result = parseSearchQuery("三层");
      
      expect(result.required).toContain("三层");
    });

    test("应该支持混合中英文关键字", () => {
      const result = parseSearchQuery("三层 memory");
      
      expect(result.required).toContain("三层");
      expect(result.required).toContain("memory");
    });

    test("应该支持中文 AND 操作", () => {
      const result = parseSearchQuery("三层 AND 记忆");
      
      expect(result.required).toContain("三层");
      expect(result.required).toContain("记忆");
    });

    test("应该支持中文 NOT 操作", () => {
      const result = parseSearchQuery("记忆 NOT 三层");
      
      expect(result.required).toContain("记忆");
      expect(result.excluded).toContain("三层");
    });

    test("CJK 关键字应该大小写不敏感", () => {
      const result = parseSearchQuery("三层");
      
      expect(result.required).toContain("三层");
    });
  });
});

// ============================================================================
// matchesQuery Tests
// ============================================================================



describe("matchesQuery", () => {
  describe("基本匹配", () => {
    test("应该匹配包含必需关键字的内容", () => {
      const result = matchesQuery("Hello World", {
        required: ["hello"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(true);
    });

    test("应该不匹配缺少必需关键字的内容", () => {
      const result = matchesQuery("Hello World", {
        required: ["foo"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(false);
    });

    test("多个必需关键字应该全部匹配（AND 逻辑）", () => {
      const result = matchesQuery("Hello World", {
        required: ["hello", "world"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(true);
    });

    test("缺少任一必需关键字应该不匹配", () => {
      const result = matchesQuery("Hello", {
        required: ["hello", "world"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(false);
    });
  });

  describe("排除关键字", () => {
    test("应该排除包含排除关键字的内容", () => {
      const result = matchesQuery("Hello World", {
        required: [],
        excluded: ["world"],
        phrases: []
      });
      
      expect(result).toBe(false);
    });

    test("应该匹配不包含排除关键字的内容", () => {
      const result = matchesQuery("Hello World", {
        required: [],
        excluded: ["foo"],
        phrases: []
      });
      
      expect(result).toBe(true);
    });

    test("排除关键字优先级高于必需关键字", () => {
      const result = matchesQuery("Hello World", {
        required: ["hello", "world"],
        excluded: ["world"],
        phrases: []
      });
      
      expect(result).toBe(false);
    });
  });

  describe("短语匹配", () => {
    test("应该匹配包含完整短语的内容", () => {
      const result = matchesQuery('Say "hello world" to everyone', {
        required: [],
        excluded: [],
        phrases: ["hello world"]
      });
      
      expect(result).toBe(true);
    });

    test("应该不匹配不包含短语的内容", () => {
      const result = matchesQuery("Hello", {
        required: [],
        excluded: [],
        phrases: ["hello world"]
      });
      
      expect(result).toBe(false);
    });

    test("多个短语应该全部匹配", () => {
      const result = matchesQuery('Hello world, say "good morning"', {
        required: [],
        excluded: [],
        phrases: ["hello world", "good morning"]
      });
      
      expect(result).toBe(true);
    });
  });

  describe("大小写不敏感", () => {
    test("应该忽略关键字的大小写", () => {
      const result = matchesQuery("HELLO World", {
        required: ["hello"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(true);
    });

    test("应该忽略排除关键字的大小写", () => {
      const result = matchesQuery("HELLO World", {
        required: [],
        excluded: ["WORLD"],
        phrases: []
      });
      
      expect(result).toBe(false);
    });

    test("应该忽略短语的大小写", () => {
      const result = matchesQuery("Say HELLO WORLD to everyone", {
        required: [],
        excluded: [],
        phrases: ["hello world"]
      });
      
      expect(result).toBe(true);
    });
  });

  describe("边界情况", () => {
    test("空必需关键字列表应该匹配任何内容（除排除和短语约束外）", () => {
      const result = matchesQuery("Any content here", {
        required: [],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(true);
    });

    test("空内容应该不匹配有必需关键字的查询", () => {
      const result = matchesQuery("", {
        required: ["hello"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(false);
    });
  });

  describe("Unicode/CJK 字符匹配", () => {
    test("应该匹配包含中文关键字的内容", () => {
      const result = matchesQuery("这是一个三层架构", {
        required: ["三层"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(true);
    });

    test("应该不匹配不包含中文关键字的内容", () => {
      const result = matchesQuery("这是一个测试", {
        required: ["三层"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(false);
    });

    test("应该支持中文排除关键字", () => {
      const result = matchesQuery("三层架构很好", {
        required: [],
        excluded: ["三层"],
        phrases: []
      });
      
      expect(result).toBe(false);
    });

    test("应该支持中文短语匹配", () => {
      const result = matchesQuery("讨论三层架构", {
        required: [],
        excluded: [],
        phrases: ["三层架构"]
      });
      
      expect(result).toBe(true);
    });

    test("应该支持混合中英文内容", () => {
      const result = matchesQuery("三层 memory architecture", {
        required: ["三层", "memory"],
        excluded: [],
        phrases: []
      });
      
      expect(result).toBe(true);
    });
  });
});
