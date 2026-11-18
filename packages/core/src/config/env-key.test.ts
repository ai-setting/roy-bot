/**
 * Bug #2186 Bug 1 RED tests: env var name should be user-friendly (single prefix)
 *
 * The root cause of the user's complaint:
 *   User expected: `LLM_DEFAULT_PROVIDER=volcengine` to work
 *   But code required: `LLM_LLM_DEFAULT_PROVIDER=volcengine` (double LLM prefix)
 *
 * This test file pins the expected behavior of toEnvKey / fromEnvKey / envKeyToConfigKey
 * AFTER Bug 1 is fixed.
 */
import { describe, test, expect } from "bun:test";
import { toEnvKey, fromEnvKey, envKeyToConfigKey } from "./env-key";

describe("env-key: Bug #2186 Bug 1 (no double LLM prefix)", () => {
  test("Bug1 RED: toEnvKey('llm.defaultProvider', 'LLM') → 'LLM_DEFAULT_PROVIDER' (single prefix)", () => {
    // User-friendly form expectation
    const envKey = toEnvKey("llm.defaultProvider", "LLM");
    expect(envKey).toBe("LLM_DEFAULT_PROVIDER");
  });

  test("Bug1 RED: toEnvKey('llm.defaultModel', 'LLM') → 'LLM_DEFAULT_MODEL' (single prefix)", () => {
    const envKey = toEnvKey("llm.defaultModel", "LLM");
    expect(envKey).toBe("LLM_DEFAULT_MODEL");
  });

  test("Bug1 RED: toEnvKey('llm.temperature', 'LLM') → 'LLM_TEMPERATURE' (single prefix)", () => {
    const envKey = toEnvKey("llm.temperature", "LLM");
    expect(envKey).toBe("LLM_TEMPERATURE");
  });

  test("Bug1 RED: toEnvKey('llm.providers.openai.apiKey', 'LLM') → 'LLM_PROVIDERS_OPENAI_API_KEY' (single prefix)", () => {
    const envKey = toEnvKey("llm.providers.openai.apiKey", "LLM");
    expect(envKey).toBe("LLM_PROVIDERS_OPENAI_API_KEY");
  });

  test("Bug1 RED: same fix applies to PROMPT, TOOL, COMMAND, MEMORY, TASK, AGENT, SESSION components", () => {
    expect(toEnvKey("prompt.defaultName", "PROMPT")).toBe("PROMPT_DEFAULT_NAME");
    expect(toEnvKey("tool.registry", "TOOL")).toBe("TOOL_REGISTRY");
    expect(toEnvKey("command.timeout", "COMMAND")).toBe("COMMAND_TIMEOUT");
    expect(toEnvKey("memory.ttl", "MEMORY")).toBe("MEMORY_TTL");
    expect(toEnvKey("task.id", "TASK")).toBe("TASK_ID");
    expect(toEnvKey("agent.name", "AGENT")).toBe("AGENT_NAME");
    expect(toEnvKey("session.id", "SESSION")).toBe("SESSION_ID");
  });

  test("Bug1 RED: log-trace prefix 'LOG_TRACE' (multi-segment) also avoids double prefix", () => {
    // Edge case: prefix is already multi-segment
    expect(toEnvKey("logTrace.logging.dir", "LOG_TRACE")).toBe("LOG_TRACE_LOGGING_DIR");
    expect(toEnvKey("log-trace.logging.dir", "LOG_TRACE")).toBe("LOG_TRACE_LOGGING_DIR");
  });

  test("Bug1 RED: non-component-prefixed keys still get prefix prepended", () => {
    // Standalone key (not starting with prefix as first segment) should still get prefix
    expect(toEnvKey("DEBUG", "LLM")).toBe("LLM_DEBUG");
    expect(toEnvKey("PROVIDER", "LLM")).toBe("LLM_PROVIDER");
  });

  test("Bug1 RED: fromEnvKey symmetric — 'LLM_DEFAULT_PROVIDER' → 'DEFAULT_PROVIDER'", () => {
    const back = fromEnvKey("LLM_DEFAULT_PROVIDER", "LLM");
    expect(back).toBe("DEFAULT_PROVIDER");
  });

  test("Bug1 RED: envKeyToConfigKey works for user-friendly single-prefix form", () => {
    // LLM_DEFAULT_PROVIDER should still resolve to llm.default.provider (snake_case form)
    const result = envKeyToConfigKey("LLM_DEFAULT_PROVIDER", "LLM", "llm");
    expect(result).toBe("llm.default.provider");
  });
});
