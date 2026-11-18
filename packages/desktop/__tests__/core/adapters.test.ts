/**
 * @fileoverview Tests for Core Adapters
 * 
 * Tests EventBusAdapter, SessionAdapter, TaskAdapter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventBus, DesktopEvent } from '../../src/core/EventBusAdapter';
import { sessionStore } from '../../src/stores/sessionStore';
import { taskStore } from '../../src/stores/taskStore';

// Helper to create events with timestamp
function createEvent(type: string, data?: unknown): DesktopEvent {
  return { type, data, timestamp: Date.now() };
}

// ========================================================================
// EventBusAdapter Tests
// ========================================================================

describe('EventBusAdapter', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it('should publish and receive events', async () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.on('test.event', handler);
    
    await eventBus.publish(createEvent('test.event', { value: 42 }));
    
    expect(handler).toHaveBeenCalledTimes(1);
    
    unsubscribe();
  });

  it('should unsubscribe from events', async () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.on('single.event', handler);
    unsubscribe(); // Unsubscribe after registration
    
    await eventBus.publish(createEvent('single.event', 'first'));
    await eventBus.publish(createEvent('single.event', 'second'));
    
    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle wildcard subscriptions', async () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.onAny(handler);
    
    await eventBus.publish(createEvent('event.a', 'A'));
    await eventBus.publish(createEvent('event.b', 'B'));
    
    expect(handler).toHaveBeenCalledTimes(2);
    
    unsubscribe();
  });

  it('should clear all subscriptions', async () => {
    const handler = vi.fn();
    eventBus.on('clear.event', handler);
    eventBus.onAny(handler);
    
    eventBus.clear();
    
    await eventBus.publish(createEvent('clear.event'));
    await eventBus.publish(createEvent('any.event'));
    
    expect(handler).not.toHaveBeenCalled();
  });

  it('should report subscription count', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    
    expect(eventBus.getSubscriptionCount()).toBe(0);
    
    eventBus.on('type1', handler1);
    expect(eventBus.getSubscriptionCount()).toBe(1);
    
    eventBus.on('type2', handler2);
    expect(eventBus.getSubscriptionCount()).toBe(2);
  });
});

// ========================================================================
// TaskAdapter Tests
// ========================================================================

describe('TaskAdapter', () => {
  // Task store uses TaskAdapter internally
  beforeEach(() => {
    const adapter = taskStore.getState().getAdapter();
    const allTasks = adapter.getAllTasks();
    for (const task of allTasks) {
      adapter.deleteTask(task.id);
    }
  });

  it('should create tasks', () => {
    const task = taskStore.getState().createTask('Test Task');
    
    expect(task).toBeDefined();
    expect(task.title).toBe('Test Task');
    expect(task.status).toBe('todo');
  });

  it('should get all tasks', () => {
    taskStore.getState().createTask('Task 1');
    taskStore.getState().createTask('Task 2');
    
    const adapter = taskStore.getState().getAdapter();
    const tasks = adapter.getAllTasks();
    
    expect(tasks.length).toBe(2);
  });

  it('should update tasks', () => {
    const task = taskStore.getState().createTask('Original');
    
    const updated = taskStore.getState().updateTask(task.id, { title: 'Updated' });
    
    expect(updated?.title).toBe('Updated');
  });

  it('should complete tasks', () => {
    const task = taskStore.getState().createTask('To Complete');
    
    const completed = taskStore.getState().completeTask(task.id);
    
    expect(completed?.status).toBe('completed');
  });

  it('should delete tasks', () => {
    const task = taskStore.getState().createTask('To Delete');
    
    taskStore.getState().deleteTask(task.id);
    
    const adapter = taskStore.getState().getAdapter();
    expect(adapter.getTask(task.id)).toBeUndefined();
  });
});

// ========================================================================
// SessionAdapter Tests
// ========================================================================

describe('SessionAdapter', () => {
  // Session store uses SessionAdapter internally
  beforeEach(() => {
    const adapter = sessionStore.getState().getAdapter();
    const allSessions = adapter.getAllSessions();
    for (const session of allSessions) {
      adapter.deleteSession(session.id);
    }
  });

  it('should create sessions', () => {
    const session = sessionStore.getState().createSession('Test Session');
    
    expect(session).toBeDefined();
    expect(session.title).toBe('Test Session');
  });

  it('should get all sessions', () => {
    sessionStore.getState().createSession('Session 1');
    sessionStore.getState().createSession('Session 2');
    
    const adapter = sessionStore.getState().getAdapter();
    const sessions = adapter.getAllSessions();
    
    expect(sessions.length).toBe(2);
  });

  it('should add messages to session', () => {
    sessionStore.getState().createSession('Test');
    
    const message = sessionStore.getState().addMessage('user', 'Hello');
    
    expect(message).toBeDefined();
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });

  it('should switch active session', () => {
    const session1 = sessionStore.getState().createSession('Session 1');
    sessionStore.getState().createSession('Session 2');
    
    sessionStore.getState().setActiveSession(session1.id);
    
    const adapter = sessionStore.getState().getAdapter();
    expect(adapter.getCurrentSessionId()).toBe(session1.id);
  });

  it('should delete sessions', () => {
    const session = sessionStore.getState().createSession('To Delete');
    
    sessionStore.getState().deleteSession(session.id);
    
    const adapter = sessionStore.getState().getAdapter();
    expect(adapter.getCurrentSession()).toBeUndefined();
  });
});

// ========================================================================
// StoreFactory Tests (simplified - no database in renderer)
// ========================================================================

describe('StoreFactory', () => {
  it('should have session store', () => {
    expect(sessionStore).toBeDefined();
    expect(typeof sessionStore.getState).toBe('function');
  });

  it('should have task store', () => {
    expect(taskStore).toBeDefined();
    expect(typeof taskStore.getState).toBe('function');
  });

  it('should have event bus', () => {
    expect(eventBus).toBeDefined();
    expect(typeof eventBus.publish).toBe('function');
  });
});
