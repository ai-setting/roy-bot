/**
 * LogTrace Project Config Integration Tests
 *
 * Verifies that log-trace reads log-trace.logging.dir from project-level
 * ${cwd}/.roy/config.jsonc, and that different projects can have different
 * log directories.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { LogTraceComponent } from "./log-trace-component";
import { ConfigComponent } from "../../config/config-component";
import { createLogger } from "./logger";
import type { Environment } from "../interface";

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

function makeMockEnv(configComponent: ConfigComponent): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getComponent: ((name: string) => {
      if (name === "config") return configComponent;
      return undefined;
    }) as any,
    hasComponent: ((name: string) => name === "config") as any,
    logger: (() => {}) as any,
    trace: (() => {}) as any,
  } as unknown as Environment;
}

describe("LogTrace Project Config Integration", () => {
  let dataDir: string;
  let projectDir: string;

  beforeEach(() => {
    dataDir = mkTmpDir("logtrace-data-");
    projectDir = mkTmpDir("logtrace-project-");
  });

  afterEach(() => {
    rmTmpDir(dataDir);
    rmTmpDir(projectDir);
    // Clean up env vars
    delete process.env.LOG_TRACE_LOGGING_DIR;
    delete process.env.LOG_TRACE_LOG_TRACE_LOGGING_DIR;
    delete process.env.LOG_TRACE_LOGGING_FILE;
    delete process.env.LOG_TRACE_LOG_TRACE_LOGGING_FILE;
    delete process.env.LOG_TRACE_LOGGING_LEVEL;
    delete process.env.LOG_TRACE_LOG_TRACE_LOGGING_LEVEL;
    delete process.env.LOG_TRACE_LOGGING_ENABLED;
    delete process.env.LOG_TRACE_LOG_TRACE_LOGGING_ENABLED;
  });

  test("log-trace.logging.dir can be set via ${cwd}/.roy/config.jsonc", async () => {
    const customDir = path.join(projectDir, "logs");
    writeProjectConfig(projectDir, {
      "log-trace": {
        logging: { dir: customDir },
      },
    });

    const configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(dataDir);

    // Now init LogTraceComponent with cwd = projectDir
    const component = new LogTraceComponent();
    await component.init({
      name: "log-trace",
      version: "1.0.0",
      enabled: true,
      env: makeMockEnv(configComponent),
      options: { configComponent, cwd: projectDir },
    });

    expect(component.getStatus()).toBe("running");

    // Verify logging.dir was applied
    const dir = configComponent.get("log-trace.logging.dir");
    expect(dir).toBe(customDir);

    component.stop?.();
  });

  test("logger writes log files to project-configured directory", async () => {
    const customDir = path.join(projectDir, "logs");
    writeProjectConfig(projectDir, {
      "log-trace": {
        logging: {
          dir: customDir,
          file: "project-test.log",
          level: "info",
          quiet: false,
        },
      },
    });

    const configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(dataDir);

    const component = new LogTraceComponent();
    await component.init({
      name: "log-trace",
      version: "1.0.0",
      enabled: true,
      env: makeMockEnv(configComponent),
      options: { configComponent, cwd: projectDir },
    });

    // Create a logger and write something
    const logger = createLogger("test-project-logger");
    logger.info("hello from project config");

    // Wait for any async writes
    await new Promise((r) => setTimeout(r, 200));

    const expectedFile = path.join(customDir, "project-test.log");
    expect(fsSync.existsSync(customDir)).toBe(true);
    expect(fsSync.existsSync(expectedFile)).toBe(true);

    const content = fsSync.readFileSync(expectedFile, "utf-8");
    expect(content).toContain("hello from project config");

    component.stop?.();
  });

  test("two projects with different .roy configs get different log dirs (no cross-contamination)", async () => {
    const projectA = mkTmpDir("logtrace-proj-A-");
    const projectB = mkTmpDir("logtrace-proj-B-");
    try {
      const dirA = path.join(projectA, "logs-A");
      const dirB = path.join(projectB, "logs-B");

      writeProjectConfig(projectA, {
        "log-trace": { logging: { dir: dirA, file: "app.log" } },
      });
      writeProjectConfig(projectB, {
        "log-trace": { logging: { dir: dirB, file: "app.log" } },
      });

      // Init project A
      const configA = new ConfigComponent();
      configA.setXdgDataHome(dataDir);
      const compA = new LogTraceComponent();
      await compA.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: makeMockEnv(configA),
        options: { configComponent: configA, cwd: projectA },
      });
      const loggerA = createLogger("loggerA");
      loggerA.info("from project A");
      await new Promise((r) => setTimeout(r, 200));

      // Init project B
      const configB = new ConfigComponent();
      configB.setXdgDataHome(dataDir);
      const compB = new LogTraceComponent();
      await compB.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: makeMockEnv(configB),
        options: { configComponent: configB, cwd: projectB },
      });
      const loggerB = createLogger("loggerB");
      loggerB.info("from project B");
      await new Promise((r) => setTimeout(r, 200));

      // A and B should be in separate directories
      expect(configA.get("log-trace.logging.dir")).toBe(dirA);
      expect(configB.get("log-trace.logging.dir")).toBe(dirB);

      const fileA = path.join(dirA, "app.log");
      const fileB = path.join(dirB, "app.log");
      expect(fsSync.existsSync(fileA)).toBe(true);
      expect(fsSync.existsSync(fileB)).toBe(true);

      const contentA = fsSync.readFileSync(fileA, "utf-8");
      const contentB = fsSync.readFileSync(fileB, "utf-8");
      expect(contentA).toContain("from project A");
      expect(contentB).toContain("from project B");
      // No cross-contamination
      expect(contentA).not.toContain("from project B");
      expect(contentB).not.toContain("from project A");

      compA.stop?.();
      compB.stop?.();
    } finally {
      rmTmpDir(projectA);
      rmTmpDir(projectB);
    }
  });

  test("project config takes precedence over env var", async () => {
    const customDir = path.join(projectDir, "project-wins");
    writeProjectConfig(projectDir, {
      "log-trace": { logging: { dir: customDir } },
    });
    process.env.LOG_TRACE_LOG_TRACE_LOGGING_DIR = "/tmp/env-wins";

    const configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(dataDir);

    const component = new LogTraceComponent();
    await component.init({
      name: "log-trace",
      version: "1.0.0",
      enabled: true,
      env: makeMockEnv(configComponent),
      options: { configComponent, cwd: projectDir },
    });

    expect(configComponent.get("log-trace.logging.dir")).toBe(customDir);

    component.stop?.();
  });

  test("missing ${cwd}/.roy/config.jsonc falls back to env / default gracefully", async () => {
    // No project config file written
    expect(fsSync.existsSync(path.join(projectDir, ".roy", "config.jsonc"))).toBe(false);

    const configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(dataDir);

    const component = new LogTraceComponent();
    await component.init({
      name: "log-trace",
      version: "1.0.0",
      enabled: true,
      env: makeMockEnv(configComponent),
      options: { configComponent, cwd: projectDir },
    });

    // Should not throw, should use default log dir (XDG_DATA_HOME-based)
    expect(component.getStatus()).toBe("running");
    const dir = configComponent.get("log-trace.logging.dir");
    expect(dir).toBeDefined();
    expect(typeof dir).toBe("string");

    component.stop?.();
  });

  test("global file config still works when project config absent", async () => {
    // The "global" config file lives at ${XDG_DATA_HOME}/logtrace-config.jsonc
    // (because LogTraceComponent registers it via configPath: "logtrace-config.jsonc")
    const globalCustomDir = path.join(projectDir, "from-global");
    fsSync.writeFileSync(
      path.join(dataDir, "logtrace-config.jsonc"),
      JSON.stringify({
        "log-trace": { logging: { dir: globalCustomDir } },
      }),
      "utf-8",
    );

    const configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(dataDir);

    const component = new LogTraceComponent();
    await component.init({
      name: "log-trace",
      version: "1.0.0",
      enabled: true,
      env: makeMockEnv(configComponent),
      options: { configComponent, configPath: "logtrace-config.jsonc", cwd: projectDir },
    });

    expect(configComponent.get("log-trace.logging.dir")).toBe(globalCustomDir);

    component.stop?.();
  });
});