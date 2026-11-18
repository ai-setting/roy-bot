/**
 * Regression tests for the bash `echo "..."` shell-escape regex bug.
 *
 * Bug: /^echo\s+"([\s\S]*)"\s*$/ uses [\s\S]* greedy, which spans newlines.
 * Multi-line bash scripts that START with `echo "..." && \` continuation
 * were being matched in their entirety, then shell-escaped as a single
 * literal string. Bash never executed them — only echoed the escaped text.
 *
 * Fix: regex must NOT match across newlines.
 */

import { describe, it, expect, beforeEach, jest } from 'vitest';
import { ToolNode } from './tool-node';
import type { NodeDefinition, NodeExecutionContext } from '../types';
import type { EventBus } from '../engine/event-bus';

const mockEventBus = {
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
} as Partial<EventBus> as EventBus;

const mockTool = {
  name: 'bash',
  execute: jest.fn<(input: any) => Promise<any>>(),
};

const mockRegistry = {
  getTool: jest.fn<(name: string) => any>(),
  hasTool: jest.fn<(name: string) => boolean>(),
} as {
  getTool: ReturnType<typeof jest.fn>;
  hasTool: ReturnType<typeof jest.fn>;
};

describe('ToolNode — bash echo shell-escape regex', () => {
  let nodeDefinition: NodeDefinition;
  let executionContext: NodeExecutionContext;
  let previousOutputsMap: Map<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    previousOutputsMap = new Map();

    nodeDefinition = {
      id: 'node-bash',
      type: 'tool',
      name: 'Bash Node',
      config: {
        tool: 'bash',
        command: 'echo "hello"',
      },
    };

    const passthroughResolver = {
      resolveValue: (input: unknown): unknown => input,
    };

    executionContext = {
      runId: 'run-1',
      workflowName: 'test-workflow',
      nodeId: 'node-bash',
      input: {},
      previousOutputs: previousOutputsMap,
      config: nodeDefinition.config,
      debug: false,
      eventBus: mockEventBus,
      sessionId: 'session-1',
      nodeOutputs: new Map(),
      askUser: () => { throw new Error('not used'); },
      templateResolver: passthroughResolver as any,
    } as unknown as NodeExecutionContext;

    mockRegistry.getTool = jest.fn().mockReturnValue(mockTool);
    mockRegistry.hasTool = jest.fn().mockReturnValue(true);
    mockTool.execute = jest.fn().mockResolvedValue({ stdout: 'ok' });
  });

  function lastBashCommand(): string {
    const calls = (mockTool.execute as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastInput = calls[calls.length - 1][0];
    expect(typeof lastInput.command).toBe('string');
    return lastInput.command as string;
  }

  describe('backward compat: single-line echo "..." still gets shell-escape applied', () => {
    it('escapes $ inside single-line echo to prevent variable expansion', async () => {
      nodeDefinition.config.command = 'echo "Price: $100"';
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      expect(lastBashCommand()).toBe('echo "Price: \\$100"');
    });

    it('escapes backticks inside single-line echo to prevent command substitution', async () => {
      nodeDefinition.config.command = 'echo "literal backtick: `code`"';
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      // both backticks get escaped
      expect(lastBashCommand()).toBe('echo "literal backtick: \\`code\\`"');
    });

    it('leaves plain single-line echo unchanged when no special chars present', async () => {
      nodeDefinition.config.command = 'echo "hello world"';
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      expect(lastBashCommand()).toBe('echo "hello world"');
    });
  });

  describe('BUG FIX: multi-line bash scripts are NOT echo-escaped', () => {
    it('passes through multi-line echo "..." && \\ continuation unchanged', async () => {
      const multiLine =
        'echo "=== verify start ===" && \\\n' +
        '  echo "second line" && \\\n' +
        '  echo "third line"';

      nodeDefinition.config.command = multiLine;
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      // Command must be passed through UNCHANGED — no echo-escape wrapping,
      // no transformation. Engine must execute the script, not echo it.
      expect(lastBashCommand()).toBe(multiLine);
    });

    it('passes through real avatar-restart shape (echo + ssh + docker ps) unchanged', async () => {
      // This is the exact pattern that was getting literal-escaped
      // before the fix — multi-line script starting with echo "..."
      // followed by `&& \` continuation including ssh.
      const multiLine =
        'echo "=== 验证启动状态 ===" && \\\n' +
        '  ssh -i ~/.ssh/x user@host \\\n' +
        "    'docker ps --filter name=livetalking' && \\\n" +
        '  echo "=== 验证结束 ==="';

      nodeDefinition.config.command = multiLine;
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      expect(lastBashCommand()).toBe(multiLine);
    });

    it('passes through pipelined multi-line commands unchanged', async () => {
      const multiLine =
        'echo "=== step 1 ===" && \\\n' +
        '  docker ps --filter name=livetalking | head -5 && \\\n' +
        '  echo "=== step 2 ===" && \\\n' +
        '  docker logs --tail 20 livetalking';

      nodeDefinition.config.command = multiLine;
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      expect(lastBashCommand()).toBe(multiLine);
    });
  });

  describe('regression guards', () => {
    it('does not modify commands that do not match echo "..." pattern', async () => {
      nodeDefinition.config.command = 'ls -la /tmp';
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      expect(lastBashCommand()).toBe('ls -la /tmp');
    });

    it('does not modify echo without double quotes', async () => {
      nodeDefinition.config.command = 'echo hello';
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      expect(lastBashCommand()).toBe('echo hello');
    });

    it('does not modify echo with single quotes (different shell semantics)', async () => {
      nodeDefinition.config.command = "echo 'Price: $100'";
      executionContext.config = nodeDefinition.config;
      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      // Single-quoted echo is NOT what the escape optimization targets —
      // bash already treats single-quoted content as literal.
      expect(lastBashCommand()).toBe("echo 'Price: $100'");
    });

    it('does not run escape logic for non-bash tools', async () => {
      // Use a non-bash tool with a single-line echo "..." command.
      // The echo-escape optimization is bash-specific.
      nodeDefinition.config = {
        tool: 'custom-tool',
        command: 'echo "Price: $100"',
      };
      executionContext.config = nodeDefinition.config;

      // Mock the custom tool
      const customTool = {
        name: 'custom-tool',
        execute: jest.fn().mockResolvedValue({ ok: true }),
      };
      mockRegistry.getTool = jest.fn().mockReturnValue(customTool);

      const toolNode = new ToolNode(nodeDefinition, mockRegistry);

      await toolNode.execute(executionContext);

      // Non-bash: command should pass through unchanged
      expect((customTool.execute as any).mock.calls[0][0].command).toBe(
        'echo "Price: $100"'
      );
    });
  });
});
