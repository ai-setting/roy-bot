/**
 * @fileoverview Session Component Index
 * 
 * Session management component for Environment
 */

// Component
export { SessionComponent } from "./session-component";

// Message Converter
export { SessionMessageConverter } from "./session-message-converter";

// Types
export type { 
  Session,
  SessionMessage,
  SessionConfig,
  SessionCheckpoint,              // (new)
  SessionCheckpointsMeta,         // (new)
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  AddMessageOptions,
  CompactOptions,                // (new)
  CompactResult,                // (new)
  CompactPreview,              // (new)
  CheckpointAdaptReport,       // Task #4933
  GetContextOptions,          // (new)
  GetContextResult,           // (new)
  GetMessagesOptions,        // (new)
} from "./types";

// Store
export type { SessionStore } from "./session-store";
export { MemorySessionStore } from "./storage/memory";

// Hooks (includes SessionHookType and SessionHookContext)
export * from "./hooks";

// Session-id validation helper (Issue #8)
export {
  isValidSessionId,
  MIN_SESSION_ID_LENGTH,
  MAX_SESSION_ID_LENGTH,
} from "./session-id";
