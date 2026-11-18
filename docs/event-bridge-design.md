# Event Bridge Design

> **Date**: 2026-05-09
> **Phase**: Phase 3 - Event System Implementation

## Problem Statement

Desktop app has two separate event systems:
1. **Environment.pushEnvEvent()**: Used by AgentComponent to publish events (`agent.start`, `agent.completed`, `tool.result`, etc.)
2. **EventBusAdapter**: Local event bus used by desktop app's UI components

Events from AgentComponent are not reaching the desktop UI's event display (PanelCenter).

## Solution

Create an **EventBridge** that connects Environment's EnvEvent to EventBusAdapter:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Desktop App                                │
│                                                                 │
│  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐   │
│  │ PanelL2     │     │ AgentComponent│     │ Environment │   │
│  │ (Chat UI)   │     │              │ ──→ │ pushEnvEvent │   │
│  └─────────────┘     └──────────────┘     └──────┬───────┘   │
│                                                  │            │
│                           ┌──────────────────────┘            │
│                           ↓                                   │
│                    ┌──────────────┐                          │
│                    │ EventBridge  │  ← NEW                    │
│                    └──────┬───────┘                          │
│                           ↓                                   │
│                    ┌──────────────┐     ┌──────────────┐   │
│                    │ EventBusAdapter│    │ eventStore   │   │
│                    │ (Local Bus)   │ ──→ │ (Zustand)   │   │
│                    └──────────────┘     └──────┬───────┘   │
│                                                ↓            │
│                                         ┌──────────────┐   │
│                                         │ PanelCenter  │   │
│                                         │ (Events UI)  │   │
│                                         └──────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Event Types

| EnvEvent Type | DesktopEvent Type | Description |
|---------------|-------------------|-------------|
| `agent.start` | `agent.start` | Agent execution started |
| `agent.completed` | `agent.completed` | Agent execution completed |
| `agent.error` | `agent.error` | Agent execution error |
| `tool.call` | `tool.call` | Tool call started |
| `tool.result` | `tool.result` | Tool execution result |
| `tool.error` | `tool.error` | Tool execution error |

## API Design

### EventBridge Class

```typescript
export class EventBridge {
  constructor(
    private env: Environment,
    private eventBus: EventBusAdapter
  ) {}
  
  /** Start bridging events */
  start(): void;
  
  /** Stop bridging events */
  stop(): void;
}
```

### Event Transformation

```typescript
// EnvEvent → DesktopEvent
interface EnvEvent {
  id: string;
  type: string;
  timestamp: number;
  metadata?: EnvEventMetadata;
  payload: Record<string, unknown>;
}

interface DesktopEvent {
  type: string;
  data?: unknown;
  timestamp: number;
}
```

## File Structure

```
packages/desktop/
├── src/
│   └── core/
│       ├── EventBusAdapter.ts    # Existing
│       └── EventBridge.ts        # NEW
└── __tests__/
    └── core/
        └── eventBridge.test.ts   # NEW
```

## Implementation Notes

1. EventBridge subscribes to Environment's wildcard handler (`env.subscribe()`)
2. All EnvEvents are transformed and forwarded to EventBusAdapter
3. EventBridge lifecycle is tied to the app lifecycle
4. No additional UI needed - PanelCenter already subscribes to eventStore

## Testing Strategy

1. **Unit tests**: EventBridge transforms events correctly
2. **Integration tests**: Verify events flow from Environment → Bridge → EventBus → eventStore
