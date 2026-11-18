/**
 * @fileoverview TaskReuseRegistry — process-global singleton + lazy hook install.
 *
 * Provides one TaskCreationRegistry per process. Lazily installs the
 * registry hook on the first call to `getOrCreateTaskReuseRegistry(env)`
 * so callers don't have to wire it manually.
 *
 * The registry is keyed by env instance so two TaskComponents in the same
 * process (rare, but possible in tests) each get their own registry.
 */

import type { Environment } from "../interface";
import { TaskCreationRegistry } from "./task-creation-registry";
import {
  installTaskCreationRegistryHooks,
  type InstallHandle,
} from "./registry-hook-installer";
import { createLogger } from "../log-trace/logger";

const logger = createLogger("task-reuse-registry");

/** Default config for the process singleton. */
const DEFAULT_CONFIG = {
  maxEntries: 500,
  ttlMs: 24 * 60 * 60 * 1000,
  maxDescriptionChars: 240,
};

// WeakMap so registries can be GC'd along with the Environment.
const registries = new WeakMap<Environment, TaskReuseRegistryEntry>();

export interface TaskReuseRegistryEntry {
  registry: TaskCreationRegistry;
  installHandle: InstallHandle;
}

/**
 * Get (and lazily create) the process-global TaskCreationRegistry for the
 * given environment. On first access, installs the registry hook.
 *
 * If the environment doesn't expose a TaskComponent, returns a stub
 * registry that is never updated — callers can still query it but it
 * will always be empty.
 */
export function getOrCreateTaskReuseRegistry(env: Environment): TaskCreationRegistry {
  const existing = registries.get(env);
  if (existing) return existing.registry;

  const registry = new TaskCreationRegistry(DEFAULT_CONFIG);

  let installHandle: InstallHandle = { uninstall: () => {} };
  try {
    const taskComponent = env.getComponent?.("task") as
      | {
          registerHook?: (point: string, hook: unknown) => void;
          unregisterHook?: (point: string, name: string) => boolean;
        }
      | undefined;

    if (taskComponent?.registerHook) {
      // Best-effort install. If it fails (e.g. test mock), fall back to
      // an empty registry — the prompt builder will just produce an
      // empty section, which is safe.
      installHandle = installTaskCreationRegistryHooks(
        taskComponent as any,
        registry,
        {
          sessionIdProvider: () => {
            try {
              return (env as any).currentSessionId ?? undefined;
            } catch {
              return undefined;
            }
          },
          staticSource: {
            // Use a recognizable processId to allow cross-process debugging
            // via the prompt "Created by" line.
            processId: typeof process !== "undefined" ? process.pid : undefined,
          },
        }
      );
      logger.debug("[task-reuse-registry] hook installed");
    } else {
      logger.debug(
        "[task-reuse-registry] no TaskComponent in env; registry stays empty"
      );
    }
  } catch (err) {
    logger.warn(
      `[task-reuse-registry] hook install failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const entry: TaskReuseRegistryEntry = { registry, installHandle };
  registries.set(env, entry);
  return registry;
}

/**
 * Uninstall and discard the registry for an environment. Mainly for tests
 * to ensure clean state between runs.
 */
export function disposeTaskReuseRegistry(env: Environment): void {
  const entry = registries.get(env);
  if (!entry) return;
  try {
    entry.installHandle.uninstall();
  } catch {
    // ignore
  }
  registries.delete(env);
}