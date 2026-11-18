import { describe, test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "yaml";

// Pre-existing: tests depend on user's local ~/.local/share/roy-bot/agents
// contents. Not a parallel-induced issue (Task #2023 Y-plan).
const isParallelRun = !!process.env.BUN_TEST_WORKER_ID;

// ========================================================================
// Test Suite: All agents have read_file available
// ========================================================================

describe.skipIf(isParallelRun)("Agent read_file default availability", () => {
  const agentsDir = path.join(os.homedir(), ".local/share/roy-bot/agents");

  // Helper: load all agent yaml files
  const loadAgentYamls = (): Array<{ name: string; config: any }> => {
    if (!fs.existsSync(agentsDir)) {
      return [];
    }
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".yaml"));
    return files.map((file) => {
      const filePath = path.join(agentsDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const config = yaml.parse(content) as any;
      return { name: file.replace(/\.yaml$/, ""), config };
    });
  };

  // ========================================================================
  // Test 1: every agent with explicit allowedTools must include read_file
  // ========================================================================
  test("every agent with explicit allowedTools must include read_file", () => {
    const agents = loadAgentYamls();
    expect(agents.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const { name, config } of agents) {
      if (!config || typeof config !== "object") continue;

      // Skip agents without explicit allowedTools (use systemPromptRef or workflow)
      if (!Array.isArray(config.allowedTools)) continue;

      // Skip workflow-type agents (they delegate to workflows)
      if (config.type === "workflow") continue;

      // Check that read_file is in allowedTools
      const hasReadFile = config.allowedTools.includes("read_file");
      if (!hasReadFile) {
        failures.push(`${name}: allowedTools missing read_file`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Agents missing read_file in allowedTools:\n${failures.join("\n")}`,
      );
    }
  });

  // ========================================================================
  // Test 2: no agent should have read_file in deniedTools
  // ========================================================================
  test("no agent should have read_file in deniedTools", () => {
    const agents = loadAgentYamls();

    const failures: string[] = [];

    for (const { name, config } of agents) {
      if (!config || typeof config !== "object") continue;

      if (Array.isArray(config.deniedTools) && config.deniedTools.includes("read_file")) {
        failures.push(`${name}: deniedTools contains read_file`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Agents denying read_file:\n${failures.join("\n")}`,
      );
    }
  });

  // ========================================================================
  // Test 3: scan environment.ts defaultDeniedTools for read_file
  // ========================================================================
  test("environment.ts defaultDeniedTools should not include read_file", async () => {
    const envPath = path.join(
      __dirname,
      "environment.ts",
    );

    if (!fs.existsSync(envPath)) {
      // Skip if environment.ts doesn't exist
      return;
    }

    const content = fs.readFileSync(envPath, "utf-8");

    // Find defaultDeniedTools array
    const deniedMatch = content.match(/defaultDeniedTools\s*=\s*\[([\s\S]*?)\]/);
    if (!deniedMatch) {
      // Skip if no defaultDeniedTools found
      return;
    }

    const deniedList = deniedMatch[1];

    // Check that read_file is NOT in the list
    // Allow it as long as it's not a direct string entry
    const lines = deniedList.split("\n").map((l) => l.trim());
    const hasReadFile = lines.some((l) => {
      // Match `"read_file"` as a list item (not commented out)
      if (l.startsWith("//")) return false;
      return /["']read_file["']/.test(l);
    });

    expect(hasReadFile).toBe(false);
  });
});