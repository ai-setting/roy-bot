import type { Tool } from "../types";
import { bashTool } from "./bash";
import { echoTool } from "./echo";
import { globTool } from "./glob";
import { readFileTool } from "./read-file";
import { writeFileTool } from "./write-file";
import { editFileTool } from "./edit-file";
import { grepTool } from "./grep";
import { understandImageTool } from "./understand-image";
import { wecomRespondTool } from "../../event-source/wecom-respond-registry";
import { createQueryBackgroundProcessTool } from "./query-background-process-tool";
import {
  createCompactSessionTool,
  compactSessionTool,
} from "./compact-session-tool";

// 重新导出所有内置工具
export { bashTool };
export { echoTool };
export { globTool };
export { readFileTool };
export { writeFileTool };
export { editFileTool };
export { grepTool };
export { understandImageTool };
// ★ Task #5174：企微 WS 回复工具（wecom_respond）
export { wecomRespondTool };

// 重新导出 query_background_process 工厂（替代旧的 named export）
// - 2026-07-15 重构：queryBackgroundProcessTool 不再以 named export 提供，
//   因为它是 "no-manager" 默认版本，调用 execute() 会失败。
//   实际使用请调 `createQueryBackgroundProcessTool(manager)` 工厂。
//   保留 queryBackgroundProcessTool 作为"无 manager 默认实例"以兼容旧测试代码。
import { queryBackgroundProcessTool } from "./query-background-process-tool";
export { queryBackgroundProcessTool, createQueryBackgroundProcessTool };

// Task #4982 — compact_session（default agent 专用 sub-session 压缩）
export { compactSessionTool, createCompactSessionTool };

// 重新导出 understand_image 的 LLM provider 注入函数，
// 方便 AgentComponent 在 LLMComponent 就绪时注册。
export {
  setUnderstandImageLLMProvider,
  getUnderstandImageLLMProvider,
  resetUnderstandImageLLMProvider,
  type UnderstandImageLLMProvider,
} from "./understand-image";

/**
 * 获取所有内置工具
 *
 * Note:
 * - run-workflow tool is not included here because it requires
 *   a WorkflowService instance which needs to be initialized at runtime.
 *   Use initRunWorkflowTool(workflowService) to initialize it.
 * - query_background_process is registered but visible ONLY to the
 *   "default" agent (via metadata.allowedAgentTypes=["default"]).
 *   Other agents (roy / strict-task-agent / explore / etc.) won't see it.
 *   实际使用时 TaskComponent.start() 会用 createQueryBackgroundProcessTool(manager)
 *   重新注册一个 manager-bound 实例，覆盖此 no-manager 默认版本。
 */
export function getAllBuiltInTools(): Tool[] {
  return [
    bashTool,
    echoTool,
    globTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    grepTool,
    understandImageTool,
    // ★ Task #5174：企微 WS 回复（aibot_respond_msg 回帧出站通道）
    wecomRespondTool,
    // 默认版本：manager=null，执行时会返回 "not initialized"
    // 真实使用由 TaskComponent 重新注册
    queryBackgroundProcessTool,
    // Task #4982 — 默认版本：deps=null，执行时会返回 "not initialized"
    // 真实使用由 TaskComponent 用 createCompactSessionTool(manager, sessionComp) 重新注册
    compactSessionTool,
  ];
}

/**
 * 获取指定内置工具
 */
export function getBuiltInTool(name: string): Tool | undefined {
  const tools = getAllBuiltInTools();
  return tools.find((t) => t.name === name);
}
