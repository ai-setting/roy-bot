/**
 * @fileoverview Tests for version helper
 *
 * Task #2687: 验证 getPackageVersion() 正确返回版本号。
 * 在开发模式下（非 compile），应返回 package.json 中的 version。
 * 在 compile 模式下，ROY_AGENT_VERSION define 常量优先。
 */

import { describe, test, expect } from "bun:test";
import { getPackageVersion } from "./version";
import pkg from "../../package.json" with { type: "json" };

describe("getPackageVersion", () => {
  test("should return a non-empty version string", () => {
    const version = getPackageVersion();
    expect(version).toBeTruthy();
    expect(typeof version).toBe("string");
  });

  test("should return a semver-compatible version (x.y.z)", () => {
    const version = getPackageVersion();
    // Basic semver pattern: major.minor.patch
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("should match package.json version in dev mode (no ROY_AGENT_VERSION define)", () => {
    // In dev mode (bun test), ROY_AGENT_VERSION is not defined via Bun.build define,
    // so getPackageVersion() should fallback to package.json version.
    const version = getPackageVersion();
    expect(version).toBe(pkg.version);
  });
});
