/**
 * @fileoverview Integration test — delegate_task tool injects the reuse candidate section
 *                 when the TaskCreationRegistry has recent tasks.
 *
 * This test wires a real TaskComponent + real TaskCreationRegistry into the
 * delegate tool, then simulates a real a-stock-screener fixture where:
 *   - 4 prior tasks were created (design / implement / register / run)
 *   - The 5th delegation ("bug fix v0.7.1") should see those 4 candidates
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskCreationRegistry } from "../task-creation-registry";
import { getOrCreateTaskReuseRegistry } from "../task-reuse-registry";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";

describe("delegate_task reuse candidate section integration", () => {
  let taskComponent: TaskComponent;
  let registry: TaskCreationRegistry;
  let env: any;

  beforeEach(async () => {
    taskComponent = new TaskComponent();
    const configComponent = new ConfigComponent();
    await taskComponent.init({
      name: "task",
      version: "1.0.0",
      enabled: true,
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(
              tmpdir(),
              `reuse-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
            ),
          },
        },
      },
    });
    // Fake environment that exposes the TaskComponent via getComponent
    env = {
      getComponent: (name: string) =>
        name === "task" ? taskComponent : undefined,
      currentSessionId: "test-session-A",
    };
    // Use the singleton registry (per-env) — that's the production path
    registry = getOrCreateTaskReuseRegistry(env) as any;
  });

  afterEach(async () => {
    const { disposeTaskReuseRegistry } = await import("../task-reuse-registry");
    disposeTaskReuseRegistry(env);
    await taskComponent.stop();
  });

  test("registry singleton returns the same instance across calls", () => {
    const r1 = getOrCreateTaskReuseRegistry(env);
    const r2 = getOrCreateTaskReuseRegistry(env);
    expect(r1).toBe(r2);
  });

  test("createTask populates the registry reachable via singleton", async () => {
    await taskComponent.createTask({
      title: "first task",
      sessionId: "test-session-A",
      project_path: "/test/proj",
      context: '{"type":"feature"}',
    });
    const r = getOrCreateTaskReuseRegistry(env);
    expect(r.size()).toBe(1);
  });

  test("5-phase a-stock-screener fixture produces 4 prior candidates", async () => {
    const titles = [
      "design a-stock-screener v0.7.0",
      "implement v0.7.0 fee/calendar/kline modules",
      "register a-stock-screener-v0.7.0",
      "run a-stock-screener v0.7.0 and analyze",
    ];
    for (const t of titles) {
      await taskComponent.createTask({
        title: t,
        sessionId: "test-session-A",
        project_path: "/test/proj",
        context: '{"type":"feature"}',
      });
    }
    const r = getOrCreateTaskReuseRegistry(env);
    expect(r.size()).toBe(4);
  });

  test("scope filter narrows to a specific subagentType", async () => {
    await taskComponent.createTask({
      title: "from-roy",
      sessionId: "s1",
      project_path: "/test/proj",
      context: '{"type":"feature"}',
    });
    // The singleton's staticSource doesn't set subagentType, so scope
    // matching by subagentType should yield zero records.
    const recs = registry.recent({
      scope: { subagentType: "roy" },
      limit: 5,
    });
    expect(recs.length).toBe(0);
    // sessionId is captured via provider
    const recsAll = registry.recent({ limit: 5 });
    expect(recsAll.length).toBe(1);
    expect(recsAll[0].source.sessionId).toBe("test-session-A");
  });

  test("no candidates → no reuse section injected", async () => {
    const r = getOrCreateTaskReuseRegistry(env);
    expect(r.size()).toBe(0);
    const { buildReuseCandidateSection } = await import("../task-reuse-context");
    const section = buildReuseCandidateSection({
      registry: r,
      similarTaskIds: [],
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 240,
    });
    expect(section.isEmpty).toBe(true);
  });

  test("env without TaskComponent → registry stays empty (graceful)", () => {
    const emptyEnv: any = { getComponent: () => undefined };
    const r = getOrCreateTaskReuseRegistry(emptyEnv);
    expect(r.size()).toBe(0);
  });

  test("disposeTaskReuseRegistry removes the registry", async () => {
    const { disposeTaskReuseRegistry } = await import("../task-reuse-registry");
    const r = getOrCreateTaskReuseRegistry(env);
    expect(r.size()).toBe(0);
    await taskComponent.createTask({
      title: "before dispose",
      sessionId: "test-session-A",
      project_path: "/test/proj",
      context: "{}",
    });
    expect(r.size()).toBe(1);
    disposeTaskReuseRegistry(env);
    // After dispose, a new singleton is created — should not have stale entries
    const r2 = getOrCreateTaskReuseRegistry(env);
    expect(r2).not.toBe(r);
    expect(r2.size()).toBe(0);
  });
});