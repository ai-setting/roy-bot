/**
 * Task #4804 — provider 分离：goal-decision（completion hook）专用 provider
 *
 * 背景（#4798 e2e）：completion hook 与 create hook 共用
 * `providers["laya-decision"]`（model=task-decision / v3-tags），
 * 而 v13e（task-completion ckpt）对「部分完成」形态判 FAIL 0.97，
 * 接上即可 fire。用户明令：completion hook 用独立 provider。
 *
 * 设计（保守回退）：
 *   - `loadLayaAuthForPurpose(path, "goal")` 读专用 provider
 *   - completion hook 侧 resolvePort 顺序：
 *     laya-goal-decision（专用）→ laya-decision（共享回退）→ null（fail-open）
 *   - create hook 不动：继续读 laya-decision
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  loadLayaAuth,
  loadLayaAuthForPurpose,
  LAYA_DECISION_PROVIDER,
  LAYA_GOAL_DECISION_PROVIDER,
} from "./laya-port";

let dir: string;
try {
  dir = mkdtempSync(join(tmpdir(), "laya-goal-provider-"));
} catch {
  dir = "/tmp";
}

function writeAuth(providers: Record<string, unknown>): string {
  const p = join(dir, `auth-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ providers }));
  return p;
}

describe("Task #4804 — provider 分离（goal-decision）", () => {
  test("常量导出且值正确", () => {
    expect(LAYA_DECISION_PROVIDER).toBe("laya-decision");
    expect(LAYA_GOAL_DECISION_PROVIDER).toBe("laya-goal-decision");
  });

  test("loadLayaAuthForPurpose('goal') 读 laya-goal-decision", async () => {
    const p = writeAuth({
      "laya-goal-decision": {
        baseURL: "http://localhost:8901",
        apiKey: "k1",
        model: "task-completion",
      },
      "laya-decision": {
        baseURL: "http://other:1",
        apiKey: "k2",
        model: "task-decision",
      },
    });
    const cfg = await loadLayaAuthForPurpose(p, "goal");
    expect(cfg).toEqual({
      baseURL: "http://localhost:8901",
      apiKey: "k1",
      model: "task-completion",
    });
  });

  test("goal 专用缺失 → 回退 laya-decision（保守共享）", async () => {
    const p = writeAuth({
      "laya-decision": {
        baseURL: "http://localhost:8901",
        apiKey: "k2",
        model: "task-decision",
      },
    });
    const cfg = await loadLayaAuthForPurpose(p, "goal");
    expect(cfg).toEqual({
      baseURL: "http://localhost:8901",
      apiKey: "k2",
      model: "task-decision",
    });
  });

  test("两者都缺失 → null（fail-open）", async () => {
    const p = writeAuth({ openai: { baseURL: "x", apiKey: "y" } });
    expect(await loadLayaAuthForPurpose(p, "goal")).toBeNull();
    expect(await loadLayaAuthForPurpose(p, "create")).toBeNull();
  });

  test("create 用途只读 laya-decision（不回退到 goal 专用）", async () => {
    const p = writeAuth({
      "laya-goal-decision": {
        baseURL: "http://goal-only:1",
        apiKey: "k1",
        model: "task-completion",
      },
    });
    expect(await loadLayaAuthForPurpose(p, "create")).toBeNull();
  });

  test("loadLayaAuth(path) 默认行为不变（向后兼容）", async () => {
    const p = writeAuth({
      "laya-decision": {
        baseURL: "http://127.0.0.1:8901",
        apiKey: "k",
        model: "task-decision",
      },
    });
    expect(await loadLayaAuth(p)).toEqual({
      baseURL: "http://127.0.0.1:8901",
      apiKey: "k",
      model: "task-decision",
    });
  });
});

describe("Task #4804 — DS 复审 round-4（MINOR-3）", () => {
  test("goal provider 漏写 model → 兜底 task-completion（不是 task-decision）", async () => {
    const p = writeAuth({
      "laya-goal-decision": { baseURL: "http://g:1", apiKey: "k" },
      "laya-decision": {
        baseURL: "http://c:1",
        apiKey: "k2",
        model: "task-decision",
      },
    });
    const cfg = await loadLayaAuthForPurpose(p, "goal");
    expect(cfg?.model).toBe("task-completion");
  });

  test("create 用途漏写 model → 仍兜底 task-decision（不变）", async () => {
    const p = writeAuth({
      "laya-decision": { baseURL: "http://c:1", apiKey: "k" },
    });
    const cfg = await loadLayaAuthForPurpose(p, "create");
    expect(cfg?.model).toBe("task-decision");
  });
});
