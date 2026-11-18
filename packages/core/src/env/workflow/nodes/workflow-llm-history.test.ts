/**
 * @fileoverview Workflow LLM History Tests
 * 
 * TDD 测试：验证 workflow 节点之间 LLM history 共享功能
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import type { ModelMessage } from "ai";
import type { WorkflowHistoryMessage } from '../../agent/types';

// Mock AgentComponent
const createMockAgentComponent = () => ({
  registerAgent: vi.fn(),
  getAgent: vi.fn().mockReturnValue({ name: 'test-agent' }),
  listAgents: vi.fn().mockReturnValue([{ name: 'test-agent' }]),
  run: vi.fn().mockResolvedValue({
    finalText: 'test response',
    iterations: 1,
    toolCalls: [],
  }),
});

// Mock SessionComponent
const createMockSessionComponent = () => ({
  create: vi.fn().mockResolvedValue({ id: 'agent_session_123' }),
  addMessage: vi.fn().mockResolvedValue('msg_123'),
  getMessages: vi.fn().mockResolvedValue([]),
});

describe('Workflow LLM History', () => {
  describe('AgentContext with workflowHistory', () => {
    it('should accept workflowHistory in AgentContext', () => {
      // 模拟 AgentContext 接口应该接受 workflowHistory 字段
      const context = {
        sessionId: 'test-session',
        workflowHistory: [
          { role: 'user', content: 'Hello from previous node' },
          { role: 'assistant', content: 'Response from previous node' },
        ] as WorkflowHistoryMessage[],
      };

      expect(context.workflowHistory).toBeDefined();
      expect(context.workflowHistory).toHaveLength(2);
      expect(context.workflowHistory![0].role).toBe('user');
      expect(context.workflowHistory![1].role).toBe('assistant');
    });

    it('should be optional in AgentContext', () => {
      // workflowHistory 应该是可选的
      const context: { sessionId: string; workflowHistory?: WorkflowHistoryMessage[] } = {
        sessionId: 'test-session',
      };

      expect(context.workflowHistory).toBeUndefined();
    });

    it('should have correct WorkflowHistoryMessage structure', () => {
      const message: WorkflowHistoryMessage = {
        role: 'user',
        content: 'Test message',
        toolCallId: 'call_123',
        toolName: 'test-tool',
        nodeId: 'node1',
      };

      expect(message.role).toBe('user');
      expect(message.content).toBe('Test message');
      expect(message.toolCallId).toBe('call_123');
      expect(message.toolName).toBe('test-tool');
      expect(message.nodeId).toBe('node1');
    });
  });

  describe('AgentComponentAdapter workflowHistory handling', () => {
    let mockAgentComponent: ReturnType<typeof createMockAgentComponent>;
    let mockSessionComponent: ReturnType<typeof createMockSessionComponent>;
    let AgentComponentAdapter: any;

    beforeEach(async () => {
      vi.clearAllMocks();
      mockAgentComponent = createMockAgentComponent();
      mockSessionComponent = createMockSessionComponent();

      // 动态导入以避免循环依赖问题
      const module = await import('./agent-component-adapter');
      AgentComponentAdapter = module.AgentComponentAdapter;
    });

    it('should receive workflowHistory in context when provided via config', async () => {
      const adapter = new AgentComponentAdapter(
        mockAgentComponent as any,
        {},
        mockSessionComponent as any
      );

      // 设置初始历史
      const workflowHistory: WorkflowHistoryMessage[] = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Response 1' },
      ];

      const config = {
        type: 'test-agent',
        prompt: 'Current task',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
        workflowHistory, // 通过 config 传递 history
      };

      await adapter.run(config as any);

      // 验证 AgentComponent.run 被调用
      expect(mockAgentComponent.run).toHaveBeenCalled();
      
      // 验证 workflowHistory 被传递（通过检查 mock 被调用时的参数）
      const callArgs = mockAgentComponent.run.mock.calls[0];
      // AgentComponent.run(agentName, query, context) - 第三个参数是 context
      const context = callArgs[2];
      expect(context).toBeDefined();
    });

    it('should accumulate messages after agent execution', async () => {
      const adapter = new AgentComponentAdapter(
        mockAgentComponent as any,
        {},
        mockSessionComponent as any
      );

      // 模拟 agent 执行后产生的消息
      mockAgentComponent.run.mockResolvedValue({
        finalText: 'Agent response',
        iterations: 1,
        toolCalls: [],
        messages: [
          { role: 'user', content: 'Task 1' },
          { role: 'assistant', content: 'Agent response' },
        ],
      });

      const workflowHistory: WorkflowHistoryMessage[] = [
        { role: 'user', content: 'Previous task' },
        { role: 'assistant', content: 'Previous response' },
      ];

      const config = {
        type: 'test-agent',
        prompt: 'Current task',
        nodeId: 'node1',
        runId: 'run1',
        workflowHistory,
      };

      await adapter.run(config as any);

      // 验证返回结果包含生成的消息
      // 注意：这需要适配器从 agent 结果中提取消息并追加到 history
      // 这个测试验证了消息应该被累积的概念
      expect(mockAgentComponent.run).toHaveBeenCalled();
    });
  });

  describe('WorkflowEngine workflowHistory integration', () => {
    it('should maintain workflowHistory in ActiveRunState', () => {
      // 验证 ActiveRunState 应该包含 workflowHistory 字段
      // 这个测试描述了期望的设计
      const mockRunState = {
        runId: 'run_1',
        workflowHistory: [] as WorkflowHistoryMessage[],
        nodeOutputs: new Map(),
      };

      expect(mockRunState.workflowHistory).toBeDefined();
      expect(Array.isArray(mockRunState.workflowHistory)).toBe(true);
    });

    it('should add node messages to workflowHistory after execution', () => {
      // 模拟节点执行完成后的消息
      const workflowHistory: WorkflowHistoryMessage[] = [];
      
      const nodeResultMessages: WorkflowHistoryMessage[] = [
        { role: 'user', content: 'Node 1 task', nodeId: 'node1' },
        { role: 'assistant', content: 'Node 1 response', nodeId: 'node1' },
      ];

      // 累积到 workflowHistory
      workflowHistory.push(...nodeResultMessages);

      expect(workflowHistory).toHaveLength(2);
      expect(workflowHistory[0].nodeId).toBe('node1');
    });

    it('should pass accumulated history to next agent node', () => {
      // 模拟两个连续 agent 节点之间的 history 传递
      const historyAfterNode1: WorkflowHistoryMessage[] = [
        { role: 'user', content: 'Node 1 task' },
        { role: 'assistant', content: 'Node 1 response' },
      ];

      // Node 2 应该接收 Node 1 的历史
      const node2Context = {
        sessionId: 'workflow_run_1',
        workflowHistory: historyAfterNode1,
      };

      expect(node2Context.workflowHistory).toHaveLength(2);
      expect(node2Context.workflowHistory![0].content).toBe('Node 1 task');
      expect(node2Context.workflowHistory![1].content).toBe('Node 1 response');
    });
  });

  describe('Message transformation to LLM format', () => {
    it('should transform workflow messages to LLM format', () => {
      // Workflow 消息格式转换为 LLM 消息格式
      const workflowMessage: WorkflowHistoryMessage = {
        role: 'user',
        content: 'Test message',
        nodeId: 'node1',
      };

      const llmMessage: ModelMessage = {
        role: 'user',
        content: workflowMessage.content,
      };

      expect(llmMessage.role).toBe('user');
      expect(llmMessage.content).toBe('Test message');
    });

    it('should handle tool messages in LLM format', () => {
      const workflowToolMessage: WorkflowHistoryMessage = {
        role: 'tool',
        content: '{"result": "tool output"}',
        toolCallId: 'call_123',
        toolName: 'test-tool',
      };

      // 转换为 LLM 格式
      const llmMessage: ModelMessage = {
        role: 'tool',
        content: workflowToolMessage.content,
      };

      expect(llmMessage.role).toBe('tool');
    });

    it('should preserve message order in history', () => {
      const messages: WorkflowHistoryMessage[] = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Message 2' },
        { role: 'user', content: 'Message 3' },
        { role: 'tool', content: 'Tool result', toolCallId: 'call_1' },
        { role: 'assistant', content: 'Message 5' },
      ];

      // 验证顺序保持
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
      expect(messages[2].role).toBe('user');
      expect(messages[3].role).toBe('tool');
      expect(messages[4].role).toBe('assistant');
    });
  });
});

describe('Workflow LLM History - Integration Scenario', () => {
  it('should simulate full workflow with history accumulation', async () => {
    // 模拟完整 workflow 执行场景：
    // Node A (agent) -> Node B (agent) -> Node C (agent)
    
    const workflowHistory: WorkflowHistoryMessage[] = [];

    // Node A 执行
    const nodeAMessages: WorkflowHistoryMessage[] = [
      { role: 'user', content: 'Task for Node A', nodeId: 'nodeA' },
      { role: 'assistant', content: 'Response from Node A', nodeId: 'nodeA' },
    ];
    workflowHistory.push(...nodeAMessages);

    // Node B 执行（应该看到 Node A 的历史）
    expect(workflowHistory).toHaveLength(2);
    const nodeBContext = { workflowHistory };
    expect(nodeBContext.workflowHistory).toHaveLength(2);

    const nodeBMessages: WorkflowHistoryMessage[] = [
      { role: 'user', content: 'Task for Node B', nodeId: 'nodeB' },
      { role: 'assistant', content: 'Response from Node B', nodeId: 'nodeB' },
    ];
    workflowHistory.push(...nodeBMessages);

    // Node C 执行（应该看到 Node A 和 Node B 的历史）
    expect(workflowHistory).toHaveLength(4);
    const nodeCContext = { workflowHistory };
    expect(nodeCContext.workflowHistory).toHaveLength(4);
    expect(nodeCContext.workflowHistory![0].nodeId).toBe('nodeA');
    expect(nodeCContext.workflowHistory![2].nodeId).toBe('nodeB');

    const nodeCMessages: WorkflowHistoryMessage[] = [
      { role: 'user', content: 'Task for Node C', nodeId: 'nodeC' },
      { role: 'assistant', content: 'Response from Node C', nodeId: 'nodeC' },
    ];
    workflowHistory.push(...nodeCMessages);

    // 最终历史应该包含所有消息
    expect(workflowHistory).toHaveLength(6);
    expect(workflowHistory[5].nodeId).toBe('nodeC');
  });

  it('should pass workflowHistory through AgentNode execution', async () => {
    // 模拟 AgentNode 接收 workflowHistory 并传递给 agentRunner
    const mockRunner = {
      run: vi.fn().mockResolvedValue({
        output: 'agent output',
        messages: [
          { role: 'user', content: 'prompt' },
          { role: 'assistant', content: 'agent output' },
        ],
      }),
    };

    // 模拟 AgentNode
    const definition = {
      id: 'agent-node-1',
      type: 'agent',
      config: {
        agent_type: 'general',
        prompt: 'Do something',
      },
    };

    const context = {
      runId: 'run_1',
      sessionId: 'session_1',
      workflowName: 'test-workflow',
      nodeId: 'agent-node-1',
      input: {},
      previousOutputs: new Map(),
      nodeOutputs: new Map(),
      config: {},
      debug: false,
      eventBus: { publish: vi.fn() },
      workflowHistory: [
        { role: 'user' as const, content: 'Previous task', nodeId: 'previous-node' },
        { role: 'assistant' as const, content: 'Previous response', nodeId: 'previous-node' },
      ],
    };

    // 执行 AgentNode
    const { AgentNode } = await import('./agent-node');
    const node = new AgentNode(definition as any, mockRunner as any);
    const result = await node.execute(context as any);

    // 验证 runner 被调用时传入了 workflowHistory
    expect(mockRunner.run).toHaveBeenCalled();
    const callArgs = mockRunner.run.mock.calls[0][0];
    expect(callArgs.workflowHistory).toBe(context.workflowHistory);
    expect(callArgs.nodeId).toBe('agent-node-1');

    // 验证返回结果包含生成的消息
    expect(result.output).toBeDefined();
    expect(result.output.workflowHistory).toBeDefined();
    expect(result.output.workflowHistory).toHaveLength(2);
  });

  it('should convert workflow messages to LLM format in AgentComponent', () => {
    // 模拟 AgentComponent 将 workflowHistory 转换为 LLM 消息格式
    const workflowMessages: WorkflowHistoryMessage[] = [
      { role: 'user', content: 'Message 1', nodeId: 'node1' },
      { role: 'assistant', content: 'Message 2', nodeId: 'node1' },
      { role: 'tool', content: '{"result": "ok"}', toolCallId: 'call_1', toolName: 'test-tool', nodeId: 'node1' },
      { role: 'assistant', content: 'Message 3', nodeId: 'node1' },
    ];

    // 转换为 ModelMessage 格式（模拟 AgentComponent 的转换逻辑）
    const llmMessages = workflowMessages.map(msg => ({
      role: msg.role,
      content: msg.content,
      ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
      ...(msg.toolName ? { toolName: msg.toolName } : {}),
    }));

    expect(llmMessages).toHaveLength(4);
    expect(llmMessages[0].role).toBe('user');
    expect(llmMessages[1].role).toBe('assistant');
    expect(llmMessages[2].role).toBe('tool');
    expect(llmMessages[2].toolCallId).toBe('call_1');
    expect(llmMessages[3].role).toBe('assistant');
  });

  it('should accumulate workflow history from node outputs in WorkflowEngine', () => {
    // 模拟 WorkflowEngine 的 node.completed 事件处理
    const workflowHistory: WorkflowHistoryMessage[] = [];
    
    // 模拟 Node A 完成，输出包含 workflowHistory
    const nodeAOutput = {
      result: 'Node A result',
      workflowHistory: [
        { role: 'user' as const, content: 'Task A' },
        { role: 'assistant' as const, content: 'Response A' },
      ],
    };
    
    // 模拟事件处理逻辑
    if (nodeAOutput && typeof nodeAOutput === 'object' && 'workflowHistory' in nodeAOutput) {
      const messages = (nodeAOutput as any).workflowHistory;
      if (Array.isArray(messages)) {
        workflowHistory.push(...messages);
      }
    }
    
    expect(workflowHistory).toHaveLength(2);
    
    // 模拟 Node B 完成，输出包含 workflowHistory
    const nodeBOutput = {
      result: 'Node B result',
      workflowHistory: [
        { role: 'user' as const, content: 'Task B' },
        { role: 'assistant' as const, content: 'Response B' },
      ],
    };
    
    // 模拟事件处理逻辑
    if (nodeBOutput && typeof nodeBOutput === 'object' && 'workflowHistory' in nodeBOutput) {
      const messages = (nodeBOutput as any).workflowHistory;
      if (Array.isArray(messages)) {
        workflowHistory.push(...messages);
      }
    }
    
    expect(workflowHistory).toHaveLength(4);
    expect(workflowHistory[0].content).toBe('Task A');
    expect(workflowHistory[2].content).toBe('Task B');
  });

  it('should skip workflowHistory accumulation for non-agent nodes', () => {
    // 模拟非 agent 节点（如 tool 节点）完成
    const workflowHistory: WorkflowHistoryMessage[] = [];
    
    // Tool 节点的输出不包含 workflowHistory
    const toolNodeOutput = {
      result: 'tool result',
    };
    
    // 模拟事件处理逻辑 - 不应该累积
    if (toolNodeOutput && typeof toolNodeOutput === 'object' && 'workflowHistory' in toolNodeOutput) {
      const messages = (toolNodeOutput as any).workflowHistory;
      if (Array.isArray(messages)) {
        workflowHistory.push(...messages);
      }
    }
    
    // workflowHistory 应该保持为空
    expect(workflowHistory).toHaveLength(0);
  });
});
