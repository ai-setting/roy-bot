/**
 * @fileoverview Glob 模式匹配工具测试
 */

import { describe, it, expect } from "vitest";
import { matchGlob, shouldIgnore } from "./glob";

describe("matchGlob", () => {
  it("should match simple file patterns", () => {
    expect(matchGlob("test.ts", "*.ts")).toBe(true);
    expect(matchGlob("test.js", "*.ts")).toBe(false);
  });

  it("should match ** patterns for recursive matching", () => {
    expect(matchGlob("src/test.ts", "**/*.ts")).toBe(true);
    expect(matchGlob("dist/test.js", "**/*.js")).toBe(true);
    expect(matchGlob("src/nested/deep/file.ts", "**/*.ts")).toBe(true);
  });

  it("should match path-specific patterns", () => {
    expect(matchGlob("dist/bundle.js", "dist/*")).toBe(true);
    expect(matchGlob("dist/sub/file.js", "dist/*")).toBe(false); // * doesn't match sub/
  });

  it("should match ** with path prefixes", () => {
    expect(matchGlob("node_modules/test.js", "node_modules/**")).toBe(true);
    expect(matchGlob("node_modules/@scope/test.js", "node_modules/**")).toBe(true);
  });

  it("should handle dot files", () => {
    expect(matchGlob(".gitignore", ".*")).toBe(true);
    expect(matchGlob(".config/file.ts", ".*/**")).toBe(true);
  });

  it("should match specific file names", () => {
    expect(matchGlob("src/main.ts", "src/main.ts")).toBe(true);
    expect(matchGlob("src/index.ts", "src/main.ts")).toBe(false);
  });
});

describe("shouldIgnore", () => {
  it("should return false for empty patterns", () => {
    expect(shouldIgnore("test.ts", [])).toBe(false);
  });

  it("should ignore test files", () => {
    const patterns = ["*.test.ts", "*.spec.ts"];
    expect(shouldIgnore("test.test.ts", patterns)).toBe(true);
    expect(shouldIgnore("file.spec.ts", patterns)).toBe(true);
    expect(shouldIgnore("main.ts", patterns)).toBe(false);
  });

  it("should ignore directory patterns", () => {
    const patterns = ["dist/**", "node_modules/**"];
    expect(shouldIgnore("dist/bundle.js", patterns)).toBe(true);
    expect(shouldIgnore("node_modules/test.js", patterns)).toBe(true);
    expect(shouldIgnore("src/file.ts", patterns)).toBe(false);
  });

  it("should ignore multiple patterns", () => {
    const patterns = ["*.test.ts", "dist/**", "node_modules/**"];
    expect(shouldIgnore("file.test.ts", patterns)).toBe(true);
    expect(shouldIgnore("dist/build.js", patterns)).toBe(true);
    expect(shouldIgnore("node_modules/pkg/index.js", patterns)).toBe(true);
    expect(shouldIgnore("src/main.ts", patterns)).toBe(false);
  });

  it("should handle complex patterns", () => {
    const patterns = ["**/*.min.js", "build/**/*.js"];
    expect(shouldIgnore("bundle.min.js", patterns)).toBe(true);
    expect(shouldIgnore("build/output.js", patterns)).toBe(true);
    expect(shouldIgnore("src/index.js", patterns)).toBe(false);
  });
});
