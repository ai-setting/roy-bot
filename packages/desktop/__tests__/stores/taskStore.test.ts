/**
 * @fileoverview Tests for Task Store
 * 
 * Tests task state management using Zustand store
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { taskStore } from '../../src/stores/taskStore';
import { TaskAdapter, getTaskAdapter } from '../../src/core/TaskAdapter';

// Store reference to singleton for cleanup
let adapterInstance: TaskAdapter;

describe('TaskStore', () => {
  beforeEach(() => {
    // Get adapter instance and clear it
    adapterInstance = getTaskAdapter();
    
    // Clear all tasks
    const allTasks = adapterInstance.getAllTasks();
    for (const task of allTasks) {
      adapterInstance.deleteTask(task.id);
    }
    
    // Reset store state
    taskStore.setState({
      tasks: [],
      selectedTask: null,
      isLoading: false,
      error: null,
    });
  });

  describe('initial state', () => {
    it('should have empty tasks array', () => {
      const { tasks } = taskStore.getState();
      expect(tasks.length).toBe(0);
    });

    it('should have no selected task', () => {
      const { selectedTask } = taskStore.getState();
      expect(selectedTask).toBeNull();
    });

    it('should not be loading initially', () => {
      const { isLoading } = taskStore.getState();
      expect(isLoading).toBe(false);
    });

    it('should have no error initially', () => {
      const { error } = taskStore.getState();
      expect(error).toBeNull();
    });
  });

  describe('createTask', () => {
    it('should create a new task with title only', () => {
      const task = taskStore.getState().createTask('New Test Task');

      expect(task).toBeDefined();
      expect(task.title).toBe('New Test Task');
      expect(task.id).toBeDefined();
    });

    it('should create task with description', () => {
      const task = taskStore.getState().createTask('Task', 'Test description');

      expect(task.description).toBe('Test description');
    });

    it('should create task with priority', () => {
      const task = taskStore.getState().createTask('High Priority Task', undefined, 'high');

      expect(task.priority).toBe('high');
    });

    it('should create task with default priority', () => {
      const task = taskStore.getState().createTask('Normal Task');

      expect(task.priority).toBe('medium');
    });

    it('should add created task to tasks array', () => {
      taskStore.getState().createTask('Task 1');
      taskStore.getState().createTask('Task 2');

      const { tasks } = taskStore.getState();
      expect(tasks.length).toBe(2);
    });
  });

  describe('selectTask', () => {
    it('should select a task', () => {
      const task = taskStore.getState().createTask('Selectable Task');
      
      taskStore.getState().selectTask(task);

      const { selectedTask } = taskStore.getState();
      expect(selectedTask).toBeDefined();
      expect(selectedTask?.id).toBe(task.id);
    });

    it('should clear selection with null', () => {
      const task = taskStore.getState().createTask('Task');
      
      taskStore.getState().selectTask(task);
      taskStore.getState().selectTask(null);

      const { selectedTask } = taskStore.getState();
      expect(selectedTask).toBeNull();
    });
  });

  describe('updateTask', () => {
    it('should update a task title', () => {
      const task = taskStore.getState().createTask('Original Title');
      
      const updatedTask = taskStore.getState().updateTask(task.id, {
        title: 'Updated Title',
      });

      expect(updatedTask).toBeDefined();
      expect(updatedTask?.title).toBe('Updated Title');
    });

    it('should update selected task reference', () => {
      const task = taskStore.getState().createTask('Task');
      taskStore.getState().selectTask(task);
      
      taskStore.getState().updateTask(task.id, { title: 'New Title' });

      const { selectedTask } = taskStore.getState();
      expect(selectedTask?.title).toBe('New Title');
    });
  });

  describe('completeTask', () => {
    it('should complete a task', () => {
      const task = taskStore.getState().createTask('To Complete');
      
      const completedTask = taskStore.getState().completeTask(task.id);

      expect(completedTask).toBeDefined();
      expect(completedTask?.status).toBe('completed');
    });
  });

  describe('cancelTask', () => {
    it('should cancel a task', () => {
      const task = taskStore.getState().createTask('To Cancel');
      
      const cancelledTask = taskStore.getState().cancelTask(task.id);

      expect(cancelledTask).toBeDefined();
      expect(cancelledTask?.status).toBe('cancelled');
    });
  });

  describe('deleteTask', () => {
    it('should delete a task', () => {
      const task1 = taskStore.getState().createTask('Task 1');
      taskStore.getState().createTask('Task 2');
      
      const result = taskStore.getState().deleteTask(task1.id);

      expect(result).toBe(true);
      const { tasks } = taskStore.getState();
      expect(tasks.length).toBe(1);
    });

    it('should clear selectedTask if deleted', () => {
      const task = taskStore.getState().createTask('To Delete');
      taskStore.getState().selectTask(task);
      
      taskStore.getState().deleteTask(task.id);

      const { selectedTask } = taskStore.getState();
      expect(selectedTask).toBeNull();
    });
  });

  describe('store API', () => {
    it('should expose state and actions', () => {
      const state = taskStore.getState();
      
      // State properties
      expect(state).toHaveProperty('tasks');
      expect(state).toHaveProperty('selectedTask');
      expect(state).toHaveProperty('isLoading');
      expect(state).toHaveProperty('error');
      
      // Actions
      expect(state).toHaveProperty('init');
      expect(state).toHaveProperty('createTask');
      expect(state).toHaveProperty('updateTask');
      expect(state).toHaveProperty('completeTask');
      expect(state).toHaveProperty('cancelTask');
      expect(state).toHaveProperty('deleteTask');
      expect(state).toHaveProperty('selectTask');
      expect(state).toHaveProperty('getAdapter');
      
      // Verify they are functions
      expect(typeof state.init).toBe('function');
      expect(typeof state.createTask).toBe('function');
      expect(typeof state.updateTask).toBe('function');
      expect(typeof state.completeTask).toBe('function');
      expect(typeof state.cancelTask).toBe('function');
      expect(typeof state.deleteTask).toBe('function');
      expect(typeof state.selectTask).toBe('function');
      expect(typeof state.getAdapter).toBe('function');
    });
  });
});
