/**
 * @fileoverview Task #4721 — 测试期能力探针（**无 JSX**，可被 `.tsx` 测试安全 import）。
 *
 * ⚠️ 本文件**故意不含 JSX**：它被 `.tsx` 测试文件 import，而 `.tsx` 文件里的
 * `jsxImportSource` pragma 只对**该文件本身**生效；一个 docblock 里出现
 * `<pkg>/jsx-dev-runtime` 字面量会让 bun 去解析那个包而失败。
 *
 * ## 背景：为什么需要 `canRepaint()`
 *
 * 实测（Task #4721 probe 8/9/10）：
 *
 *   - `bun test` 使用 Bun **内置**的 JSX 转换，它是**急求值**（React 风格）：
 *     `status={stream.status()}` 在**元素创建时**求值一次，产物是**静态快照**，
 *     **不是**响应式 getter。
 *   - ⇒ 在 `bun test` 下，`tui-solid` 组件渲染完首帧就**再也不更新**
 *     （`setVal("AFTER")` 之后帧里仍是 `BEFORE`）。
 *   - ⇒ `ROY_SOLID_JSX=1` 的 scoped preload 在 `bun test` 下**不生效**
 *     （probe 10：onLoad 收到的 path 数组为空 ⇒ hook 根本没被调用；
 *     这与 `scripts/tui-solid/solid-jsx-plugin.ts:126-135` 的注释一致 ——
 *     bun 的 test loader 不调用 `bun run` 下注册的 tsx onLoad）。
 *
 * ## 这**不是**生产问题
 *
 * `scripts/build-cli-dev.ts` 走真正的 Solid JSX 转译
 * （`scopedSolidTransformPlugin` + `solidClientResolvePlugin`），
 * 实测产物含 **64** 处 `setProp(...)` ⇒ 出货的 UI **是**响应式的。
 *
 * ## 结论：凡是依赖「状态变化 → 重绘」的断言，都必须**按实测能力 gate**
 *
 * 这与既有测试的做法一致（`Spinner.opentui.test.tsx` 的 `REPAINTABLE` 探针）。
 * 否则测试要么因错误的原因失败，要么——更糟——**空过**。
 */

/**
 * 实测能力探针：这个 runner 能不能在 signal 变化后**重绘**？
 *
 * @param makeElement 造一个元素的工厂（由调用方提供，因为它需要 JSX）。
 * @returns `true` = 能重绘（断言可依赖重绘）；`false` = 不能（断言必须 gate）。
 */
export async function canRepaintWith(
  makeElement: (value: () => string) => unknown,
): Promise<boolean> {
  const { createSignal } = await import("solid-js");
  const { testRender } = await import("@opentui/solid");
  const [v, setV] = createSignal("a1");
  const t = await testRender(
    () => makeElement(() => v()) as never,
    { width: 16, height: 2 },
  );
  await t.renderOnce();
  const before = t.captureCharFrame();
  setV("b2");
  await t.renderOnce();
  const after = t.captureCharFrame();
  await t.dispose();
  return before !== after;
}

/**
 * 当 runner **不能**重绘时打印的跳过原因（必须可打印 ⇒ 不允许静默跳过）。
 */
export const NO_REPAINT_REASON =
  "the test runner cannot repaint after a signal change (Bun's built-in JSX " +
  "transform is eager => props are snapshots, not reactive getters). " +
  "Re-render-dependent assertions are therefore not trustworthy here; " +
  "the behaviour is covered by the real-pty e2e scripts under scripts/tui-solid/.";
