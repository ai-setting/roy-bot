/**
 * Project Config Source Tests
 *
 * Tests for the project-level config override mechanism:
 * - Register a project source via ConfigComponent.registerProjectSource()
 * - Loads ${cwd}/.roy/config.jsonc
 * - Graceful skip when file doesn't exist
 * - Priority: project > env > file > memory/default
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigComponent } from "./config-component";

function mkTmpDir(prefix: string): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  try {
    fsSync.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function writeProjectConfig(cwd: string, data: Record<string, unknown>): string {
  const dir = path.join(cwd, ".roy");
  fsSync.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "config.jsonc");
  fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}

describe("Project Config Source", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkTmpDir("roy-project-cfg-");
  });

  afterEach(() => {
    rmTmpDir(cwd);
  });

  test("registerProjectSource does not throw when file missing", () => {
    const config = new ConfigComponent();
    expect(() => config.registerProjectSource({ cwd })).not.toThrow();
  });

  test("registerProjectSource loads values from ${cwd}/.roy/config.jsonc", async () => {
    writeProjectConfig(cwd, {
      "log-trace": {
        logging: { dir: "/tmp/from-project-config" },
      },
    });

    const config = new ConfigComponent();
    config.registerProjectSource({ cwd });

    // Make sure we can read the nested key
    const allSources = config.getRegisteredSources();
    const projectSource = allSources.find((s) => "filePath" in s);
    expect(projectSource).toBeDefined();
    expect((projectSource as any).filePath).toBe(path.join(cwd, ".roy", "config.jsonc"));
    expect(projectSource!.read("log-trace.logging.dir")).toBe("/tmp/from-project-config");
  });

  test("project source value wins over env source value", async () => {
    writeProjectConfig(cwd, {
      "log-trace": {
        logging: { dir: "/tmp/project-dir" },
      },
    });
    // EnvSource 期望的 env var 名：PREFIX + "_" + KEY_NORMALIZED
    // toEnvKey("log-trace.logging.dir", "LOG_TRACE") = "LOG_TRACE_LOGGING_DIR"
    process.env.LOG_TRACE_LOGGING_DIR = "/tmp/env-dir";

    try {
      const config = new ConfigComponent();
      config.registerProjectSource({ cwd });
      config.registerSource({
        type: "env",
        envPrefix: "LOG_TRACE",
        priority: 20,
        watch: false,
      });

      // Register key with project > env order
      config.registerKeys([
        { key: "log-trace.logging.dir", sources: ["project", "env", "file"] },
      ]);

      await config.load();

      const value = config.get("log-trace.logging.dir");
      expect(value).toBe("/tmp/project-dir");
    } finally {
      delete process.env.LOG_TRACE_LOGGING_DIR;
    }
  });

  test("env source value wins over global file source value", async () => {
    const globalDir = mkTmpDir("roy-global-cfg-");
    try {
      fsSync.writeFileSync(
        path.join(globalDir, "global.jsonc"),
        JSON.stringify({
          "log-trace": { logging: { dir: "/tmp/global-dir" } },
        }),
        "utf-8",
      );

      process.env.LOG_TRACE_LOGGING_DIR = "/tmp/env-dir";

      const config = new ConfigComponent();
      config.setXdgDataHome(globalDir);
      config.registerSource({
        type: "file",
        relativePath: "global.jsonc",
        optional: true,
        watch: false,
      });
      config.registerSource({
        type: "env",
        envPrefix: "LOG_TRACE",
        priority: 20,
        watch: false,
      });

      config.registerKeys([
        { key: "log-trace.logging.dir", sources: ["env", "file"] },
      ]);

      await config.load();

      const value = config.get("log-trace.logging.dir");
      expect(value).toBe("/tmp/env-dir");
    } finally {
      delete process.env.LOG_TRACE_LOGGING_DIR;
      rmTmpDir(globalDir);
    }
  });

  test("global file source value wins over default (memory)", async () => {
    const globalDir = mkTmpDir("roy-global-cfg-");
    try {
      fsSync.writeFileSync(
        path.join(globalDir, "global.jsonc"),
        JSON.stringify({
          "log-trace": { logging: { dir: "/tmp/global-dir" } },
        }),
        "utf-8",
      );

      const config = new ConfigComponent();
      config.setXdgDataHome(globalDir);
      config.registerSource({
        type: "file",
        relativePath: "global.jsonc",
        optional: true,
        watch: false,
      });

      config.registerKeys([
        { key: "log-trace.logging.dir", sources: ["file"] },
      ]);

      await config.load();

      const value = config.get("log-trace.logging.dir");
      expect(value).toBe("/tmp/global-dir");
    } finally {
      rmTmpDir(globalDir);
    }
  });

  test("all four layers combine: project > env > file > default", async () => {
    // Set up global file
    const globalDir = mkTmpDir("roy-global-cfg-");
    fsSync.writeFileSync(
      path.join(globalDir, "global.jsonc"),
      JSON.stringify({
        "log-trace": { logging: { dir: "/tmp/global-dir" } },
      }),
      "utf-8",
    );

    // Set up project file (different value)
    writeProjectConfig(cwd, {
      "log-trace": { logging: { dir: "/tmp/project-dir" } },
    });

    process.env.LOG_TRACE_LOGGING_DIR = "/tmp/env-dir";

    try {
      const config = new ConfigComponent();
      config.setXdgDataHome(globalDir);
      config.registerProjectSource({ cwd });
      config.registerSource({
        type: "file",
        relativePath: "global.jsonc",
        optional: true,
        watch: false,
      });
      config.registerSource({
        type: "env",
        envPrefix: "LOG_TRACE",
        priority: 20,
        watch: false,
      });

      config.registerKeys([
        { key: "log-trace.logging.dir", sources: ["project", "env", "file"] },
      ]);

      await config.load();

      // project > everything else
      expect(config.get("log-trace.logging.dir")).toBe("/tmp/project-dir");
    } finally {
      delete process.env.LOG_TRACE_LOGGING_DIR;
      rmTmpDir(globalDir);
    }

    // Re-test: remove project config, env should win
    const globalDir2 = mkTmpDir("roy-global-cfg2-");
    fsSync.writeFileSync(
      path.join(globalDir2, "global.jsonc"),
      JSON.stringify({
        "log-trace": { logging: { dir: "/tmp/global-dir" } },
      }),
      "utf-8",
    );
    process.env.LOG_TRACE_LOGGING_DIR = "/tmp/env-dir";
    try {
      const cwd2 = mkTmpDir("roy-project-cfg2-");
      try {
        const config = new ConfigComponent();
        config.setXdgDataHome(globalDir2);
        // No project source registered
        config.registerSource({
          type: "file",
          relativePath: "global.jsonc",
          optional: true,
          watch: false,
        });
        config.registerSource({
          type: "env",
          envPrefix: "LOG_TRACE",
          priority: 20,
          watch: false,
        });
        config.registerKeys([
          { key: "log-trace.logging.dir", sources: ["project", "env", "file"] },
        ]);
        await config.load();
        // env > file
        expect(config.get("log-trace.logging.dir")).toBe("/tmp/env-dir");
      } finally {
        rmTmpDir(cwd2);
      }
    } finally {
      delete process.env.LOG_TRACE_LOGGING_DIR;
      rmTmpDir(globalDir2);
    }

    // Re-test: no project, no env, only file → file wins
    const globalDir3 = mkTmpDir("roy-global-cfg3-");
    try {
      fsSync.writeFileSync(
        path.join(globalDir3, "global.jsonc"),
        JSON.stringify({
          "log-trace": { logging: { dir: "/tmp/global-dir" } },
        }),
        "utf-8",
      );

      const config = new ConfigComponent();
      config.setXdgDataHome(globalDir3);
      config.registerSource({
        type: "file",
        relativePath: "global.jsonc",
        optional: true,
        watch: false,
      });
      config.registerKeys([
        { key: "log-trace.logging.dir", sources: ["project", "env", "file"] },
      ]);
      await config.load();
      expect(config.get("log-trace.logging.dir")).toBe("/tmp/global-dir");
    } finally {
      rmTmpDir(globalDir3);
    }

    // Re-test: nothing → returns undefined (default will be set by component)
    const config2 = new ConfigComponent();
    config2.registerKeys([
      { key: "log-trace.logging.dir", sources: ["project", "env", "file"] },
    ]);
    await config2.load();
    expect(config2.get("log-trace.logging.dir")).toBeUndefined();
  });

  test("different cwd values give different project configs (isolation)", async () => {
    const cwdA = mkTmpDir("roy-proj-a-");
    const cwdB = mkTmpDir("roy-proj-b-");
    try {
      writeProjectConfig(cwdA, {
        "log-trace": { logging: { dir: "/tmp/dir-A" } },
      });
      writeProjectConfig(cwdB, {
        "log-trace": { logging: { dir: "/tmp/dir-B" } },
      });

      const cfgA = new ConfigComponent();
      cfgA.registerProjectSource({ cwd: cwdA });
      cfgA.registerKeys([
        { key: "log-trace.logging.dir", sources: ["project", "file"] },
      ]);
      await cfgA.load();
      expect(cfgA.get("log-trace.logging.dir")).toBe("/tmp/dir-A");

      const cfgB = new ConfigComponent();
      cfgB.registerProjectSource({ cwd: cwdB });
      cfgB.registerKeys([
        { key: "log-trace.logging.dir", sources: ["project", "file"] },
      ]);
      await cfgB.load();
      expect(cfgB.get("log-trace.logging.dir")).toBe("/tmp/dir-B");
    } finally {
      rmTmpDir(cwdA);
      rmTmpDir(cwdB);
    }
  });

  test("default cwd is process.cwd()", async () => {
    // Write project config into the actual cwd
    const originalCwd = process.cwd();
    const sandbox = mkTmpDir("roy-cwd-sandbox-");
    try {
      process.chdir(sandbox);
      writeProjectConfig(sandbox, {
        "log-trace": { logging: { dir: "/tmp/cwd-default" } },
      });

      const config = new ConfigComponent();
      // No cwd passed → should default to process.cwd()
      config.registerProjectSource();
      config.registerKeys([
        { key: "log-trace.logging.dir", sources: ["project", "file"] },
      ]);
      await config.load();
      expect(config.get("log-trace.logging.dir")).toBe("/tmp/cwd-default");
    } finally {
      process.chdir(originalCwd);
      rmTmpDir(sandbox);
    }
  });

  test("duplicate registration with same cwd is idempotent", () => {
    const config = new ConfigComponent();
    config.registerProjectSource({ cwd });
    config.registerProjectSource({ cwd });
    const sources = config.getRegisteredSources();
    const projectSources = sources.filter(
      (s) => "filePath" in s && (s as any).filePath === path.join(cwd, ".roy", "config.jsonc"),
    );
    expect(projectSources.length).toBe(1);
  });
});