/**
 * @fileoverview EventBus Adapter
 * 
 * Simple EventBus implementation for desktop UI.
 * 
 * Note: This is a standalone implementation that doesn't depend on core.
 * Events are published locally within the renderer process.
 */

export interface DesktopEvent {
  type: string;
  data?: unknown;
  timestamp: number;
  [key: string]: unknown;
}

type EventHandler = (event: DesktopEvent) => void | Promise<void>;

interface Subscription {
  id: number;
  handler: EventHandler;
  eventType?: string;
}

/**
 * EventBus - Simple event bus for desktop UI
 * 
 * This is a standalone implementation for the renderer process.
 * It handles local event publishing and subscribing.
 */
class EventBus {
  private subscriptions: Subscription[] = [];
  private nextId = 1;
  private wildcardHandlers: Subscription[] = [];

  /**
   * Subscribe to an event type
   */
  on(eventType: string, handler: EventHandler): () => void {
    const subscription: Subscription = {
      id: this.nextId++,
      handler,
      eventType,
    };
    this.subscriptions.push(subscription);

    return () => {
      this.subscriptions = this.subscriptions.filter(s => s.id !== subscription.id);
    };
  }

  /**
   * Subscribe to all events (wildcard)
   */
  onAny(handler: EventHandler): () => void {
    const subscription: Subscription = {
      id: this.nextId++,
      handler,
    };
    this.wildcardHandlers.push(subscription);

    return () => {
      this.wildcardHandlers = this.wildcardHandlers.filter(s => s.id !== subscription.id);
    };
  }

  /**
   * Publish an event
   */
  async publish(event: DesktopEvent): Promise<void> {
    // Call wildcard handlers first
    for (const sub of this.wildcardHandlers) {
      try {
        sub.handler(event);
      } catch (err) {
        console.error('[EventBus] Handler error:', err);
      }
    }

    // Call type-specific handlers
    const typeSubs = this.subscriptions.filter(s => s.eventType === event.type);
    for (const sub of typeSubs) {
      try {
        sub.handler(event);
      } catch (err) {
        console.error('[EventBus] Handler error:', err);
      }
    }
  }

  /**
   * Clear all subscriptions
   */
  clear(): void {
    this.subscriptions = [];
    this.wildcardHandlers = [];
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.length + this.wildcardHandlers.length;
  }
}

// Singleton instance
export const eventBus = new EventBus();
