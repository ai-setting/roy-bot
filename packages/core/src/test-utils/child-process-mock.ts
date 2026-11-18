/**
 * @fileoverview Shared `child_process` mock factory for `mock.module(...)`.
 *
 * ## 为什么需要它（Task #4420）
 *
 * Bun 当前对 `mock.module("child_process", factory)` 采用 **ESM exports 语义**：
 * factory 返回的对象被当作模块的**完整导出面**，而不是「在真实模块上打补丁」。
 * 因此只要少提供一个命名导出，任何**静态** `import { x } from "child_process"`
 * 该导出的模块都会在**模块加载期**直接抛：
 *
 * ```
 * SyntaxError: Export named 'exec' not found in module 'node:child_process'.
 * ```
 *
 * 更糟的是：
 *   1. 报错指向**被 import 的模块**（如 `event-source-handlers.ts`），
 *      而不是写了不完整 mock 的**测试文件** —— 极难定位。
 *   2. mock.module 在同一 `bun test` 进程内**跨文件泄漏**（bun 不像 jest
 *      每文件独立 registry），所以还会顺带炸掉后面无关的文件。
 *
 * ## 历史事故（同一个坑踩了 3 次）
 *
 * - Task #2372：`event-source-handlers-builtin.test.ts` 只 mock `spawn`，
 *   炸掉后面所有静态 import `spawnSync` 的模块（见
 *   `util/process/process-tree-killer.ts` 里的 lazy-import 规避注释）。
 * - Task #4331：源码 `event-source-handlers.ts` 新增 `exec as execSync`，
 *   但该测试的 mock 没跟上 → 整个文件 48/64 条测试挂红（Task #4420 修的就是这个）。
 *
 * ## 解决方式
 *
 * **导出面从真实模块自省派生**，永不手写清单：
 *   - `require("node:child_process")` 枚举出真实存在的导出名
 *   - 对每个导出，默认**透传真实实现**，只把测试显式 `overrides` 的键替换掉
 *   - 额外补一个 `default`（ESM namespace 有 `default`，`require()` 没有 ——
 *     这也是历史 mock 需要手写 `default: {...}` 的原因，现在自动生成）
 *
 * 这样即使未来 Node/Bun 新增导出，或源码新增 `import { execFile }`，
 * mock 也不会因为「缺导出」再次炸掉整个测试文件。
 *
 * ## 用法
 *
 * ```ts
 * import { createChildProcessMockModule } from "../../../test-utils/child-process-mock";
 *
 * beforeEach(() => {
 *   mock.module("child_process", () =>
 *     createChildProcessMockModule({ spawn: spawnMock }),
 *   );
 * });
 * ```
 *
 * 注意：`mock.module` 的 specifier 用 `"child_process"` 还是
 * `"node:child_process"` 都能命中（Bun 会把两者归一），helper 内部统一
 * 从 `node:child_process` 自省。
 */

/**
 * 当前 Node/Bun 上 `node:child_process` 的完整命名导出清单（运行时自省）。
 *
 * 在 Bun 上为：`ChildProcess`, `exec`, `execFile`, `execFileSync`,
 * `execSync`, `fork`, `spawn`, `spawnSync`。
 */
export const CHILD_PROCESS_EXPORT_NAMES: readonly string[] = Object.keys(
  require("node:child_process"),
).filter((name) => name !== "default");

type ChildProcessModule = Record<string, any>;

/**
 * 构造一个**导出面完整**的 `child_process` mock 模块对象。
 *
 * @param overrides 需要替换为测试替身（spy/stub）的导出。其余导出保持真实实现，
 *                  既保证导出面完整，又避免把未测行为也一起假掉。
 * @returns 可直接被 `mock.module("child_process", () => ...)` 返回的模块对象，
 *          含 `default` 自引用（`default` 上的键与命名导出保持一致）。
 */
export function createChildProcessMockModule(
  overrides: ChildProcessModule = {},
): ChildProcessModule {
  const real: ChildProcessModule = require("node:child_process");

  const mocked: ChildProcessModule = {};

  // 1) 先铺满真实导出面（含 default，逐个 switch 掉）
  for (const name of CHILD_PROCESS_EXPORT_NAMES) {
    mocked[name] = overrides[name] ?? real[name];
  }

  // 2) 覆盖项里可能有真实模块没有的额外 key，一并带上（防止误用时报 undefined）
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) mocked[name] = value;
  }

  // 3) 显式补 default —— ESM namespace 有 default 而 require() 没有，
  //    历史 mock 手写 `default: { spawn }` 就是为了这个。这里让它与命名导出
  //    保持一致，避免两份导出面不同步。
  //    用浅拷贝而非自引用：自引用会形成 `default.default.default...` 循环，
  //    一旦有人 toEqual / JSON.stringify 这个 mock 就会爆栈。
  mocked.default = { ...mocked };

  return mocked;
}
