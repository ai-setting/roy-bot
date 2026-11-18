import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  isUsableNpmPrefix,
  ensureFallbackNpmPrefix,
  getFallbackNpmPrefixPath,
} from "./npm-prefix";

describe("npm-prefix", () => {
  const tempDir = path.join(os.tmpdir(), "npm-prefix-test-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("isUsableNpmPrefix", () => {
    it("should accept prefix with lib/", async () => {
      const prefix = path.join(tempDir, "with-lib");
      await fs.mkdir(path.join(prefix, "lib"), { recursive: true });
      expect(isUsableNpmPrefix(prefix)).toBe(true);
    });

    it("should accept prefix with bin/ only", async () => {
      const prefix = path.join(tempDir, "with-bin");
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
      expect(isUsableNpmPrefix(prefix)).toBe(true);
    });

    it("should reject prefix without lib/ or bin/", () => {
      expect(isUsableNpmPrefix(path.join(tempDir, "empty"))).toBe(false);
    });
  });

  describe("ensureFallbackNpmPrefix", () => {
    it("should create lib/ and bin/ under fallback prefix", async () => {
      const prefix = ensureFallbackNpmPrefix();
      expect(prefix).toBe(getFallbackNpmPrefixPath());
      await fs.access(path.join(prefix, "lib"));
      await fs.access(path.join(prefix, "bin"));
    });
  });
});
