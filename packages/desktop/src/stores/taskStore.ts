/**
 * @fileoverview Task Store - Zustand store for task management
 * 
 * Manages tasks and their operations using TaskAdapter.
 * Provides reactive state for the desktop UI.
 */

import { create } from 'zustand';
import { TaskAdapter, getTaskAdapter, type Task } from '../core/TaskAdapter';

// ============================================================================
// Types
// ============================================================================

/**
 * Task state interface
 */
interface TaskState {
  /** List of tasks */
  tasks: Task[];
  /** Currently selected task */
  selectedTask: Task | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
}

/**
 * Task actions interface
 */
interface TaskActions {
  /** Initialize the store */
  init: () => void;
  /** Create a new task */
  createTask: (title: string, description?: string, priority?: Task['priority']) => Task;
  /** Update an existing task */
  updateTask: (id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>) => Task | undefined;
  /** Complete a task */
  completeTask: (id: string) => Task | undefined;
  /** Cancel a task */
  cancelTask: (id: string) => Task | undefined;
  /** Delete a task */
  deleteTask: (id: string) => boolean;
  /** Select a task */
  selectTask: (task: Task | null) => void;
  /** Get the task adapter */
  getAdapter: () => TaskAdapter;
}

// Combined store type
export type TaskStore = TaskState & TaskActions;

// ============================================================================
// Store Implementation
// ============================================================================

/**
 * Create the task store
 */
const store = create<TaskStore>((set, _get) => {
  // Get singleton adapter
  const adapter = getTaskAdapter();

  // Subscribe to adapter changes
  adapter.subscribe(() => {
    set({ tasks: adapter.getAllTasks() });
  });

  return {
    // Initial state
    tasks: adapter.getAllTasks(),
    selectedTask: null,
    isLoading: false,
    error: null,

    // Actions
    /**
     * Initialize the store.
     */
    init: () => {
      set({ tasks: adapter.getAllTasks() });
    },

    /**
     * Create a new task.
     */
    createTask: (title: string, description?: string, priority?: Task['priority']) => {
      const task = adapter.createTask(title, description, priority);
      set({ tasks: adapter.getAllTasks() });
      return task;
    },

    /**
     * Update an existing task.
     */
    updateTask: (id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>) => {
      const task = adapter.updateTask(id, updates);
      set({ 
        tasks: adapter.getAllTasks(),
        selectedTask: task || null,
      });
      return task;
    },

    /**
     * Complete a task.
     */
    completeTask: (id: string) => {
      const task = adapter.completeTask(id);
      set({ tasks: adapter.getAllTasks() });
      return task;
    },

    /**
     * Cancel a task.
     */
    cancelTask: (id: string) => {
      const task = adapter.cancelTask(id);
      set({ tasks: adapter.getAllTasks() });
      return task;
    },

    /**
     * Delete a task.
     */
    deleteTask: (id: string) => {
      const success = adapter.deleteTask(id);
      if (success) {
        set((state) => ({
          tasks: adapter.getAllTasks(),
          selectedTask: state.selectedTask?.id === id ? null : state.selectedTask,
        }));
      }
      return success;
    },

    /**
     * Select a task.
     */
    selectTask: (task: Task | null) => {
      set({ selectedTask: task });
    },

    /**
     * Get the task adapter instance.
     */
    getAdapter: () => adapter,
  };
});

// Export as hook for React components
export const useTaskStore = store;

// Also export as plain store for non-React usage
export const taskStore = store;
