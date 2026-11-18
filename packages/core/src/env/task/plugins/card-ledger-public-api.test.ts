/**
 * Task #4860 — RED test: the card ledger must be a **public API** of core.
 *
 * ## Why
 *
 * Core's card hooks keep a **ledger** — `lark-cards.db`, keyed by task id
 * (`taskId → messageId`) — so that the *second* producer of a card adopts
 * the first one's card instead of sending a new one. It is the mechanism
 * that makes "one task ⇒ one card" true across processes and restarts.
 *
 * That ledger was **internal**: `lark-card-state-store.ts` was not exported
 * from the plugins barrel, so an external host (the plugin's daemon-side
 * card port) could not write it. Two consequences:
 *
 * 1. the daemon's card and the MCP hook's card could not see each other →
 *    **two cards for one task** (measured: `scripts/probe-double-card.mjs`
 *    reported 2 sends for one task id);
 * 2. the only way to write the ledger from outside was to hand-roll SQL
 *    against core's private schema — exactly the "re-implement roy's
 *    semantics in the plugin" failure mode Task #4619 removed.
 *
 * ## The rule
 *
 * The ledger store must be reachable from `@ai-setting/roy-bot-core/env/
 * task/plugins`, with the same factory core's own hook uses (so there is one
 * schema, one path resolution and one busy-timeout policy).
 */

import { describe, expect, test } from "bun:test";

import {
  createLarkCardStateStore,
  getDefaultLarkCardDbPath,
  MemoryLarkCardStateStore,
  SqliteLarkCardStateStore,
  type LarkCardState,
  type LarkCardStateStore,
} from "./index";

describe("Task #4860: the card ledger is a public API", () => {
  test("the barrel exports the ledger store factory and both implementations", () => {
    expect(typeof createLarkCardStateStore).toBe("function");
    expect(typeof getDefaultLarkCardDbPath).toBe("function");
    expect(typeof MemoryLarkCardStateStore).toBe("function");
    expect(typeof SqliteLarkCardStateStore).toBe("function");
  });

  test("the factory honours an explicit path", () => {
    const store = createLarkCardStateStore(":memory:");
    expect(store).toBeDefined();
    expect(typeof store.upsert).toBe("function");
    expect(typeof store.get).toBe("function");
    store.close();
  });

  test("the default path is the well-known lark-cards.db location", () => {
    expect(getDefaultLarkCardDbPath()).toContain("lark-cards.db");
  });

  test("a store round-trips a taskId → messageId record", () => {
    const store: LarkCardStateStore = createLarkCardStateStore(":memory:");
    const state: LarkCardState = {
      taskId: 4242,
      messageId: "om_ledger_1",
      chatId: "oc_ledger",
      profile: "default",
      pinned: true,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.upsert(state);
    const read = store.get(4242);
    expect(read?.messageId).toBe("om_ledger_1");
    expect(read?.chatId).toBe("oc_ledger");
    expect(read?.status).toBe("open");
    store.close();
  });
});
