import type { WorkflowEvent } from '../types/event';
import { createLogger } from '../../log-trace/logger';

export type EventHandler = (event: WorkflowEvent) => void | Promise<void>;

const logger = createLogger('workflow.eventbus');

/**
 * EventBus for workflow events.
 * Custom event bus implementation with support for wildcard subscriptions.
 */
export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private wildcardHandlers: Set<EventHandler> = new Set();

  constructor() {
    // No-op - keep for potential future use
  }

  /**
   * Subscribe to a specific event type.
   * @returns Unsubscribe function
   */
  on(eventType: string, handler: EventHandler): () => void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => this.off(eventType, handler);
  }

  /**
   * Subscribe to an event type only once (auto-unsubscribe after first call).
   * @returns Unsubscribe function
   */
  once(eventType: string, handler: EventHandler): () => void {
    // Use a flag to track if handler has been executed
    let executed = false;
    
    const wrappedHandler: EventHandler = async (event) => {
      // Skip if already executed (prevent double execution)
      if (executed) {
        return;
      }
      executed = true;
      
      // Execute the original handler
      try {
        await handler(event);
      } catch (error) {
        // Silently catch handler errors
        logger.error('Event handler error:', error);
      }
      
      // Then unsubscribe
      this.off(eventType, wrappedHandler);
    };
    
    // Subscribe the wrapped handler
    return this.on(eventType, wrappedHandler);
  }

  /**
   * Unsubscribe from an event type.
   */
  off(eventType: string, handler: EventHandler): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(eventType);
      }
    }
  }

  /**
   * Subscribe to all events (wildcard subscription).
   * @returns Unsubscribe function
   */
  onAny(handler: EventHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => {
      this.wildcardHandlers.delete(handler);
    };
  }

  /**
   * Publish an event to all subscribers.
   * Handler errors are caught and do not crash the bus.
   * 
   * @param event - The event to publish
   * @param waitForHandlers - If true, waits for all async handlers to complete (default: false)
   */
  async publish(event: WorkflowEvent, waitForHandlers: boolean = false): Promise<void> {
    // Get specific handlers for this event type
    const handlers = this.handlers.get(event.type);
    
    // Collect all handler promises
    const handlerPromises: Promise<void>[] = [];

    // Execute specific handlers
    if (handlers) {
      for (const handler of handlers) {
        const promise = this.executeHandler(handler, event);
        handlerPromises.push(promise);
      }
    }

    // Execute wildcard handlers
    for (const handler of this.wildcardHandlers) {
      const promise = this.executeHandler(handler, event);
      handlerPromises.push(promise);
    }

    // Optionally wait for all handlers to complete
    if (waitForHandlers && handlerPromises.length > 0) {
      await Promise.allSettled(handlerPromises);
    }
  }

  /**
   * Execute a handler safely, catching any errors.
   */
  private async executeHandler(handler: EventHandler, event: WorkflowEvent): Promise<void> {
    try {
      await handler(event);
    } catch (error) {
      // Silently catch handler errors to prevent crash
      logger.error('Event handler error:', error);
    }
  }

  /**
   * Clear all subscriptions.
   */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /**
   * Get statistics about the event bus.
   */
  getStats(): { eventTypes: number; wildcardHandlers: number; totalHandlers: number } {
    let totalHandlers = 0;
    for (const handlers of this.handlers.values()) {
      totalHandlers += handlers.size;
    }
    totalHandlers += this.wildcardHandlers.size;

    return {
      eventTypes: this.handlers.size,
      wildcardHandlers: this.wildcardHandlers.size,
      totalHandlers,
    };
  }
}
