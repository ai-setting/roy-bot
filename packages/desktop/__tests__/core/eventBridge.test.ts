/**
 * @fileoverview Tests for EventBridge
 * 
 * Tests the event bridging from Environment to EventBusAdapter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types for testing
interface EnvEvent {
  id: string;
  type: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
}

interface DesktopEvent {
  type: string;
  data?: unknown;
  timestamp: number;
}

// Mock Environment
function createMockEnvironment() {
  const handlers = new Set<(event: EnvEvent) => void>();
  
  return {
    subscribe: vi.fn((handler: (event: EnvEvent) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    publish: (event: EnvEvent) => {
      handlers.forEach(h => h(event));
    },
    _getHandlerCount: () => handlers.size,
  };
}

// Mock EventBus
function createMockEventBus() {
  const publishedEvents: DesktopEvent[] = [];
  
  return {
    on: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
    publish: vi.fn(async (event: DesktopEvent) => {
      publishedEvents.push(event);
    }),
    clear: vi.fn(),
    getStats: vi.fn(() => ({ eventTypes: 0, wildcardHandlers: 0, totalHandlers: 0 })),
    _getPublishedEvents: () => publishedEvents,
    _clearPublishedEvents: () => publishedEvents.length = 0,
  };
}

// Import EventBridge after mocks
import { EventBridge } from '../../src/core/EventBridge';

describe('EventBridge', () => {
  let mockEnv: ReturnType<typeof createMockEnvironment>;
  let mockBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    mockEnv = createMockEnvironment();
    mockBus = createMockEventBus();
  });

  describe('start()', () => {
    it('should subscribe to environment events on start', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      
      expect(mockEnv.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should not subscribe multiple times if already started', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      bridge.start();
      
      expect(mockEnv.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('event forwarding', () => {
    it('should forward EnvEvent to EventBus when environment publishes', async () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      
      const envEvent: EnvEvent = {
        id: 'evt_123',
        type: 'agent.start',
        timestamp: 1234567890,
        metadata: { source: 'agent' },
        payload: { sessionId: 'sess_1' },
      };
      
      mockEnv.publish(envEvent);
      
      // Give async publish time to complete
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockBus.publish).toHaveBeenCalledWith({
        type: 'agent.start',
        data: { sessionId: 'sess_1' },
        timestamp: 1234567890,
      });
    });

    it('should forward multiple events with different types', async () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      
      const events: EnvEvent[] = [
        { id: '1', type: 'agent.start', timestamp: 1, metadata: {}, payload: {} },
        { id: '2', type: 'tool.call', timestamp: 2, metadata: {}, payload: {} },
        { id: '3', type: 'tool.result', timestamp: 3, metadata: {}, payload: {} },
        { id: '4', type: 'agent.completed', timestamp: 4, metadata: {}, payload: {} },
      ];
      
      events.forEach(e => mockEnv.publish(e));
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockBus.publish).toHaveBeenCalledTimes(4);
      expect(mockBus._getPublishedEvents().map(e => e.type)).toEqual([
        'agent.start',
        'tool.call',
        'tool.result',
        'agent.completed',
      ]);
    });

    it('should preserve event timestamp', async () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      
      const timestamp = Date.now();
      mockEnv.publish({
        id: 'evt_1',
        type: 'agent.start',
        timestamp,
        metadata: {},
        payload: {},
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockBus._getPublishedEvents()[0].timestamp).toBe(timestamp);
    });

    it('should include payload as data in DesktopEvent', async () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      
      mockEnv.publish({
        id: 'evt_1',
        type: 'tool.result',
        timestamp: 123,
        metadata: {},
        payload: {
          name: 'read_file',
          success: true,
          output: 'file content',
        },
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const published = mockBus._getPublishedEvents()[0];
      expect(published.data).toEqual({
        name: 'read_file',
        success: true,
        output: 'file content',
      });
    });
  });

  describe('stop()', () => {
    it('should unsubscribe from environment when stopped', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      bridge.stop();
      
      // After stop, events should not be forwarded
      // Verify by checking that new events don't trigger publish
      mockEnv.publish({
        id: 'evt_1',
        type: 'agent.start',
        timestamp: 123,
        metadata: {},
        payload: {},
      });
      
      expect(mockBus.publish).not.toHaveBeenCalled();
    });

    it('should not forward events after stop', async () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      bridge.stop();
      
      mockEnv.publish({
        id: 'evt_1',
        type: 'agent.start',
        timestamp: 123,
        metadata: {},
        payload: {},
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockBus.publish).not.toHaveBeenCalled();
    });

    it('should be safe to stop without starting', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      expect(() => bridge.stop()).not.toThrow();
    });
  });

  describe('isStarted()', () => {
    it('should return false before start', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      expect(bridge.isStarted()).toBe(false);
    });

    it('should return true after start', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      expect(bridge.isStarted()).toBe(true);
    });

    it('should return false after stop', () => {
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      bridge.stop();
      expect(bridge.isStarted()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should continue forwarding events even if one handler throws', async () => {
      mockBus.publish.mockImplementationOnce(() => {
        throw new Error('Publish error');
      });
      
      const bridge = new EventBridge(mockEnv as any, mockBus as any);
      bridge.start();
      
      // First event throws
      mockEnv.publish({
        id: 'evt_1',
        type: 'agent.start',
        timestamp: 1,
        metadata: {},
        payload: {},
      });
      
      // Second event should still be processed
      mockEnv.publish({
        id: 'evt_2',
        type: 'tool.call',
        timestamp: 2,
        metadata: {},
        payload: {},
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Both events were attempted
      expect(mockBus.publish).toHaveBeenCalledTimes(2);
    });
  });
});
