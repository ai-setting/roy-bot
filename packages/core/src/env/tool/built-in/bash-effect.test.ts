/**
 * Bash 工具 Effect 架构测试
 *
 * 使用 TDD 方法测试 Effect 风格的 spawner 实现
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect, Cause, Exit, Layer } from "effect";
import { BashSpawner, BashSpawnerLayer, _setSpawnForTests } from "./bash-effect";

// 测试辅助函数：运行 Effect 并返回结果
const runEffect = async <A>(effect: Effect.Effect<A>): Promise<A> => {
  const exit = await Effect.runPromise(effect.pipe(
    Effect.scoped,
    Effect.provide(BashSpawnerLayer)
  ));
  return exit;
};

// ★ Defensive: ensure spawn injector is reset before/after each test
beforeEach(() => {
  _setSpawnForTests(undefined);
});
afterEach(() => {
  _setSpawnForTests(undefined);
});

describe("BashSpawner Effect 架构", () => {
  test("应该能执行简单命令", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run("echo 'hello world'");
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.stdout).toContain("hello world");
  });

  test("应该支持 cwd 参数", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run("pwd", { cwd: "/tmp" });
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.exitCode).toBe(0);
  });

  test("应该支持环境变量", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run("echo $TEST_VAR", { 
        env: { TEST_VAR: "test_value" } 
      });
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.stdout).toContain("test_value");
  });

  test("应该正确处理命令失败", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run("exit 1");
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });
});

describe("BashSpawner stdin 处理", () => {
  test("stdin 应该保持打开状态", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      // 测试：命令尝试从 stdin 读取，3秒后超时（而不是立即 EOF）
      const result = yield* spawner.run(
        `bash -c '
          read -t 3 line
          if [ $? -ne 0 ]; then
            echo "stdin_timeout_not_closed"
          else
            echo "got: $line"
          fi
        '`,
        { timeout: 5000 }
      );
      return result;
    });
    
    const result = await runEffect(program);
    // 如果 stdin 被正确保持，read 应该超时而不是立即 EOF
    expect(result.stdout).toContain("stdin_timeout_not_closed");
    expect(result.exitCode).toBe(0);
  });

  test("长时间运行的命令应该正常运行", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run(
        `bash -c '
          echo "Starting..."
          sleep 1
          echo "Done"
        '`,
        { timeout: 5000 }
      );
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.stdout).toContain("Starting...");
    expect(result.stdout).toContain("Done");
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
  });
});

describe("BashSpawner 超时处理", () => {
  test("超时后进程应该被终止", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run(
        "sleep 10",
        { timeout: 100 }
      );
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
  });
});

describe("BashSpawner OpenTelemetry 追踪", () => {
  test("应该支持 trace 环境变量传递", async () => {
    const program = Effect.gen(function* () {
      const spawner = yield* BashSpawner;
      const result = yield* spawner.run(
        `echo $TRACEPARENT`,
        { env: { TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } }
      );
      return result;
    });
    
    const result = await runEffect(program);
    expect(result.stdout).toContain("0af7651916cd43dd8448eb211c80319c");
  });
});
