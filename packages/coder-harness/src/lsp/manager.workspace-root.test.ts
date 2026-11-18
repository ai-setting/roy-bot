import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPManager } from "./manager";

describe("LSPManager workspaceRoot configuration", () => {
  let manager: LSPManager | undefined;

  afterEach(async () => {
    await manager?.dispose();
    vi.restoreAllMocks();
  });

  it("uses configured workspaceRoot when prewarming without an override", async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/explicit/workspace",
    });
    const prewarmServer = vi
      .spyOn(manager as any, "prewarmServer")
      .mockResolvedValue(undefined);

    await manager.prewarm(["typescript"]);

    expect(prewarmServer).toHaveBeenCalledWith("typescript", "/explicit/workspace");
  });

  it("does not read process.cwd when a workspaceRoot is configured", async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/explicit/workspace",
    });
    const cwd = vi.spyOn(process, "cwd");
    vi.spyOn(manager as any, "prewarmServer").mockResolvedValue(undefined);

    await manager.prewarm(["typescript"]);

    expect(cwd).not.toHaveBeenCalled();
  });

  it("reuses a prewarmed connection for files inside the configured root", async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/explicit/workspace",
    });
    const client = {
      isDisposed: vi.fn().mockReturnValue(false),
      getLastUsed: vi.fn().mockReturnValue(Date.now()),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const server = {
      findRoot: vi.fn().mockResolvedValue("/discovered/root"),
      createClient: vi.fn(),
    };
    (manager as any).servers.set("typescript", server);
    (manager as any)._prewarmedConnections.set(
      "typescript:/explicit/workspace",
      client,
    );

    const result = await manager.getOrCreateConnection(
      "typescript",
      "/explicit/workspace/src/index.ts",
    );

    expect(result).toBe(client);
    expect(server.findRoot).not.toHaveBeenCalled();
    expect(server.createClient).not.toHaveBeenCalled();
  });
});
