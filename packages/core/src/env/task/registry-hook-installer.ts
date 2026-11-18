/**
 * @fileoverview Registry Hook Installer — wires TaskCreationRegistry to the
 * TaskComponent hook system so create/update/complete/delete events feed
 * the registry automatically.
 *
 * Use this when you want sub-agent delegate prompts to surface recent
 * task candidates. See docs/design/task-reuse-context.md for the full
 * design rationale.
 *
 * The installer returns a handle with `uninstall()` for clean teardown
 * (tests + plugin shutdown).
 */

import type { TaskComponent } from "./task-component";
import { TaskHookPoints } from "./hooks/task-hook-points";
import type { TaskCreationRegistry, TaskRecordSource } from "./task-creation-registry";
import type { Task } from "./types";
import type { Hook } from "../hook/types";
import { createLogger } from "../log-trace/logger";

const logger = createLogger("registry-hook-installer");

export interface InstallOptions {
  /**
   * Returns the sessionId to record as source.sessionId. If omitted, the
   * registry record's source.sessionId will be undefined.
   *
   * Why an explicit provider? Hook contexts don't always carry a sessionId
   * (e.g. AFTER_UPDATE may run from background code paths). The provider
   * lets the caller inject the correct value from the call site where it's
   * known (e.g. delegate-tool's executeWithAbort).
   */
  sessionIdProvider?: () => string | undefined;
  /** Default: "registry-hook-installer" */
  hookName?: string;
  /** Default: 100 (medium priority — runs after notifications) */
  priority?: number;
  /** Optional metadata to attach (e.g. { subagentType: "roy" }) */
  staticSource?: Omit<TaskRecordSource, "sessionId">;
}

export interface InstallHandle {
  uninstall(): void;
}

/**
 * Subscribe a TaskCreationRegistry to a TaskComponent's lifecycle hooks.
 *
 * The registry is observation-only; this installer never mutates tasks.
 * Errors thrown by registry calls are caught and logged so they can never
 * break the host task lifecycle.
 */
export function installTaskCreationRegistryHooks(
  taskComponent: TaskComponent,
  registry: TaskCreationRegistry,
  options: InstallOptions = {}
): InstallHandle {
  // Per-installation unique suffix to avoid global hook name collisions when
  // multiple TaskComponents share the same globalHookManager (which is the
  // default in tests and PluginComponent environments).
  const uniqueSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const hookName = options.hookName
    ? `${options.hookName}:${uniqueSuffix}`
    : `registry-hook-installer:${uniqueSuffix}`;
  const priority = options.priority ?? 100;
  let uninstalled = false;

  const safeRecord = (task: Task, source: TaskRecordSource): void => {
    try {
      registry.record(task, source);
    } catch (err) {
      logger.warn(
        `[registry-hook-installer] record failed for task #${task.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const safeUpdate = (task: Task, source?: TaskRecordSource): void => {
    try {
      registry.update(task, source);
    } catch (err) {
      logger.warn(
        `[registry-hook-installer] update failed for task #${task.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const safeRemove = (id: number): void => {
    try {
      registry.remove(id);
    } catch (err) {
      logger.warn(
        `[registry-hook-installer] remove failed for task #${id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const buildSource = (): TaskRecordSource => ({
    sessionId: options.sessionIdProvider?.(),
    ...(options.staticSource ?? {}),
  });

  // AFTER_CREATE: registry gets the freshly-created task
  const afterCreate: Hook = {
    name: `${hookName}:after-create`,
    priority,
    execute: async (ctx) => {
      const data = ctx.data as { task?: Task } | undefined;
      if (data?.task) safeRecord(data.task, buildSource());
    },
  };

  // AFTER_UPDATE: registry updates the existing record (or records if new)
  const afterUpdate: Hook = {
    name: `${hookName}:after-update`,
    priority,
    execute: async (ctx) => {
      const data = ctx.data as { task?: Task } | undefined;
      if (!data?.task) return;
      const exists = registry.peekById(data.task.id);
      if (exists) {
        safeUpdate(data.task, buildSource());
      } else {
        safeRecord(data.task, buildSource());
      }
    },
  };

  // AFTER_COMPLETE: registry reflects the terminal status
  const afterComplete: Hook = {
    name: `${hookName}:after-complete`,
    priority,
    execute: async (ctx) => {
      const data = ctx.data as { task?: Task } | undefined;
      if (data?.task) safeUpdate(data.task, buildSource());
    },
  };

  // AFTER_DELETE: registry drops the record
  const afterDelete: Hook = {
    name: `${hookName}:after-delete`,
    priority,
    execute: async (ctx) => {
      const data = ctx.data as { id?: number } | undefined;
      if (typeof data?.id === "number") safeRemove(data.id);
    },
  };

  // Register all hooks
  taskComponent.registerHook(TaskHookPoints.AFTER_CREATE, afterCreate);
  taskComponent.registerHook(TaskHookPoints.AFTER_UPDATE, afterUpdate);
  taskComponent.registerHook(TaskHookPoints.AFTER_COMPLETE, afterComplete);
  taskComponent.registerHook(TaskHookPoints.AFTER_DELETE, afterDelete);

  return {
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      taskComponent.unregisterHook(TaskHookPoints.AFTER_CREATE, afterCreate.name);
      taskComponent.unregisterHook(TaskHookPoints.AFTER_UPDATE, afterUpdate.name);
      taskComponent.unregisterHook(TaskHookPoints.AFTER_COMPLETE, afterComplete.name);
      taskComponent.unregisterHook(TaskHookPoints.AFTER_DELETE, afterDelete.name);
      logger.debug(`[registry-hook-installer] uninstalled hooks (name=${hookName})`);
    },
  };
}