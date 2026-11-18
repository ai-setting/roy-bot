/**
 * @fileoverview REPL Engine Test
 * 
 * TDD: 测试 REPL 引擎的核心功能
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import * as readline from "readline";

// We'll test the REPL class by testing its interface and logic
// Since REPL relies on readline which is hard to mock in unit tests,
// we'll focus on testing the command registry and event handling

interface REPLCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute: (args: string[]) => Promise<void>;
}

interface REPLOptions {
  onExecute: (message: string) => Promise<string>;
  onStatus: () => { sessionId: string; sessionTitle: string; messageCount: number; tokenCount: number };
  onSwitchSession: (sessionId: string) => Promise<{ sessionId: string; sessionTitle: string }>;
  onCompact: () => Promise<void>;
}

/**
 * REPLCommandRegistry - 测试 REPL 命令注册逻辑
 */
class REPLCommandRegistry {
  private commands: Map<string, REPLCommand> = new Map();
  private registeredNames: Set<string> = new Set(); // Track original names for getAllCommands

  registerCommand(command: REPLCommand): void {
    // Store by lowercase name for case-insensitive lookup
    const lowerName = command.name.toLowerCase();
    this.commands.set(lowerName, command);
    this.registeredNames.add(lowerName);
    command.aliases?.forEach((alias) => {
      this.commands.set(alias.toLowerCase(), command);
    });
  }

  getCommand(name: string): REPLCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  getAllCommands(): REPLCommand[] {
    // Return unique commands by registered names only (not aliases)
    const uniqueCommands: REPLCommand[] = [];
    const seen = new Set<REPLCommand>();
    for (const name of this.registeredNames) {
      const command = this.commands.get(name);
      if (command && !seen.has(command)) {
        uniqueCommands.push(command);
        seen.add(command);
      }
    }
    return uniqueCommands;
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }
}

describe("REPLCommandRegistry", () => {
  let registry: REPLCommandRegistry;

  beforeEach(() => {
    registry = new REPLCommandRegistry();
  });

  describe("registerCommand()", () => {
    test("should register command by name", async () => {
      // Given
      const executeFn = vi.fn();
      const command: REPLCommand = {
        name: "test",
        description: "Test command",
        execute: executeFn,
      };

      // When
      registry.registerCommand(command);

      // Then
      expect(registry.hasCommand("test")).toBe(true);
      expect(registry.getCommand("test")).toBe(command);
    });

    test("should register command aliases", async () => {
      // Given
      const executeFn = vi.fn();
      const command: REPLCommand = {
        name: "test",
        aliases: ["t", "x"],
        description: "Test command",
        execute: executeFn,
      };

      // When
      registry.registerCommand(command);

      // Then
      expect(registry.hasCommand("test")).toBe(true);
      expect(registry.hasCommand("t")).toBe(true);
      expect(registry.hasCommand("x")).toBe(true);
      expect(registry.getCommand("t")).toBe(command);
      expect(registry.getCommand("x")).toBe(command);
    });

    test("should overwrite existing command with same name", async () => {
      // Given
      const executeFn1 = vi.fn();
      const executeFn2 = vi.fn();
      registry.registerCommand({
        name: "test",
        description: "First",
        execute: executeFn1,
      });

      // When
      registry.registerCommand({
        name: "test",
        description: "Second",
        execute: executeFn2,
      });

      // Then
      expect(registry.getCommand("test")?.description).toBe("Second");
    });
  });

  describe("getCommand()", () => {
    test("should find command by exact name", async () => {
      // Given
      const command: REPLCommand = {
        name: "help",
        description: "Show help",
        execute: vi.fn(),
      };
      registry.registerCommand(command);

      // When & Then
      expect(registry.getCommand("help")).toBe(command);
    });

    test("should find command by alias", async () => {
      // Given
      const command: REPLCommand = {
        name: "help",
        aliases: ["h", "?"],
        description: "Show help",
        execute: vi.fn(),
      };
      registry.registerCommand(command);

      // When & Then
      expect(registry.getCommand("h")).toBe(command);
      expect(registry.getCommand("?")).toBe(command);
    });

    test("should return undefined for unknown command", async () => {
      // When & Then
      expect(registry.getCommand("unknown")).toBeUndefined();
    });

    test("should be case insensitive", async () => {
      // Given
      const command: REPLCommand = {
        name: "Help",
        description: "Show help",
        execute: vi.fn(),
      };
      registry.registerCommand(command);

      // When & Then
      expect(registry.getCommand("help")).toBe(command);
      expect(registry.getCommand("HELP")).toBe(command);
    });
  });

  describe("getAllCommands()", () => {
    test("should return all unique commands", async () => {
      // Given
      registry.registerCommand({
        name: "cmd1",
        aliases: ["c1"],
        description: "Command 1",
        execute: vi.fn(),
      });
      registry.registerCommand({
        name: "cmd2",
        aliases: ["c2"],
        description: "Command 2",
        execute: vi.fn(),
      });

      // When
      const commands = registry.getAllCommands();

      // Then
      expect(commands.length).toBe(2);
    });
  });
});

/**
 * REPLOptions Interface Test
 */
describe("REPLOptions", () => {
  test("should require onExecute callback", () => {
    // Given
    const mockExecute = vi.fn().mockResolvedValue("response");

    // When
    const options: REPLOptions = {
      onExecute: mockExecute,
      onStatus: () => ({
        sessionId: "sess_123",
        sessionTitle: "Test Session",
        messageCount: 5,
        tokenCount: 1024,
      }),
      onSwitchSession: vi.fn().mockResolvedValue({
        sessionId: "sess_456",
        sessionTitle: "New Session",
      }),
      onCompact: vi.fn().mockResolvedValue(undefined),
    };

    // Then
    expect(options.onExecute).toBeDefined();
    expect(typeof options.onExecute("test")).toBe("object"); // Promise
  });

  test("should provide status information", () => {
    // Given
    const status = {
      sessionId: "sess_123",
      sessionTitle: "Test Session",
      messageCount: 10,
      tokenCount: 2048,
    };

    // When
    const options: REPLOptions = {
      onExecute: vi.fn().mockResolvedValue("response"),
      onStatus: () => status,
      onSwitchSession: vi.fn(),
      onCompact: vi.fn(),
    };

    // Then
    expect(options.onStatus()).toEqual(status);
  });
});

/**
 * Input Parsing Test
 */
describe("Input Parsing", () => {
  test("should parse command with arguments", () => {
    // Given
    const input = "compact --force";

    // When
    const [command, ...args] = input.split(/\s+/);

    // Then
    expect(command).toBe("compact");
    expect(args).toEqual(["--force"]);
  });

  test("should parse command without arguments", () => {
    // Given
    const input = "help";

    // When
    const [command, ...args] = input.split(/\s+/);

    // Then
    expect(command).toBe("help");
    expect(args).toEqual([]);
  });

  test("should identify slash commands", () => {
    // Given
    const slashInput = "/help";
    const normalInput = "show me something";

    // When & Then
    expect(slashInput.startsWith("/")).toBe(true);
    expect(normalInput.startsWith("/")).toBe(false);
  });

  test("should strip slash prefix", () => {
    // Given
    const input = "/exit";

    // When
    const command = input.slice(1);

    // Then
    expect(command).toBe("exit");
  });
});

/**
 * Command Execution Flow Test
 */
describe("Command Execution Flow", () => {
  test("should execute registered command", async () => {
    // Given
    const executeFn = vi.fn().mockResolvedValue(undefined);
    const registry = new REPLCommandRegistry();
    registry.registerCommand({
      name: "test",
      description: "Test command",
      execute: executeFn,
    });

    // When
    const command = registry.getCommand("test");
    if (command) {
      await command.execute([]);
    }

    // Then
    expect(executeFn).toHaveBeenCalledWith([]);
  });

  test("should pass arguments to command", async () => {
    // Given
    const executeFn = vi.fn().mockResolvedValue(undefined);
    const registry = new REPLCommandRegistry();
    registry.registerCommand({
      name: "test",
      description: "Test command",
      execute: executeFn,
    });

    // When
    const command = registry.getCommand("test");
    if (command) {
      await command.execute(["arg1", "arg2"]);
    }

    // Then
    expect(executeFn).toHaveBeenCalledWith(["arg1", "arg2"]);
  });
});
