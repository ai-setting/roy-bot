/**
 * @fileoverview BountyCliNotificationChannel Tests
 */

import { describe, it, expect } from "bun:test";
import { BountyCliNotificationChannel } from "./bounty-cli-notification-channel";

describe("BountyCliNotificationChannel", () => {
  it("name is 'bounty-cli'", () => {
    const ch = new BountyCliNotificationChannel();
    expect(ch.name).toBe("bounty-cli");
  });

  describe("canRoute", () => {
    const ch = new BountyCliNotificationChannel();

    it("returns true when type contains 'bounty-cli' and has channelId", () => {
      const canRoute = ch.canRoute(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {
          replyChannel: {
            type: "bounty-cli",
            params: { channelId: "X" },
          },
        },
      );
      expect(canRoute).toBe(true);
    });

    it("returns true when type contains 'bounty-cli' (case insensitive) and has channelName", () => {
      const canRoute = ch.canRoute(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {
          replyChannel: {
            type: "Bounty-CLI",
            params: { channelName: "town-square" },
          },
        },
      );
      expect(canRoute).toBe(true);
    });

    it("returns true when type contains 'bounty-cli' and has messageId", () => {
      const canRoute = ch.canRoute(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {
          replyChannel: {
            type: "bounty-cli",
            messageId: "msg-123",
          },
        },
      );
      expect(canRoute).toBe(true);
    });

    it("returns false when replyChannel is missing", () => {
      const canRoute = ch.canRoute(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {},
      );
      expect(canRoute).toBe(false);
    });

    it("returns false when type does not contain 'bounty-cli'", () => {
      const canRoute = ch.canRoute(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {
          replyChannel: {
            type: "lark-cli",
            params: { channelId: "X" },
          },
        },
      );
      expect(canRoute).toBe(false);
    });

    it("returns false when no channelId/channelName/messageId", () => {
      const canRoute = ch.canRoute(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {
          replyChannel: {
            type: "bounty-cli",
          },
        },
      );
      expect(canRoute).toBe(false);
    });
  });

  describe("send (with mocked spawn)", () => {
    // Note: We don't mock child_process here; we just verify the channel
    // gracefully no-ops when channelId/channelName is missing.
    it("send with only messageId resolves without spawning (messageId-only path)", async () => {
      const ch = new BountyCliNotificationChannel();
      // Should resolve silently (no channel to publish to)
      await ch.send(
        { type: "test", title: "t", content: "c" },
        { pluginName: "p" },
        {
          replyChannel: {
            type: "bounty-cli",
            messageId: "msg-1",
          },
        },
      );
      // If we get here without throwing, the channel gracefully handled the case
    });
  });
});