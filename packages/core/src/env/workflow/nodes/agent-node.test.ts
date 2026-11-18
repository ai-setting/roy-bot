/**
 * @fileoverview AgentNode TDD Tests
 * 
 * 测试 AgentNode 类的功能：
 * - 运行 agent 成功
 * - Agent runner 错误处理
 * - Prompt 模板解析
 * - 传递前置节点上下文
 * - 处理 agent 超时
 * - 记录执行元数据
 */

import { AgentNode, AgentRunner, AgentConfig, AgentResult } from './agent-node';
import { NodeDefinition, NodeExecutionContext } from '../types';

// ============================================================================
// Test Setup
// ============================================================================

/**
 * 创建默认的 NodeDefinition
 */
function createDefaultDefinition(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: 'test-agent-node',
    type: 'agent',
    name: 'Test Agent',
    config: {
      agent_type: 'general',
      prompt: 'Hello, {{input.name}}!',
    },
    depends_on: [],
    ...overrides,
  };
}

/**
 * 创建默认的执行上下文
 */
function createDefaultContext(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  // 创建模拟的 templateResolver
  const mockResolveValue = (input: unknown): unknown => {
    if (typeof input !== 'string') return input;
    
    // 简单的模板解析实现：处理 {{nodes.xxx}} 和 {{input.xxx}}
    return input.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const trimmed = path.trim();
      
      // 处理 {{input.xxx}}
      if (trimmed.startsWith('input.')) {
        const key = trimmed.slice(6);
        const inputObj = overrides.input ?? { name: 'World' };
        return (inputObj as Record<string, unknown>)?.[key] ?? match;
      }
      
      // 处理 {{nodes.xxx}} - 从 previousOutputs 中获取
      if (trimmed.startsWith('nodes.')) {
        const rest = trimmed.slice(6);
        const segments = rest.split('.');
        const nodeId = segments[0];
        const restPath = segments.slice(1).join('.');
        const previousOutputs = overrides.previousOutputs as Map<string, unknown> | undefined;
        if (previousOutputs) {
          const nodeOutput = previousOutputs.get(nodeId);
          if (nodeOutput && restPath) {
            const keys = restPath.split('.');
            let value: unknown = nodeOutput;
            for (const k of keys) {
              if (value && typeof value === 'object') {
                value = (value as Record<string, unknown>)[k];
              } else {
                return match;
              }
            }
            return value ?? match;
          } else if (nodeOutput) {
            // 没有 restPath，直接返回节点输出
            if (typeof nodeOutput === 'object' && 'result' in (nodeOutput as object)) {
              return (nodeOutput as { result: unknown }).result;
            }
            return nodeOutput;
          }
        }
      }
      
      return match;
    });
  };
  
  const templateResolver = {
    resolveValue: mockResolveValue,
  };
  
  return {
    sessionId: 'test-session-123',
    workdir: '/tmp',
    nodeOutputs: {},
    input: { name: 'World' },
    templateResolver: templateResolver as any,
    ...overrides,
  };
}

/**
 * 创建 Mock AgentRunner
 */
function createMockRunner(): {
  runner: AgentRunner;
  runMock: jest.Mock;
  hasAgentMock: jest.Mock;
  getAgentConfigMock: jest.Mock;
} {
  const runMock = jest.fn();
  const hasAgentMock = jest.fn();
  const getAgentConfigMock = jest.fn();
  const runner: AgentRunner = { 
    run: runMock,
    hasAgent: hasAgentMock,
    getAgentConfig: getAgentConfigMock,
  };
  return { runner, runMock, hasAgentMock, getAgentConfigMock };
}

/**
 * 创建 Mock SessionComponent
 */
function createMockSessionComponent(): {
  sessionComponent: any;
  createMock: jest.Mock;
  updateMock: jest.Mock;
  getMock: jest.Mock;
  updateMessageMock: jest.Mock;
} {
  const createMock = jest.fn().mockResolvedValue({ id: 'agent_test-node_123' });
  const updateMock = jest.fn().mockResolvedValue(undefined);
  const updateMessageMock = jest.fn().mockResolvedValue(true);
  const getMock = jest.fn().mockResolvedValue({
    id: 'test-session-123',
    metadata: {},
  });
  
  const sessionComponent = {
    create: createMock,
    update: updateMock,
    get: getMock,
    updateMessage: updateMessageMock,
  };
  
  return { sessionComponent, createMock, updateMock, getMock, updateMessageMock };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('AgentNode', () => {
  describe('constructor', () => {
    it('should create AgentNode with correct type', () => {
      const definition = createDefaultDefinition();
      const { runner } = createMockRunner();
      
      const node = new AgentNode(definition, runner);
      
      expect(node.type).toBe('agent');
      expect(node.id).toBe('test-agent-node');
    });

    it('should store definition and runner references', () => {
      const definition = createDefaultDefinition();
      const { runner } = createMockRunner();
      
      const node = new AgentNode(definition, runner);
      
      // 通过执行来验证 runner 是否正确
      expect(node).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should run agent successfully with default config', async () => {
      const definition = createDefaultDefinition();
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'agent completed' },
        metadata: { tokens: 100, duration: 500 },
      });
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      expect(result.error).toBeUndefined();
      expect(result.output).toEqual({
        result: { result: 'agent completed' },
        metadata: { tokens: 100, duration: 500 },
      });
    });

    it('should pass correct AgentConfig to runner', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'explore',
          prompt: 'Explore {{input.topic}}',
          options: {
            model: 'gpt-4',
            timeout: 60000,
          },
        },
      });
      const context = createDefaultContext({ input: { topic: 'AI' } });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'exploration complete' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // AgentNode 现在调用 runner.run(config, resumeOptions)
      // 注意：allowedTools: ['ask_user'] 被添加以确保 ask_user 工具在 workflow agent 上下文中可用
      // resumeOptions 始终传递 { userResponse: undefined, agentSessionId: undefined }
      expect(runMock).toHaveBeenCalledWith({
        type: 'explore',
        prompt: 'Explore AI',
        options: {
          model: 'gpt-4',
          timeout: 60000,
          allowedTools: ['ask_user'],  // ask_user 工具仅在 workflow agent 上下文中可用
        },
        workflowHistory: undefined,
        nodeId: 'test-agent-node',
        agentSessionId: undefined,
      }, {
        userResponse: undefined,
        agentSessionId: undefined,
      });
    });

    // Task #1974 — Capability 1b: agentNode must read top-level
    // `config.timeout` (which is populated by nodeConfig[nodeId] merging).
    it('RED→GREEN: should read flat config.timeout (Task #1974 nodeConfig override)', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'explore',
          prompt: 'Explore {{input.topic}}',
          timeout: 5000, // flat key — the new nodeConfig shape
        },
      });
      const context = createDefaultContext({ input: { topic: 'AI' } });
      const { runner, runMock } = createMockRunner();

      runMock.mockResolvedValue({ output: { result: 'done' } });

      const node = new AgentNode(definition, runner);
      await node.execute(context);

      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            timeout: 5000,
          }),
        }),
        expect.anything(),
      );
    });

    it('flat config.timeout wins over config.options.timeout (input precedence)', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'explore',
          prompt: 'Explore {{input.topic}}',
          options: { timeout: 1000 },
          timeout: 9000, // flat key overrides nested
        },
      });
      const context = createDefaultContext({ input: { topic: 'AI' } });
      const { runner, runMock } = createMockRunner();

      runMock.mockResolvedValue({ output: { result: 'done' } });

      const node = new AgentNode(definition, runner);
      await node.execute(context);

      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            timeout: 9000,
          }),
        }),
        expect.anything(),
      );
    });

    it('should resolve prompt template with previous outputs (AgentResult format)', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          prompt: 'Based on {{nodes.fetch-data}}, analyze it',
        },
      });
      // AgentNode 执行后，output 是 { result, metadata } 格式
      const context = createDefaultContext({
        previousOutputs: new Map([
          ['fetch-data', { result: 'fetched data content', metadata: { duration: 100 } }],
        ]),
      });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'analysis complete' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // AgentNode 现在调用 runner.run(config, resumeOptions)
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Based on fetched data content, analyze it',
        }),
        { userResponse: undefined, agentSessionId: undefined }
      );
    });

    it('should resolve prompt template with nested property access', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          prompt: 'The result is: {{nodes.step1.result}}',
        },
      });
      const context = createDefaultContext({
        previousOutputs: new Map([
          ['step1', { result: 'nested result', metadata: {} }],
        ]),
      });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'done' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'The result is: nested result',
        }),
        { userResponse: undefined, agentSessionId: undefined }
      );
    });

    it('should handle agent runner error', async () => {
      const definition = createDefaultDefinition();
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockRejectedValue(new Error('Agent runner failed'));
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      expect(result.error).toBe('Agent runner failed');
    });

    it('should handle agent timeout', async () => {
      const definition = createDefaultDefinition();
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockRejectedValue(new Error('Agent timeout after 30000ms'));
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      expect(result.error).toContain('timeout');
    });

    it('should record execution duration', async () => {
      const definition = createDefaultDefinition();
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'done' },
      });
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      expect(result.duration).toBeDefined();
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include metadata from agent result', async () => {
      const definition = createDefaultDefinition();
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { answer: 42 },
        metadata: {
          tokens: 150,
          duration: 300,
          model: 'gpt-3.5-turbo',
        },
      });
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      expect(result.output).toEqual({
        result: { answer: 42 },
        metadata: {
          tokens: 150,
          duration: 300,
          model: 'gpt-3.5-turbo',
        },
      });
    });

    it('should handle runner returning output without metadata', async () => {
      const definition = createDefaultDefinition();
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { simple: 'result' },
      });
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      expect(result.error).toBeUndefined();
      expect(result.output).toEqual({
        result: { simple: 'result' },
      });
    });

    it('should handle complex template with multiple variables', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          prompt: 'Task: {{input.task}}\nData: {{nodes.step1.output}}',
        },
      });
      const context = createDefaultContext({
        input: { task: 'analyze' },
        previousOutputs: new Map([
          ['step1', { output: 'data from step1' }],
        ]),
      });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'analysis complete' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // AgentNode 现在调用 runner.run(config, resumeOptions)
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Task: analyze\nData: data from step1',
        }),
        { userResponse: undefined, agentSessionId: undefined }
      );
    });
  });

  describe('error handling', () => {
    it('should handle undefined config gracefully', async () => {
      const definition = createDefaultDefinition({ config: undefined as any });
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'ok' },
      });
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      // 应该使用空配置或默认值
      expect(result.error).toBeUndefined();
    });

    it('should handle missing prompt in config', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          // prompt 缺失
        },
      });
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'ok' },
      });
      
      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);
      
      // AgentNode 现在调用 runner.run(config, resumeOptions)
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '', // 应该使用空字符串或默认值
        }),
        { userResponse: undefined, agentSessionId: undefined }
      );
    });
  });

  describe('agent sub-session creation', () => {
    it('RED: should create agent sub-session when sessionComponent is available', async () => {
      // This test verifies the fix for: Fresh workflow run fails with "Session not found"
      // 
      // Problem: AgentNode creates agent sub-session via createAgentSubSession(),
      // but AgentComponentAdapter was not using this session, creating a mismatch.
      //
      // Expected behavior:
      // 1. AgentNode should call sessionComponent.create() to create agent sub-session
      // 2. The created agentSessionId should be passed to AgentRunner via resumeOptions
      // 3. AgentComponentAdapter should use this sessionId from resumeOptions.agentSessionId
      
      const definition = createDefaultDefinition({
        id: 'test-node',
      });
      const { sessionComponent, createMock } = createMockSessionComponent();
      const attachMock = jest.fn().mockResolvedValue(undefined);
      const context = createDefaultContext({
        sessionComponent,
        attachAgentSessionToLastStart: attachMock,
      });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'ok' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Verify: sessionComponent.create should be called to create agent sub-session
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(/^agent_test-node_\d+$/),
          title: 'Agent: test-node',
          // Task #1739: top-level parentSessionId must be the workflow run
          // session id so `sessions list --graph` can render the hierarchy.
          parentSessionId: 'test-session-123',
          metadata: expect.objectContaining({
            type: 'agent',
            nodeId: 'test-node',
          }),
        })
      );

      // Issue #5: metadata must NOT redundantly mirror parentSessionId.
      // The top-level Session.parentSessionId is the canonical source of truth;
      // duplicating it in metadata invites drift.
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.not.objectContaining({
            parentSessionId: 'test-session-123',
          }),
        })
      );
      
      // Verify: The agentSessionId from created session should be passed to runner
      // This ensures AgentComponentAdapter uses the correct session
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: expect.stringMatching(/^agent_test-node_\d+$/),
        }),
        expect.objectContaining({
          agentSessionId: expect.stringMatching(/^agent_test-node_\d+$/),
        })
      );

      expect(attachMock).toHaveBeenCalledWith(
        'test-node',
        expect.stringMatching(/^agent_test-node_\d+$/)
      );
    });

    it('RED: should not create new session if agentSessionId already exists in context', async () => {
      // If agentSessionId is already set in context (e.g., from resume), should not create new session
      
      const definition = createDefaultDefinition({ id: 'test-node' });
      const { sessionComponent, createMock } = createMockSessionComponent();
      const context = createDefaultContext({ 
        sessionComponent,
        agentSessionId: 'existing_agent_session_456',
      });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'ok' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Verify: sessionComponent.create should NOT be called since session already exists
      expect(createMock).not.toHaveBeenCalled();
      
      // Verify: The existing agentSessionId should be passed to runner
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: 'existing_agent_session_456',
        }),
        expect.objectContaining({
          agentSessionId: 'existing_agent_session_456',
        })
      );
    });

    it('should resolve agentSessionId from workflow metadata.agentSessions on resume', async () => {
      const definition = createDefaultDefinition({ id: 'agent-confirm' });
      const { sessionComponent, createMock, getMock } = createMockSessionComponent();

      getMock.mockResolvedValue({
        id: 'test-session-123',
        metadata: {
          agentSessions: [
            { nodeId: 'agent-confirm', sessionId: 'agent_from_metadata_789', status: 'active' },
          ],
        },
      });

      const context = createDefaultContext({
        sessionComponent,
        workflowInput: { userQuery: 'Yes' },
      });
      (context as any).input = { userQuery: 'Yes' };

      const { runner, runMock } = createMockRunner();
      runMock.mockResolvedValue({ output: { result: 'CONFIRMED: Yes' } });

      const node = new AgentNode(definition, runner);
      await node.execute(context);

      expect(createMock).not.toHaveBeenCalled();
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: 'agent_from_metadata_789' }),
        expect.objectContaining({
          userQuery: 'Yes',
          agentSessionId: 'agent_from_metadata_789',
        })
      );
    });

    it('should pass agentSessionId to resumeOptions for fresh run', async () => {
      // This test specifically verifies that resumeOptions.agentSessionId is set correctly
      // AgentComponentAdapter reads from resumeOptions.agentSessionId first
      
      const definition = createDefaultDefinition({ id: 'greeting-agent' });
      const { sessionComponent, createMock } = createMockSessionComponent();
      const context = createDefaultContext({ sessionComponent });
      const { runner, runMock } = createMockRunner();
      
      runMock.mockResolvedValue({
        output: { result: 'ok' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // The key assertion: resumeOptions.agentSessionId should be set
      // This is what AgentComponentAdapter checks first in run()
      expect(runMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userQuery: undefined,
          agentSessionId: expect.stringMatching(/^agent_greeting-agent_\d+$/),
        })
      );
    });
  });

  describe('json structured output mode', () => {
    const verifySchema = {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        feedback: { type: 'string' },
      },
      required: ['passed'],
    };

    it('should pass outputSchema and enable json plugin without workflow_submit_output tool', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          prompt: 'Verify the task',
          output: { mode: 'json', schema: verifySchema },
        },
      });
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();

      runMock.mockResolvedValue({
        output: { passed: false, feedback: 'missing' },
        structuredOutput: { passed: false, feedback: 'missing' },
      });

      const node = new AgentNode(definition, runner);
      await node.execute(context);

      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: ['ask_user'],
            outputSchema: verifySchema,
          }),
        }),
        expect.anything()
      );
    });

    it('should flatten json fields in node output for template access', async () => {
      const definition = createDefaultDefinition({
        id: 'verify',
        config: {
          agent_type: 'general',
          prompt: 'Verify',
          output: { mode: 'json', schema: verifySchema },
        },
      });
      const context = createDefaultContext();
      const { runner, runMock } = createMockRunner();

      runMock.mockResolvedValue({
        output: { passed: false, feedback: 'missing token' },
        structuredOutput: { passed: false, feedback: 'missing token' },
        metadata: { duration: 42 },
      });

      const node = new AgentNode(definition, runner);
      const result = await node.execute(context);

      expect(result.output).toMatchObject({
        result: { passed: false, feedback: 'missing token' },
        passed: false,
        feedback: 'missing token',
        metadata: expect.objectContaining({ outputMode: 'json', duration: 42 }),
      });
    });
  });

  describe('agent_name support', () => {
    it('should use agent_name as type when registered agent exists', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_name: 'web-search',
          prompt: 'Search for {{input.query}}',
        },
      });
      const context = createDefaultContext({ input: { query: 'AI news' } });
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      hasAgentMock.mockReturnValue(true);
      getAgentConfigMock.mockReturnValue({
        type: 'general',
        model: 'minimax/MiniMax-Text-01',
        allowedTools: ['web_search', 'ask_user'],
      });
      
      runMock.mockResolvedValue({
        output: { result: 'search results' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Should use agent_name as type (routes to the correct registered agent)
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'web-search',
        }),
        expect.any(Object)
      );
    });

    it('should inherit model from registered agent config', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_name: 'explore',
          prompt: 'Explore {{input.topic}}',
        },
      });
      const context = createDefaultContext({ input: { topic: 'AI' } });
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      hasAgentMock.mockReturnValue(true);
      getAgentConfigMock.mockReturnValue({
        type: 'general',
        model: 'minimax/MiniMax-Text-01',
        allowedTools: ['web_search'],
      });
      
      runMock.mockResolvedValue({
        output: { result: 'exploration complete' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Should inherit model from registered agent
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'minimax/MiniMax-Text-01',
          }),
        }),
        expect.any(Object)
      );
    });

    it('should allow YAML options.model to override inherited model', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_name: 'explore',
          prompt: 'Explore {{input.topic}}',
          options: {
            model: 'gpt-4',  // YAML explicitly specifies model
          },
        },
      });
      const context = createDefaultContext({ input: { topic: 'AI' } });
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      hasAgentMock.mockReturnValue(true);
      getAgentConfigMock.mockReturnValue({
        type: 'general',
        model: 'minimax/MiniMax-Text-01',  // inherited model
        allowedTools: ['web_search'],
      });
      
      runMock.mockResolvedValue({
        output: { result: 'exploration complete' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // YAML options.model should override inherited model
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'gpt-4',
          }),
        }),
        expect.any(Object)
      );
    });

    it('should inherit allowedTools and deniedTools from registered agent', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_name: 'web-search',
          prompt: 'Search',
        },
      });
      const context = createDefaultContext();
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      hasAgentMock.mockReturnValue(true);
      getAgentConfigMock.mockReturnValue({
        type: 'general',
        model: 'gpt-4',
        allowedTools: ['web_search', 'fetch_url'],
        deniedTools: ['shell_exec'],
      });
      
      runMock.mockResolvedValue({
        output: { result: 'done' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Should inherit allowedTools and deniedTools from registered agent
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: expect.arrayContaining(['web_search', 'fetch_url']),
            deniedTools: ['shell_exec'],
          }),
        }),
        expect.any(Object)
      );
    });

    it('should fall back to agent_type when agent_name is not registered', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_name: 'non-existent-agent',
          agent_type: 'general',
          prompt: 'Test prompt',
        },
      });
      const context = createDefaultContext();
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      hasAgentMock.mockReturnValue(false);
      getAgentConfigMock.mockReturnValue(undefined);
      
      runMock.mockResolvedValue({
        output: { result: 'fallback result' },
      });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Should fall back to agent_type 
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'general',
        }),
        expect.any(Object)
      );
    });

    // ────────────────────────────────────────────────────────────────────
    // Task #2060 (Bug fix: roy-rd-pipeline init-task node gets only ask_user)
    //
    // Symptom: when a workflow agent node uses `agent_type: roy` without
    // `agent_name` and without `options.allowedTools`, the runner only
    // configured `['ask_user']` as the tool whitelist. The init-task
    // node then cannot call task_create / task_update / bash / read_file /
    // edit_file → workflow hangs on ask_user interrupt.
    //
    // Root cause: the agent_type registry lookup only ran for `agent_name`,
    // not for `agent_type`. The auto-registered agent had no allowedTools,
    // so the code fell back to the default `['ask_user']` whitelist.
    //
    // Expected: when `agent_type` resolves to a registered agent (e.g. `roy`),
    // inherit that agent's config (deniedTools + allowedTools-undefined =
    // "all tools allowed") instead of falling back to `['ask_user']`.
    // ────────────────────────────────────────────────────────────────────
    it('RED #2060: should inherit allowedTools/deniedTools from agent_type registry when agent_name is not specified', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'roy',  // No agent_name — mimics roy-rd-pipeline init-task
          prompt: 'Phase 1: 任务管理',
        },
      });
      const context = createDefaultContext();
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      // Simulate: 'roy' is registered (built-in) but no other agents
      hasAgentMock.mockImplementation((name: string) => name === 'roy');
      getAgentConfigMock.mockImplementation((name: string) => {
        if (name === 'roy') {
          // Built-in roy agent: no allowedTools (all allowed),
          // denies delegate_task + stop_task.
          return {
            type: 'sub',
            deniedTools: ['delegate_task', 'stop_task'],
            // allowedTools intentionally undefined → "no restriction"
          };
        }
        return undefined;
      });
      
      runMock.mockResolvedValue({ output: { result: 'done' } });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Should use 'roy' as the agent type
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'roy',
          options: expect.objectContaining({
            // Should inherit deniedTools from 'roy' registry
            deniedTools: ['delegate_task', 'stop_task'],
            // ❌ MUST NOT default to ['ask_user'] — that was the bug
            allowedTools: expect.not.arrayContaining([]),  // placeholder, real check below
          }),
        }),
        expect.any(Object)
      );
      
      // Critical: allowedTools should NOT be the restrictive ['ask_user']
      const callArgs = runMock.mock.calls[0]?.[0] as AgentConfig;
      expect(callArgs.options?.allowedTools).not.toEqual(['ask_user']);
      // Should not have any tool whitelist restriction at all
      expect(callArgs.options?.allowedTools).toBeUndefined();
    });

    it('RED #2060: should still default to ask_user when agent_type is NOT in registry (existing behavior preserved)', async () => {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'unknown-agent',  // Not in registry
          prompt: 'Test prompt',
        },
      });
      const context = createDefaultContext();
      const { runner, runMock, hasAgentMock, getAgentConfigMock } = createMockRunner();
      
      // 'unknown-agent' is NOT in registry → auto-registers with no tools
      hasAgentMock.mockReturnValue(false);
      getAgentConfigMock.mockReturnValue(undefined);
      
      runMock.mockResolvedValue({ output: { result: 'done' } });
      
      const node = new AgentNode(definition, runner);
      await node.execute(context);
      
      // Should fall back to ['ask_user'] when no agent info is available
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: ['ask_user'],
          }),
        }),
        expect.any(Object)
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #2135 — prompt_injection (v2 re-run for workflow verification)
  //
  // Background: workflow caller can pass an optional `prompt_injection`
  // string via `workflow run --input '{"prompt_injection": "..."}'`.
  // AgentNode.execute() should append it to the resolved prompt using a
  // unified separator. Empty / missing → behavior identical to before.
  // See plan: docs/superpowers/plans/2026-07-18-agent-node-prompt-inject-v2-plan.md
  // ────────────────────────────────────────────────────────────────────
  describe('prompt_injection (Task #2135)', () => {
    /**
     * Default agent has no special tools / no agent_name lookup → easy target
     * for asserting the prompt string only.
     */
    function makeGeneralAgentContext(workflowInput: Record<string, unknown> | undefined) {
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          prompt: 'Original task description',
        },
      });
      const context = createDefaultContext({
        workflowInput,
      });
      const { runner, runMock } = createMockRunner();
      runMock.mockResolvedValue({ output: { result: 'done' } });
      return { definition, context, runner, runMock };
    }

    it('keeps the prompt unchanged when prompt_injection is not provided', async () => {
      const { definition, context, runner, runMock } = makeGeneralAgentContext(undefined);
      const node = new AgentNode(definition, runner);
      await node.execute(context);

      expect(runMock).toHaveBeenCalledTimes(1);
      const submittedConfig = runMock.mock.calls[0]?.[0] as AgentConfig;
      expect(submittedConfig.prompt).toBe('Original task description');
    });

    it('keeps the prompt unchanged when prompt_injection is empty string', async () => {
      const { definition, context, runner, runMock } = makeGeneralAgentContext({ prompt_injection: '' });
      const node = new AgentNode(definition, runner);
      await node.execute(context);

      const submittedConfig = runMock.mock.calls[0]?.[0] as AgentConfig;
      expect(submittedConfig.prompt).toBe('Original task description');
    });

    it('appends prompt_injection with a caller-injection separator', async () => {
      const injection = '额外约束：只用 JSON 返回';
      const { definition, context, runner, runMock } = makeGeneralAgentContext({ prompt_injection: injection });
      const node = new AgentNode(definition, runner);
      await node.execute(context);

      const submittedConfig = runMock.mock.calls[0]?.[0] as AgentConfig;
      expect(submittedConfig.prompt).toBe(
        `Original task description\n\n---\n[Caller Injection]\n${injection}`
      );
    });

    it('appends injection AFTER template resolution (post-{}-substitution)', async () => {
      // templateResolver default in createDefaultContext replaces {{input.name}} → 'World'
      const definition = createDefaultDefinition({
        config: {
          agent_type: 'general',
          prompt: 'Hello, {{input.name}}!',
        },
      });
      const context = createDefaultContext({
        workflowInput: { prompt_injection: 'You must respond in English.' },
      });
      const { runner, runMock } = createMockRunner();
      runMock.mockResolvedValue({ output: { result: 'done' } });

      const node = new AgentNode(definition, runner);
      await node.execute(context);

      const submittedConfig = runMock.mock.calls[0]?.[0] as AgentConfig;
      // Template resolution already happened in resolvedPrompt; injection appended after
      expect(submittedConfig.prompt).toBe(
        'Hello, World!\n\n---\n[Caller Injection]\nYou must respond in English.'
      );
      // And the template placeholder must NOT leak into the final prompt
      expect(submittedConfig.prompt).not.toContain('{{input.name}}');
    });
  });
});
