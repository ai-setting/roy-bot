import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLATFORM_BINARIES,
  buildTrimmedManifest,
  createRestoreGuard,
  parseFlagValue,
  parsePlatformList,
  parseRegistryTimeoutSec,
  partitionBinaries,
  pruneStaleBinaries,
  restorePrunedBinaries,
} from "../publish-full-helpers";

const buildStartedAt = Date.parse("2026-10-22T10:00:00.000Z");

describe("partitionBinaries", () => {
  test("splits freshly built binaries from stale leftovers by mtime", () => {
    const mtimes = {
      "roy-bot-linux-x64": buildStartedAt + 12_000, // 本次构建
      "roy-bot-darwin-arm64": Date.parse("2026-08-15T14:44:00.000Z"), // 8 月旧产物
      "roy-bot-darwin-x64": Date.parse("2026-08-15T14:44:00.000Z"),
      "roy-bot-linux-arm64": Date.parse("2026-08-15T14:44:00.000Z"),
      "roy-bot-windows-x64.exe": Date.parse("2026-08-15T14:44:00.000Z"),
    };

    const { fresh, stale } = partitionBinaries(mtimes, buildStartedAt);

    expect(fresh.map(p => p.tag)).toEqual(["linux-x64"]);
    expect(stale.map(p => p.tag).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "windows-x64",
    ]);
  });

  test("ignores binaries that do not exist", () => {
    const { fresh, stale } = partitionBinaries(
      { "roy-bot-linux-x64": buildStartedAt + 1, "roy-bot-darwin-x64": undefined },
      buildStartedAt
    );

    expect(fresh.map(p => p.tag)).toEqual(["linux-x64"]);
    expect(stale).toEqual([]);
  });

  test("treats everything as fresh when the build timestamp is unknown", () => {
    const mtimes = Object.fromEntries(
      PLATFORM_BINARIES.map(p => [p.file, Date.parse("2026-01-01T00:00:00.000Z")])
    );

    const { fresh, stale } = partitionBinaries(mtimes, 0);

    expect(fresh).toHaveLength(PLATFORM_BINARIES.length);
    expect(stale).toHaveLength(0);
  });
});

describe("buildTrimmedManifest", () => {
  const pkgJson = {
    name: "@ai-setting/roy-bot-standalone",
    version: "1.7.56",
    type: "module",
    files: ["bin/**/*"],
    os: ["linux", "darwin", "win32"],
    cpu: ["x64", "arm64"],
    bin: {
      "roy-bot": "bin/run.js",
      "roy-bot-linux-x64": "bin/roy-bot-linux-x64",
      "roy-bot-darwin-x64": "bin/roy-bot-darwin-x64",
      "roy-bot-linux-arm64": "bin/roy-bot-linux-arm64",
      "roy-bot-windows-x64": "bin/roy-bot-windows-x64.exe",
      "roy-bot-darwin-arm64": "bin/roy-bot-darwin-arm64",
    },
    publishConfig: { registry: "https://registry.npmjs.org", access: "public" },
  };

  test("single-platform publish only ships that platform's binary", () => {
    const linuxX64 = PLATFORM_BINARIES.find(p => p.tag === "linux-x64")!;
    const trimmed = buildTrimmedManifest(pkgJson, [linuxX64]);

    expect(trimmed.files).toEqual(["bin/run.js", "bin/roy-bot-linux-x64"]);
    expect(trimmed.os).toEqual(["linux"]);
    expect(trimmed.cpu).toEqual(["x64"]);
    expect(trimmed.bin).toEqual({
      "roy-bot": "./bin/run.js",
      "roy-bot-linux-x64": "./bin/roy-bot-linux-x64",
    });
    // 其它字段保持不变
    expect(trimmed.version).toBe("1.7.56");
    expect(trimmed.publishConfig).toEqual(pkgJson.publishConfig);
  });

  test("all-platform publish keeps all five platforms with deduped os/cpu", () => {
    const trimmed = buildTrimmedManifest(pkgJson, PLATFORM_BINARIES);

    expect(trimmed.files).toHaveLength(1 + PLATFORM_BINARIES.length);
    expect(trimmed.os).toEqual(["linux", "darwin", "win32"]);
    expect(trimmed.cpu).toEqual(["x64", "arm64"]);
    expect(Object.keys(trimmed.bin)).toHaveLength(1 + PLATFORM_BINARIES.length);
  });

  test("bin paths always carry the ./ prefix that npm expects", () => {
    const trimmed = buildTrimmedManifest(pkgJson, PLATFORM_BINARIES);

    for (const target of Object.values(trimmed.bin)) {
      expect(target.startsWith("./")).toBe(true);
    }
  });
});

describe("pruneStaleBinaries / restorePrunedBinaries", () => {
  function makeSandbox() {
    const root = join(tmpdir(), `standalone-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(root, "bin");
    const holdingDir = join(root, "holding");
    mkdirSync(binDir, { recursive: true });
    return { root, binDir, holdingDir };
  }

  test("moves stale binaries out of bin/ and restores them afterwards", () => {
    const { root, binDir, holdingDir } = makeSandbox();
    const keep = PLATFORM_BINARIES.find(p => p.tag === "linux-x64")!;
    const drop = PLATFORM_BINARIES.find(p => p.tag === "darwin-arm64")!;

    writeFileSync(join(binDir, "run.js"), "// launcher");
    writeFileSync(join(binDir, keep.file), "fresh binary");
    writeFileSync(join(binDir, drop.file), "august binary");

    const moved = pruneStaleBinaries(binDir, [drop], holdingDir);

    expect(moved).toEqual([drop.file]);
    // tarball 只会看到 run.js + 当前平台二进制
    expect(readdirSync(binDir).sort()).toEqual([keep.file, "run.js"].sort());
    expect(existsSync(join(holdingDir, drop.file))).toBe(true);

    restorePrunedBinaries(binDir, holdingDir, moved);

    expect(readdirSync(binDir).sort()).toEqual([drop.file, keep.file, "run.js"].sort());
    expect(existsSync(holdingDir)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("ignores files that are already gone", () => {
    const { root, binDir, holdingDir } = makeSandbox();
    const drop = PLATFORM_BINARIES.find(p => p.tag === "windows-x64")!;

    expect(pruneStaleBinaries(binDir, [drop], holdingDir)).toEqual([]);
    expect(existsSync(holdingDir)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

// ============================================================
// 回归测试（交叉验证 ❌ FAIL 的 4 个 blocker，见 Task #4506）
// ============================================================

describe("partitionBinaries mtime tolerance", () => {
  test("a binary written in the same second as the build start still counts as fresh", () => {
    // 文件系统 mtime 粒度可能是 1s，构建开始与产物落盘可能同秒
    const justBefore = buildStartedAt - 500;
    const { fresh, stale } = partitionBinaries(
      { "roy-bot-linux-x64": justBefore },
      buildStartedAt
    );

    expect(fresh.map(p => p.tag)).toEqual(["linux-x64"]);
    expect(stale).toEqual([]);
  });

  test("a binary from an earlier build is still stale despite the tolerance", () => {
    const { fresh, stale } = partitionBinaries(
      { "roy-bot-linux-x64": buildStartedAt - 60_000 },
      buildStartedAt
    );

    expect(fresh).toEqual([]);
    expect(stale.map(p => p.tag)).toEqual(["linux-x64"]);
  });
});

describe("restorePrunedBinaries must never destroy unknown leftovers", () => {
  function makeSandbox() {
    const root = join(tmpdir(), `standalone-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(root, "bin");
    const holdingDir = join(root, "holding");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(holdingDir, { recursive: true });
    return { root, binDir, holdingDir };
  }

  test("keeps files stranded by a previous interrupted run instead of rm -rf'ing them", () => {
    const { root, binDir, holdingDir } = makeSandbox();
    const stranded = "roy-bot-darwin-arm64";
    writeFileSync(join(holdingDir, stranded), "august binary from a crashed run");

    // 本轮没有任何需要还原的文件（movedFiles 为空）
    const result = restorePrunedBinaries(binDir, holdingDir, []);

    expect(result.restored).toEqual([]);
    expect(result.leftovers).toEqual([stranded]);
    // 关键：不能删掉它
    expect(existsSync(join(holdingDir, stranded))).toBe(true);
    expect(readFileSync(join(holdingDir, stranded), "utf-8")).toContain("crashed run");

    rmSync(root, { recursive: true, force: true });
  });

  test("removes the holding dir only when it is empty after restoring", () => {
    const { root, binDir, holdingDir } = makeSandbox();
    const drop = PLATFORM_BINARIES.find(p => p.tag === "darwin-x64")!;
    writeFileSync(join(holdingDir, drop.file), "moved this run");

    const result = restorePrunedBinaries(binDir, holdingDir, [drop.file]);

    expect(result.restored).toEqual([drop.file]);
    expect(result.leftovers).toEqual([]);
    expect(existsSync(join(binDir, drop.file))).toBe(true);
    expect(existsSync(holdingDir)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("pruneStaleBinaries collision safety", () => {
  test("refuses to overwrite a file stranded in the holding dir by a previous run", () => {
    const root = join(tmpdir(), `standalone-collision-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(root, "bin");
    const holdingDir = join(root, "holding");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(holdingDir, { recursive: true });
    const drop = PLATFORM_BINARIES.find(p => p.tag === "darwin-arm64")!;
    writeFileSync(join(binDir, drop.file), "current binary");
    writeFileSync(join(holdingDir, drop.file), "stranded binary from before");

    expect(() => pruneStaleBinaries(binDir, [drop], holdingDir)).toThrow(/holding/i);
    // 两个文件都不能丢
    expect(readFileSync(join(binDir, drop.file), "utf-8")).toBe("current binary");
    expect(readFileSync(join(holdingDir, drop.file), "utf-8")).toBe("stranded binary from before");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("createRestoreGuard", () => {
  function fakeSignalTarget() {
    const handlers = new Map<string, Array<() => void>>();
    return {
      handlers,
      on(event: string, listener: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener]);
      },
      off(event: string, listener: () => void) {
        handlers.set(event, (handlers.get(event) ?? []).filter(l => l !== listener));
      },
      fire(event: string) {
        for (const l of handlers.get(event) ?? []) l();
      },
    };
  }

  test("restores exactly once even if called repeatedly", () => {
    const target = fakeSignalTarget();
    let calls = 0;
    const guard = createRestoreGuard(() => calls++, target, () => {});

    guard.runRestore();
    guard.runRestore();
    target.fire("SIGINT");

    expect(calls).toBe(1);
  });

  test("runs the restore when the process is interrupted, then exits with a signal code", () => {
    const target = fakeSignalTarget();
    const restored: string[] = [];
    const exits: number[] = [];
    createRestoreGuard(() => restored.push("restored"), target, code => exits.push(code));

    target.fire("SIGINT");
    target.fire("SIGTERM");

    expect(restored).toEqual(["restored"]);
    expect(exits).toEqual([130]);
  });

  test("still restores when the restore callback itself throws", () => {
    const target = fakeSignalTarget();
    const exits: number[] = [];
    createRestoreGuard(
      () => {
        throw new Error("restore exploded");
      },
      target,
      code => exits.push(code)
    );

    expect(() => target.fire("SIGINT")).not.toThrow();
    expect(exits).toEqual([130]);
  });

  test("stops listening to signals after dispose", () => {
    const target = fakeSignalTarget();
    let calls = 0;
    const guard = createRestoreGuard(() => calls++, target, () => {});

    guard.dispose();
    target.fire("SIGINT");

    expect(calls).toBe(0);
  });
});

describe("parseFlagValue", () => {
  test("supports both --flag=value and --flag value", () => {
    expect(parseFlagValue(["--tag=beta"], "--tag")).toBe("beta");
    expect(parseFlagValue(["--tag", "beta"], "--tag")).toBe("beta");
  });

  test("does not truncate values that contain '='", () => {
    expect(parseFlagValue(["--tag=a=b"], "--tag")).toBe("a=b");
  });

  test("returns undefined when the flag is absent", () => {
    expect(parseFlagValue(["--dry-run"], "--tag")).toBeUndefined();
  });

  test("does not treat a longer flag as a prefix match", () => {
    expect(parseFlagValue(["--tagline=beta"], "--tag")).toBeUndefined();
  });
});

describe("parseRegistryTimeoutSec", () => {
  test("falls back to the default when the flag is absent", () => {
    expect(parseRegistryTimeoutSec([], 1500)).toBe(1500);
  });

  test("parses a valid timeout", () => {
    expect(parseRegistryTimeoutSec(["--registry-timeout=1800"], 1500)).toBe(1800);
  });

  test("throws on a non-numeric value instead of producing NaN (which never times out)", () => {
    expect(() => parseRegistryTimeoutSec(["--registry-timeout=abc"], 1500)).toThrow(/registry-timeout/);
  });

  test("throws on an empty value instead of silently skipping the wait", () => {
    expect(() => parseRegistryTimeoutSec(["--registry-timeout="], 1500)).toThrow(/registry-timeout/);
  });

  test("throws on zero, negative and Infinity", () => {
    for (const bad of ["0", "-5", "Infinity"]) {
      expect(() => parseRegistryTimeoutSec([`--registry-timeout=${bad}`], 1500)).toThrow(/registry-timeout/);
    }
  });
});

describe("parsePlatformList", () => {
  test("defaults to the current platform", () => {
    expect(parsePlatformList(undefined, "linux-x64").map(p => p.tag)).toEqual(["linux-x64"]);
  });

  test("accepts a comma separated list", () => {
    expect(parsePlatformList("linux-x64,darwin-arm64", "linux-x64").map(p => p.tag)).toEqual([
      "linux-x64",
      "darwin-arm64",
    ]);
  });

  test("rejects an unknown platform tag", () => {
    expect(() => parsePlatformList("linux-riscv64", "linux-x64")).toThrow(/linux-riscv64/);
  });
});
