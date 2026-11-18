/**
 * @fileoverview Session Hooks
 */

import type { Hook } from "../component";
import type { SessionHookType as SHT, SessionHookContext as SHC } from "./types";

// Re-export types from types.ts to avoid duplication
export type SessionHookType = SHT;
export type SessionHookContext = SHC;

/**
 * Session hook registration
 */
export interface SessionHookRegistration {
  type: SessionHookType;
  hook: Hook;
}
