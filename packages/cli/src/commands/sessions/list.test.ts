/**
 * @fileoverview Integration tests for `sessions list --graph` (TDD for Task #1739)
 *
 * Verifies:
 *  1. yargs builder registers the `--graph` flag.
 *  2. With `--graph`, the handler prints the ASCII tree (not the table).
 *  3. The JSON output includes `parentSessionId` for every session.
 *  4. The table output includes a Parent column (or `parentSessionId` info).
 *  5. `--id` / `--quiet` still produce ID-only output.
 *  6. Empty data with `--graph` prints "No sessions.".
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Session } from "@ai-setting/roy-bot-core";

// Mock environment service + output to avoid touching real SQLite
const capturedOutput: { lines: string[]; json: any | null } = {
  lines: [],
  json: null,
};

const fakeSessionComponent = {
  list: mock(async () => fakeSessions) as any,
  getCount: mock(async () => fakeSessions.length) as any,
  getActiveSessionId: mock(() => undefined) as any,
  // Task #1955: list --graph now calls expandSessionAncestors which may
  // fetch missing parents via `.get`. Return undefined so orphan cases
  // (parentSessionId points at a missing session) are skipped silently —
  // matching the "renders orphan and cycle markers" test's expectations.
  get: mock(async () => undefined) as any,
};

let fakeSessions: Session[] = [];

const fakeEnvService: any = {
  create: mock(async () => undefined) as any,
  getEnvironment: mock(() => ({
    getComponent: (name: string) =>
      name === "session" ? fakeSessionComponent : undefined,
  })) as any,
  dispose: mock(async () => undefined) as any,
};

const OutputServiceMock: any = mock(() => ({
  configure: mock(() => undefined) as any,
  log: mock((line: string) => {
    capturedOutput.lines.push(line);
  }) as any,
  error: mock(() => undefined) as any,
  json: mock((obj: any) => {
    capturedOutput.json = obj;
  }) as any,
}));

const EnvironmentServiceMock: any = mock(() => fakeEnvService);

mock.module("../../services/environment.service", () => ({
  EnvironmentService: EnvironmentServiceMock,
}));

mock.module("../../services/output.service", () => ({
  OutputService: OutputServiceMock,
}));

mock.module("../../services/quiet-mode.service", () => ({
  CliQuietModeService: { getInstance: () => ({ setQuiet: () => undefined }) },
}));

// Now import the command under test
const { ListCommand } = await import("./list");

function resetCapture() {
  capturedOutput.lines = [];
  capturedOutput.json = null;
  fakeSessionComponent.list.mockClear();
  fakeSessionComponent.getCount.mockClear();
  fakeSessionComponent.get.mockClear();
  fakeEnvService.create.mockClear();
  fakeEnvService.dispose.mockClear();
  OutputServiceMock.mockClear();
  EnvironmentServiceMock.mockClear();
}

function mkSession(
  id: string,
  partial: Partial<Session> = {}
): Session {
  return {
    id,
    title: `Session ${id}`,
    directory: "/tmp",
    parentSessionId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messageCount: 0,
    metadata: {},
    ...partial,
  };
}

describe("sessions list --graph (integration)", () => {
  beforeEach(() => {
    resetCapture();
    fakeSessions = [];
  });

  it("yargs builder registers --graph option", () => {
    const yargs: any = {
      option: function (...args: any[]) {
        this.calls = this.calls || [];
        this.calls.push(args);
        return this;
      },
    };
    // @ts-ignore
    ListCommand.builder!(yargs);
    const registered = (yargs.calls || []).map((c: any) => c[0]);
    expect(registered).toContain("graph");
  });

  it("yargs builder registers --short-id option", () => {
    const yargs: any = {
      option: function (...args: any[]) {
        this.calls = this.calls || [];
        this.calls.push(args);
        return this;
      },
    };
    // @ts-ignore
    ListCommand.builder!(yargs);
    const registered = (yargs.calls || []).map((c: any) => c[0]);
    expect(registered).toContain("short-id");
  });

  it("--graph default: shows FULL session id (no truncation)", async () => {
    fakeSessions = [
      mkSession("session_abcdef1234567890"),
      mkSession("session_child9876543210", {
        parentSessionId: "session_abcdef1234567890",
      }),
    ];
    await invoke({ graph: true });
    const all = capturedOutput.lines.join("\n");
    expect(all).toContain("session_abcdef1234567890");
    expect(all).toContain("session_child9876543210");
  });

  it("--graph --short-id: shows 8-char truncated id (legacy)", async () => {
    fakeSessions = [
      mkSession("session_abcdef1234567890"),
      mkSession("session_child9876543210", {
        parentSessionId: "session_abcdef1234567890",
      }),
    ];
    await invoke({ graph: true, shortId: true });
    const all = capturedOutput.lines.join("\n");
    // Legacy: strip session_ prefix and show 8 chars
    expect(all).toContain("abcdef12");
    expect(all).toContain("child987");
    // Full id should NOT appear
    expect(all).not.toContain("session_abcdef1234567890");
    expect(all).not.toContain("session_child9876543210");
  });

  it("prints 'No sessions.' for empty data with --graph", async () => {
    fakeSessions = [];
    await invoke({ graph: true });
    // The handler should print "No sessions." (as part of the tree)
    const all = capturedOutput.lines.join("\n");
    expect(all).toContain("No sessions.");
  });

  it("renders the tree when --graph is set, with multiple roots", async () => {
    fakeSessions = [
      mkSession("a"),
      mkSession("b"),
      mkSession("c", { parentSessionId: "a" }),
    ];
    await invoke({ graph: true });
    const all = capturedOutput.lines.join("\n");
    expect(all).toContain("Session Tree");
    expect(all).toContain("a");
    expect(all).toContain("b");
    expect(all).toContain("c");
  });

  it("renders orphan and cycle markers in --graph output", async () => {
    fakeSessions = [
      mkSession("o", { parentSessionId: "ghost" }),
      mkSession("x", { parentSessionId: "y" }),
      mkSession("y", { parentSessionId: "x" }),
    ];
    await invoke({ graph: true });
    const all = capturedOutput.lines.join("\n");
    expect(all).toContain("[orphan]");
    expect(all).toContain("[cycle]");
  });

  it("JSON output includes parentSessionId for every session", async () => {
    fakeSessions = [
      mkSession("p"),
      mkSession("c1", { parentSessionId: "p" }),
      mkSession("c2", { parentSessionId: "p" }),
    ];
    await invoke({ json: true });
    expect(capturedOutput.json).toBeTruthy();
    const sessions = capturedOutput.json.sessions as any[];
    expect(sessions).toHaveLength(3);
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId["p"]!.parentSessionId).toBeNull();
    expect(byId["c1"]!.parentSessionId).toBe("p");
    expect(byId["c2"]!.parentSessionId).toBe("p");
  });

  it("table output includes parentSessionId info", async () => {
    fakeSessions = [
      mkSession("p"),
      mkSession("c", { parentSessionId: "p" }),
    ];
    await invoke({});
    const all = capturedOutput.lines.join("\n");
    // table should show either a "Parent" column or a parentSessionId annotation
    expect(all).toContain("Parent");
    expect(all).toContain("p");
  });

  it("--id flag still produces ID-only output (script compat)", async () => {
    fakeSessions = [
      mkSession("p"),
      mkSession("c", { parentSessionId: "p" }),
    ];
    await invoke({ id: true });
    expect(capturedOutput.lines).toEqual(["p", "c"]);
    expect(capturedOutput.json).toBeNull();
  });

  // Task #1818 user feedback (round 3): --quiet must show
  //   # Total: N header
  //   <id>\t<title> per line (id 在第一列, 便于 grep/awk)
  // `--id` keeps the legacy ID-only output for backward-compat scripts.
  it("--quiet flag outputs '# Total: N sessions' header", async () => {
    fakeSessions = [
      mkSession("p"),
      mkSession("c", { parentSessionId: "p" }),
    ];
    await invoke({ quiet: true });
    expect(capturedOutput.lines[0]).toBe("# Total: 2 sessions");
  });

  it("--quiet flag outputs '<id>\\t<title>' per line", async () => {
    fakeSessions = [
      mkSession("p"),
      mkSession("c", { parentSessionId: "p" }),
    ];
    await invoke({ quiet: true });
    // Skip first line (the # Total header)
    const dataLines = capturedOutput.lines.slice(1);
    expect(dataLines).toEqual(["p\tSession p", "c\tSession c"]);
  });

  // Issue #3: --short-id applies to the Parent column in the table view (and
  // the graph view). Default (no flag) is the FULL parent id.
  it("table view: Parent column defaults to the FULL parent session id (Issue #3)", async () => {
    fakeSessions = [
      mkSession("session_abcdef1234567890"),
      mkSession("session_child9876543210", {
        parentSessionId: "session_abcdef1234567890",
      }),
    ];
    await invoke({});
    const all = capturedOutput.lines.join("\n");
    const childRow = all
      .split("\n")
      .find((l) => l.includes("session_child9876543210"));
    expect(childRow).toBeTruthy();
    // Child row's Parent column should contain the FULL parent id
    expect(childRow).toContain("session_abcdef1234567890");
    // No truncation marker
    expect(childRow).not.toContain("abcdef1…");
  });

  it("table view: --short-id truncates the Parent column to 8-char prefix (Issue #3)", async () => {
    fakeSessions = [
      mkSession("session_abcdef1234567890"),
      mkSession("session_child9876543210", {
        parentSessionId: "session_abcdef1234567890",
      }),
    ];
    await invoke({ shortId: true });
    const all = capturedOutput.lines.join("\n");
    const childRow = all
      .split("\n")
      .find((l) => l.includes("session_child9876543210"));
    expect(childRow).toBeTruthy();
    // Child row's Parent column should show truncated parent id (8 chars + ellipsis)
    expect(childRow).toContain("abcdef1");
    // Child row's Parent column should NOT contain the full parent id
    expect(childRow).not.toContain("session_abcdef1234567890");
    // The child's own ID column should still show the full ID
    expect(childRow).toContain("session_child9876543210");
  });
});

// ===== helpers =====

async function invoke(opts: Record<string, any>): Promise<void> {
  const args: any = { ...opts };
  // @ts-ignore — the command's handler accepts our stubbed shape
  await ListCommand.handler!(args);
}
