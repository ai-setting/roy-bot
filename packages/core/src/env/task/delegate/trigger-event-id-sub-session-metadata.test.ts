/**
 * Task #4042 Phase 2 集成测试：triggerEventId 写入 sub-session metadata
 *
 * 验证 delegate_tool 接到 CreateBackgroundTaskOptions.triggerEventId 时，
 * 把它写入新建 sub-session 的 metadata.triggerEventId 字段（sub-agent 也能读到）。
 */

import { describe, expect, test, beforeEach } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";

interface CapturedSession {
  title: string;
  parentSessionId: string;
  metadata: Record<string, unknown>;
  id: string;
}

function makeMockEnv(opts: { capturedSessions?: CapturedSession[]; parentSession?: any } = {}) {
  const capturedSessions = opts.capturedSessions ?? [];
  const parentSession = opts.parentSession ?? {
    id: "parent_001",
    info: { metadata: {} },
  };
  return {
    events: [] as any[],
    pushEnvEvent: (input: any) => {
      // capture only metadata
    },
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) => (id === parentSession.id ? parentSession : null),
          create: async (sessOpts: any) => {
            const sess: CapturedSession = {
              id: `sub_${Math.random().toString(36).slice(2, 10)}`,
              title: sessOpts.title,
              parentSessionId: sessOpts.parentSessionId,
              metadata: { ...(sessOpts.metadata ?? {}) },
            };
            capturedSessions.push(sess);
            return sess;
          },
          update: async () => {},
        };
      }
      return null;
    },
  };
}

describe("BackgroundTaskManager / createTask triggerEventId propagation", () => {
  test("triggerEventId is written to sub-session.metadata.triggerEventId", async () => {
    const captured: CapturedSession[] = [];
    const env = makeMockEnv({ capturedSessions: captured });
    const mgr = new BackgroundTaskManager(env as any);

    const result = await mgr.createTask({
      parentSessionId: "parent_001",
      description: "test triggerEventId propagation",
      prompt: "do something",
      subagentType: "general-purpose",
      triggerEventId: "evt_sub_session_test_123",
    });

    expect(captured.length).toBe(1);
    expect(captured[0].metadata.triggerEventId).toBe("evt_sub_session_test_123");
    expect(result.subSessionId).toBe(captured[0].id);
  });

  test("omitted triggerEventId does not leak into sub-session metadata", async () => {
    const captured: CapturedSession[] = [];
    const env = makeMockEnv({ capturedSessions: captured });
    const mgr = new BackgroundTaskManager(env as any);

    await mgr.createTask({
      parentSessionId: "parent_001",
      description: "no trigger",
      prompt: "do something",
      subagentType: "general-purpose",
    });

    expect(captured.length).toBe(1);
    expect(captured[0].metadata.triggerEventId).toBeUndefined();
  });
});