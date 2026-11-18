/**
 * @fileoverview Task Adapter
 * 
 * Simplified task adapter for renderer process.
 * 
 * Note: Actual task management is done in the main process via DesktopEnvironment.
 * This adapter provides a simplified interface for the renderer.
 */

/**
 * Task type
 */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'todo' | 'in-progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * TaskAdapter
 * 
 * Simplified task management for renderer.
 * UI components use this to interact with tasks.
 */
export class TaskAdapter {
  private tasks: Map<string, Task> = new Map();
  private listeners: Set<() => void> = new Set();

  constructor() {
    // Load from localStorage if available
    this.loadFromStorage();
  }

  /**
   * Load tasks from localStorage
   */
  private loadFromStorage(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('desktop_tasks');
        if (stored) {
          const parsed = JSON.parse(stored) as Task[];
          for (const task of parsed) {
            this.tasks.set(task.id, task);
          }
        }
      }
    } catch (err) {
      console.warn('[TaskAdapter] Failed to load from localStorage:', err);
    }
  }

  /**
   * Save tasks to localStorage
   */
  private saveToStorage(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const tasks = Array.from(this.tasks.values());
        localStorage.setItem('desktop_tasks', JSON.stringify(tasks));
      }
    } catch (err) {
      console.warn('[TaskAdapter] Failed to save to localStorage:', err);
    }
  }

  /**
   * Notify listeners of changes
   */
  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Subscribe to task changes
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Create a new task
   */
  createTask(title: string, description?: string, priority: Task['priority'] = 'medium'): Task {
    const task: Task = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title,
      description,
      status: 'todo',
      priority,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(task.id, task);
    this.saveToStorage();
    this.notify();

    return task;
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: Task['status']): Task[] {
    return this.getAllTasks().filter(t => t.status === status);
  }

  /**
   * Update a task
   */
  updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const updated: Task = {
      ...task,
      ...updates,
      updatedAt: Date.now(),
    };

    // Set completedAt if status changed to completed
    if (updates.status === 'completed' && task.status !== 'completed') {
      updated.completedAt = Date.now();
    }

    this.tasks.set(id, updated);
    this.saveToStorage();
    this.notify();

    return updated;
  }

  /**
   * Delete a task
   */
  deleteTask(id: string): boolean {
    const result = this.tasks.delete(id);
    if (result) {
      this.saveToStorage();
      this.notify();
    }
    return result;
  }

  /**
   * Complete a task
   */
  completeTask(id: string): Task | undefined {
    return this.updateTask(id, { status: 'completed' });
  }

  /**
   * Cancel a task
   */
  cancelTask(id: string): Task | undefined {
    return this.updateTask(id, { status: 'cancelled' });
  }

  /**
   * Get task count by status
   */
  getTaskCounts(): Record<Task['status'], number> {
    const tasks = this.getAllTasks();
    return {
      'todo': tasks.filter(t => t.status === 'todo').length,
      'in-progress': tasks.filter(t => t.status === 'in-progress').length,
      'completed': tasks.filter(t => t.status === 'completed').length,
      'cancelled': tasks.filter(t => t.status === 'cancelled').length,
    };
  }
}

// Singleton instance
let taskAdapterInstance: TaskAdapter | null = null;

/**
 * Get the singleton TaskAdapter instance
 */
export function getTaskAdapter(): TaskAdapter {
  if (!taskAdapterInstance) {
    taskAdapterInstance = new TaskAdapter();
  }
  return taskAdapterInstance;
}
