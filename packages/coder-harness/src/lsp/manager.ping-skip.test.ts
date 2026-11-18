import { afterEach, describe, expect, it, vi } from "vitest";
import type { LSPClient } from "./client";
import { LSPManager } from "./manager";

const managers: LSPManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

function makeClient(lastUsed: number): LSPClient {
  return {
    isDisposed: vi.fn().mockReturnValue(false),
    getLastUsed: vi.fn().mockReturnValue(lastUsed),
    ping: vi.fn().mockResolvedValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as LSPClient;
}

function makeManager(client: LSPClient, active: boolean): LSPManager {
  const manager = new LSPManager({
    idleTimeout: 60_000,
    maxConnections: 5,
    autoDownload: false,
    workspaceRoot: "/explicit",
  });
  managers.push(manager);
  (manager as any).servers.set("typescript", {
    findRoot: vi.fn().mockResolvedValue("/explicit"),
    createClient: vi.fn(),
  });
  const pool = active ? (manager as any).connections : (manager as any)._prewarmedConnections;
  pool.set("typescript:/explicit", client);
  return manager;
}

describe("LSPManager ping-skip optimization", () => {
  it("does not ping a prewarmed connection on first use", async () => {
    const client = makeClient(Date.now());
    const manager = makeManager(client, false);

    const result = await manager.getOrCreateConnection(
      "typescript",
      "/explicit/foo.ts",
    );

    expect(result).toBe(client);
    expect(client.ping).not.toHaveBeenCalled();
  });

  it("skips ping when an active connection was used within 30 seconds", async () => {
    const client = makeClient(Date.now() - 6_000);
    const manager = makeManager(client, true);

    const result = await manager.getOrCreateConnection(
      "typescript",
      "/explicit/foo.ts",
    );

    expect(result).toBe(client);
    expect(client.ping).not.toHaveBeenCalled();
  });

  it("pings an active connection after 30 seconds of inactivity", async () => {
    const client = makeClient(Date.now() - 40_000);
    const manager = makeManager(client, true);

    const result = await manager.getOrCreateConnection(
      "typescript",
      "/explicit/foo.ts",
    );

    expect(result).toBe(client);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });
});
