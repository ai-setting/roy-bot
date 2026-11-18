/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview mount — JSX bridge that lets the (non-JSX) `commands/interactive.ts`
 * mount the Solid interactive screen without itself being a .tsx file.
 *
 * Why this exists (Task #4278 片1):
 *   Solid's reconciler expects a *component function* returning a
 *   `BaseRenderable`, NOT a React element descriptor
 *   (`{ $$typeof, type, props }`). `commands/interactive.ts` is a plain `.ts` file and
 *   therefore cannot write JSX, and hand-rolling `createComponent()` calls
 *   would bypass Solid's reactive ownership setup.
 *
 *   So the JSX lives here (inside the `tui-solid/` scope, which is where the
 *   scoped-solid-jsx plugin and the nested tsconfig apply) and `interactive.ts` only
 *   calls `mountInteractiveScreen(renderer, props)`.
 *
 * ⚠️ Add this file's directory to SOLID_SCOPE_DIRS if it moves.
 */

import { render } from "@opentui/solid";
import type { CliRenderer } from "@opentui/core";
import RunScreenSolid, { type RunTuiSolidProps } from "./RunScreen.js";

/**
 * Mount the Solid interactive screen onto an already-created renderer.
 * Resolves once the tree is attached (rendering then continues async).
 */
export async function mountInteractiveScreen(
  renderer: CliRenderer,
  props: RunTuiSolidProps
): Promise<void> {
  await render(() => <RunScreenSolid {...props} />, renderer);
}

export { RunScreenSolid };
export type { RunTuiSolidProps };
