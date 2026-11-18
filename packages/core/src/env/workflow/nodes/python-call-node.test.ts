/**
 * Tests for PythonCallNode
 *
 * Task #1998: 投资选股 workflow 解耦 CLI/bash 依赖
 *
 * PythonCallNode is a new workflow node type that executes a Python function
 * via subprocess. This decouples workflows from hardcoded paths like
 * `~/work/.../.venv/bin/python scripts/*.py`.
 *
 * Design:
 *   - Spawn: `python3 -c "<source>"` where <source> reads JSON args from stdin
 *     and writes JSON result to stdout.
 *   - Config: { module, function, args?, cwd?, python?, timeout? }
 *   - Output: parsed JSON if stdout looks like JSON, otherwise raw string.
 *   - MVP safety: module must start with an allow-list prefix (default `investment_strategy`).
 *
 * Tests inject a fake `spawn` function via the constructor's `spawnFn` option,
 * so no real Python or `jest.mock('node:child_process')` plumbing is required.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  PythonCallNode,
  type PythonCallAllowList,
  type PythonCallNodeOptions,
} from './python-call-node';
import type { NodeDefinition, NodeExecutionContext } from '../types';
import type { EventBus } from '../engine/event-bus';

// Mock EventBus
const mockEventBus = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
} as Partial<EventBus> as EventBus;

describe('PythonCallNode', () => {
  /**
   * Fake child process returned by the injected spawnFn.
   * Captures stdin write, then emits stdout/stderr/close on next tick.
   */
  function makeFakeChild(opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    hang?: boolean;
  } = {}): any {
    const { stdout = '', stderr = '', exitCode = 0, hang = false } = opts;
    const ee = new EventEmitter();
    const stdoutStream = new EventEmitter();
    const stderrStream = new EventEmitter();
    const stdinChunks: Buffer[] = [];
    const stdinStream: any = new EventEmitter();
    stdinStream.write = (chunk: Buffer | string) => {
      stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    stdinStream.end = (chunk?: Buffer | string) => {
      if (chunk !== undefined) {
        stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      stdinStream.emit('end');
      stdinStream.emit('finish');
    };
    const child: any = ee;
    child.stdout = stdoutStream;
    child.stderr = stderrStream;
    child.stdin = stdinStream;
    child.kill = vi.fn();
    child.killed = false;
    child.pid = 12345;
    child.stdinChunks = stdinChunks;
    if (!hang) {
      setImmediate(() => {
        if (stdout) stdoutStream.emit('data', Buffer.from(stdout));
        if (stderr) stderrStream.emit('data', Buffer.from(stderr));
        ee.emit('close', exitCode);
      });
    }
    return child;
  }

  /**
   * SpawnFn that records the call and returns the next queued fake child.
   */
  function makeSpawnFn(): { fn: Mock; queue: ReturnType<typeof makeFakeChild>[] } {
    const queue: ReturnType<typeof makeFakeChild>[] = [];
    const fn = vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) throw new Error('makeSpawnFn: queue empty — test must queue a child');
      return next;
    });
    return { fn, queue };
  }

  function createContext(node: NodeDefinition, workflowInput?: Record<string, unknown>): NodeExecutionContext {
    const previousOutputsMap = new Map<string, unknown>();
    const resolveValue = (input: unknown): unknown => {
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) {
          resolved[k] = resolveValue(v);
        }
        return resolved;
      }
      if (typeof input !== 'string') return input;
      // Match production TemplateResolver: pure-template references preserve the
      // underlying value's type; mixed strings collapse to a string.
      const pureMatch = /^\s*\{\{([^}]+)\}\}\s*$/.exec(input);
      if (pureMatch) {
        const p = pureMatch[1].trim();
        if (p.startsWith('input.')) {
          const v = (workflowInput as Record<string, unknown> | undefined)?.[p.slice(6)];
          return v !== undefined ? v : input;
        }
        return input;
      }
      return input.replace(/\{\{([^}]+)\}\}/g, (m: string, p: string) => {
        const trimmed = p.trim();
        if (trimmed.startsWith('input.')) {
          const v = (workflowInput as Record<string, unknown> | undefined)?.[trimmed.slice(6)];
          return v !== undefined ? String(v) : m;
        }
        return m;
      });
    };

    return {
      runId: 'run-1',
      workflowName: 'test-workflow',
      nodeId: node.id,
      input: {},
      workflowInput,
      previousOutputs: previousOutputsMap,
      config: node.config,
      debug: false,
      eventBus: mockEventBus,
      sessionId: 'session-1',
      nodeOutputs: new Map(),
      askUser: () => { throw new Error('askUser not implemented'); },
      templateResolver: { resolveValue } as any,
    } as unknown as NodeExecutionContext;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('basic execution', () => {
    it('executes python -c with module/function and parses JSON stdout', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: '{"ok":true,"n":42}\n' }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-1',
        type: 'python_call',
        name: 'Run Python',
        config: {
          module: 'investment_strategy.scripts.market_timing',
          function: 'run',
          args: { base_top_n: 20 },
          timeout: 60000,
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn } as PythonCallNodeOptions);
      const ctx = createContext(nodeDefinition);

      const result = await node.execute(ctx);

      expect(result.error).toBeUndefined();
      expect(result.output).toEqual({ ok: true, n: 42 });

      // Verify spawn call shape
      expect(fn).toHaveBeenCalledTimes(1);
      const [bin, args, options] = fn.mock.calls[0];
      expect(bin).toBe('python3');
      expect(Array.isArray(args)).toBe(true);
      expect(args[0]).toBe('-c');
      expect(args[1]).toContain('from investment_strategy.scripts.market_timing import run');
      expect(args[1]).toMatch(/import\s+sys,\s*json|import\s+json,\s*sys/);
      // Stdin is pipe so we can pipe JSON args; stdout/stderr are pipe.
      expect(options).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
      // options should be an object
      expect(typeof options).toBe('object');
    });

    it('sends JSON-encoded args via stdin', async () => {
      const { fn, queue } = makeSpawnFn();
      const child = makeFakeChild({ stdout: '{"ok":1}\n' });
      queue.push(child);

      const nodeDefinition: NodeDefinition = {
        id: 'python-args',
        type: 'python_call',
        config: {
          module: 'investment_strategy.x',
          function: 'y',
          args: { foo: 'bar', n: 7 },
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      await node.execute(createContext(nodeDefinition));

      const stdinBuf = Buffer.concat(child.stdinChunks).toString('utf8');
      expect(JSON.parse(stdinBuf)).toEqual({ foo: 'bar', n: 7 });
    });

    it('returns raw string when stdout is not JSON', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: 'plain text output\n' }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-2',
        type: 'python_call',
        config: {
          module: 'investment_strategy.scripts.foo',
          function: 'bar',
          args: {},
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('plain text output');
    });

    it('parses a JSON-encoded string result without retaining serialization quotes', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: '"hello, 世界"\n' }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-json-string',
        type: 'python_call',
        config: {
          module: 'investment_strategy.scripts.greeting',
          function: 'run',
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));

      expect(result.error).toBeUndefined();
      expect(result.output).toBe('hello, 世界');
    });

    it('decodes escaped newlines in a JSON-encoded string result', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: '"line 1\\nline 2"\n' }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-json-multiline-string',
        type: 'python_call',
        config: {
          module: 'investment_strategy.scripts.greeting',
          function: 'run',
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));

      expect(result.error).toBeUndefined();
      expect(result.output).toBe('line 1\nline 2');
    });

    it('returns error result when subprocess exits non-zero', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({
        stderr: 'Traceback...\nModuleNotFoundError: No module named foo',
        exitCode: 1,
      }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-3',
        type: 'python_call',
        config: {
          module: 'investment_strategy.scripts.broken',
          function: 'main',
          args: {},
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/exit code 1/);
    });
  });

  describe('config validation', () => {
    it('returns error result when module is missing', async () => {
      const { fn } = makeSpawnFn();
      const nodeDefinition: NodeDefinition = {
        id: 'python-4',
        type: 'python_call',
        config: { function: 'main' },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/module is required/);
      expect(fn).not.toHaveBeenCalled();
    });

    it('returns error result when function is missing', async () => {
      const { fn } = makeSpawnFn();
      const nodeDefinition: NodeDefinition = {
        id: 'python-5',
        type: 'python_call',
        config: { module: 'investment_strategy.x' },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/function is required/);
      expect(fn).not.toHaveBeenCalled();
    });

    it('rejects module outside the allow-list (security: MVP)', async () => {
      const { fn } = makeSpawnFn();
      const nodeDefinition: NodeDefinition = {
        id: 'python-6',
        type: 'python_call',
        config: {
          module: 'os',
          function: 'system',
          args: { cmd: 'rm -rf /' },
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/not allowed/);
      expect(fn).not.toHaveBeenCalled();
    });

    it('rejects function containing dangerous chars', async () => {
      const { fn } = makeSpawnFn();
      const nodeDefinition: NodeDefinition = {
        id: 'python-7',
        type: 'python_call',
        config: {
          module: 'investment_strategy.x',
          function: 'os.system',
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/invalid/);
      expect(fn).not.toHaveBeenCalled();
    });

    it('accepts a custom allow-list that includes additional prefixes', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: '{"ok":1}\n' }));

      const allowList: PythonCallAllowList = { prefix: ['my_pkg', 'investment_strategy'] };
      const nodeDefinition: NodeDefinition = {
        id: 'python-8',
        type: 'python_call',
        config: {
          module: 'my_pkg.foo',
          function: 'bar',
          args: {},
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn, allowList });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeUndefined();
      expect(result.output).toEqual({ ok: 1 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('default node (no allow-list option) blocks non-investment_strategy modules', async () => {
      const { fn } = makeSpawnFn();
      const nodeDefinition: NodeDefinition = {
        id: 'python-default-block',
        type: 'python_call',
        config: {
          module: 'random_pkg.x',
          function: 'y',
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/not allowed/);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('templating and cwd', () => {
    it('resolves templates in args from workflow input', async () => {
      const { fn, queue } = makeSpawnFn();
      const child = makeFakeChild({ stdout: '{"ok":1}\n' });
      queue.push(child);

      const nodeDefinition: NodeDefinition = {
        id: 'python-9',
        type: 'python_call',
        config: {
          module: 'investment_strategy.scripts.foo',
          function: 'bar',
          args: { top_n: '{{input.base_top_n}}' },
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      await node.execute(createContext(nodeDefinition, { base_top_n: 20 }));

      const stdinBuf = Buffer.concat(child.stdinChunks).toString('utf8');
      expect(JSON.parse(stdinBuf)).toEqual({ top_n: 20 });
    });

    it('passes cwd to spawn options when provided', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: '{"ok":1}\n' }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-10',
        type: 'python_call',
        config: {
          module: 'investment_strategy.x',
          function: 'y',
          args: {},
          cwd: '/tmp/work',
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      await node.execute(createContext(nodeDefinition));
      const [, , options] = fn.mock.calls[0];
      expect(options).toMatchObject({ cwd: '/tmp/work' });
    });

    it('allows custom python binary override', async () => {
      const { fn, queue } = makeSpawnFn();
      queue.push(makeFakeChild({ stdout: '{"ok":1}\n' }));

      const nodeDefinition: NodeDefinition = {
        id: 'python-11',
        type: 'python_call',
        config: {
          module: 'investment_strategy.x',
          function: 'y',
          args: {},
          python: '/opt/conda/bin/python3.11',
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      await node.execute(createContext(nodeDefinition));
      const [bin] = fn.mock.calls[0];
      expect(bin).toBe('/opt/conda/bin/python3.11');
    });
  });

  describe('timeout', () => {
    it('returns error result when execution exceeds timeout', async () => {
      const { fn, queue } = makeSpawnFn();
      const hangingChild = makeFakeChild({ hang: true });
      queue.push(hangingChild);

      const nodeDefinition: NodeDefinition = {
        id: 'python-12',
        type: 'python_call',
        config: {
          module: 'investment_strategy.x',
          function: 'hang',
          args: {},
          timeout: 80,
        },
      };
      const node = new PythonCallNode(nodeDefinition, { spawnFn: fn });
      const result = await node.execute(createContext(nodeDefinition));
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/timed out|timeout/i);
      // kill() should have been called at least once
      expect(hangingChild.kill).toHaveBeenCalled();
    });
  });

  describe('config helpers', () => {
    it('exposes a type field "python_call"', () => {
      const nodeDefinition: NodeDefinition = {
        id: 'python-x',
        type: 'python_call',
        config: { module: 'investment_strategy.x', function: 'y' },
      };
      const node = new PythonCallNode(nodeDefinition);
      expect(node.type).toBe('python_call');
      expect(node.id).toBe('python-x');
    });
  });
});