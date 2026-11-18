/**
 * @fileoverview Task Hooks Module
 * 
 * 提供 Task Component 的 Hook 机制
 */

// Hook 点常量
export { TaskHookPoints, type TaskHookPoint } from "./task-hook-points";

// Context 类型
export type {
  TaskCreateContext,
  TaskCreateResultContext,
  TaskUpdateContext,
  TaskUpdateResultContext,
  TaskDeleteContext,
  TaskDeleteResultContext,
  TaskDelegateContext,
  TaskDelegateResultContext,
  TaskOperationCreateContext,
  TaskOperationCreateResultContext,
  TaskHookContextMap,
} from "./contexts";
