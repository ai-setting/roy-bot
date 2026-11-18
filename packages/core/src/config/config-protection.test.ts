import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  PROTECTED_CONFIG_FILES,
  snapshotConfigDir,
  listSnapshots,
  appendAuditLog,
  readAuditLog,
  checkSourceCountDrop,
  readSourceCountFromDisk,
} from "./config-protection";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "config-protection-test-"));
  mkdirSync(join(home, ".roy-bot"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedConfig(dir: string, esSources: number) {
  writeFileSync(
    join(dir, "event-sources.json"),
    JSON.stringify({ version: "1.0.0", sources: Array.from({ length: esSources }, (_, i) => ({ id: `s${i}` })) }),
  );
  writeFileSync(join(dir, "config.jsonc"), "{}");
}

describe("PROTECTED_CONFIG_FILES", () => {
  test("includes the four critical config files", () => {
    for (const f of ["config.jsonc", "auth.json", "event-sources.json", "wecom-credentials.json"]) {
      expect(PROTECTED_CONFIG_FILES).toContain(f);
    }
  });
});

describe("snapshotConfigDir", () => {
  test("snapshots existing config files into snapshots/<ts>/", () => {
    seedConfig(join(home, ".roy-bot"), 3);
    const snapDir = snapshotConfigDir(join(home, ".roy-bot"));
    expect(snapDir).toBeTruthy();
    expect(existsSync(join(snapDir!, "event-sources.json"))).toBe(true);
    expect(existsSync(join(snapDir!, "config.jsonc"))).toBe(true);
    // content preserved
    const loaded = JSON.parse(readFileSync(join(snapDir!, "event-sources.json"), "utf-8"));
    expect(loaded.sources.length).toBe(3);
  });

  test("skips missing files without failing", () => {
    writeFileSync(join(home, ".roy-bot", "config.jsonc"), "{}");
    const snapDir = snapshotConfigDir(join(home, ".roy-bot"));
    expect(snapDir).toBeTruthy();
    expect(existsSync(join(snapDir!, "config.jsonc"))).toBe(true);
    expect(existsSync(join(snapDir!, "auth.json"))).toBe(false);
  });

  test("keeps at most N=10 snapshots, pruning oldest by name order", () => {
    const cfgDir = join(home, ".roy-bot");
    writeFileSync(join(cfgDir, "config.jsonc"), "{}");
    // pre-seed 10 fake snapshots with names that sort BEFORE any real
    // snapshotTimestamp() output (real format: 20261108T21-37-13-512Z,
    // all digits after the year — "0" prefix sorts first)
    const seeded: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = `0000-00-0${i}T00-00-00-000Z`;
      const d = join(cfgDir, "snapshots", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "config.jsonc"), "{}");
      seeded.push(name);
    }
    const snapDir = snapshotConfigDir(cfgDir)!;
    expect(snapDir).toBeTruthy();
    const snaps = listSnapshots(cfgDir);
    // exactly 10 remain
    expect(snaps.length).toBe(10);
    // the new snapshot survived
    expect(snaps).toContain(snapDir);
    // the pruned one is the OLDEST seeded name, not the newest snapshot
    const remainingNames = snaps.map((p) => p.split("/").pop());
    expect(remainingNames).not.toContain(seeded[0]); // oldest pruned
    for (let i = 1; i < 10; i++) {
      expect(remainingNames).toContain(seeded[i]); // rest kept
    }
  });

  test("returns null and does not throw when config dir missing", () => {
    const snapDir = snapshotConfigDir(join(home, "no-such-dir"));
    expect(snapDir).toBeNull();
  });
});

describe("appendAuditLog / readAuditLog", () => {
  test("appends one JSON line per write and readAuditLog parses them", () => {
    const cfgDir = join(home, ".roy-bot");
    appendAuditLog(cfgDir, { file: "event-sources.json", action: "pre-save-snapshot", detail: "3 sources" });
    appendAuditLog(cfgDir, { file: "config.jsonc", action: "save", detail: "manual" });
    const entries = readAuditLog(cfgDir);
    expect(entries.length).toBe(2);
    expect(entries[0].file).toBe("event-sources.json");
    expect(entries[1].action).toBe("save");
    // each entry has ts + pid
    expect(typeof entries[0].ts).toBe("string");
    expect(typeof entries[0].pid).toBe("number");
  });
});

describe("checkSourceCountDrop", () => {
  test("allows when count unchanged or increased", () => {
    expect(checkSourceCountDrop(11, 11).allowed).toBe(true);
    expect(checkSourceCountDrop(11, 12).allowed).toBe(true);
  });

  test("allows when previous count is 0 or unreadable", () => {
    expect(checkSourceCountDrop(0, 5).allowed).toBe(true);
    expect(checkSourceCountDrop(-1, 5).allowed).toBe(true);
  });

  test("blocks drop >30% (11 -> 1)", () => {
    const r = checkSourceCountDrop(11, 1);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("30%");
  });

  test("blocks drop >30% (3 -> 1)", () => {
    expect(checkSourceCountDrop(3, 1).allowed).toBe(false);
  });

  test("allows small drop <=30% (10 -> 8)", () => {
    expect(checkSourceCountDrop(10, 8).allowed).toBe(true);
  });

  test("boundary: exactly 30% drop is allowed, >30% blocked", () => {
    // 10 -> 7 = 30% drop exactly -> allowed
    expect(checkSourceCountDrop(10, 7).allowed).toBe(true);
    // 10 -> 6.9 not integer; use 20 -> 13 = 35% -> blocked
    expect(checkSourceCountDrop(20, 13).allowed).toBe(false);
  });
});

// helper removed (B1 fix): prune is by name order, mtime was dead code

// =============================================================================
// Task #5194 opencodego review MAJOR-1 修复 —— 写入面全覆盖（TDD RED）
// =============================================================================

import {
  guardConfigWrite,
  listSnapshots,
  readAuditLog,
  snapshotConfigDir,
} from "./config-protection";

describe("guardConfigWrite（MAJOR-1：护栏覆盖其余受保护文件写入路径）", () => {
  test("写前快照 + 写后审计（save），写入成功返回 true", () => {
    const cfgDir = join(home, ".roy-bot");
    writeFileSync(join(cfgDir, "config.jsonc"), '{"old":true}');
    const ok = guardConfigWrite(cfgDir, "config.jsonc", () => {
      writeFileSync(join(cfgDir, "config.jsonc"), '{"new":true}');
    });
    expect(ok).toBe(true);
    // 快照里是旧内容
    const snaps = listSnapshots(cfgDir);
    expect(snaps.length).toBe(1);
    const snapContent = readFileSync(join(snaps[0], "config.jsonc"), "utf-8");
    expect(snapContent).toBe('{"old":true}');
    // 审计含 pre-save-snapshot + save 两条
    const entries = readAuditLog(cfgDir);
    expect(entries.some((e) => e.action === "pre-save-snapshot" && e.file === "config.jsonc")).toBe(true);
    expect(entries.some((e) => e.action === "save" && e.file === "config.jsonc")).toBe(true);
  });

  test("写入抛错时返回 false，写前快照仍保留（可回滚）", () => {
    const cfgDir = join(home, ".roy-bot");
    writeFileSync(join(cfgDir, "auth.json"), '{"token":"keep"}');
    const ok = guardConfigWrite(cfgDir, "auth.json", () => {
      throw new Error("boom");
    });
    expect(ok).toBe(false);
    // 快照存在且为旧内容
    const snaps = listSnapshots(cfgDir);
    expect(snaps.length).toBe(1);
    expect(readFileSync(join(snaps[0], "auth.json"), "utf-8")).toBe('{"token":"keep"}');
    // 审计记录 write-failed
    const entries = readAuditLog(cfgDir);
    expect(entries.some((e) => e.action === "write-failed" && e.file === "auth.json")).toBe(true);
  });

  test("快照目录权限 0700、快照内文件权限 0600（MINOR-5：凭据不比原件更宽）", () => {
    const cfgDir = join(home, ".roy-bot");
    writeFileSync(join(cfgDir, "auth.json"), '{"token":"t"}');
    const ok = guardConfigWrite(cfgDir, "auth.json", () => {
      writeFileSync(join(cfgDir, "auth.json"), '{"token":"t2"}');
    });
    expect(ok).toBe(true);
    const snapDir = listSnapshots(cfgDir)[0];
    const dirMode = readdirSync(snapDir) && (require("fs").statSync(snapDir).mode & 0o777);
    expect(dirMode).toBe(0o700);
    const fileMode = (require("fs").statSync(join(snapDir, "auth.json")).mode & 0o777);
    expect(fileMode).toBe(0o600);
  });
});

describe("readSourceCountFromDisk（MINOR-9：补单测）", () => {
  test("正常计数 / 缺失 -1 / 损坏 -1 / 无 sources 数组 -1", () => {
    const cfgDir = join(home, ".roy-bot");
    const p = join(cfgDir, "event-sources.json");
    // 正常
    writeFileSync(p, JSON.stringify({ version: "1.0.0", sources: [{ id: "a" }, { id: "b" }] }));
    expect(readSourceCountFromDisk(p)).toBe(2);
    // 缺失
    expect(readSourceCountFromDisk(join(cfgDir, "no-such.json"))).toBe(-1);
    // 损坏
    writeFileSync(p, "{not json");
    expect(readSourceCountFromDisk(p)).toBe(-1);
    // 无 sources 数组
    writeFileSync(p, JSON.stringify({ version: "1.0.0" }));
    expect(readSourceCountFromDisk(p)).toBe(-1);
  });
});
