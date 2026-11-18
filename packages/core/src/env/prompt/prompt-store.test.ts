/**
 * @fileoverview PromptStore tests (TDD)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PromptStore } from "./prompt-store";

describe("PromptStore", () => {
  let baseDir: string;
  let store: PromptStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "roy-prompt-store-"));
    store = new PromptStore({ configDir: baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("should save prompt to nested path", async () => {
    const filePath = await store.savePrompt("subagent/explore", "Explore prompt body");

    expect(filePath).toBe(join(baseDir, "subagent", "explore.md"));
    expect(existsSync(filePath)).toBe(true);
    expect(await readFile(filePath, "utf-8")).toBe("Explore prompt body");
  });

  it("should load prompts preserving slash names", async () => {
    await mkdir(join(baseDir, "subagent"), { recursive: true });
    await store.savePrompt("subagent/explore", "Loaded explore prompt");
    await store.savePrompt("custom-agent", "Simple prompt");

    const loaded = await store.loadAll();

    expect(loaded).toHaveLength(2);
    expect(loaded.find((p) => p.name === "subagent/explore")?.content).toBe(
      "Loaded explore prompt"
    );
    expect(loaded.find((p) => p.name === "custom-agent")?.content).toBe("Simple prompt");
  });

  it("should delete prompt file", async () => {
    const filePath = await store.savePrompt("to-delete", "temp");
    expect(existsSync(filePath)).toBe(true);

    const deleted = await store.deletePrompt("to-delete");
    expect(deleted).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it("should return config dir", () => {
    expect(store.getConfigDir()).toBe(baseDir);
  });
});
