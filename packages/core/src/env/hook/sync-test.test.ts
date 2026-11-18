import { describe, test, expect, afterEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
import { HookManager } from "./hook-manager";
import { TracedAs } from "../log-trace/decorator";
import { getTracerProvider, resetTracerProvider } from "../log-trace/opentelemetry/tracer-provider";

class SyncHook {
  name = "SyncHook";
  
  @TracedAs("sync-hook.execute")
  execute(ctx: any): void {  // 注意：不是 async！
    console.log("SyncHook execute");
  }
}

describe.skipIf(isParallelRun)("Sync Hook Test", () => {
  afterEach(() => resetTracerProvider());
  
  test.serial("sync hook", async () => {
    resetTracerProvider();
    const provider = getTracerProvider();
    await provider.initialize();
    
    const manager = new HookManager({ componentName: "test" });
    const hook = new SyncHook();
    manager.register("test:point", {
      name: "SyncHook:test:point",
      execute: hook.execute.bind(hook),
    });
    
    await manager.execute("test:point", { data: "test" });
    
    const storage = provider.getStorage();
    const spans = (storage as any).db?.prepare("SELECT name FROM span WHERE name LIKE '%sync-hook%'")?.all() || [];
    console.log("sync-hook spans:", spans);
    expect(spans.length).toBeGreaterThan(0);
  });
});
