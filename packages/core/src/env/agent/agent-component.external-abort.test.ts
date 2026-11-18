/**
 * @fileoverview TDD RED — AgentComponent external AbortSignal must mark
 * runId as aborted so final state is "stopped" (Task #2275 Task 4).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

function createMockEnvironment(configComponent: ConfigComponent, llmInvoke: any): Environment {
  const mockEnv = {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return { invoke: llmInvoke };
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config" || name === "llm"),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
  return mockEnv;
}

interface BlockingLlmHandle {
  release(): void;
  calls: Array<{ signal?: AbortSignal }>;
}

function makeBlockingLlm(): BlockingLlmHandle {
  const calls: Array<{ signal?: AbortSignal }> = [];
  let releaseFn: (() => void) | undefined;
  return {
    calls,
    release() {
      releaseFn?.();
      releaseFn = undefined;
    },
    install() {
      // returns an invoke function. Each call captures latest release.
      const invoke = ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        calls.push({ signal: abortSignal });
        let resolveP!: (v: any) => void;
        let rejectP!: (e: Error) => void;
        const promise = new Promise<any>((resolve, reject) => {
          resolveP = resolve;
          rejectP = reject;
        });
        releaseFn = () => resolveP({ output: { content: "done", toolCalls: [] } });
        if (abortSignal) {
          if (abortSignal.aborted) {
            const err = new Error("Aborted (pre)");
            (err as any).name = "AbortError";
            return Promise.reject(err);
          }
          abortSignal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            (err as any).name = "AbortError";
            rejectP(err);
          }, { once: true });
        }
        return promise;
      };
      return invoke;
    },
  } as any;
}

describe("[Task #2275 RED] AgentComponent external abort → status=stopped", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let llmHandle: any;

  beforeEach(async () => {
    llmHandle = makeBlockingLlm();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    const mockEnv = createMockEnvironment(configComponent, llmHandle.install());
    await agentComponent.init({ env: mockEnv, options: { configComponent }, name: "agent", version: "1.0.0", enabled: true } as any);
    agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 } as any);
  });

  afterEach(async () => {
    llmHandle.release();
    if (agentComponent.getStatus() !== "stopped") {
      try { await agentComponent.stop(); } catch {}
    }
  });

  it("EA-1: external abort during blocking LLM → agent.status === 'stopped'", async () => {
    const extController = new AbortController();
    const runPromise = agentComponent.run(
      "test-agent",
      "long query",
      { abort: extController.signal } as any,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(llmHandle.calls.length).toBe(1);

    extController.abort("ESC cascade");

    const result = await Promise.race([
      runPromise,
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("RUN_HUNG")), 2000)),
    ]);
    expect(result).toBeDefined();

    const agent = (agentComponent as any).agents?.get?.("test-agent")
      ?? (agentComponent as any).agentRegistry?.get?.("test-agent");
    expect(agent).toBeDefined();
    expect(agent.status).toBe("stopped");
  });

  it("EA-2: external abort → result.stopped === true", async () => {
    const extController = new AbortController();
    const runPromise = agentComponent.run(
      "test-agent",
      "long query",
      { abort: extController.signal } as any,
    );
    await new Promise((r) => setTimeout(r, 50));
    extController.abort("ESC");
    const result: any = await runPromise;
    expect(result?.stopped).toBe(true);
  });

  it("EA-4: per-run isolation — aborting run A does NOT abort run B", async () => {
    agentComponent.registerAgent("test-agent-2", { type: "primary" } as any);

    const extA = new AbortController();
    const runA = agentComponent.run(
      "test-agent", "A",
      { abort: extA.signal } as any,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(llmHandle.calls.length).toBe(1);

    const extB = new AbortController();
    const runB = agentComponent.run(
      "test-agent-2", "B",
      { abort: extB.signal } as any,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(llmHandle.calls.length).toBe(2);

    extA.abort("ESC A");
    await Promise.race([
      runA,
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("A_HUNG")), 2000)),
    ]);

    const agentB = (agentComponent as any).agents?.get?.("test-agent-2");
    expect(agentB?.status).not.toBe("stopped");

    extB.abort("cleanup B");
    await runB;
  });

  it("EA-5: pre-aborted external signal → run returns immediately, agent.status=stopped", async () => {
    const extController = new AbortController();
    extController.abort("pre-aborted");
    const runPromise = agentComponent.run(
      "test-agent",
      "should-not-start",
      { abort: extController.signal } as any,
    );
    await runPromise;
    expect(llmHandle.calls.length).toBe(0);
    const agent = (agentComponent as any).agents?.get?.("test-agent");
    expect(agent?.status).toBe("stopped");
  });
});
