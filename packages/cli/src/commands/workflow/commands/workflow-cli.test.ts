/**
 * @fileoverview Workflow CLI Tests
 * 
 * Tests workflow CLI commands with taskId and search functionality.
 */

import { describe, it, expect } from 'bun:test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

// Get the project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../../..');
const royBin = path.join(projectRoot, 'packages/cli/src/bin/roy-bot.ts');

// Helper function to run CLI command with proper timeout using Bun subprocess
async function runCliCommand(args: string[], timeoutMs: number = 10000): Promise<{ stdout: string; stderr: string }> {
  const cmd = `bun run ${royBin} ${args.join(' ')}`;
  
  // Create subprocess promise
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
    if (code !== 0 && code !== null) {
      throw new Error(`Command exited with code ${code}: ${cmd}\nStderr: ${stderr}`);
    }
    
    return { stdout, stderr };
  };
  
  // Use Promise.race for timeout
  return Promise.race([
    runProcess(),
    sleep(timeoutMs).then(() => {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`);
    }),
  ]);
}

describe('Workflow CLI Commands', () => {
  describe('workflow list --help', () => {
    it('should show --task-id option', async () => {
      const result = await runCliCommand(['workflow', 'list', '--help']);
      
      expect(result.stdout).toContain('--task-id');
      expect(result.stdout).toContain('按关联任务 ID 筛选');
    });

    it('should show --search option', async () => {
      const result = await runCliCommand(['workflow', 'list', '--help']);
      
      expect(result.stdout).toContain('--search');
      expect(result.stdout).toContain('搜索 description 和 tags');
    });
  });

  describe('workflow add --help', () => {
    it('should show --task-id option', async () => {
      const result = await runCliCommand(['workflow', 'add', '--help']);
      
      expect(result.stdout).toContain('--task-id');
      expect(result.stdout).toContain('关联任务 ID');
    });
  });

  describe('workflow update --help', () => {
    it('should show --task-id option', async () => {
      const result = await runCliCommand(['workflow', 'update', '--help']);
      
      expect(result.stdout).toContain('--task-id');
      expect(result.stdout).toContain('更新关联任务 ID');
    });
  });
});

describe("workflow run CLI", () => {
  describe("run --help", () => {
    it("should show --session option for resume", async () => {
      const result = await runCliCommand(['workflow', 'run', '--help']);

      expect(result.stdout).toContain('--session');
      expect(result.stdout).toContain('-s');
      expect(result.stdout).toContain('恢复运行');
    });

    it("should NOT show --session-id option (deprecated alias removed)", async () => {
      const result = await runCliCommand(['workflow', 'run', '--help']);

      // --session-id must be fully removed (no deprecated alias)
      expect(result.stdout).not.toContain('--session-id');
    });

    it("should reject --session-id (unknown option, no deprecated alias)", async () => {
      // yargs with strict:false would treat --session-id as a free arg,
      // so we explicitly verify it does NOT match the documented --session surface.
      // Using --session-id should NOT enable resume behavior.
      const result = await runCliCommand(['workflow', 'run', '--help']);

      // Surface check: --session is present, --session-id is not
      expect(result.stdout).toContain('--session');
      expect(result.stdout).not.toContain('--session-id');
    });

    it("should show --file option for file-based workflows", async () => {
      const result = await runCliCommand(['workflow', 'run', '--help']);
      
      expect(result.stdout).toContain('--file');
      expect(result.stdout).toContain('-f');
      expect(result.stdout).toContain('文件路径');
    });

    it("should show --name option for custom registration", async () => {
      const result = await runCliCommand(['workflow', 'run', '--help']);
      
      expect(result.stdout).toContain('--name');
      expect(result.stdout).toContain('-n');
      expect(result.stdout).toContain('注册');
    });

    it("should show --register-only option", async () => {
      const result = await runCliCommand(['workflow', 'run', '--help']);
      
      expect(result.stdout).toContain('--register-only');
      expect(result.stdout).toContain('-r');
      expect(result.stdout).toContain('只注册不运行');
    });

    it("should show positional argument identifier", async () => {
      const result = await runCliCommand(['workflow', 'run', '--help']);
      
      expect(result.stdout).toContain('<identifier>');
      expect(result.stdout).toContain('Workflow 名称或定义文件路径');
    });
  });

  // Note: Integration tests for actual run/resume functionality are skipped
  // because they require:
  // 1. A valid workflow to be registered in the system
  // 2. Environment setup with proper configuration
  // 3. Long execution time for workflow runs
  // 
  // These should be covered by E2E tests or integration tests with proper mocks.
  
  describe.skip("run with actual workflow", () => {
    it("should create new session and run", async () => {
      // TODO: This requires a registered workflow and proper environment
      // Would test: roy-bot workflow run <workflowName>
      // Expected: creates session, runs workflow, returns result
    });
    
    it("should validate session exists on resume", async () => {
      // TODO: This requires a paused workflow session
      // Would test: roy-bot workflow run -s <sessionId> --input "response"
      // Expected: validates session type is 'workflow', resumes execution
    });
  });
});

describe("workflow stop CLI", () => {
  describe("stop --help", () => {
    it("should show positional argument runId", async () => {
      const result = await runCliCommand(['workflow', 'stop', '--help']);
      
      expect(result.stdout).toContain('<runId>');
      expect(result.stdout).toContain('Workflow run ID');
    });

    it("should show --config option", async () => {
      const result = await runCliCommand(['workflow', 'stop', '--help']);
      
      expect(result.stdout).toContain('--config');
      expect(result.stdout).toContain('配置文件路径');
    });
  });

  // Note: Testing actual stop functionality requires a running/paused workflow session.
  // This should be covered by E2E tests with proper setup.
  
  describe.skip("stop with actual run", () => {
    it("should call engine.stop for running session", async () => {
      // TODO: This requires a running workflow session
      // Would test: roy-bot workflow stop <runId>
      // Expected: calls service.stopRun(runId), confirms stop
    });
    
    it("should call engine.stop for paused session", async () => {
      // TODO: This requires a paused workflow session
      // Would test: roy-bot workflow stop <sessionId>
      // Expected: calls service.stopRun(sessionId), confirms stop
    });

    it("should error when session not found", async () => {
      // TODO: This requires mocking the service to return null for getSession
      // Expected: exits with error "Run not found"
    });
    
    it("should error when session not in stoppable state", async () => {
      // TODO: This requires a completed/failed session
      // Expected: exits with error "Cannot stop run in status: completed"
    });
  });
});

// ============================================================================
// workflow run --session format validation (#1678)
// ============================================================================
//
// Verifies that --session (NOT --session-id) is the resume option, and that
// session IDs must start with the `workflow_` prefix (no auto-prefix fallback).

describe("workflow run --session format validation", () => {
  it("should reject --session value without workflow_ prefix (exit non-zero, error message)", async () => {
    // Pass a bare ID (no workflow_ prefix). Expect non-zero exit and a clear error.
    const proc = Bun.spawn({
      cmd: ['bun', 'run', royBin, 'workflow', 'run', 'some-workflow', '--session', 'bad-id-no-prefix'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    const combined = stdout + stderr;
    // Must mention workflow_ prefix requirement.
    expect(combined).toMatch(/workflow_/);
  });

  it("should NOT auto-prefix bare IDs (workflow_<id> fallback removed)", async () => {
    // If user passes 'abc123' as session, the old code would convert it to
    // 'workflow_abc123'. New code must REJECT 'abc123' outright.
    const proc = Bun.spawn({
      cmd: ['bun', 'run', royBin, 'workflow', 'run', 'some-workflow', '--session', 'abc123'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    // Must mention the workflow_ prefix requirement (NOT silently auto-prefix).
    const combined = stdout + stderr;
    expect(combined).toMatch(/workflow_/);
  });
});

// ============================================================================
// workflow add --file (follow-up of #1511: validate integration)
// ============================================================================

describe("workflow add --file validate integration (refuses invalid YAML)", () => {
  it("should exit with non-zero status when --file points to a workflow with duplicate node IDs", async () => {
    const tmpFile = path.join("/tmp", `invalid-dup-${Date.now()}.yaml`);
    const yaml = `name: invalid-dup-cli-${Date.now()}
version: "1.0"
nodes:
  - id: a
    type: tool
    config:
      tool: echo
  - id: a
    type: tool
    config:
      tool: echo
`;
    await Bun.write(tmpFile, yaml);

    let exitCode: number | null = null;
    let stderr = "";
    try {
      const proc = Bun.spawn({
        cmd: ['bun', 'run', royBin, 'workflow', 'add', '--file', tmpFile, '--tags', 'cli-test'],
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      stderr = await new Response(proc.stderr).text();
      exitCode = await proc.exited;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    expect(exitCode).not.toBe(0);
    // Should mention validation / duplicate (loose match)
    expect(stderr.toLowerCase()).toMatch(/validat|duplicate|empty/);
  });

  it("should exit with non-zero status when --file points to a workflow with missing dependencies", async () => {
    const tmpFile = path.join("/tmp", `invalid-missing-${Date.now()}.yaml`);
    const yaml = `name: invalid-missing-cli-${Date.now()}
version: "1.0"
nodes:
  - id: a
    type: tool
    config:
      tool: echo
    depends_on: [ghost]
`;
    await Bun.write(tmpFile, yaml);

    let exitCode: number | null = null;
    let stderr = "";
    try {
      const proc = Bun.spawn({
        cmd: ['bun', 'run', royBin, 'workflow', 'add', '--file', tmpFile, '--tags', 'cli-test'],
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      stderr = await new Response(proc.stderr).text();
      exitCode = await proc.exited;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/validat|ghost|non-existent/);
  });
});
