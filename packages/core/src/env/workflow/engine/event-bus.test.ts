import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from './event-bus';
import type { WorkflowEvent } from '../types/event';

// Helper to create test events
function createTestEvent(type: WorkflowEvent['type'], runId = 'run_123') {
  return {
    type,
    run_id: runId,
    timestamp: Date.now(),
  } as WorkflowEvent;
}

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('on() - Subscribe to specific event type', () => {
    it('should subscribe to a specific event type and receive events', async () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.on('workflow.started', handler);

      const event = createTestEvent('workflow.started');
      await eventBus.publish(event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
      unsubscribe();
    });

    it('should support multiple handlers for the same event type', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('workflow.started', handler1);
      eventBus.on('workflow.started', handler2);

      const event = createTestEvent('workflow.started');
      await eventBus.publish(event);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not receive events after unsubscribe', async () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.on('workflow.started', handler);

      const event1 = createTestEvent('workflow.started');
      await eventBus.publish(event1);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      const event2 = createTestEvent('workflow.started');
      await eventBus.publish(event2);
      expect(handler).toHaveBeenCalledTimes(1); // Should not increase
    });

    it('should return unsubscribe function from on()', () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.on('workflow.started', handler);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('once() - Subscribe once (auto-unsubscribe)', () => {
    it('should only call handler once and then auto-unsubscribe', async () => {
      const handler = vi.fn();
      eventBus.once('workflow.started', handler);

      const event1 = createTestEvent('workflow.started');
      const event2 = createTestEvent('workflow.started');

      await eventBus.publish(event1);
      await eventBus.publish(event2);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event1);
    });

    it('should return unsubscribe function from once()', () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.once('workflow.started', handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should handle multiple once() subscriptions independently', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.once('workflow.started', handler1);
      eventBus.once('workflow.started', handler2);

      await eventBus.publish(createTestEvent('workflow.started'));
      await eventBus.publish(createTestEvent('workflow.started'));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('off() - Unsubscribe', () => {
    it('should remove handler when off() is called', async () => {
      const handler = vi.fn();
      eventBus.on('workflow.started', handler);
      eventBus.off('workflow.started', handler);

      await eventBus.publish(createTestEvent('workflow.started'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should only remove the specified handler', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('workflow.started', handler1);
      eventBus.on('workflow.started', handler2);
      eventBus.off('workflow.started', handler1);

      await eventBus.publish(createTestEvent('workflow.started'));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should handle off() for non-existent handler gracefully', () => {
      const handler = vi.fn();
      // Should not throw
      expect(() => eventBus.off('workflow.started', handler)).not.toThrow();
    });
  });

  describe('onAny() - Wildcard subscriptions', () => {
    it('should receive all events when using onAny()', async () => {
      const handler = vi.fn();

      eventBus.onAny(handler);

      await eventBus.publish(createTestEvent('workflow.started'));
      await eventBus.publish(createTestEvent('workflow.completed'));
      await eventBus.publish(createTestEvent('node.started'));

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should return unsubscribe function from onAny()', () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.onAny(handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should not receive events after unsubscribe', async () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.onAny(handler);

      await eventBus.publish(createTestEvent('workflow.started'));
      unsubscribe();
      await eventBus.publish(createTestEvent('workflow.completed'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should work together with specific event subscriptions', async () => {
      const anyHandler = vi.fn();
      const specificHandler = vi.fn();

      eventBus.onAny(anyHandler);
      eventBus.on('workflow.started', specificHandler);

      await eventBus.publish(createTestEvent('workflow.started'));
      await eventBus.publish(createTestEvent('workflow.completed'));

      expect(anyHandler).toHaveBeenCalledTimes(2);
      expect(specificHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('publish() - Publish events to subscribers', () => {
    it('should publish event to all matching subscribers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('workflow.started', handler1);
      eventBus.on('workflow.started', handler2);

      const event = createTestEvent('workflow.started');
      await eventBus.publish(event);

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
    });

    it('should handle async handlers', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      eventBus.on('workflow.started', handler);

      await eventBus.publish(createTestEvent('workflow.started'));

      expect(handler).toHaveBeenCalled();
    });

    it('should not block publish when handlers are async', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      eventBus.on('workflow.started', handler);

      const start = Date.now();
      await eventBus.publish(createTestEvent('workflow.started'));
      const duration = Date.now() - start;

      // publish should not wait for handler to complete
      expect(duration).toBeLessThan(40);
    });
  });

  describe('Error handling in handlers', () => {
    it('should not crash the bus when a handler throws', async () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();

      eventBus.on('workflow.started', errorHandler);
      eventBus.on('workflow.started', normalHandler);

      // Should not throw - the publish method should catch errors internally
      let threw = false;
      try {
        await eventBus.publish(createTestEvent('workflow.started'));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(normalHandler).toHaveBeenCalled();
    });

    it('should not crash the bus when a handler rejects', async () => {
      const errorHandler = vi.fn().mockImplementation(async () => {
        throw new Error('Async handler error');
      });
      const normalHandler = vi.fn();

      eventBus.on('workflow.started', errorHandler);
      eventBus.on('workflow.started', normalHandler);

      // Should not throw - the publish method should catch errors internally
      let threw = false;
      try {
        await eventBus.publish(createTestEvent('workflow.started'));
        // Wait a bit for async handlers to potentially throw
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(normalHandler).toHaveBeenCalled();
    });

    it('should continue to other handlers after one fails', async () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();

      eventBus.on('workflow.started', errorHandler);
      eventBus.on('workflow.started', normalHandler);

      await eventBus.publish(createTestEvent('workflow.started'));

      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  describe('clear() - Clear all subscriptions', () => {
    it('should remove all handlers when clear() is called', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const wildcardHandler = vi.fn();

      eventBus.on('workflow.started', handler1);
      eventBus.on('workflow.completed', handler2);
      eventBus.onAny(wildcardHandler);

      eventBus.clear();

      await eventBus.publish(createTestEvent('workflow.started'));
      await eventBus.publish(createTestEvent('workflow.completed'));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(wildcardHandler).not.toHaveBeenCalled();
    });

    it('should allow new subscriptions after clear()', async () => {
      const oldHandler = vi.fn();
      const newHandler = vi.fn();

      eventBus.on('workflow.started', oldHandler);
      eventBus.clear();
      eventBus.on('workflow.started', newHandler);

      await eventBus.publish(createTestEvent('workflow.started'));

      expect(oldHandler).not.toHaveBeenCalled();
      expect(newHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats() - Get statistics', () => {
    it('should return correct stats after subscriptions', () => {
      eventBus.on('workflow.started', vi.fn());
      eventBus.on('workflow.started', vi.fn());
      eventBus.on('workflow.completed', vi.fn());
      eventBus.onAny(vi.fn());

      const stats = eventBus.getStats();

      expect(stats.eventTypes).toBe(2); // workflow.started and workflow.completed
      expect(stats.wildcardHandlers).toBe(1);
      expect(stats.totalHandlers).toBe(4); // 3 specific + 1 wildcard
    });

    it('should return zero stats for new EventBus', () => {
      const stats = eventBus.getStats();

      expect(stats.eventTypes).toBe(0);
      expect(stats.wildcardHandlers).toBe(0);
      expect(stats.totalHandlers).toBe(0);
    });

    it('should update stats after clearing', () => {
      eventBus.on('workflow.started', vi.fn());
      eventBus.onAny(vi.fn());

      eventBus.clear();

      const stats = eventBus.getStats();

      expect(stats.eventTypes).toBe(0);
      expect(stats.wildcardHandlers).toBe(0);
      expect(stats.totalHandlers).toBe(0);
    });
  });
});
