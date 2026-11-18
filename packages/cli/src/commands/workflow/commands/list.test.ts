/**
 * @fileoverview workflow list command - JSON output structure tests
 *
 * Code Review Suggestion S-4 (post #1475/#1476/#1477 merge systematic test):
 * The `workflow list --json` output previously violated the same invariant
 * that #1476 fixed for `tasks search --json`:
 *
 *   - `total` was NOT the first key in the JSON output
 *     → tail-truncation by downstream consumers could silently drop it
 *   - `truncated` flag was MISSING
 *   - Key ordering was inconsistent with the tool path (`workflow_list`)
 *
 * These tests are the regression guard for the public JSON contract.
 *
 * Verified invariants (must hold for `roy-bot workflow list --json`):
 *   1. `total` is the FIRST key in the serialized JSON output
 *      (so it survives tail-truncation in any downstream consumer).
 *   2. `truncated` is `true` when total > count (pagination truncated data).
 *   3. `truncated` is `false` when total === count (no truncation).
 *   4. `workflows` is the LAST key in the serialized JSON output
 *      (so the array is the candidate for tail-truncation, not the metadata).
 *   5. Key order is exactly:
 *        total, count, truncated, limit, offset, page, available_tags, workflows
 *   6. `limit` echoes back the requested page size (default 50).
 *   7. `offset` echoes back the resolved offset (page-aware).
 *   8. `page` echoes back the 1-based page number.
 *   9. `available_tags` is preserved in metadata block (not dropped).
 *
 * The tests exercise a `buildListWorkflowsJson` helper that the CLI
 * re-exports from `./list`, mirroring the `tasks` pattern
 * (`packages/cli/src/commands/tasks/list.test.ts`).
 */

import { describe, it, expect } from "bun:test";
import { buildListWorkflowsJson } from "./list";

// Shapes of a single workflow item as exposed in CLI JSON output.
// Kept local (not exported) — this test only cares about the shape
// produced by the helper, not the underlying type machinery.
interface WorkflowListItem {
  name: string;
  version: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Shape of `available_tags` entries in the JSON output.
 * Match the tool-path shape: `{ name, count }`.
 */
interface AvailableTag {
  name: string;
  count: number;
}

function makeWorkflowItem(overrides: Partial<WorkflowListItem> = {}): WorkflowListItem {
  return {
    name: "hello-world",
    version: "1.0.0",
    description: "A sample workflow",
    tags: ["demo", "greeting"],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Mock `available_tags` shape returned by the tool path.
 */
function makeAvailableTag(name: string, count: number): AvailableTag {
  return { name, count };
}

describe("buildListWorkflowsJson - CLI JSON output structure (bug fix: total position + truncated flag)", () => {
  it("should place `total` as the FIRST key in the serialized JSON output (regression: structural parity with tool path)", () => {
    const workflows = [makeWorkflowItem({ name: "a" }), makeWorkflowItem({ name: "b" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 2, {
      limit: 50,
      offset: 0,
      page: 1,
    }, []);
    const serialized = JSON.stringify(result);

    // The serialized JSON's literal first key MUST be "total".
    expect(serialized.startsWith('{"total":')).toBe(true);
  });

  it("should set `truncated: true` when total > count (pagination in effect)", () => {
    // 5 workflows in DB, only 2 returned because limit=2.
    const workflows = [makeWorkflowItem({ name: "a" }), makeWorkflowItem({ name: "b" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 5, {
      limit: 2,
      offset: 0,
      page: 1,
    }, []);

    expect(result.total).toBe(5);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("should set `truncated: false` when total === count (no pagination truncation)", () => {
    const workflows = [makeWorkflowItem({ name: "a" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 1, {
      limit: 50,
      offset: 0,
      page: 1,
    }, []);

    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("should place `workflows` as the LAST key in the serialized JSON output (metadata-first ordering)", () => {
    const workflows = [makeWorkflowItem({ name: "a" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 1, {
      limit: 50,
      offset: 0,
      page: 1,
    }, []);

    const serialized = JSON.stringify(result);
    const keys = Object.keys(result);
    expect(keys[0]).toBe("total");
    expect(keys[keys.length - 1]).toBe("workflows");

    const totalIndex = serialized.indexOf('"total":');
    expect(totalIndex).toBeGreaterThanOrEqual(0);
    const workflowsIndex = serialized.indexOf('"workflows":');
    expect(workflowsIndex).toBeGreaterThan(totalIndex);
  });

  it("should produce key order exactly: total, count, truncated, limit, offset, page, available_tags, workflows", () => {
    const workflows = [makeWorkflowItem({ name: "a" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 1, {
      limit: 50,
      offset: 0,
      page: 1,
    }, [makeAvailableTag("ai", 3)]);

    expect(Object.keys(result)).toEqual([
      "total",
      "count",
      "truncated",
      "limit",
      "offset",
      "page",
      "available_tags",
      "workflows",
    ]);
  });

  it("should omit `available_tags` from the key list when no tags exist (array stays last)", () => {
    const workflows = [makeWorkflowItem({ name: "a" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 1, {
      limit: 50,
      offset: 0,
      page: 1,
    }, []);

    // available_tags is not present, but the ordering invariant still holds:
    // total → count → truncated → limit → offset → page → workflows.
    expect(Object.keys(result)).toEqual([
      "total",
      "count",
      "truncated",
      "limit",
      "offset",
      "page",
      "workflows",
    ]);
    expect((result as any).available_tags).toBeUndefined();
  });

  it("should echo back `limit` and `offset` exactly as passed (no typo swap)", () => {
    // Regression guard: at one point, search.ts had limit/offset swapped.
    // The workflow-list helper must echo them as supplied.
    const workflows = [makeWorkflowItem({ name: "a" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 1, {
      limit: 7,
      offset: 21,
      page: 1,
    }, []);

    expect(result.limit).toBe(7);
    expect(result.offset).toBe(21);
  });

  it("should echo `page` as the 1-based page number (consistency with --page arg)", () => {
    const workflows = [makeWorkflowItem({ name: "a" })];
    const result = buildListWorkflowsJson(workflows, /* total */ 100, {
      limit: 10,
      offset: 20,
      page: 3,
    }, []);

    expect(result.page).toBe(3);
  });
});

describe("buildListWorkflowsJson - pagination truncation behavior", () => {
  it("triggers truncated=true with limit=2 and total=10 (3x more results exist)", () => {
    const workflows = Array.from({ length: 2 }, (_, i) =>
      makeWorkflowItem({ name: `wf-${i}` })
    );
    const result = buildListWorkflowsJson(workflows, /* total */ 10, {
      limit: 2,
      offset: 0,
      page: 1,
    }, []);

    expect(result.total).toBe(10);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("triggers truncated=false with limit=50 (default) and total=10 (no truncation)", () => {
    const workflows = Array.from({ length: 10 }, (_, i) =>
      makeWorkflowItem({ name: `wf-${i}` })
    );
    const result = buildListWorkflowsJson(workflows, /* total */ 10, {
      limit: 50,
      offset: 0,
      page: 1,
    }, []);

    expect(result.total).toBe(10);
    expect(result.count).toBe(10);
    expect(result.truncated).toBe(false);
  });
});

// Issue 8 (code review #1818 round 3): workflow list quiet 模式的
// renderQuietHeader / renderQuietLine / renderQuietPaginationHint 行为
// 通过源代码静态检查覆盖（workflow list 的 quiet 分支是 tool-path 集成，
// 直接 unit test 需要 mock 整个 WorkflowService，比较重。下面是 source
// 级的 contract 检查 + helper 自身的 unit test）。
describe("workflow list quiet output format (Task #1818 round 3)", () => {
  it("uses renderQuietHeader(total, 'workflow') in the quiet branch", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "list.ts"),
      "utf8",
    );
    // quiet 模式必须先输出 # Total: N workflows
    expect(src).toContain("renderQuietHeader(total, 'workflow')");
  });

  it("uses renderQuietLine(w.name, w.name) in the quiet branch", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "list.ts"),
      "utf8",
    );
    // workflow 无独立 id，name 即 id
    expect(src).toContain("renderQuietLine(w.name, w.name)");
  });

  it("uses renderQuietPaginationHint in the quiet branch", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "list.ts"),
      "utf8",
    );
    // 至少一处调用 renderQuietPaginationHint（用于 truncated 时显示分页提示）
    expect(src).toContain("renderQuietPaginationHint");
  });
});

describe("workflow list default limit unified to 20 (Issue 7, Task #1818 round 3)", () => {
  it("uses default: 20 (not 50) to match PAGINATION_OPTIONS", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "list.ts"),
      "utf8",
    );
    // 确认 limit option 块中 default 是 20
    const match = src.match(/option\('limit'[\s\S]*?default:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("20");
  });
});
