/**
 * @fileoverview Task #5063 — CLI `tasks complete --archive` 端到端回归
 *
 * 背景（Task #5060 的 follow-up，DS review 留档 MINOR m2）：
 *   `packages/cli/src/commands/tasks/complete.ts` 的 `--archive` 分支原来只设
 *   `status: "archived"`，**不写 current_status** ⇒ 归档后任务卡片仍显示
 *   归档前的旧文案（「调研中：…」），与 #5060 修掉的 bug 一模一样，只是入口不同。
 *
 * 本测试用**真实** TaskComponent（真 sqlite 临时库）驱动 CLI handler，
 * 完整走通 CLI → TaskComponent → store → 回读 的链路，
 * 验证：status=archived 且 current_status 含「已归档」语义。
 *
 * 断言策略：用真实 TaskComponent 而不是 mock —— mock 只能证明
 * 「CLI 传了什么参数」，证不了「落库后 current_status 真的对」。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "@ai-setting/roy-bot-core";
import { ConfigComponent } from "../../../../core/src/config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

describe("Task #5063 — CLI tasks complete --archive 同步 current_status", () => {
  let taskComponent: TaskComponent;
  let dbPath: string;
  let taskId: number;
  let capturedOutput: { lines: string[]; json: unknown };

  beforeEach(async () => {
    capturedOutput = { lines: [], json: null };

    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    dbPath = join(
      tmpdir(),
      `task-5063-cli-archive-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    await taskComponent.init({
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath } },
      },
    });

    // 建一个任务，并塞一句「还在推进」的旧文案（复现 stale 场景）
    const created = await (taskComponent as any).store.createTask({
      title: "CLI archive target",
      status: "active",
      current_status: "调研中：检索 GitHub 仓库",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_init",
    });
    taskId = created.id;
  });

  afterEach(async () => {
    await taskComponent.stop();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          // 清理失败不影响测试结论
        }
      }
    }
  });

  it("tasks complete --archive → status=archived 且 current_status 含「已归档」", async () => {
    // mock 环境服务，把真实 TaskComponent 注入 CLI handler
    const { mock } = await import("bun:test");
    mock.module("../../services/environment.service", () => ({
      EnvironmentService: class {
        async create(_opts: unknown) {}
        getEnvironment() {
          return {
            getComponent: (name: string) => {
              if (name === "session") {
                return { getActiveSessionId: () => "cli-test-session" };
              }
              if (name === "task") return taskComponent;
              return undefined;
            },
          };
        }
        async dispose() {}
      },
    }));
    mock.module("../../services/output.service", () => ({
      OutputService: class {
        log(line: string) {
          capturedOutput.lines.push(line);
        }
        error(_line: string) {}
        info(_line: string) {}
        success(_line: string) {}
        json(obj: unknown) {
          capturedOutput.json = obj;
        }
      },
    }));

    // 动态 import（必须在 mock.module 之后）
    const { CompleteCommand } = (await import("./complete")) as any;

    await (CompleteCommand.handler as (a: Record<string, unknown>) => Promise<void>)({
      id: taskId,
      archive: true,
    });

    // 回读真实落库结果
    const task = await taskComponent.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe("archived");
    expect(task!.current_status).toContain("已归档");
    // 旧的 stale 文案必须被覆盖掉
    expect(task!.current_status).not.toContain("调研中");
  });
});
