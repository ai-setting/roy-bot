import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  augmentNpmEnvForPackageRunner,
  resolvePackageRunnerCommand,
} from "./command-resolver";

describe("command-resolver", () => {
  const tempDir = path.join(os.tmpdir(), "mcp-command-resolver-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("resolvePackageRunnerCommand", () => {
    it("should resolve npx to local node_modules/.bin when installed", async () => {
      const binDir = path.join(tempDir, "node_modules", ".bin");
      await fs.mkdir(binDir, { recursive: true });
      const binPath = path.join(binDir, "minimax-coding-plan-mcp");
      await fs.writeFile(binPath, "#!/usr/bin/env node\n");

      const resolved = resolvePackageRunnerCommand(
        ["npx", "minimax-coding-plan-mcp"],
        tempDir
      );

      expect(resolved).toEqual([binPath]);
    });

    it("should keep original command when local bin is missing", () => {
      const command = ["npx", "missing-package"];
      expect(resolvePackageRunnerCommand(command, tempDir)).toEqual(command);
    });

    it("should leave non-package-runner commands unchanged", () => {
      const command = ["bun", "run", "server.ts"];
      expect(resolvePackageRunnerCommand(command, tempDir)).toEqual(command);
    });

    it("should resolve bunx to local node_modules/.bin when installed", async () => {
      const binDir = path.join(tempDir, "node_modules", ".bin");
      await fs.mkdir(binDir, { recursive: true });
      const binPath = path.join(binDir, "demo-mcp");
      await fs.writeFile(binPath, "#!/usr/bin/env node\n");

      const resolved = resolvePackageRunnerCommand(["bunx", "demo-mcp"], tempDir);
      expect(resolved).toEqual([binPath]);
    });
  });

  describe("augmentNpmEnvForPackageRunner", () => {
    it("should set fallback npm prefix when current prefix lib is missing", () => {
      const env = augmentNpmEnvForPackageRunner(["npx", "pkg"], {
        NPM_CONFIG_PREFIX: path.join(tempDir, "broken-prefix"),
      });

      expect(env.NPM_CONFIG_PREFIX).toBe(
        path.join(os.homedir(), ".local", "share", "roy-bot", "npm-prefix")
      );
    });

    it("should not override env when prefix lib exists", async () => {
      const prefix = path.join(tempDir, "valid-prefix");
      await fs.mkdir(path.join(prefix, "lib"), { recursive: true });

      const env = augmentNpmEnvForPackageRunner(["npx", "pkg"], {
        NPM_CONFIG_PREFIX: prefix,
      });

      expect(env.NPM_CONFIG_PREFIX).toBe(prefix);
    });

    it("should accept prefix with bin/ only", async () => {
      const prefix = path.join(tempDir, "bin-only-prefix");
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });

      const env = augmentNpmEnvForPackageRunner(["npx", "pkg"], {
        NPM_CONFIG_PREFIX: prefix,
      });

      expect(env.NPM_CONFIG_PREFIX).toBe(prefix);
    });
  });
});
