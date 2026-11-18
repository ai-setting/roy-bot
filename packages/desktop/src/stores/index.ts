/**
 * @fileoverview Stores Index
 * 
 * Central export point for all Zustand stores in the desktop application.
 */

// UI Store (existing)
export { useUIStore, uiStore, type UIStore, type MenuType } from './uiStore';

// Event Store (new)
export { useEventStore, eventStore, type EventStore, type DesktopEvent } from './eventStore';

// Task Store (new)
export { useTaskStore, taskStore, type TaskStore } from './taskStore';

// Session Store (new)
export { useSessionStore, sessionStore, type SessionStore } from './sessionStore';
