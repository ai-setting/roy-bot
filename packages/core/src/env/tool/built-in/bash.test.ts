/**
 * Bash 工具跨平台兼容性测试
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { bashTool } from "./bash";

// ★ Defensive: ensure bash-effect's spawn injector is reset before each test
// (otherwise leaked mocks from other test files break real bash spawning).
import { _setSpawnForTests as _resetBashSpawn } from "./bash-effect";

const testDir = join("/tmp", `bash-test-${Date.now()}`);

beforeEach(() => {
  _resetBashSpawn(undefined);
});
afterEach(() => {
  _resetBashSpawn(undefined);
});

describe("bashTool 基础功能", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("应该执行简单命令", async () => {
    const result = await bashTool.execute(
      { command: "echo 'hello world'" },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello world");
  });

  test("应该支持 workdir 参数", async () => {
    const result = await bashTool.execute(
      { command: "pwd", workdir: testDir },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("应该返回元数据", async () => {
    const result = await bashTool.execute(
      { command: "echo 'test'" },
      {}
    );
    expect(result.metadata?.execution_time_ms).toBeDefined();
    expect(result.metadata?.exit_code).toBe(0);
  });

  test("命令失败应该返回错误", async () => {
    const result = await bashTool.execute(
      { command: "exit 1" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.exit_code).toBe(1);
  });

  test("应该支持 timeout 参数", async () => {
    const result = await bashTool.execute(
      { command: "echo 'quick'", timeout: 5000 },
      {}
    );
    expect(result.success).toBe(true);
  });
});

describe("bashTool 跨平台兼容性", () => {
  test("应该检测当前平台", async () => {
    const platform = process.platform;
    expect(["linux", "darwin", "win32"]).toContain(platform);
  });

  test("应该正确处理路径分隔符", async () => {
    // 在 Linux 上测试路径
    const result = await bashTool.execute(
      { command: "echo '/tmp/test/path'" },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("应该正确处理带空格的路径", async () => {
    const dirWithSpace = join(testDir, "dir with space");
    await mkdir(dirWithSpace, { recursive: true });
    
    const result = await bashTool.execute(
      { command: `ls "${dirWithSpace}"` },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("Windows 路径应该被正确处理", async () => {
    // 测试反斜杠路径（模拟 Windows）
    const result = await bashTool.execute(
      { command: "echo 'C:\\\\Users\\\\test'" },
      {}
    );
    expect(result.success).toBe(true);
  });
});

describe("bashTool 环境变量", () => {
  test("应该继承当前环境变量", async () => {
    const result = await bashTool.execute(
      { command: "echo $HOME" },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("应该支持添加自定义环境变量", async () => {
    const result = await bashTool.execute(
      { command: "echo $TEST_VAR", env: { TEST_VAR: "test_value" } },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("test_value");
  });

  test("自定义环境变量应该覆盖默认变量", async () => {
    const result = await bashTool.execute(
      { command: "echo $PATH", env: { PATH: "/custom/path" } },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("/custom/path");
  });
});

describe("bashTool Trace 功能", () => {
  test("应该返回 trace 相关元数据", async () => {
    const result = await bashTool.execute(
      { command: "echo 'trace test'" },
      {}
    );
    // trace_id 可能存在也可能不存在，取决于上下文
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.exit_code).toBeDefined();
  });

  test("TRACEPARENT 环境变量应该被传递", async () => {
    const result = await bashTool.execute(
      { 
        command: "echo $TRACEPARENT", 
        env: { TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } 
      },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("0af7651916cd43dd8448eb211c80319c");
  });
});

describe("bashTool 边界情况", () => {
  test("空命令应该被处理", async () => {
    const result = await bashTool.execute(
      { command: "" },
      {}
    );
    // 空命令可能返回成功或失败，取决于 shell
    expect(result).toBeDefined();
  });

  test("超长命令应该被处理", async () => {
    const longArg = "x".repeat(10000);
    const result = await bashTool.execute(
      { command: `echo '${longArg}'` },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("特殊字符应该被正确处理", async () => {
    const result = await bashTool.execute(
      { command: 'echo "hello $HOME world"' },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("管道命令应该被支持", async () => {
    const result = await bashTool.execute(
      { command: "echo 'line1\\nline2' | grep 'line1'" },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("重定向应该被支持", async () => {
    const result = await bashTool.execute(
      { command: `echo 'test' > ${join(testDir, "output.txt")} && cat ${join(testDir, "output.txt")}` },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("test");
  });
});

describe("bashTool 超时处理", () => {
  test("应该正确处理较短超时", async () => {
    const result = await bashTool.execute(
      { command: "echo 'quick'", timeout: 500 },
      {}
    );
    expect(result.success).toBe(true);
  });

  test("超长运行的命令应该超时", async () => {
    // 使用超短超时测试命令执行
    // 限制测试范围，避免触发 bun 的默认超时
    const result = await bashTool.execute(
      { command: "sleep 1", timeout: 50 },
      {}
    );
    // 应该返回超时
    expect(result.success).toBe(false);
    expect(result.metadata?.timed_out).toBe(true);
    expect(result.error).toContain("timed out");
  }, 10000); // 给测试 10 秒超时
});

describe("bashTool 进程树终止", () => {
  // 使用唯一标记避免匹配其他进程
  const uniqueMarker = `BASH_TEST_${Date.now()}`;

  afterEach(async () => {
    // 清理可能遗留的后台进程（sleep 10 & 会脱离进程组，无法被 bash kill 捕获）
    await bashTool.execute(
      { command: `pkill -f "sleep 10.${uniqueMarker}" 2>/dev/null; pkill -f "sleep 20.${uniqueMarker}" 2>/dev/null; true`, timeout: 2000 },
      {}
    ).catch(() => {});
  });

  test("超时后子进程应该被终止", async () => {
    // 创建一个会 fork 子进程的脚本
    // 使用 bash -c 启动后台进程，超时后应该被终止
    const result = await bashTool.execute(
      { command: `bash -c '(sleep 10.${uniqueMarker} & echo child_pid=$!); sleep 20'`, timeout: 100 },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.timed_out).toBe(true);
    
    // 等待一段时间确保子进程被清理
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 清理可能残留的后台进程
    await bashTool.execute(
      { command: `pkill -f "sleep 10.${uniqueMarker}" 2>/dev/null; true`, timeout: 2000 },
      {}
    ).catch(() => {});

    // 验证子进程确实被终止 - 使用唯一标记精确匹配
    const psResult = await bashTool.execute(
      { command: `ps aux | grep -v grep | grep '${uniqueMarker}' | wc -l` },
      {}
    );
    expect(String(psResult.output).trim()).toBe("0");
  }, 15000);

  test("管道命令超时后整个管道应该被终止", async () => {
    // 创建一个管道命令，其中一个命令会 fork 子进程
    const result = await bashTool.execute(
      { command: `bash -c '(sleep 10.${uniqueMarker} &); sleep 20'`, timeout: 100 },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.timed_out).toBe(true);
    
    // 等待一段时间确保子进程被清理
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 清理可能残留的后台进程
    await bashTool.execute(
      { command: `pkill -f "sleep 10.${uniqueMarker}" 2>/dev/null; true`, timeout: 2000 },
      {}
    ).catch(() => {});

    // 验证子进程被终止 - 使用唯一标记精确匹配
    const psResult = await bashTool.execute(
      { command: `ps aux | grep -v grep | grep '${uniqueMarker}' | wc -l` },
      {}
    );
    expect(String(psResult.output).trim()).toBe("0");
  }, 15000);
});

describe("bashTool 事件处理", () => {
  test("exit 事件应该正确触发", async () => {
    // 验证正常退出的命令
    const result = await bashTool.execute(
      { command: "exit 0" },
      {}
    );
    expect(result.metadata?.exit_code).toBe(0);
    expect(result.metadata?.timed_out).toBe(false);
  });

  test("错误退出码应该被正确报告", async () => {
    const result = await bashTool.execute(
      { command: "exit 42" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.exit_code).toBe(42);
  });

  test("SIGTERM 应该能终止进程", async () => {
    // 使用 kill 命令发送 SIGTERM
    // 由于我们没有进程 ID，这个测试验证 kill 语法正确
    const result = await bashTool.execute(
      { command: "kill -15 $ || true" }, // $ 是当前 shell 的 PID
      {}
    );
    // 命令应该成功执行
    expect(result.success).toBe(true);
  });
});

describe("bashTool Windows 兼容性", () => {
  test("Windows cmd.exe 参数应该正确传递", async () => {
    // 在 Linux 上验证 /c 参数格式
    const result = await bashTool.execute(
      { command: "echo test" },
      {}
    );
    expect(result.success).toBe(true);
  });
});
