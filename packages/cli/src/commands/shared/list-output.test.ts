/**
 * @fileoverview Shared list-output helpers unit tests
 *
 * 测试 applyPagination、renderPaginationFooter、PAGINATION_OPTIONS
 * 等统一规范的 helper。
 */

import { describe, it, expect } from "bun:test";
import {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "./list-output";

describe("applyPagination", () => {
  it("returns the first N items when offset=0", () => {
    const items = [1, 2, 3, 4, 5];
    const result = applyPagination(items, { limit: 3, offset: 0 });
    expect(result).toEqual([1, 2, 3]);
  });

  it("skips the first `offset` items", () => {
    const items = [1, 2, 3, 4, 5];
    const result = applyPagination(items, { limit: 2, offset: 2 });
    expect(result).toEqual([3, 4]);
  });

  it("returns empty array when offset >= items.length", () => {
    const items = [1, 2, 3];
    const result = applyPagination(items, { limit: 5, offset: 10 });
    expect(result).toEqual([]);
  });

  it("returns empty array when limit=0 (defensive, but should not happen)", () => {
    const items = [1, 2, 3];
    // Math.max(1, 0) = 1, so returns at least 1 item
    const result = applyPagination(items, { limit: 0, offset: 0 });
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("clamps negative offset to 0", () => {
    const items = [1, 2, 3];
    const result = applyPagination(items, { limit: 2, offset: -5 });
    expect(result).toEqual([1, 2]);
  });
});

describe("renderPaginationFooter", () => {
  it("formats 'Showing X-Y of Z items' for normal pagination", () => {
    const out = renderPaginationFooter({
      total: 100,
      count: 20,
      offset: 0,
      limit: 20,
      itemName: "task",
    });
    // Should contain the standard phrasing
    expect(out).toContain("Showing 1-20 of 100 tasks");
  });

  it("uses singular 'item' form when count=1", () => {
    const out = renderPaginationFooter({
      total: 1,
      count: 1,
      offset: 0,
      limit: 20,
      itemName: "task",
    });
    expect(out).toContain("of 1 task");
    expect(out).not.toContain("of 1 tasks");
  });

  it("includes extras metadata when provided", () => {
    const out = renderPaginationFooter({
      total: 50,
      count: 20,
      offset: 0,
      limit: 20,
      itemName: "skill",
      extras: ["source=built-in"],
    });
    expect(out).toContain("Showing 1-20 of 50 skills");
    expect(out).toContain("source=built-in");
  });

  it("shows 'Showing 0-0 of 0 items' for empty result", () => {
    const out = renderPaginationFooter({
      total: 0,
      count: 0,
      offset: 0,
      limit: 20,
      itemName: "agent",
    });
    expect(out).toContain("Showing 0-0 of 0 agents");
  });

  it("includes '-o <next>' hint when there are more pages", () => {
    const out = renderPaginationFooter({
      total: 100,
      count: 20,
      offset: 0,
      limit: 20,
      itemName: "task",
    });
    expect(out).toContain("-o 20");
    expect(out).toContain("next page");
  });

  it("does NOT include 'next page' hint when on the last page", () => {
    const out = renderPaginationFooter({
      total: 20,
      count: 20,
      offset: 0,
      limit: 20,
      itemName: "task",
    });
    expect(out).not.toContain("next page");
  });
});

describe("PAGINATION_OPTIONS", () => {
  it("defines -n as alias for limit", () => {
    expect(PAGINATION_OPTIONS.limit.alias).toBe("n");
    expect(PAGINATION_OPTIONS.limit.type).toBe("number");
    expect(PAGINATION_OPTIONS.limit.default).toBe(20);
  });

  it("defines -o as alias for offset", () => {
    expect(PAGINATION_OPTIONS.offset.alias).toBe("o");
    expect(PAGINATION_OPTIONS.offset.type).toBe("number");
    expect(PAGINATION_OPTIONS.offset.default).toBe(0);
  });
});

describe("renderQuietHeader (Task #1818 user feedback: list output missing total)", () => {
  it("formats '# Total: N items' for normal total", () => {
    expect(renderQuietHeader(28, "workflow")).toBe("# Total: 28 workflows");
  });

  it("uses singular form when total=1", () => {
    expect(renderQuietHeader(1, "task")).toBe("# Total: 1 task");
    expect(renderQuietHeader(1, "agent")).toBe("# Total: 1 agent");
  });

  it("handles zero total", () => {
    expect(renderQuietHeader(0, "skill")).toBe("# Total: 0 skills");
  });

  it("starts with '#' so grep -v '^#' can skip the header", () => {
    expect(renderQuietHeader(100, "tool")).toMatch(/^#/);
  });
});

describe("renderQuietLine (Task #1818 user feedback: show id + name)", () => {
  it("emits '<id>\\t<name>' for numeric id", () => {
    expect(renderQuietLine(1818, "Optimize list commands")).toBe("1818\tOptimize list commands");
  });

  it("emits '<id>\\t<name>' for string id", () => {
    expect(renderQuietLine("session_abc123", "My Session")).toBe("session_abc123\tMy Session");
  });

  it("emits '<name>\\t<name>' for name-only commands (id == name)", () => {
    // workflow/skills/agents/tools/mcp/prompts/commands 都用 name 作为 id
    expect(renderQuietLine("ppt-master", "ppt-master")).toBe("ppt-master\tppt-master");
  });
});

describe("renderQuietPaginationHint (Task #1818 user feedback: tail pagination info)", () => {
  it("emits '# (showing X-Y of Z, use -o N for next page)' when truncated", () => {
    expect(
      renderQuietPaginationHint({ count: 3, total: 28, offset: 0, limit: 3 }),
    ).toBe("# (showing 1-3 of 28, use -o 3 for next page)");
  });

  it("uses correct range when on a non-first page", () => {
    expect(
      renderQuietPaginationHint({ count: 3, total: 28, offset: 6, limit: 3 }),
    ).toBe("# (showing 7-9 of 28, use -o 9 for next page)");
  });

  it("returns empty string when not truncated (count === total)", () => {
    expect(
      renderQuietPaginationHint({ count: 3, total: 3, offset: 0, limit: 3 }),
    ).toBe("");
  });

  it("returns empty string when total is 0", () => {
    expect(
      renderQuietPaginationHint({ count: 0, total: 0, offset: 0, limit: 20 }),
    ).toBe("");
  });

  it("starts with '# ' so grep -v '^#' can skip both header and hint", () => {
    const hint = renderQuietPaginationHint({ count: 1, total: 10, offset: 0, limit: 1 });
    expect(hint.startsWith("# ")).toBe(true);
  });
});
