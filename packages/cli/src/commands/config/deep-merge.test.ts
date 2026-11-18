/**
 * @fileoverview 深度合并工具测试
 */

import { describe, it, expect } from "vitest";
import { deepMerge } from "./deep-merge";

describe("deepMerge", () => {
  it("should merge two flat objects", () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };
    const result = deepMerge(target, source);

    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("should recursively merge nested objects", () => {
    const target = {
      agent: {
        maxIterations: 100,
        maxErrorRetries: 3,
      },
    };
    const source = {
      agent: {
        maxIterations: 200,
        doomLoopThreshold: 5,
      },
    };
    const result = deepMerge(target, source);

    expect(result).toEqual({
      agent: {
        maxIterations: 200,
        maxErrorRetries: 3,
        doomLoopThreshold: 5,
      },
    });
  });

  it("should preserve fields in target that are not in source", () => {
    const target = {
      agent: {
        maxIterations: 100,
        maxErrorRetries: 3,
        preserveMe: "keep",
      },
      llm: {
        provider: "openai",
      },
    };
    const source = {
      agent: {
        maxIterations: 200,
      },
    };
    const result = deepMerge(target, source);

    expect(result).toEqual({
      agent: {
        maxIterations: 200,
        maxErrorRetries: 3,
        preserveMe: "keep",
      },
      llm: {
        provider: "openai",
      },
    });
  });

  it("should replace arrays instead of merging", () => {
    const target = {
      agent: {
        tools: ["tool1", "tool2"],
      },
    };
    const source = {
      agent: {
        tools: ["tool3", "tool4", "tool5"],
      },
    };
    const result = deepMerge(target, source);

    expect(result).toEqual({
      agent: {
        tools: ["tool3", "tool4", "tool5"],
      },
    });
  });

  it("should handle null values", () => {
    const target = {
      agent: {
        customField: null,
        keepMe: "value",
      },
    };
    const source = {
      agent: {
        customField: "newValue",
      },
    };
    const result = deepMerge(target, source);

    expect(result).toEqual({
      agent: {
        customField: "newValue",
        keepMe: "value",
      },
    });
  });

  it("should handle empty objects", () => {
    const target = {};
    const source = { agent: { maxIterations: 100 } };
    const result = deepMerge(target, source);

    expect(result).toEqual({ agent: { maxIterations: 100 } });
  });

  it("should handle deeply nested objects", () => {
    const target = {
      agent: {
        defaultAgent: {
          nested: {
            deep: {
              value: 1,
            },
          },
        },
      },
    };
    const source = {
      agent: {
        defaultAgent: {
          nested: {
            deep: {
              value: 2,
              added: 3,
            },
          },
        },
      },
    };
    const result = deepMerge(target, source);

    expect(result).toEqual({
      agent: {
        defaultAgent: {
          nested: {
            deep: {
              value: 2,
              added: 3,
            },
          },
        },
      },
    });
  });

  it("should not mutate original target", () => {
    const target = { agent: { maxIterations: 100, keep: true } };
    const source = { agent: { maxIterations: 200 } };
    deepMerge(target, source);

    expect(target).toEqual({ agent: { maxIterations: 100, keep: true } });
  });
});
