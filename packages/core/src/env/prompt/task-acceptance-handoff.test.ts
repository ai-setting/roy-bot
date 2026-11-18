/**
 * @fileoverview Task #5007 — 验收权移交：default agent ↔ roy sub-agent 契约测试
 *
 * 架构意图（用户原话）：
 *   「给 default agent 添加 task complete 和 task cancel/stop 工具，
 *     将这个工具从 roy sub agent 中干掉。整体逻辑是让 default agent
 *     来完成任务验收的动作。从而触发 goal 检查的 decision model 调用进行判断。
 *     roy sub agent 只是更新操作记录包括进度，进度达到它认为的 100%
 *     它就认为任务完成，可以结束返回给主智能体响应了。」
 *
 * 好处：
 *   ① 验收放到另一个智能体（主智能体而非 roy）—— 裁判和运动员不同人
 *   ② sub agent 可能超时或未更新任务完成状态 ⇒ 任务状态未同步；
 *      主智能体可检查并补更新，或按用户要求 cancel/stop
 *
 * 本测试守住四条契约：
 *   A. default agent **有** task_complete + task_cancel（验收权在手）
 *   B. roy sub-agent **没有** task_complete（只执行 + 记操作记录 + 报进度）
 *   C. 两处 prompt 语义同步（default = 验收方；roy = 执行方）
 *   D. goal 检查链路未被破坏（task:after.complete hook 仍由 completeTask 触发）
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtInPrompts } from "./prompts-index";

const repoFile = (rel: string): string => {
  const self = fileURLToPath(import.meta.url);
  // packages/core/src/env/prompt/<file> → repo root
  const repoRoot = self.replace(/\/packages\/core\/src\/env\/prompt\/.*$/, "");
  return readFileSync(`${repoRoot}/${rel}`, "utf-8");
};

describe("Task #5007 — 验收权移交（default agent 接管验收）", () => {
  const defaultPrompt = builtInPrompts["default"];
  const royPrompt = builtInPrompts["roy"];

  // ============================================================
  // A. 工具集契约
  // ============================================================

  describe("A. default agent 工具集", () => {
    test("A1. defaultDeniedTools 不再包含 task_complete（验收权移交）", () => {
      const envSrc = repoFile("packages/core/src/env/environment.ts");
      const m = envSrc.match(/defaultDeniedTools\s*=\s*\[([\s\S]*?)\]/);
      expect(m, "必须能定位 defaultDeniedTools 数组").not.toBeNull();
      expect(m![1]).not.toMatch(/["']task_complete["']/);
    });

    test("A2. defaultDeniedTools 禁止 task_create / task_update，已解锁 task_operation_create（执行与验收分离，但操作记录可作通信介质）", () => {
      const envSrc = repoFile("packages/core/src/env/environment.ts");
      const m = envSrc.match(/defaultDeniedTools\s*=\s*\[([\s\S]*?)\]/);
      expect(m).not.toBeNull();
      // task_create / task_update 仍禁止（执行与验收分离）
      for (const t of ["task_create", "task_update"]) {
        expect(m![1], `defaultDeniedTools 应仍禁止 ${t}`).toMatch(
          new RegExp(`["']${t}["']`),
        );
      }
      // task_operation_create 已解锁 —— default agent 可用它记录用户反馈，
      // 使操作记录成为 agents 间的通信介质
      expect(m![1], "defaultDeniedTools 应不再禁止 task_operation_create").not.toMatch(
        /["']task_operation_create["']/,
      );
    });

    test("A3. task_cancel 工具已注册到 TaskComponent（default 可用）", async () => {
      const { TaskComponent } = await import("../task/task-component");
      const { ConfigComponent } = await import("../../config/config-component");
      const { tmpdir } = await import("os");
      const { join } = await import("path");

      const configComponent = new ConfigComponent();
      const taskComponent = new TaskComponent();
      await taskComponent.init({
        options: {
          configComponent,
          config: {
            storage: {
              type: "sqlite",
              dbPath: join(
                tmpdir(),
                `task-5007-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
              ),
            },
          },
        },
      });

      const registered: string[] = [];
      const fakeToolComponent = {
        register: (t: any) => {
          registered.push(t.name);
        },
      };
      (taskComponent as any).toolComponent = fakeToolComponent;
      await (taskComponent as any).registerTools();

      expect(registered).toContain("task_cancel");
      expect(registered).toContain("task_complete");
      await taskComponent.stop();
    });
  });

  describe("B. roy sub-agent 工具集", () => {
    test("B1. registerRoyAgent 的 deniedTools 包含 task_complete", () => {
      const src = repoFile("packages/core/src/env/agent/agent-registry.ts");
      const m = src.match(/registerRoyAgent\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/);
      expect(m, "必须能定位 registerRoyAgent 实现").not.toBeNull();
      expect(m![1]).toMatch(/deniedTools\s*:\s*\[[^\]]*["']task_complete["']/);
    });

    test("B1b. roy deniedTools 也含 task_cancel（取消同属验收侧能力）", () => {
      const src = repoFile("packages/core/src/env/agent/agent-registry.ts");
      const m = src.match(/registerRoyAgent\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/);
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(/deniedTools\s*:\s*\[[^\]]*["']task_cancel["']/);
    });

    test("B1c. delegate-tool builtInSubAgents 的 roy 条目同步（双写点一致）", () => {
      const src = repoFile("packages/core/src/env/task/delegate/delegate-tool.ts");
      // 定位 builtInSubAgents 里 id: "roy" 的条目
      const m = src.match(/id:\s*"roy",[\s\S]*?deniedTools:\s*\[([^\]]*)\]/);
      expect(m, "必须能定位 builtInSubAgents 的 roy 条目").not.toBeNull();
      expect(m![1]).toContain("task_complete");
      expect(m![1]).toContain("task_cancel");
    });

    test("B2. roy 仍保留 task_create / task_update / task_operation_create（执行方要能记操作记录）", () => {
      const src = repoFile("packages/core/src/env/agent/agent-registry.ts");
      const m = src.match(/registerRoyAgent\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/);
      expect(m).not.toBeNull();
      // 没设 allowedTools ⇒ 不设白名单即全量可见；deniedTools 里不得出现这三个
      for (const t of ["task_create", "task_update", "task_operation_create"]) {
        expect(m![1], `roy deniedTools 不应含 ${t}`).not.toMatch(
          new RegExp(`["']${t}["']`),
        );
      }
    });
  });

  // ============================================================
  // B'. 绕过防线：sub-agent 不能用 task_update 偷跑终态
  // ============================================================

  describe("B'. 验收权绕过防线", () => {
    async function makeEnv(suffix: string) {
      const { TaskComponent } = await import("../task/task-component");
      const { ConfigComponent } = await import("../../config/config-component");
      const { tmpdir } = await import("os");
      const { join } = await import("path");

      const configComponent = new ConfigComponent();
      const taskComponent = new TaskComponent();
      await taskComponent.init({
        options: {
          configComponent,
          config: {
            storage: {
              type: "sqlite",
              dbPath: join(
                tmpdir(),
                `task-5007-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
              ),
            },
          },
        },
      });
      return taskComponent;
    }

    /** 把 taskComponent 接到一个假 agentComponent，用于按 agent 配置判定权限 */
    function attachAgent(
      taskComponent: any,
      name: string,
      config: { allowedTools?: string[]; deniedTools?: string[] },
    ) {
      taskComponent.env = {
        getComponent: (n: string) =>
          n === "agent" ? { getAgent: (nm: string) => (nm === name ? { config } : undefined) } : undefined,
      };
    }

    test("B'1. 无验收权限的 sub agent 被拒绝置 completed", async () => {
      const { updateTaskTool } = await import("../task/tools/update-tool");
      const taskComponent = await makeEnv("bypass");
      // 模拟 roy：type=sub + deniedTools 含 task_complete
      attachAgent(taskComponent, "roy", {
        deniedTools: ["delegate_task", "stop_task", "task_complete", "task_cancel"],
      });

      const created = await (taskComponent as any).store.createTask({
        title: "Bypass Me",
        project_path: "unknown",
        context: "{}",
        sessionId: "sess_bypass",
      });

      const tool = updateTaskTool(taskComponent);
      const res = await tool.execute(
        { task_id: created.id, status: "completed" },
        { session_id: "sess_bypass", metadata: { agentType: "sub", agentName: "roy" } },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain("验收权分离");

      const after = await taskComponent.getTask(created.id);
      expect(after!.status).not.toBe("completed");

      await taskComponent.stop();
    });

    test("B'2. primary agent（验收方）仍可用 task_update 置 completed", async () => {
      const { updateTaskTool } = await import("../task/tools/update-tool");
      const taskComponent = await makeEnv("primary");
      // 模拟 default：type=primary + deniedTools 不含 task_complete
      attachAgent(taskComponent, "default", {
        deniedTools: ["task_create", "task_update", "task_operation_create"],
      });

      const created = await (taskComponent as any).store.createTask({
        title: "Primary Can",
        project_path: "unknown",
        context: "{}",
        sessionId: "sess_primary",
      });

      const tool = updateTaskTool(taskComponent);
      const res = await tool.execute(
        { task_id: created.id, status: "completed" },
        { session_id: "sess_primary", metadata: { agentType: "primary", agentName: "default" } },
      );

      expect(res.success).toBe(true);
      await taskComponent.stop();
    });

    test("B'2b. task-organizer（type=sub 但被授权 task_complete）不被误伤", async () => {
      const { updateTaskTool } = await import("../task/tools/update-tool");
      const taskComponent = await makeEnv("organizer");
      // task-organizer 是 sub，但 allowedTools 白名单里明确含 task_complete
      attachAgent(taskComponent, "task-organizer", {
        allowedTools: [
          "task_create",
          "task_update",
          "task_complete",
          "task_operation_create",
        ],
      });

      const created = await (taskComponent as any).store.createTask({
        title: "Organizer Can",
        project_path: "unknown",
        context: "{}",
        sessionId: "sess_org",
      });

      const tool = updateTaskTool(taskComponent);
      const res = await tool.execute(
        { task_id: created.id, status: "completed" },
        {
          session_id: "sess_org",
          metadata: { agentType: "sub", agentName: "task-organizer" },
        },
      );

      expect(res.success).toBe(true);
      await taskComponent.stop();
    });

    // ── default-deny：身份解析失败时必须**拒绝**，不能 fail-open ──
    // review r3 MAJOR：cfg === undefined 时旧逻辑求值为 true ⇒ 放行，
    // 方向反了（「查不到身份」= 假定有验收权）。以下 2 条锁死 default-deny。
    test("B'2b. agentName 缺失（无法解析身份）⇒ 仍拒绝 completed（default-deny）", async () => {
      const { updateTaskTool } = await import("../task/tools/update-tool");
      const taskComponent = await makeEnv("failopen-name");

      const created = await (taskComponent as any).store.createTask({
        title: "No AgentName",
        project_path: "unknown",
        context: "{}",
        sessionId: "sess_noname",
      });

      const tool = updateTaskTool(taskComponent);
      const res = await tool.execute(
        { task_id: created.id, status: "completed" },
        // 只有 agentType，没有 agentName ⇒ registry 查不到 ⇒ 必须拒绝
        { session_id: "sess_noname", metadata: { agentType: "sub" } },
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/acceptance permission|验收权分离/);
      const after = await taskComponent.getTask(created.id);
      expect(after!.status).not.toBe("completed");

      await taskComponent.stop();
    });

    test("B'2c. agentName 存在但 registry 查不到 ⇒ 仍拒绝 completed（default-deny）", async () => {
      const { updateTaskTool } = await import("../task/tools/update-tool");
      const taskComponent = await makeEnv("failopen-ghost");

      const created = await (taskComponent as any).store.createTask({
        title: "Ghost Agent",
        project_path: "unknown",
        context: "{}",
        sessionId: "sess_ghost",
      });

      const tool = updateTaskTool(taskComponent);
      const res = await tool.execute(
        { task_id: created.id, status: "completed" },
        // 未注册的 agent 名 ⇒ cfg 为 undefined ⇒ 必须拒绝（不能当作"有权限"）
        {
          session_id: "sess_ghost",
          metadata: { agentType: "sub", agentName: "ghost-agent-not-registered" },
        },
      );

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/acceptance permission|验收权分离/);
      const after = await taskComponent.getTask(created.id);
      expect(after!.status).not.toBe("completed");

      await taskComponent.stop();
    });

    test("B'3. sub-agent 仍可推进进度到 100%（执行方正当收尾）", async () => {
      const { updateTaskTool } = await import("../task/tools/update-tool");
      const taskComponent = await makeEnv("progress");
      attachAgent(taskComponent, "roy", {
        deniedTools: ["task_complete", "task_cancel"],
      });

      const created = await (taskComponent as any).store.createTask({
        title: "Progress OK",
        project_path: "unknown",
        context: "{}",
        sessionId: "sess_prog",
      });

      const tool = updateTaskTool(taskComponent);
      const res = await tool.execute(
        { task_id: created.id, progress: 100 },
        { session_id: "sess_prog", metadata: { agentType: "sub", agentName: "roy" } },
      );

      expect(res.success).toBe(true);
      const after = await taskComponent.getTask(created.id);
      expect(after!.progress).toBe(100);
      expect(after!.status).not.toBe("completed");

      await taskComponent.stop();
    });
  });

  // ============================================================
  // C. prompt 语义契约
  // ============================================================

  describe("C. default prompt 验收语义", () => {
    test("C1. default prompt 明确自己承担任务验收职责", () => {
      expect(defaultPrompt).toContain("验收");
      expect(defaultPrompt).toMatch(/验收[^\n]*task_complete|task_complete[^\n]*验收/);
    });

    test("C2. default prompt 的工具表包含 task_complete 与 task_cancel", () => {
      // 用行首标题做锚点，避免匹配到澄清段落里的行内引用 "## 你的工具"
      const tableMatch = defaultPrompt.match(/^## 你的工具\n[\s\S]*?(?=\n## )/m);
      expect(tableMatch, "必须有「## 你的工具」区块").not.toBeNull();
      const table = tableMatch![0];
      expect(table).toMatch(/\| `?task_complete`? \|/);
      expect(table).toMatch(/\| `?task_cancel`? \|/);
    });

    test("C3. default prompt 说明验收流程（核对产出 → complete / 重新委托 / cancel）", () => {
      expect(defaultPrompt).toContain("task_get");
      expect(defaultPrompt).toMatch(/重新委托|重新派发|再次委托/);
      expect(defaultPrompt).toMatch(/task_cancel/);
    });

    test("C4. default prompt 说明 sub-agent 超时/未更新状态时主动补验收", () => {
      expect(defaultPrompt).toMatch(/超时|timeout|未更新/);
    });
  });

  describe("D. roy prompt 执行语义", () => {
    test("D1. roy prompt 明确不自行调用 task_complete（验收交给 default agent）", () => {
      expect(royPrompt).toMatch(/不要.*task_complete|不.*自行.*task_complete|禁止.*task_complete/);
      expect(royPrompt).toContain("default");
    });

    test("D2. roy prompt 明确：进度达到 100% 即结束返回（交由主智能体验收）", () => {
      expect(royPrompt).toMatch(/100\s*%/);
      expect(royPrompt).toMatch(/结束|返回/);
    });

    test("D3. roy prompt 保留操作记录类工具（task_operation_create / task_update）", () => {
      expect(royPrompt).toContain("task_operation_create");
      expect(royPrompt).toContain("task_update");
    });

    test("D4. roy prompt 的 Task Management Tools 表不再出现 task_complete", () => {
      const tableMatch = royPrompt.match(/### Task Management Tools[\s\S]*?(?=\n### |\n## |\n$)/);
      expect(tableMatch).not.toBeNull();
      expect(tableMatch![0]).not.toMatch(/\| `?task_complete`? \|/);
    });
  });

  // ============================================================
  // E. goal 检查链路（Task #5073 设计调整②：挪到 pre_complete）
  // ============================================================

  describe("E. goal 检查 decision 链路", () => {
    test("E1a. preCompleteTask 是 AFTER_COMPLETE 的唯一触发点（goal 检查入口）", () => {
      const src = repoFile("packages/core/src/env/task/task-component.ts");
      const m = src.match(/async preCompleteTask\([\s\S]*?\n  \}/);
      expect(m, "必须能定位 preCompleteTask 实现").not.toBeNull();
      expect(m![0]).toContain("updateTask");
      expect(m![0]).toContain("AFTER_COMPLETE");
    });

    test("E1b. updateTask 不再触发 AFTER_COMPLETE（设计调整②）", () => {
      const src = repoFile("packages/core/src/env/task/task-component.ts");
      // updateTask 方法体内不得再出现 AFTER_COMPLETE 触发
      const m = src.match(/async updateTask\(id: number[\s\S]*?\n  \}/);
      expect(m, "必须能定位 updateTask 实现").not.toBeNull();
      expect(m![0]).not.toMatch(/executeHook\(TaskHookPoints\.AFTER_COMPLETE/);
    });

    test("E2. task:after.complete 仍是 goal 判定 hook 点", () => {
      const src = repoFile("packages/core/src/env/task/hooks/task-hook-points.ts");
      expect(src).toContain("task:after.complete");
    });

    test("E3. LayaCompletionPlugin 仍订阅 AFTER_COMPLETE（判目标 vs 交付物）", () => {
      const src = repoFile("packages/core/src/env/task/plugins/laya-completion-plugin.ts");
      expect(src).toContain("AFTER_COMPLETE");
      expect(src).toContain("completion_check");
    });
  });

  // ============================================================
  // F. 两阶段验收契约（Task #5073）
  // ============================================================

  describe("F. 两阶段验收（task_pre_complete）", () => {
    test("F1. task_pre_complete 工具已注册到 TaskComponent", async () => {
      const { TaskComponent } = await import("../task/task-component");
      const { ConfigComponent } = await import("../../config/config-component");
      const { tmpdir } = await import("os");
      const { join } = await import("path");

      const configComponent = new ConfigComponent();
      const taskComponent = new TaskComponent();
      await taskComponent.init({
        options: {
          configComponent,
          config: {
            storage: {
              type: "sqlite",
              dbPath: join(
                tmpdir(),
                `task-5073-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
              ),
            },
          },
        },
      });

      const registered: string[] = [];
      const fakeToolComponent = {
        register: (t: any) => {
          registered.push(t.name);
        },
      };
      (taskComponent as any).toolComponent = fakeToolComponent;
      await (taskComponent as any).registerTools();

      expect(registered).toContain("task_pre_complete");
      await taskComponent.stop();
    });

    test("F2. registerRoyAgent 的 deniedTools 不含 task_pre_complete（sub-agent 可调用）", () => {
      const src = repoFile("packages/core/src/env/agent/agent-registry.ts");
      const m = src.match(/registerRoyAgent\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/);
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(/deniedTools\s*:\s*\[[^\]]*["']task_complete["']/);
      // pre_complete 是执行方的提交口，绝不能进 deniedTools
      expect(m![1]).not.toMatch(/["']task_pre_complete["']/);
    });

    test("F3. delegate-tool builtInSubAgents 的 roy 条目同样不禁 task_pre_complete", () => {
      const src = repoFile("packages/core/src/env/task/delegate/delegate-tool.ts");
      const m = src.match(/id:\s*"roy",[\s\S]*?deniedTools:\s*\[([^\]]*)\]/);
      expect(m).not.toBeNull();
      expect(m![1]).toContain("task_complete");
      expect(m![1]).not.toContain("task_pre_complete");
    });

    test("F4. CompleteTaskToolSchema 不再有 deliverable_storage_path（设计调整①）", () => {
      const src = repoFile("packages/core/src/env/task/tools/task-types.ts");
      const m = src.match(/CompleteTaskToolSchema\s*=\s*withLegacyTaskId\(\{([\s\S]*?)\}\);/);
      expect(m, "必须能定位 CompleteTaskToolSchema").not.toBeNull();
      expect(m![1]).not.toContain("deliverable_storage_path");
    });

    test("F5. defaultDeniedTools 不含 task_pre_complete（default 不需要它但 prompt 工具表一致）", () => {
      const envSrc = repoFile("packages/core/src/env/environment.ts");
      const m = envSrc.match(/defaultDeniedTools\s*=\s*\[([\s\S]*?)\]/);
      expect(m).not.toBeNull();
      // default 不需要 pre_complete（它是执行方工具），但也不主动禁用
      // —— 若未来 default 需要代提交，不用改代码。
      expect(m![1]).not.toMatch(/["']task_pre_complete["']/);
    });

    test("F6. default prompt 验收四步的 complete 调用不带 deliverable 参数", () => {
      expect(defaultPrompt).toMatch(/task_complete\(task_id=<id>\)/);
      expect(defaultPrompt).not.toMatch(
        /task_complete\(task_id=<id>,\s*deliverable_storage_path/,
      );
    });

    test("F7. roy prompt 引导调用 task_pre_complete 提交待验证", () => {
      expect(royPrompt).toMatch(/task_pre_complete/);
      expect(royPrompt).toMatch(/to_validate|待验证/);
    });
  });
});
