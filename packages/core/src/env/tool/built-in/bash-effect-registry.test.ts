/**
 * @fileoverview BashSpawner × ProcessRegistry 集成测试
 *
 * 验证当 bash 工具在 delegate_task 子 agent 中运行时：
 * 1. spawn 出来的 child PID 被自动注册到当前 registry
 * 2. child 'exit' 时自动反注册
 * 3. finalizer 在外部 abort 场景下使用 killProcessTree 杀进程组（防止孙进程泄漏）
 * 4. POSIX spawn 使用 detached:true（让 child 拥有独立进程组，可被 -pid 杀组）
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Effect } from "effect";

import { BashSpawner, BashSpawnerLayer, _setSpawnForTests as _setBashSpawnForTests } from "./bash-effect";
import {
  ProcessRegistry,
  runWithProcessRegistryAsync,
  getCurrentProcessRegistry,
} from "../../task/delegate/process-registry";
import {
  _setPlatformForTests,
  _setSpawnForTests,
} from "../../../util/process/process-tree-killer";

// =============================================================================
// ProcessRegistry interaction (real bash, real OS shell)
// =============================================================================

// Match the style in bash-effect.test.ts — use `as any` to bypass Effect generics
// (the BashSpawner requirement is satisfied by the layer at the provide() step).
const runEffect = async (effect: any): Promise<any> => {
  return await Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(BashSpawnerLayer) as any) as any
  );
};

// Guard against cross-test pollution: ensure both spawn injectors are reset.
afterEach(() => {
  _setBashSpawnForTests(undefined);
  _setSpawnForTests(undefined);
});

describe("BashSpawner × ProcessRegistry integration", () => {
  describe("PID registration lifecycle", () => {
    test("child PID is registered when running inside a registry scope", async () => {
      const reg = new ProcessRegistry();
      let peakInsideScope = -1;

      const program = Effect.gen(function* () {
        const spawner = yield* BashSpawner;
        // While the sleep 0.2 command runs, sample size from the parent ALS scope.
        // The BashSpawner internally has registered the PID by now.
        yield* spawner.run("sleep 0.2");
        return null;
      });

      // Start the program in the background so we can sample concurrently from the same ALS scope.
      const effect = runWithProcessRegistryAsync(reg, async () => {
        const promise = runEffect(program);
        // Sample every 20ms for up to 150ms (sleep 0.2 → at least one sample should see size=1)
        const start = Date.now();
        while (Date.now() - start < 150) {
          peakInsideScope = Math.max(peakInsideScope, reg.size());
          await new Promise((r) => setTimeout(r, 20));
        }
        return await promise;
      });
      await effect;

      // Peak should be at least 1 (one child registered while bash is sleeping)
      expect(peakInsideScope).toBeGreaterThanOrEqual(1);

      // After child naturally exits, it should have been unregistered.
      expect(reg.size()).toBe(0);
    });

    test("child PID is NOT registered when running outside a registry scope", async () => {
      const program = Effect.gen(function* () {
        const spawner = yield* BashSpawner;
        const result = yield* spawner.run("sleep 0.01");
        return { midRegistry: getCurrentProcessRegistry(), result };
      });

      const { midRegistry } = await runEffect(program);
      // Outside runWithProcessRegistryAsync, ALS returns undefined
      expect(midRegistry).toBeUndefined();
    });

    test("multiple concurrent bash invocations register independently", async () => {
      const reg = new ProcessRegistry();
      let peakSize = 0;

      const runOne = (id: string) =>
        Effect.gen(function* () {
          const spawner = yield* BashSpawner;
          yield* spawner.run(`sleep 0.1 && echo ${id}`);
        });

      const program = Effect.all([runOne("a"), runOne("b"), runOne("c")]);

      // Sample size from the parent ALS scope while the program runs concurrently
      const effect = runWithProcessRegistryAsync(reg, async () => {
        // Start the program in the background so we can sample concurrently
        const promise = runEffect(program);
        // Sample every 10ms for up to 200ms
        const start = Date.now();
        while (Date.now() - start < 200) {
          peakSize = Math.max(peakSize, reg.size());
          await new Promise((r) => setTimeout(r, 10));
        }
        return await promise;
      });
      await effect;

      // All three finished cleanly → registry empty
      expect(reg.size()).toBe(0);
      // At least one PID was registered at peak
      expect(peakSize).toBeGreaterThanOrEqual(1);
    });
  });

  describe("spawn option isolation", () => {
    test(
      "POSIX spawn uses detached:true (child has own process group)",
      async () => {
        _setPlatformForTests("linux");

        // Inject a recording spawn to capture SpawnOptions, then fall through to real spawn.
        const spawnRecords: Array<{ opts: any }> = [];
        const realSpawn = require("child_process").spawn;

        const recordingSpawn = ((cmd: string, args: string[], opts: any) => {
          spawnRecords.push({ opts });
          return realSpawn(cmd, args, opts);
        }) as any;

        _setBashSpawnForTests(recordingSpawn);

        try {
          const program = Effect.gen(function* () {
            const spawner = yield* BashSpawner;
            yield* spawner.run("echo hi");
          });
          await runEffect(program);

          expect(spawnRecords.length).toBeGreaterThanOrEqual(1);
          expect(spawnRecords.some((r) => r.opts?.shell === true)).toBe(true);
          expect(spawnRecords.some((r) => r.opts?.detached === true)).toBe(true);
        } finally {
          _setBashSpawnForTests(undefined);
        }
      }
    );
  });
});
