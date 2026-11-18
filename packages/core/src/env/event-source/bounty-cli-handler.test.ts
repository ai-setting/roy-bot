/**
 * @fileoverview BountyCliHandler Tests
 */

import { describe, it, expect } from "bun:test";
import { bountyCliHandler } from "./bounty-cli-handler";

describe("BountyCliHandler", () => {
  it("type is 'bounty-cli'", () => {
    expect(bountyCliHandler.type).toBe("bounty-cli");
  });

  describe("validateConfig", () => {
    it("rejects when id is missing", () => {
      const errors = bountyCliHandler.validateConfig({
        id: "",
        name: "test",
        type: "bounty-cli",
        enabled: true,
      });
      expect(errors).toContain("EventSource ID is required");
    });

    it("rejects when name is missing", () => {
      const errors = bountyCliHandler.validateConfig({
        id: "x",
        name: "",
        type: "bounty-cli",
        enabled: true,
      });
      expect(errors).toContain("EventSource name is required");
    });

    it("rejects when channel and command are both missing", () => {
      const errors = bountyCliHandler.validateConfig({
        id: "x",
        name: "test",
        type: "bounty-cli",
        enabled: true,
      });
      expect(errors.some((e) => e.toLowerCase().includes("channel"))).toBe(true);
    });

    it("accepts when channel is set (top-level)", () => {
      const errors = bountyCliHandler.validateConfig({
        id: "x",
        name: "test",
        type: "bounty-cli",
        enabled: true,
        channel: "town-square",
      } as any);
      expect(errors).toEqual([]);
    });

    it("accepts when channel is set via options", () => {
      const errors = bountyCliHandler.validateConfig({
        id: "x",
        name: "test",
        type: "bounty-cli",
        enabled: true,
        options: { channel: "town-square" },
      });
      expect(errors).toEqual([]);
    });

    it("accepts when command is set (custom command)", () => {
      const errors = bountyCliHandler.validateConfig({
        id: "x",
        name: "test",
        type: "bounty-cli",
        enabled: true,
        command: "bounty --profile custom event consume --channel X",
      });
      expect(errors).toEqual([]);
    });
  });

  describe("createInstance", () => {
    it("returns an instance", () => {
      const instance = bountyCliHandler.createInstance({
        id: "x",
        name: "test",
        type: "bounty-cli",
        enabled: true,
        channel: "town-square",
      } as any);
      expect(instance).toBeDefined();
      expect(instance.getStatus()).toBe("created");
    });
  });
});