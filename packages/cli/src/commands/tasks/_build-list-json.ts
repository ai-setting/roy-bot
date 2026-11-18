/**
 * @fileoverview Shared JSON builder for `tasks list` and `tasks search`.
 *
 * Both `roy-bot tasks list --json` and `roy-bot tasks search --json`
 * construct a paginated task-list response. To keep their JSON shape
 * identical (so consumers can write one parser), they share this helper.
 *
 * Shape produced (key ordering matters — see invariant comments below):
 *
 *   {
 *     "total":     <number>,         // FIRST so it survives tail-truncation
 *     "count":     <number>,         // tasks.length
 *     "truncated": <boolean>,        // total > count
 *     "limit":     <number|undef>,
 *     "offset":    <number|undef>,
 *     ...extras,                     // e.g. { keywords: [...] } from search
 *     "tasks":     [...]             // LAST so the array is the truncation target
 *   }
 *
 * Keep this shape in sync with:
 *   - packages/core/src/env/task/tools/list-tool.ts (tool path)
 *   - the consumer of `tasks search --json` output (scripts / LLMs)
 */

import type { Task } from "@ai-setting/roy-bot-core";

/**
 * CLI-facing shape of a single task in JSON output.
 *
 * Only fields needed by typical CLI consumers are surfaced; the full
 * `Task` object (including description, due_date, tags, etc.) is
 * available via `tasks get <id>`.
 */
export interface ListTaskJson {
  id: number;
  title: string;
  status: string;
  priority: string;
  type: string;
  progress: number;
  current_status: string;
  project_path: string;
  context: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Top-level shape of the JSON output for both `tasks list --json` and
 * `tasks search --json`.
 *
 * IMPORTANT: Key ordering is part of the public contract.
 *   - `total` MUST be first so it survives tail-truncation by any
 *     downstream consumer (e.g. piping through `head -c` or an LLM
 *     context window).
 *   - `tasks` MUST be last so the array is the truncation target, not
 *     the summary metadata.
 *   - `extras` (when provided, e.g. `keywords` for search) are inserted
 *     BEFORE `tasks` but AFTER the standard metadata, so they sit in the
 *     "metadata block" rather than the array.
 *
 * Keep this shape in sync with `packages/core/src/env/task/tools/list-tool.ts`
 * (the tool path) so both code paths emit identical JSON.
 */
export interface ListTasksJsonOutput {
  total: number;
  count: number;
  truncated: boolean;
  limit?: number;
  offset?: number;
  // IMPORTANT: `depth` MUST sit immediately after `offset` (canonical
  // order matches the tool path in list-tool.ts).
  depth?: number;
  // `extras` (e.g. keywords) — accessed via type assertion since the
  // helper merges them dynamically; the test suite asserts presence.
  tasks: ListTaskJson[];
}

/**
 * Common pagination args accepted by both `list` and `search`.
 */
export interface ListJsonArgs {
  limit?: number;
  offset?: number;
  depth?: number;
}

/**
 * Optional command-specific fields surfaced at the top level of the JSON.
 *
 * - `search.ts` passes `{ keywords: string[] }` so consumers can echo the
 *   query that produced these results.
 *
 * Inserted BEFORE `tasks` but AFTER the standard metadata so the
 * "metadata first, array last" invariant holds.
 */
export type ListJsonExtras = Record<string, unknown>;

/**
 * Build the JSON output object for `tasks list --json` and `tasks search --json`.
 *
 * @param tasks  - The paginated tasks returned by the storage layer.
 * @param total  - The total count of matching tasks BEFORE pagination.
 * @param args   - The pagination args (`limit`, `offset`).
 * @param extras - Optional command-specific top-level fields (e.g.
 *                 `{ keywords: [...] }` for search). Inserted before
 *                 `tasks` to preserve the metadata-first ordering.
 */
export function buildListTasksJson(
  tasks: Task[],
  total: number,
  args: ListJsonArgs,
  extras?: ListJsonExtras,
): ListTasksJsonOutput {
  const projected: ListTaskJson[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    type: t.type,
    progress: t.progress,
    current_status: t.current_status,
    project_path: t.project_path,
    context: t.context,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  return {
    // IMPORTANT: `total` is first so it survives downstream tail-truncation.
    total,
    count: tasks.length,
    truncated: total > tasks.length,
    limit: args.limit,
    offset: args.offset,
    // IMPORTANT: `depth` MUST sit immediately after `offset` (canonical
    // order matches the tool path in list-tool.ts). Echoed as-is from CLI
    // args so downstream consumers can confirm what filter was applied.
    depth: args.depth,
    // Command-specific extras (e.g. keywords for search) — inserted here so
    // they live in the metadata block rather than after the tasks array.
    ...(extras ?? {}),
    // IMPORTANT: `tasks` is last so it's the truncation target, not
    // the summary metadata that precedes it.
    tasks: projected,
  };
}