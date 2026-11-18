/**
 * @fileoverview Event Store - Zustand store for desktop events
 * 
 * Manages a list of workflow events with a maximum limit.
 * Subscribes to the EventBus for real-time event updates.
 */

import { create } from 'zustand';
import { eventBus } from '../core/EventBusAdapter';

// ============================================================================
// Types
// ============================================================================

/**
 * Desktop event type - represents a workflow event in the desktop UI
 */
export interface DesktopEvent {
  /** Event type identifier */
  type: string;
  /** Event data payload */
  data?: unknown;
  /** Event timestamp */
  timestamp: number;
}

/**
 * Event state interface
 */
interface EventState {
  /** List of events */
  events: DesktopEvent[];
  /** Maximum number of events to store */
  MAX_EVENTS: number;
  /** Whether subscribed to event bus */
  isSubscribed: boolean;
}

/**
 * Event actions interface
 */
interface EventActions {
  /** Add an event to the store */
  addEvent: (event: DesktopEvent) => void;
  /** Remove an event by index */
  removeEvent: (index: number) => void;
  /** Clear all events */
  clearEvents: () => void;
  /** Subscribe to event bus */
  subscribe: () => () => void;
  /** Unsubscribe from event bus */
  unsubscribe: () => void;
}

/**
 * Combined event store type
 */
export type EventStore = EventState & EventActions;

// Type for the event handler
type EventHandler = (event: DesktopEvent) => void | Promise<void>;

// ============================================================================
// Store Implementation
// ============================================================================

/**
 * Create the event store
 */
const store = create<EventStore>((set, get) => {
  // Track the unsubscribe function
  let unsubscribeFn: (() => void) | null = null;

  // Track processed events to prevent duplicate additions
  // Events can arrive via both direct addEvent() and eventBus.onAny() subscription
  const processedEvents = new Set<string>();

  // Handler for event bus events
  const handleEvent: EventHandler = (event: DesktopEvent) => {
    // Deduplicate: create a unique key based on timestamp and type
    const eventKey = `${event.timestamp}-${event.type}`;
    if (processedEvents.has(eventKey)) {
      return; // Already processed this event
    }
    processedEvents.add(eventKey);

    // Keep the set from growing too large (max 10000 entries)
    if (processedEvents.size > 10000) {
      // Remove oldest entries (first 1000)
      const entries = Array.from(processedEvents);
      processedEvents.clear();
      entries.slice(1000).forEach(e => processedEvents.add(e));
    }

    get().addEvent(event);
  };

  return {
    // Initial state
    events: [],
    MAX_EVENTS: 1000,
    isSubscribed: false,

    // Actions
    /**
     * Add an event to the store.
     * If the event limit is reached, removes the oldest event.
     */
    addEvent: (event: DesktopEvent) => {
      set((state) => {
        const newEvents = [...state.events, event];
        
        // Enforce max events limit by removing oldest
        if (newEvents.length > state.MAX_EVENTS) {
          return { events: newEvents.slice(-state.MAX_EVENTS) };
        }
        
        return { events: newEvents };
      });
    },

    /**
     * Remove an event by index.
     * Does nothing if index is out of bounds.
     */
    removeEvent: (index: number) => {
      set((state) => {
        if (index < 0 || index >= state.events.length) {
          return state;
        }
        return { events: state.events.filter((_, i) => i !== index) };
      });
    },

    /**
     * Clear all events from the store.
     */
    clearEvents: () => {
      set({ events: [] });
    },

    /**
     * Subscribe to the event bus to receive events.
     * @returns Unsubscribe function
     */
    subscribe: () => {
      // If already subscribed, return existing unsubscribe
      if (unsubscribeFn) {
        return unsubscribeFn;
      }

      // Subscribe to all events (wildcard)
      unsubscribeFn = eventBus.onAny(handleEvent as any);
      
      set({ isSubscribed: true });

      return () => {
        if (unsubscribeFn) {
          unsubscribeFn();
          unsubscribeFn = null;
          set({ isSubscribed: false });
        }
      };
    },

    /**
     * Unsubscribe from the event bus.
     */
    unsubscribe: () => {
      if (unsubscribeFn) {
        unsubscribeFn();
        unsubscribeFn = null;
        set({ isSubscribed: false });
      }
    },
  };
});

// Export as hook for React components
export const useEventStore = store;

// Also export as plain store for non-React usage
export const eventStore = store;
