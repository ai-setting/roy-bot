/**
 * Task #4042 P1 fix: profile threading through extractReplyContext /
 * buildNotifyHandlePrompt（多 appId 场景 notify prompt 必须带 --profile）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "./event-store";
import { larkCliHandler } from "./event-source-handlers";

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lark-profile-test-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "e.db") });
});
afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("larkCliHandler profile threading (P1 fix)", () => {
  test("extractReplyContext uses explicit profile over metadata.profile", async () => {
    const id = await store.insertTriggerEvent(
      {
        senderId: "ou_s",
        metadata: { chatId: "oc_p", messageId: "om_p", senderId: "ou_s", profile: "meta_profile" },
      },
      "lark-cli",
    );
    const event = (await store.getEventById(id))!;
    const ctx = larkCliHandler.extractReplyContext!(event, "explicit_profile");
    expect(ctx.profile).toBe("explicit_profile");
  });

  test("extractReplyContext falls back to event.metadata.profile", async () => {
    const id = await store.insertTriggerEvent(
      {
        senderId: "ou_s",
        metadata: { chatId: "oc_p", messageId: "om_p", senderId: "ou_s", profile: "meta_profile" },
      },
      "lark-cli",
    );
    const event = (await store.getEventById(id))!;
    const ctx = larkCliHandler.extractReplyContext!(event);
    expect(ctx.profile).toBe("meta_profile");
  });

  test("buildNotifyHandlePrompt threads profile into prompt + hint", async () => {
    const id = await store.insertTriggerEvent(
      {
        senderId: "ou_s",
        metadata: { chatId: "oc_p", messageId: "om_p", senderId: "ou_s" },
      },
      "lark-cli",
    );
    const event = (await store.getEventById(id))!;
    const out = larkCliHandler.buildNotifyHandlePrompt!({
      notifyEvent: { type: "task.background.completed", taskId: 42, description: "调研", result: "r" },
      triggerEvent: event,
      subAgentResult: { summary: "done" },
      profile: "zhishitong",
    });
    // 关键：notify prompt 的命令必须带 --profile
    expect(out.promptText).toContain("--profile zhishitong");
    expect(out.systemHint).toContain("zhishitong");
  });
});
