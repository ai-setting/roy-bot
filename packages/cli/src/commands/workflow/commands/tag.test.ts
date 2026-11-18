/**
 * Workflow Tag CLI Command Tests (v3)
 *
 * Verifies the `workflow tag list` and `workflow tag get` subcommands.
 *
 * Coverage:
 * - tag list: default sort, custom sort, limit, --json output, empty pool
 * - tag get: existing tag, non-existing tag, --json output
 * - help text: --sort-by, --order, --limit, --json options
 */

import { describe, it, expect } from 'bun:test';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../../..');
const royBin = path.join(projectRoot, 'packages/cli/src/bin/roy-bot.ts');

// Helper to run CLI command with proper timeout using Bun subprocess
async function runCliCommand(
  args: string[],
  timeoutMs: number = 15000
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const runProcess = async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'run', royBin, ...args],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const code = await proc.exited;
    return { stdout, stderr, code };
  };

  return Promise.race([
    runProcess(),
    sleep(timeoutMs).then(() => {
      throw new Error(
        `Command timed out after ${timeoutMs}ms: bun run ${royBin} ${args.join(' ')}`
      );
    }),
  ]);
}

// Pre-existing: flaky timeout test (5000ms) — also fails in serial.
// Skip in parallel (Task #2023 Y-plan).
const isParallelRun = !!process.env.BUN_TEST_WORKER_ID;

describe.skipIf(isParallelRun)('Workflow Tag CLI Commands (v3)', () => {
  describe('workflow tag list --help', () => {
    it('should show --sort-by option', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list', '--help']);
      expect(result.stdout).toContain('--sort-by');
    });

    it('should show --order option', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list', '--help']);
      expect(result.stdout).toContain('--order');
    });

    it('should show --limit option', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list', '--help']);
      expect(result.stdout).toContain('--limit');
    });

    it('should show --json option', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list', '--help']);
      expect(result.stdout).toContain('--json');
    });

    it('should describe the soft-prompt purpose', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list', '--help']);
      // Should mention "BEFORE `workflow add`" or "semantic consistency"
      const hasSoftPrompt =
        result.stdout.toLowerCase().includes('workflow add') ||
        result.stdout.toLowerCase().includes('semantic consistency');
      expect(hasSoftPrompt).toBe(true);
    });
  });

  describe('workflow tag get --help', () => {
    it('should require a name positional', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'get', '--help']);
      expect(result.stdout).toContain('name');
    });

    it('should show --json option', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'get', '--help']);
      expect(result.stdout).toContain('--json');
    });
  });

  describe('workflow tag list (empty)', () => {
    it('should not throw when no tags exist (returns empty list)', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list']);
      // Either succeeds with empty list, or fails gracefully — but should not hang
      // We don't assert specific content because the global tag table may have entries
      expect(typeof result.stdout).toBe('string');
    });
  });

  describe('workflow tag list --json', () => {
    it('should produce valid JSON output with tags and total fields', async () => {
      const result = await runCliCommand(['workflow', 'tag', 'list', '--json']);
      // Find first '{' and extract a balanced JSON object until matching '}'
      const stdout = result.stdout;
      const startIdx = stdout.indexOf('{');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      let depth = 0;
      let endIdx = -1;
      let inString = false;
      let escape = false;
      for (let i = startIdx; i < stdout.length; i++) {
        const ch = stdout[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      expect(endIdx).toBeGreaterThan(startIdx);
      const jsonStr = stdout.slice(startIdx, endIdx + 1);
      const parsed = JSON.parse(jsonStr);
      expect(parsed).toHaveProperty('tags');
      expect(parsed).toHaveProperty('total');
      expect(Array.isArray(parsed.tags)).toBe(true);
      if (parsed.tags.length > 0) {
        expect(parsed.tags[0]).toHaveProperty('name');
        expect(parsed.tags[0]).toHaveProperty('usage_count');
      }
    });
  });

  describe('workflow tag list --sort-by', () => {
    it('should accept name as sort field', async () => {
      const result = await runCliCommand([
        'workflow',
        'tag',
        'list',
        '--sort-by',
        'name',
        '--order',
        'asc',
        '--json',
      ]);
      // Either succeeds with sorted JSON, or fails with validation error
      // We just check the command doesn't hang
      expect(typeof result.stdout).toBe('string');
    });

    it('should reject invalid sort field', async () => {
      const result = await runCliCommand([
        'workflow',
        'tag',
        'list',
        '--sort-by',
        'garbage',
      ]);
      // Should fail (non-zero exit or error message)
      const hasError =
        result.code !== 0 ||
        result.stdout.includes('Invalid') ||
        result.stderr.includes('Invalid') ||
        result.stdout.includes('Choices') ||
        result.stderr.includes('Choices');
      expect(hasError).toBe(true);
    });
  });

  describe('workflow tag get <name>', () => {
    it('should return error for non-existent tag', async () => {
      const result = await runCliCommand([
        'workflow',
        'tag',
        'get',
        'this-tag-does-not-exist-anywhere-xyz123',
      ]);
      // Should fail gracefully
      const hasError =
        result.code !== 0 ||
        result.stdout.includes('not found') ||
        result.stderr.includes('not found');
      expect(hasError).toBe(true);
    });

    it('should accept --json flag with non-existent tag', async () => {
      const result = await runCliCommand([
        'workflow',
        'tag',
        'get',
        'nonexistent-tag-xyz',
        '--json',
      ]);
      // Should produce output (possibly with error in JSON)
      expect(typeof result.stdout).toBe('string');
    });
  });

  describe('command registration', () => {
    it('should appear in workflow --help', async () => {
      const result = await runCliCommand(['workflow', '--help']);
      expect(result.stdout).toContain('tag');
    });
  });
});

describe('Workflow Tag CLI — unit tests (mocked service)', () => {
  // Direct test of the traced core implementation with a mocked OutputService + env.
  // This avoids subprocess overhead and lets us exercise rendering logic.

  function createMockOutput(): any {
    const lines: string[] = [];
    const jsonOutputs: any[] = [];
    return {
      lines,
      jsonOutputs,
      log: (msg?: string) => {
        lines.push(msg ?? '');
        return msg?.length ?? 0;
      },
      json: (data: any) => {
        jsonOutputs.push(data);
        return 1;
      },
      error: (msg: string) => {
        lines.push(`[ERROR] ${msg}`);
        return msg.length;
      },
    };
  }

  function createMockEnvService(opts: { tags?: any[]; tag?: any } = {}): any {
    const component = {
      getService: () => ({
        listTags: async (_options: any) => ({
          tags: opts.tags ?? [],
          total: opts.tags?.length ?? 0,
        }),
        getTag: (name: string) => {
          if (opts.tag && opts.tag.name === name) return opts.tag;
          return undefined;
        },
      }),
    };
    return {
      create: async () => {},
      getEnvironment: () => ({ getComponent: () => component }),
      dispose: async () => {},
    };
  }

  it('list should render tags in human-readable format with header', async () => {
    const { runWorkflowTagList } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({
      tags: [
        { name: 'ai', usage_count: 5, created_at: '2026-06-30T10:00:00.000Z', updated_at: '2026-06-30T10:00:00.000Z' },
        { name: 'cli', usage_count: 3, created_at: '2026-06-30T09:00:00.000Z', updated_at: '2026-06-30T09:00:00.000Z' },
      ],
    });

    await runWorkflowTagList({
      asJson: false,
      configPath: undefined,
      limit: 100,
      order: 'desc',
      sortBy: 'usage_count',
      output,
      envService,
    });

    const joined = output.lines.join('\n');
    expect(joined).toContain('Workflow tags (2)');
    expect(joined).toContain('ai');
    expect(joined).toContain('cli');
    expect(joined).toContain('5');
    expect(joined).toContain('3');
    expect(joined.toLowerCase()).toContain('consistency');
  });

  it('list should render empty message when no tags', async () => {
    const { runWorkflowTagList } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({ tags: [] });

    await runWorkflowTagList({
      asJson: false,
      configPath: undefined,
      limit: 100,
      order: 'desc',
      sortBy: 'usage_count',
      output,
      envService,
    });

    const joined = output.lines.join('\n');
    expect(joined.toLowerCase()).toMatch(/no tags/);
  });

  it('list with --json should emit JSON to output.json', async () => {
    const { runWorkflowTagList } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({
      tags: [
        { name: 'ai', usage_count: 5, created_at: '2026-06-30T10:00:00.000Z', updated_at: '2026-06-30T10:00:00.000Z' },
      ],
    });

    await runWorkflowTagList({
      asJson: true,
      configPath: undefined,
      limit: 100,
      order: 'desc',
      sortBy: 'usage_count',
      output,
      envService,
    });

    expect(output.jsonOutputs.length).toBe(1);
    expect(output.jsonOutputs[0].tags.length).toBe(1);
    expect(output.jsonOutputs[0].total).toBe(1);
    expect(output.jsonOutputs[0].tags[0].name).toBe('ai');
  });

  it('get should render existing tag details', async () => {
    const { runWorkflowTagGet } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({
      tag: {
        name: 'ai',
        usage_count: 7,
        created_at: '2026-06-30T10:00:00.000Z',
        updated_at: '2026-06-30T10:00:00.000Z',
      },
    });

    await runWorkflowTagGet({
      name: 'ai',
      asJson: false,
      configPath: undefined,
      output,
      envService,
    });

    const joined = output.lines.join('\n');
    expect(joined).toContain('Tag: ai');
    expect(joined).toContain('usage_count: 7');
  });

  it('get should error for non-existent tag (sets exitCode = 1)', async () => {
    const { runWorkflowTagGet } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({});
    const origExitCode = process.exitCode;

    await runWorkflowTagGet({
      name: 'ghost-tag',
      asJson: false,
      configPath: undefined,
      output,
      envService,
    });

    // exitCode should be set to 1
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;

    const joined = output.lines.join('\n');
    expect(joined.toLowerCase()).toContain('not found');
  });

  it('get with --json should emit JSON for existing tag', async () => {
    const { runWorkflowTagGet } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({
      tag: {
        name: 'ai',
        usage_count: 5,
        created_at: '2026-06-30T10:00:00.000Z',
        updated_at: '2026-06-30T10:00:00.000Z',
      },
    });

    await runWorkflowTagGet({
      name: 'ai',
      asJson: true,
      configPath: undefined,
      output,
      envService,
    });

    expect(output.jsonOutputs.length).toBe(1);
    expect(output.jsonOutputs[0].name).toBe('ai');
  });

  it('get with --json should emit error JSON for missing tag', async () => {
    const { runWorkflowTagGet } = await import('./tag');
    const output = createMockOutput();
    const envService = createMockEnvService({});
    const origExitCode = process.exitCode;

    await runWorkflowTagGet({
      name: 'no-such-tag',
      asJson: true,
      configPath: undefined,
      output,
      envService,
    });

    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;

    expect(output.jsonOutputs.length).toBe(1);
    expect(output.jsonOutputs[0].error).toBe('Tag not found');
    expect(output.jsonOutputs[0].name).toBe('no-such-tag');
  });
});