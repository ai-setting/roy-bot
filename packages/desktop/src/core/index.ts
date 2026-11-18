/**
 * @fileoverview Core module exports
 * 
 * Re-exports all core modules for convenient imports.
 */

// EventBus Adapter
export { eventBus, type DesktopEvent } from './EventBusAdapter';

// Streaming Message Service
export { streamingMessageService, type StreamingMessageState } from './StreamingMessageService';
