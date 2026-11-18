/**
 * @fileoverview Shared helpers for the **opentui/solid** test files (Task #4679 片5).
 *
 * ⚠️ No JSX in this file on purpose — it is imported by `.tsx` test files and
 * must not itself carry a `jsxImportSource` pragma (a pragma literal inside a
 * docblock makes bun try to resolve `<pkg>/jsx-dev-runtime` and fail).
 *
 * ## Why the `isSolidReactive()` gate exists
 *
 * `bun test` resolves `solid-js` to its **SSR** build (`dist/server.js`),
 * whereas the production path (`bun build --conditions=browser`) uses the
 * **client** build (`dist/solid.js`). The difference is not cosmetic:
 *
 *   - Under SSR, Solid's `<Show>` / `<For>` render their *fallback* branch
 *     eagerly. opentui's reconciler then rejects the resulting empty text node:
 *         `Orphan text error: "" must have a <text> as a parent`
 *     So every component that uses `<Show>`/`<For>` **throws** under plain
 *     `bun test` — e.g. `App`, `ToolCall`, `Markdown` (empty content).
 *   - Under the client build the same components render correctly.
 *
 * Measured (Task #4679):
 *   | component            | plain `bun test` (SSR)      | `--conditions=browser` |
 *   |----------------------|-----------------------------|------------------------|
 *   | Spinner              | OK                          | OK                     |
 *   | StatusBar            | OK                          | OK                     |
 *   | App (idle/streaming) | THROWS Orphan text error    | OK                     |
 *   | ToolCall             | THROWS Orphan text error    | OK                     |
 *   | Markdown (empty)     | THROWS Orphan text error    | OK                     |
 *
 * ⇒ A test file must **not** silently pass under the wrong runtime. Following
 * the pattern already established by `RunScreen.notice.test.tsx` /
 * `RunScreen.env-event.test.tsx`, the affected suites are gated on a **measured**
 * capability probe and **skip with a printed reason** under SSR, so the skip is
 * visible in the test output instead of hiding a broken run.
 *
 * ## How to actually run these
 *
 * ```bash
 * bun --conditions=browser test packages/cli/src/tui-solid/
 * ```
 */

import { createEffect, createSignal } from "solid-js";

/**
 * True only when Solid's **client** runtime is live.
 *
 * Under plain `bun test` this is `false`; under `bun --conditions=browser test`
 * it is `true`. Measured, never assumed — see the module docblock.
 */
export function isSolidReactive(): boolean {
  const seen: number[] = [];
  const [n, setN] = createSignal(0);
  createEffect(() => {
    seen.push(n());
  });
  setN(1);
  return seen.length > 1;
}

/** Strip SGR escapes so assertions compare against plain text. */
export function bare(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Reason string printed when a suite is skipped because the client runtime is
 * missing. Kept in one place so every migrated file reports the same thing.
 */
export const SSR_SKIP_REASON =
  "solid-js resolved to the SSR build (plain `bun test`); opentui's " +
  "reconciler throws `Orphan text error` for <Show>/<For> children. " +
  "Run with `bun --conditions=browser test` to execute this suite.";
