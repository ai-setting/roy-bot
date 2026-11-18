/**
 * @fileoverview EventBridge
 * 
 * Bridges events from Environment (EnvEvent) to EventBusAdapter (DesktopEvent).
 * 
 * Flow:
 * Environment.pushEnvEvent() → EventBridge → EventBusAdapter.publish()
 *                                       ↓
 *                                 eventStore.addEvent()
 *                                       ↓
 *                                 PanelCenter renders
 */

/**
 * DesktopEvent - Event format used by EventBusAdapter
 */
export interface DesktopEvent {
  type: string;
  data?: unknown;
  timestamp: number;
}

/**
 * EnvEventHandler - Handler type for Environment events
 */
type EnvEventHandler = (event: EnvEvent) => void;

/**
 * EnvEvent - Event format from Environment
 */
interface EnvEvent {
  id: string;
  type: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  payload?: unknown;
}

/**
 * Environment interface (minimal subset for EventBridge)
 */
interface EnvironmentLike {
  subscribe(handler: EnvEventHandler): () => void;
}

/**
 * EventBus-like interface (minimal subset)
 */
interface EventBusLike {
  publish(event: DesktopEvent): Promise<void>;
}

/**
 * EventBridge - Bridges events from Environment to EventBusAdapter
 */
export class EventBridge {
  private unsubscribe?: () => void;
  private started = false;

  constructor(
    private env: EnvironmentLike,
    private eventBus: EventBusLike
  ) {}

  /**
   * Start bridging events from Environment to EventBus
   */
  start(): void {
    if (this.started) {
      return;
    }

    this.unsubscribe = this.env.subscribe((event: EnvEvent) => {
      // Transform EnvEvent to DesktopEvent
      const desktopEvent: DesktopEvent = {
        type: event.type,
        data: event.payload,
        timestamp: event.timestamp,
      };

      // Forward to EventBus (ignore errors)
      try {
        this.eventBus.publish(desktopEvent).catch((err: unknown) => {
          console.error('[EventBridge] Failed to publish event:', err);
        });
      } catch (err) {
        console.error('[EventBridge] Failed to publish event:', err);
      }
    });

    this.started = true;
  }

  /**
   * Stop bridging events
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.started = false;
  }

  /**
   * Check if bridge is started
   */
  isStarted(): boolean {
    return this.started;
  }
}
