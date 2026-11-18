/**
 * @fileoverview Task Workflow Extractor Integration Tests
 * 
 * 测试 TaskTagPlugin 的工作流提取功能
 * 使用 BasePlugin 接口（init/dispose）
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { TaskTagPlugin } from "./task-tag-plugin";
import type { Task, TaskOperation } from "../types";

// Mock logger
vi.mock("../../log-trace/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("Task Workflow Extraction Integration", () => {
  let plugin: TaskTagPlugin;
  let mockTaskComponent: any;
  let mockAgentComponent: any;
  let mockWorkflowRepo: any;
  let mockSessionComponent: any;
  let mockWorkflowComponent: any;
  let mockPluginEnv: any;

  beforeEach(() => {
    plugin = new TaskTagPlugin();

    mockWorkflowRepo = {
      getByName: vi.fn().mockReturnValue(null),  // No existing workflow
      create: vi.fn().mockReturnValue({
        id: "wf-123",
        name: "test-extracted-workflow",
        nodes: [
          { id: "node-1", type: "tool" },
          { id: "node-2", type: "tool" },
        ],
      }),
    };

    mockWorkflowComponent = {
      workflowService: {
        workflowRepository: mockWorkflowRepo,
      },
    };

    mockSessionComponent = {
      getContext: vi.fn().mockResolvedValue({
        messages: [
          { role: "user", content: "Read the file" },
          { role: "assistant", content: "Reading file..." },
          { role: "user", content: "Write the changes" },
          { role: "assistant", content: "Writing changes..." },
        ],
      }),
    };

    mockAgentComponent = {
      run: vi.fn().mockResolvedValue({
        finalText: `
\`\`\`yaml
name: test-extracted-workflow
version: "1.0"
description: Test workflow
nodes:
  - id: node-1
    type: tool
    name: Read File
    config:
      toolName: read_file
    depends_on: []
  - id: node-2
    type: tool
    name: Write File
    config:
      toolName: write_file
    depends_on: [node-1]
\`\`\`
`,
      }),
    };

    mockTaskComponent = {
      getTask: vi.fn().mockResolvedValue({
        id: 1,
        title: "Test Task",
        description: "Test description",
        goals_and_expected_deliverables: "Test goals",
        status: "completed" as const,
      }),
      listOperations: vi.fn().mockResolvedValue([
        {
          id: 1,
          taskId: 1,
          sessionId: "session-1",
          actionType: "create",
          actionTitle: "Task created",
        },
        {
          id: 2,
          taskId: 1,
          sessionId: "session-1",
          actionType: "completed",
          actionTitle: "Task completed",
        },
      ]),
      createOperation: vi.fn().mockResolvedValue({ id: 3 }),
      getTagService: vi.fn().mockReturnValue(null),
    };

    // Mock PluginEnv
    mockPluginEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "task") return mockTaskComponent;
        if (name === "agent") return mockAgentComponent;
        if (name === "session") return mockSessionComponent;
        if (name === "workflow") return mockWorkflowComponent;
        return null;
      }),
      registerHook: vi.fn(),
      registerAgent: vi.fn(),
      registerTool: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };

    // 使用 init 方法初始化（BasePlugin 接口）
    plugin.init(mockPluginEnv);
  });

  test("should extract workflow on task completion", async () => {
    await plugin.extractWorkflow(1, "session-1");

    // 验证 agent 被调用 (built-in 'workflow-extract' agent)
    expect(mockAgentComponent.run).toHaveBeenCalledWith(
      "workflow-extract",
      expect.stringContaining("Test Task")
    );

    // 验证 workflow 被存储
    expect(mockWorkflowRepo.create).toHaveBeenCalled();

    // 验证 operation 被创建
    expect(mockTaskComponent.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 1,
        sessionId: "session-1",
        actionType: "workflow_extracted",
      })
    );
  });

  test("should skip extraction when agent component unavailable", async () => {
    // 创建新的 plugin，使用没有 agent 的 env
    const pluginNoAgent = new TaskTagPlugin();
    
    const mockEnvNoAgent = {
      getComponent: vi.fn((name: string) => {
        if (name === "task") return mockTaskComponent;
        if (name === "agent") return null;  // No agent
        return null;
      }),
      registerHook: vi.fn(),
      registerAgent: vi.fn(),
      registerTool: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
    
    pluginNoAgent.init(mockEnvNoAgent);

    await pluginNoAgent.extractWorkflow(1, "session-1");

    // agent 不存在时不应抛出异常
    expect(mockAgentComponent.run).not.toHaveBeenCalled();
  });

  test("should skip when workflow has less than 2 nodes", async () => {
    mockAgentComponent.run.mockResolvedValueOnce({
      finalText: `
\`\`\`yaml
name: single-node-workflow
version: "1.0"
nodes:
  - id: node-1
    type: tool
    name: Single Node
    config:
      toolName: test_tool
    depends_on: []
\`\`\`
`,
    });

    await plugin.extractWorkflow(1, "session-1");

    // 少于 2 个节点，不应创建 workflow
    expect(mockWorkflowRepo.create).not.toHaveBeenCalled();
  });

  describe('validate integration (Task #1511 Phase 2)', () => {
    test("should skip workflow creation when extracted YAML is invalid (duplicate node IDs)", async () => {
      // Extracted YAML has duplicate node IDs — DAGManager.validate() should fail
      mockAgentComponent.run.mockResolvedValueOnce({
        finalText: `
\`\`\`yaml
name: invalid-dup-workflow
version: "1.0"
description: Has duplicate node IDs
nodes:
  - id: node-1
    type: tool
    name: A
    config:
      toolName: bash
    depends_on: []
  - id: node-1
    type: tool
    name: B
    config:
      toolName: bash
    depends_on: []
\`\`\`
`,
      });

      await plugin.extractWorkflow(1, "session-1");

      // Validate failed → should NOT create workflow
      expect(mockWorkflowRepo.create).not.toHaveBeenCalled();
      // Should NOT create success operation
      expect(mockTaskComponent.createOperation).not.toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 1,
          actionType: "workflow_extracted",
        })
      );
    });

    test("should skip workflow creation when extracted YAML has missing dependency", async () => {
      mockAgentComponent.run.mockResolvedValueOnce({
        finalText: `
\`\`\`yaml
name: missing-dep-workflow
version: "1.0"
description: References non-existent node
nodes:
  - id: node-1
    type: tool
    name: Step
    config:
      toolName: bash
    depends_on: [non-existent-node]
  - id: node-2
    type: tool
    name: Step 2
    config:
      toolName: bash
    depends_on: [node-1]
\`\`\`
`,
      });

      await plugin.extractWorkflow(1, "session-1");

      expect(mockWorkflowRepo.create).not.toHaveBeenCalled();
    });

    test("should create workflow when extracted YAML passes validation", async () => {
      mockAgentComponent.run.mockResolvedValueOnce({
        finalText: `
\`\`\`yaml
name: valid-extracted-workflow
version: "1.0"
description: A valid workflow
nodes:
  - id: node-1
    type: tool
    name: Step 1
    config:
      toolName: read_file
    depends_on: []
  - id: node-2
    type: tool
    name: Step 2
    config:
      toolName: write_file
    depends_on: [node-1]
\`\`\`
`,
      });

      await plugin.extractWorkflow(1, "session-1");

      expect(mockWorkflowRepo.create).toHaveBeenCalled();
      expect(mockTaskComponent.createOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 1,
          actionType: "workflow_extracted",
        })
      );
    });
  });

  test("should skip when workflow parsing fails", async () => {
    mockAgentComponent.run.mockResolvedValueOnce({
      finalText: "Invalid workflow output - not yaml",
    });

    await plugin.extractWorkflow(1, "session-1");

    // 解析失败，不应创建 workflow
    expect(mockWorkflowRepo.create).not.toHaveBeenCalled();
  });

  test("should collect messages from multiple sessions", async () => {
    // Mock session component to return different messages per session
    mockSessionComponent.getContext.mockImplementation(async (sid: string) => {
      return {
        sessionId: sid,
        messages: [
          { role: "user", content: `Message from ${sid}` },
        ],
      };
    });

    // 设置多个 session 的 operations
    mockTaskComponent.listOperations.mockResolvedValueOnce([
      {
        id: 1,
        taskId: 1,
        sessionId: "session-1",
        actionType: "create",
        actionTitle: "Task created",
      },
      {
        id: 2,
        taskId: 1,
        sessionId: "session-2",
        actionType: "progress",
        actionTitle: "Made progress",
      },
      {
        id: 3,
        taskId: 1,
        sessionId: "session-3",
        actionType: "completed",
        actionTitle: "Task completed",
      },
    ]);

    await plugin.extractWorkflow(1, "session-1");

    // 验证 agent 被调用，并且输入包含了多个 session 的消息
    expect(mockAgentComponent.run).toHaveBeenCalled();
    
    // 获取调用参数
    const callArgs = mockAgentComponent.run.mock.calls[0];
    const prompt = callArgs[1];  // 第二个参数是 prompt
    
    // prompt 应该包含操作记录
    expect(prompt).toContain("[create] Task created");
    expect(prompt).toContain("[progress] Made progress");
    expect(prompt).toContain("[completed] Task completed");
  });
});
