/**
 * @fileoverview LarkCliTaskNotifyHook Tests
 *
 * 测试 LarkCliTaskNotifyHook（直接实现 Hook 接口）
 *
 * 覆盖场景：
 * - Plugin interface compliance
 * - NotifyType 枚举（TASK_CREATED, TASK_COMPLETED, TASK_UPDATED, TASK_FAILED, OPERATION_CREATED, OPERATION_PROGRESS）
 * - 任务状态变更（task:after.update）触发 TASK_UPDATED 通知
 * - 操作记录新增（task:operation:after.create）触发 OPERATION_CREATED 通知
 * - NotifyType 过滤
 * - 消息格式（markdown 渲染）
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  LarkCliTaskNotifyHook,
  createLarkCliTaskNotifyHook,
  extractLarkFields,
  type TaskNotifyConfig,
  NotifyType,
} from "./lark-cli-task-notify-plugin";
import {
  renderTaskInfoLines,
  renderContextAsLines,
  buildTaskCard,
} from "./lark-card-patch-notifier";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import {
  EventStoreImpl,
  setSharedEventStore,
  resetSharedEventStore,
} from "../../event-source/event-store";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskOperationCreateResultContext,
} from "../hooks/contexts";
import {
  runWithEnvContext,
  type EnvContext,
} from "../../context";

// ============================================================================
// 测试辅助
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 1,
    title: "测试任务",
    description: "测试描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    ...overrides,
  };
}

function makeOperation(overrides: Partial<any> = {}): any {
  return {
    id: 100,
    taskId: 1,
    sessionId: "session-abc",
    milestoneType: "milestone",
    milestoneTitle: "完成需求分析",
    milestoneDescription: "已完成核心功能的需求拆解",
    timestamp: "2026-06-01T02:00:00Z",
    ...overrides,
  };
}

function makeReplyChannel(overrides: Partial<any> = {}): any {
  return {
    chatId: "oc_chat123",
    messageId: "om_msg456",
    ...overrides,
  };
}

function makeEnvContext(overrides: Partial<EnvContext> = {}): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test-1",
    userId: "ou_test",
    replyChannel: makeReplyChannel(),
    pluginEnabled: { "es-test-1:LarkCliTaskNotifyPlugin": true },
    ...overrides,
  } as EnvContext;
}

function makeHookContext<T>(
  hookPoint: string,
  data: T,
  metadata: Record<string, unknown> = {}
): HookContext<T> {
  return {
    component: { name: "task", version: "1.0.0" },
    data,
    metadata,
    phase: "after",
    hookPoint,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("LarkCliTaskNotifyHook", () => {
  // ========================================================================
  // 1. Plugin 接口合规性（保留原有）
  // ========================================================================
  describe("Plugin interface compliance", () => {
    it("should implement Hook interface", () => {
      const hook = new LarkCliTaskNotifyHook();
      expect(typeof hook.execute).toBe("function");
      expect(typeof hook.name).toBe("string");
      expect(typeof hook.priority).toBe("number");
    });

    it("should have name property", () => {
      const hook = new LarkCliTaskNotifyHook();
      expect(hook.name).toBe("LarkCliTaskNotifyHook");
    });

    it("should accept config in constructor", () => {
      const config: TaskNotifyConfig = {
        enabled: false,
        priority: 10,
        pluginName: "custom-plugin",
        sourceId: "custom-source",
      };
      const hook = new LarkCliTaskNotifyHook(config);
      expect(hook.name).toBe("custom-plugin");
      expect(hook.priority).toBe(10);
    });
  });

  // ========================================================================
  // 2. NotifyType 枚举
  // ========================================================================
  describe("NotifyType enum", () => {
    it("should have TASK_CREATED", () => {
      expect(NotifyType.TASK_CREATED).toBeDefined();
    });

    it("should have TASK_COMPLETED", () => {
      expect(NotifyType.TASK_COMPLETED).toBeDefined();
    });

    it("should have TASK_UPDATED", () => {
      expect(NotifyType.TASK_UPDATED).toBeDefined();
    });

    it("should have TASK_FAILED", () => {
      expect(NotifyType.TASK_FAILED).toBeDefined();
    });

    it("should have OPERATION_CREATED (new)", () => {
      expect(NotifyType.OPERATION_CREATED).toBeDefined();
    });
  });

  // ========================================================================
  // 3. Config
  // ========================================================================
  describe("TaskNotifyConfig type", () => {
    it("should accept enabled option", () => {
      const hook = new LarkCliTaskNotifyHook({ enabled: false });
      expect(hook).toBeDefined();
    });

    it("should accept priority option", () => {
      const hook = new LarkCliTaskNotifyHook({ priority: 100 });
      expect(hook.priority).toBe(100);
    });

    it("should accept notifyTypes option", () => {
      const hook = new LarkCliTaskNotifyHook({
        notifyTypes: [NotifyType.TASK_CREATED, NotifyType.TASK_COMPLETED],
      });
      expect(hook).toBeDefined();
    });

    it("should accept pluginName and sourceId for pluginEnabled check", () => {
      const hook = new LarkCliTaskNotifyHook({
        pluginName: "test-plugin",
        sourceId: "test-source",
      });
      expect(hook).toBeDefined();
    });

    it("should default notifyTypes to include OPERATION_CREATED (backward-compatible additive default)", () => {
      const hook = new LarkCliTaskNotifyHook();
      // 验证默认配置包含 OPERATION_CREATED
      const config = (hook as any).config;
      expect(config.notifyTypes).toContain(NotifyType.OPERATION_CREATED);
    });

    // ========================================================================
    // NEW: 完整生命周期默认通知（用户需求：每一步都该发飞书通知）
    // ========================================================================
    it("should default notifyTypes to include TASK_UPDATED so progress changes are reported", () => {
      const hook = new LarkCliTaskNotifyHook();
      const config = (hook as any).config;
      expect(config.notifyTypes).toContain(NotifyType.TASK_UPDATED);
    });

    it("should default notifyTypes to include TASK_CREATED so task creation is reported", () => {
      const hook = new LarkCliTaskNotifyHook();
      const config = (hook as any).config;
      expect(config.notifyTypes).toContain(NotifyType.TASK_CREATED);
    });

    it("should default notifyTypes to include TASK_COMPLETED so task completion is reported", () => {
      const hook = new LarkCliTaskNotifyHook();
      const config = (hook as any).config;
      expect(config.notifyTypes).toContain(NotifyType.TASK_COMPLETED);
    });

    it("should cover all 4 task lifecycle event types in default notifyTypes", () => {
      const hook = new LarkCliTaskNotifyHook();
      const config = (hook as any).config;
      // 默认配置应该包含完整的任务生命周期事件
      const expected = [
        NotifyType.TASK_CREATED,
        NotifyType.TASK_UPDATED,
        NotifyType.TASK_COMPLETED,
        NotifyType.OPERATION_CREATED,
      ];
      for (const t of expected) {
        expect(config.notifyTypes).toContain(t);
      }
    });
  });


  // ==========================================================================
  // Task #2325 / #4230 v2: 任务定位信息（项目 / worktree / 背景）
  // ==========================================================================
  //
  // 用户验收要求（Task #4230 v2）：
  // - 卡片第一块是「任务栏位」：任务 ID / 标题 / 描述 / 目标 / 父任务 / 优先级 / context…
  // - context 必须渲染成**人类可读的 markdown**（绝不出现 JSON 原文）
  describe("Task #2325 / #4230: 任务栏位含量（项目/worktree/背景，无 JSON）", () => {
    /** 捕获 startTask 入参（不 spawn lark-cli） */
    function makeCapturingNotifier() {
      const calls: any[] = [];
      const notifier = {
        startTask: mock(async (opts: any) => {
          calls.push(opts);
          return { messageId: "om_card_context", pinned: true };
        }),
        updateTask: mock(async () => {}),
        finishTask: mock(async () => {}),
      };
      return { notifier, calls };
    }

    async function triggerCreate(task: any, notifier: any) {
      const hook = new LarkCliTaskNotifyHook();
      (hook as any).cardNotifier = notifier;
      await runWithEnvContext(makeEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task,
          } as unknown as TaskCreateResultContext)
        );
      });
    }

    it("startTask 收到完整 TaskMeta（id/title/description/goals/parent/priority/type/project/context）", async () => {
      const { notifier, calls } = makeCapturingNotifier();
      const task = makeTask({
        id: 42,
        title: "时空增强任务",
        description: "任务描述",
        goals_and_expected_deliverables: "交付报告",
        parent_task_id: 4116,
        priority: "high",
        type: "normal",
        project_path: "~/proj",
        current_status: "进行中",
        context: JSON.stringify({
          worktree_path: "~/proj/.worktrees/feat-x",
          branch: "feature/x",
        }),
      });

      await triggerCreate(task, notifier);

      expect(calls).toHaveLength(1);
      const meta = calls[0].meta;
      expect(meta.id).toBe(42);
      expect(meta.title).toBe("时空增强任务");
      expect(meta.description).toBe("任务描述");
      expect(meta.goals).toBe("交付报告");
      expect(meta.parentTaskId).toBe(4116);
      expect(meta.priority).toBe("high");
      expect(meta.type).toBe("normal");
      expect(meta.projectPath).toBe("~/proj");
      expect(meta.currentStatus).toBe("进行中");
      expect(meta.context).toContain("worktree_path");
    });

    it("卡片栏位渲染 📂 项目 / 🌿 Worktree / 🕐 创建时间，且不含 JSON 字符", () => {
      const meta = {
        id: 42,
        title: "时空增强任务",
        projectPath: "~/proj",
        context: JSON.stringify({
          worktree_path: "~/proj/.worktrees/feat-x",
          created_at: "2026-07-23T14:00:00.000Z",
        }),
      };
      const lines = renderTaskInfoLines(meta).join("\n");

      expect(lines).toContain("📂 项目");
      expect(lines).toContain("~/proj");
      expect(lines).toContain("🌿 Worktree");
      expect(lines).toContain("~/proj/.worktrees/feat-x");
      expect(lines).toContain("🕐 创建时间");
      // ★ 绝不能出现 JSON 原文
      expect(lines).not.toContain("{");
      expect(lines).not.toContain('"');
    });

    it("prior_context 渲染成 📜 背景（且是 key: value，不是 JSON）", () => {
      const lines = renderContextAsLines(
        JSON.stringify({ prior_context: { prev_task: "#2300", commit: "ab696ca3" } })
      ).join("\n");

      expect(lines).toContain("📜 背景");
      expect(lines).toContain("#2300");
      expect(lines).toContain("ab696ca3");
      expect(lines).not.toContain("{");
    });

    it("缺 worktree_path / 坏 JSON 时安全跳过（不崩、不输出 undefined/JSON）", () => {
      // 只有内部机器字段 → 全部跳过（渲染空）
      expect(
        renderContextAsLines(
          '{"larkPerTaskChatTaskId": 1, "larkPerTaskChatCreatedAt": "x"}'
        )
      ).toEqual([]);
      expect(renderContextAsLines("not-json")).toEqual([]);
      expect(renderContextAsLines(undefined)).toEqual([]);
      // 坏 JSON：数组不是合法 context 对象 → 跳过
      expect(renderContextAsLines('["a","b"]')).toEqual([]);
      // type 是已知字段 → 用友好标签渲染（不是 JSON）
      expect(renderContextAsLines('{"type": "general"}').join("\n")).toContain(
        "🏷️ 类型"
      );

      const lines = renderTaskInfoLines({
        id: 42,
        title: "无时空信息任务",
        projectPath: "~/proj",
        context: "not-json",
      }).join("\n");
      expect(lines).toContain("~/proj");
      expect(lines).not.toContain("undefined");
    });

    it("buildTaskCard 顺序正确：任务栏位 → 里程碑序列 → 操作记录 → 进度", () => {
      const card = buildTaskCard({
        status: "running",
        meta: {
          id: 42,
          title: "时空增强任务",
          projectPath: "~/proj",
          context: JSON.stringify({ worktree_path: "/w" }),
        },
        milestones: [{ title: "Task 创建", timestamp: "2026-07-23T14:00:00.000Z" }],
        processSteps: [{ title: "初始化", timestamp: "2026-07-23T14:00:00.000Z" }],
        progress: 30,
        updateCount: 1,
        spinner: "⏳",
      });
      const md = (() => {
        // ★ Task #4845：内容收在 collapsible_panel 里，递归扫进面板内部
        const parts: string[] = [];
        const walk = (els: any[]): void => {
          for (const e of els ?? []) {
            if (e?.tag === "markdown" && typeof e.content === "string") {
              parts.push(e.content);
            } else if (
              e?.tag === "collapsible_panel" &&
              Array.isArray(e.elements)
            ) {
              walk(e.elements);
            }
          }
        };
        walk((card.body.elements as any[]) ?? []);
        return parts.join("\n");
      })();

      expect(md.indexOf("🆔 任务 ID")).toBeLessThan(md.indexOf("## 🎯 里程碑序列"));
      // ★ Task #4889：过程信息区拆成「操作记录」/「执行轨迹（工具调用）」两区。
      expect(md.indexOf("## 🎯 里程碑序列")).toBeLessThan(md.indexOf("## 📝 操作记录"));
      expect(md.indexOf("## 📝 操作记录")).toBeLessThan(md.indexOf("**📊 进度**"));
      expect(md).toContain("30%");
    });
  });
});

// ============================================================================
// Task #2331: extractLarkFields helper - 验证 lark-cli plugin 内部类型转换
// ============================================================================

describe("Task #2331: extractLarkFields helper", () => {
  it("lark event → 返回完整 lark 字段", () => {
    const env = {
      event: {
        source: "lark" as const,
        id: "om_extract_001",
        receivedAt: "2026-07-23T10:00:00.000Z",
      },
      replyChannel: {
        type: "lark",
        messageId: "om_extract_001",
        chatId: "oc_extract_001",
        userId: "ou_extract_001",
        identity: "bot" as const,
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      },
    };

    const fields = extractLarkFields(env);
    expect(fields.isLark).toBe(true);
    expect(fields.messageId).toBe("om_extract_001");
    expect(fields.chatId).toBe("oc_extract_001");
    expect(fields.userId).toBe("ou_extract_001");
    expect(fields.source).toBe("lark");
  });

  it("github event → isLark=false, 字段为空 (plugin 跳过)", () => {
    const env = {
      event: {
        source: "github" as const,
        id: "issue_42",
        receivedAt: "2026-07-23T10:00:00.000Z",
      },
      replyChannel: {
        type: "lark",
        messageId: "om_legacy", // 即便有 replyChannel, github event 不发 lark
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      },
    };

    const fields = extractLarkFields(env);
    expect(fields.isLark).toBe(false);
    expect(fields.messageId).toBeUndefined();
    expect(fields.chatId).toBeUndefined();
  });

  it("jira event → isLark=false", () => {
    const env = {
      event: {
        source: "jira" as const,
        id: "PROJ-123",
        receivedAt: "2026-07-23T10:00:00.000Z",
      },
    };
    const fields = extractLarkFields(env);
    expect(fields.isLark).toBe(false);
  });

  it("无 event 字段 (backward compat) → 从 replyChannel 派生 lark envelope", () => {
    const env = {
      replyChannel: {
        type: "lark",
        messageId: "om_compat_001",
        chatId: "oc_compat_001",
        userId: "ou_compat_001",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      },
    };
    const fields = extractLarkFields(env);
    // 通过 getEventFromEnvContext 派生 lark envelope (backward compat)
    expect(fields.isLark).toBe(true);
    expect(fields.messageId).toBe("om_compat_001");
    expect(fields.chatId).toBe("oc_compat_001");
    expect(fields.userId).toBe("ou_compat_001");
  });

  it("空 env → 返回 isLark=false, 无字段", () => {
    const fields = extractLarkFields({});
    expect(fields.isLark).toBe(false);
    expect(fields.messageId).toBeUndefined();
  });
});
