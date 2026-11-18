import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types";

/**
 * Echo tool - simple echo command
 *
 * This is a convenience tool for logging messages in workflows.
 */
export const echoTool: Tool = {
  name: "echo",
  description: "Echo a message to the console. Useful for logging in workflows.",
  parameters: z.object({
    message: z.string().optional().describe("The message to echo"),
  }),
  execute: async (args: { message?: string }, _ctx: ToolContext): Promise<ToolResult> => {
    const message = args?.message || "(no message)";

    return {
      success: true,
      output: message,
      metadata: {
        execution_time_ms: 0,
      },
    };
  },
};
