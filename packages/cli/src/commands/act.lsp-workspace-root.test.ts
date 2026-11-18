import { describe, expect, it, vi } from "vitest";
import * as actModule from "./act";

type GitRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] },
) => string;
type DetectWorkspaceRoot = (cwd: string, runGit?: GitRunner) => string;

const detectWorkspaceRoot = (actModule as unknown as {
  detectWorkspaceRoot?: DetectWorkspaceRoot;
}).detectWorkspaceRoot;

describe("detectWorkspaceRoot", () => {
  it("returns the trimmed git top-level directory when available", () => {
    expect(typeof detectWorkspaceRoot).toBe("function");
    if (!detectWorkspaceRoot) return;
    const runGit = vi.fn().mockReturnValue("/git/root\n");

    const root = detectWorkspaceRoot("/any/cwd", runGit);

    expect(root).toBe("/git/root");
    expect(runGit).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: "/any/cwd",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  });

  it("falls back to cwd when git root detection fails", () => {
    expect(typeof detectWorkspaceRoot).toBe("function");
    if (!detectWorkspaceRoot) return;
    const runGit = vi.fn(() => {
      throw new Error("not a git repository");
    });

    expect(detectWorkspaceRoot("/some/cwd", runGit)).toBe("/some/cwd");
  });
});
