/**
 * @fileoverview TDD RED — AgentComponentAdapter must register a real
 * onForce handler when given a cancellationScope (Task #2291
 * Codex P0-3 / Claude P0-1).
 *
 * Background (Task #2291 follow-up to Task #2275):
 *   Both reviewers flagged the same architectural gap:
 *   - Codex P0-3: "AgentNode writes cancellationScope to agentConfig but
 *     no production runner reads it — force escalation is structurally
 *     unreachable in production"
 *   - Claude P0-1: "cancellationScope object forwarding to AgentRunner
 *     is dead code in production"
 *
 * Contract after GREEN:
 *   - AgentComponentAdapter.run(), when invoked with a config that
 *     contains `(config as any).cancellationScope`, registers at least
 *     one onForce handler on that scope.
 *   - When the scope fires `cancel({force:true})`, the registered
 *     handler is invoked (observable via a side effect the test
 *     installs in the handler, OR by inspecting the scope's internal
 *     handler list after run() returns).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { AgentComponentAdapter } from "./agent-component-adapter";
import { RuntimeCancellationScope } from "../runtime/runtime-cancellation-scope";
import type { AgentConfig } from "./agent-node";
import type { SessionComponent } from "../../session/session-component";

// =============================================================================
// Helpers
// =============================================================================

function makeStubAgentComponent() {
  // The adapter's run() calls:
  //   this.agentComponent.getAgent(name) → for the agent registry lookup
  //   this.agentComponent.run(agentName, userInput, context) → the actual run
  // We stub both. The "real" agent.run simply returns success so the
  // adapter's post-processing is happy.
  return {
    getAgent: (_name: string) => ({
      // Minimal agent shape the adapter reads:
      config: { maxIterations: 1 },
    }),
    run: async (_name: string, _input: any, _ctx: any) => ({
      iterations: 0,
      toolCalls: [],
      finalText: "ok",
    }),
  } as any;
}

function makeSessionsStub(): SessionComponent {
  return {
    get: async () => null,
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => undefined,
    addMessage: async () => undefined,
    getMessages: async () => [],
  } as unknown as SessionComponent;
}

describe("[Task #2291 P0-3/P0-1] AgentComponentAdapter.onForce wire", () => {
  let adapter: AgentComponentAdapter;
  let sessions: SessionComponent;

  beforeEach(() => {
    sessions = makeSessionsStub();
    adapter = new AgentComponentAdapter(
      makeStubAgentComponent(),
      {},
      sessions
    );
  });

  it("RED-F5-1: adapter registers a force handler when config carries a cancellationScope", async () => {
    const scope = new RuntimeCancellationScope();
    // Sanity: no force handlers initially.
    // (We can't directly read the handler list — it's private. Instead,
    // we observe the side effect: after force fire, the handler must
    // have been invoked.)
    const config: AgentConfig = {
      type: "general",
      agentSessionId: "agent_f5_1",
      prompt: "echo",
      options: { model: "test" },
    } as AgentConfig;
    // The AgentNode (Task #2275) writes (config as any).cancellationScope
    // when a scope is available. We mimic that here.
    (config as any).cancellationScope = scope;

    let observed = false;
    // Install a watcher that increments `observed` whenever ANY onForce
    // handler fires. We can't add a watcher directly, but we can
    // subscribe to forceSignal and observe the abort event — that's
    // independent of the handler list. The actual proof: invoke the
    // adapter, then fire scope.cancel({force:true}) and check that
    // the registered handler has been called. Since we don't have a
    // hook to capture the handler side-effect, we use a sentinel:
    // BEFORE invoking the adapter, install our OWN handler that sets
    // `observed`; then check that AFTER cancel, exactly one of:
    //   (a) the adapter registered a handler too, AND
    //   (b) `observed` is true (our handler was called).
    // The GREEN test asserts that the adapter's handler was called by
    // checking the force handler list size (via a public test surface
    // we'll add) OR by setting a side effect on the scope that the
    // adapter touches.
    //
    // Approach: After adapter.run() returns, we expect scope.cancel({force:true})
    // to be observable in the agent's own controller. But the adapter
    // doesn't have its own controller. So we just assert that the
    // adapter, when given the scope, set up the wire — observable as:
    //   - The scope's force handler list (via reflection) has at least
    //     one entry registered AFTER adapter.run().
    //   - This is the GREEN condition: the adapter must have called
    //     `scope.onForce(...)` at least once.
    (scope as any).onForce("test-watcher", () => {
      observed = true;
    });
    const handlerCountBefore = ((scope as any).forceHandlers as Array<unknown>).length;

    await adapter.run(config, undefined, undefined);

    const handlerCountAfter = ((scope as any).forceHandlers as Array<unknown>).length;
    // The adapter must have registered at least one onForce handler.
    // (Our test watcher counts as one, so the delta must be ≥ 1.)
    expect(handlerCountAfter - handlerCountBefore).toBeGreaterThanOrEqual(1);

    // Now fire force and confirm our watcher saw the abort.
    await scope.cancel("test-force-fire", { force: true });
    expect(observed).toBe(true);
  });
});
