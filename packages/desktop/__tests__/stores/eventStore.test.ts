/**
 * @fileoverview Tests for Event Store
 * 
 * Tests event state management using Zustand store
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to hoist the mock along with vi.mock
const { mockEventBus } = vi.hoisted(() => {
  const handlers = new Map<string, Set<Function>>();
  const wildcardHandlers = new Set<Function>();
  
  const mockBus = {
    on: vi.fn((_eventType: string, handler: Function) => {
      let eventHandlers = handlers.get(_eventType);
      if (!eventHandlers) {
        eventHandlers = new Set();
        handlers.set(_eventType, eventHandlers);
      }
      eventHandlers.add(handler);
      return () => {
        eventHandlers?.delete(handler);
      };
    }),
    onAny: vi.fn((handler: Function) => {
      wildcardHandlers.add(handler);
      return () => wildcardHandlers.delete(handler);
    }),
    publish: vi.fn(async (event: any) => {
      handlers.get(event.type)?.forEach((h) => h(event));
      wildcardHandlers.forEach((h) => h(event));
    }),
    clear: vi.fn(() => {
      handlers.clear();
      wildcardHandlers.clear();
    }),
    getStats: vi.fn(() => ({
      eventTypes: handlers.size,
      wildcardHandlers: wildcardHandlers.size,
      totalHandlers: handlers.size + wildcardHandlers.size,
    })),
  };
  
  return { mockEventBus: mockBus };
});

// Mock the EventBusAdapter
vi.mock('../../src/core/EventBusAdapter', () => ({
  eventBus: mockEventBus,
  EventBusAdapter: {
    getInstance: vi.fn(() => mockEventBus),
  },
}));

// Import after mock
import { eventStore } from '../../src/stores/eventStore';

describe('EventStore', () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Reset store state
    eventStore.setState({
      events: [],
      isSubscribed: false,
    });
  });

  describe('initial state', () => {
    it('should have empty events array', () => {
      const { events } = eventStore.getState();
      expect(events).toEqual([]);
    });

    it('should have MAX_EVENTS limit', () => {
      const { MAX_EVENTS } = eventStore.getState();
      expect(MAX_EVENTS).toBe(1000);
    });

    it('should not be subscribed initially', () => {
      const { isSubscribed } = eventStore.getState();
      expect(isSubscribed).toBe(false);
    });
  });

  describe('addEvent', () => {
    it('should add an event to the store', () => {
      const event = {
        type: 'task.created',
        data: { taskId: 1 },
        timestamp: Date.now(),
      };

      eventStore.getState().addEvent(event);

      const { events } = eventStore.getState();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it('should add multiple events', () => {
      const testEvents = [
        { type: 'task.created', data: { taskId: 1 }, timestamp: Date.now() },
        { type: 'task.updated', data: { taskId: 1 }, timestamp: Date.now() + 1 },
      ];

      testEvents.forEach((e) => eventStore.getState().addEvent(e));

      const { events: storedEvents } = eventStore.getState();
      expect(storedEvents).toHaveLength(2);
    });

    it('should respect MAX_EVENTS limit', () => {
      const { MAX_EVENTS } = eventStore.getState();
      
      // Add more events than the limit
      for (let i = 0; i < MAX_EVENTS + 10; i++) {
        eventStore.getState().addEvent({
          type: 'test.event',
          data: { index: i },
          timestamp: Date.now() + i,
        });
      }

      const { events } = eventStore.getState();
      expect(events).toHaveLength(MAX_EVENTS);
    });

    it('should remove oldest events when exceeding limit', () => {
      const { MAX_EVENTS } = eventStore.getState();
      
      // Add events that will exceed the limit
      for (let i = 0; i < MAX_EVENTS + 5; i++) {
        eventStore.getState().addEvent({
          type: 'test.event',
          data: { index: i },
          timestamp: i,
        });
      }

      const { events } = eventStore.getState();
      // First events should have been removed
      expect((events[0] as any).data.index).toBe(5);
      // Last events should be the most recent
      expect((events[events.length - 1] as any).data.index).toBe(MAX_EVENTS + 4);
    });
  });

  describe('removeEvent', () => {
    it('should remove an event by index', () => {
      eventStore.getState().addEvent({ type: 'task.created', data: { taskId: 1 }, timestamp: Date.now() });
      eventStore.getState().addEvent({ type: 'task.updated', data: { taskId: 1 }, timestamp: Date.now() });

      eventStore.getState().removeEvent(0);

      const { events } = eventStore.getState();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.updated');
    });

    it('should not throw when removing out-of-bounds index', () => {
      expect(() => eventStore.getState().removeEvent(100)).not.toThrow();
    });
  });

  describe('clearEvents', () => {
    it('should clear all events', () => {
      eventStore.getState().addEvent({ type: 'test', data: null, timestamp: Date.now() });
      eventStore.getState().addEvent({ type: 'test2', data: null, timestamp: Date.now() });

      eventStore.getState().clearEvents();

      const { events } = eventStore.getState();
      expect(events).toHaveLength(0);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to event bus', () => {
      const unsubscribe = eventStore.getState().subscribe();
      
      // Verify onAny was called
      expect(mockEventBus.onAny).toHaveBeenCalled();
      
      // Verify isSubscribed is true
      const { isSubscribed } = eventStore.getState();
      expect(isSubscribed).toBe(true);
      
      // Cleanup
      unsubscribe();
    });

    it('should return unsubscribe function', () => {
      const unsubscribe = eventStore.getState().subscribe();
      expect(typeof unsubscribe).toBe('function');
      
      // Call unsubscribe
      unsubscribe();
      
      // Verify isSubscribed is false
      const { isSubscribed } = eventStore.getState();
      expect(isSubscribed).toBe(false);
    });

    it('should receive events when subscribed', async () => {
      const unsubscribe = eventStore.getState().subscribe();
      
      // Simulate an event being published
      const event = { type: 'task.created', data: { id: 1 }, timestamp: Date.now() };
      await mockEventBus.publish(event);
      
      // The store should have received the event
      const { events } = eventStore.getState();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('task.created');
      
      // Cleanup
      unsubscribe();
    });

    it('should not duplicate handlers on multiple subscribe calls', () => {
      const unsub1 = eventStore.getState().subscribe();
      eventStore.getState().subscribe(); // Second call should return same unsubscribe
      
      // onAny should only be called once (second call returns existing unsubscribe)
      expect(mockEventBus.onAny).toHaveBeenCalledTimes(1);
      
      // Cleanup
      unsub1();
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe from event bus', () => {
      eventStore.getState().subscribe();
      eventStore.getState().unsubscribe();
      
      const { isSubscribed } = eventStore.getState();
      expect(isSubscribed).toBe(false);
    });
  });

  describe('store API', () => {
    it('should expose state and actions', () => {
      const state = eventStore.getState();
      
      // State properties
      expect(state).toHaveProperty('events');
      expect(state).toHaveProperty('MAX_EVENTS');
      expect(state).toHaveProperty('isSubscribed');
      
      // Actions
      expect(state).toHaveProperty('addEvent');
      expect(state).toHaveProperty('removeEvent');
      expect(state).toHaveProperty('clearEvents');
      expect(state).toHaveProperty('subscribe');
      expect(state).toHaveProperty('unsubscribe');
      
      // Verify they are functions
      expect(typeof state.addEvent).toBe('function');
      expect(typeof state.removeEvent).toBe('function');
      expect(typeof state.clearEvents).toBe('function');
      expect(typeof state.subscribe).toBe('function');
      expect(typeof state.unsubscribe).toBe('function');
    });
  });
});
