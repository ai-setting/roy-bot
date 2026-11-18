/**
 * Mock Repositories for Testing
 * 
 * Note: After session-based refactoring, workflow runs are managed via SessionComponent.
 * These mock repositories only handle workflow definitions.
 */

import type { Workflow, WorkflowRun, RunStatus } from '../types';

// ==================== Mock RunRepository ====================

export interface MockRunRepositoryOptions {
  workflowId?: string;
  workflowName?: string;
}

export class MockRunRepository {
  private runs: Map<string, WorkflowRun> = new Map();
  private options: MockRunRepositoryOptions;
  
  constructor(options: MockRunRepositoryOptions = {}) {
    this.options = options;
  }
  
  setWorkflowInfo(workflowId: string, workflowName: string): void {
    this.options.workflowId = workflowId;
    this.options.workflowName = workflowName;
  }
  
  createWorkflowRun(run: Omit<WorkflowRun, 'id'>): WorkflowRun {
    const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const created: WorkflowRun = {
      ...run,
      id,
    };
    
    this.runs.set(id, created);
    return created;
  }
  
  getWorkflowRun(id: string): WorkflowRun | null {
    return this.runs.get(id) || null;
  }
  
  listWorkflowRuns(workflowId?: string, options?: { status?: RunStatus }): WorkflowRun[] {
    let runs = Array.from(this.runs.values());
    
    if (workflowId) {
      runs = runs.filter(r => r.workflowId === workflowId);
    }
    
    if (options?.status) {
      runs = runs.filter(r => r.status === options.status);
    }
    
    // Sort by startedAt descending
    runs.sort((a, b) => {
      const aTime = a.startedAt?.getTime() || 0;
      const bTime = b.startedAt?.getTime() || 0;
      return bTime - aTime;
    });
    
    return runs;
  }
  
  updateWorkflowRun(id: string, updates: Partial<WorkflowRun>): WorkflowRun | null {
    const existing = this.runs.get(id);
    if (!existing) return null;
    
    const updated: WorkflowRun = {
      ...existing,
      ...updates,
    };
    
    this.runs.set(id, updated);
    return updated;
  }
  
  // Helper for testing
  clear(): void {
    this.runs.clear();
  }
  
  count(): number {
    return this.runs.size;
  }
  
  // Helper for MockWorkflowEngine
  setWorkflowName(name: string): void {
    this.options.workflowName = name;
  }
}

// ==================== Mock WorkflowRepository ====================

export class MockWorkflowRepository {
  private workflows: Map<string, Workflow> = new Map();
  private nameIndex: Map<string, string> = new Map(); // name -> id
  
  create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Workflow {
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    
    const created: Workflow = {
      ...workflow,
      id,
      createdAt: now,
      updatedAt: now,
    };
    
    this.workflows.set(id, created);
    this.nameIndex.set(created.name, id);
    
    return created;
  }
  
  getById(id: string): Workflow | null {
    return this.workflows.get(id) || null;
  }
  
  getByName(name: string): Workflow | null {
    const id = this.nameIndex.get(name);
    return id ? this.workflows.get(id) || null : null;
  }
  
  list(options?: { tag?: string; limit?: number; offset?: number }): Workflow[] {
    let workflows = Array.from(this.workflows.values());
    
    if (options?.tag) {
      workflows = workflows.filter(w => w.tags.includes(options.tag!));
    }
    
    // Sort by updatedAt descending
    workflows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    
    if (options?.offset) {
      workflows = workflows.slice(options.offset);
    }
    
    if (options?.limit) {
      workflows = workflows.slice(0, options.limit);
    }
    
    return workflows;
  }
  
  update(id: string, updates: Partial<Workflow>): Workflow | null {
    const existing = this.workflows.get(id);
    if (!existing) return null;
    
    const updated: Workflow = {
      ...existing,
      ...updates,
      id, // Ensure ID doesn't change
      updatedAt: new Date(),
    };
    
    // Update name index if name changed
    if (updates.name && updates.name !== existing.name) {
      this.nameIndex.delete(existing.name);
      this.nameIndex.set(updated.name, id);
    }
    
    this.workflows.set(id, updated);
    return updated;
  }
  
  delete(id: string): boolean {
    const workflow = this.workflows.get(id);
    if (!workflow) return false;
    
    this.workflows.delete(id);
    this.nameIndex.delete(workflow.name);
    return true;
  }
  
  exists(name: string): boolean {
    return this.nameIndex.has(name);
  }
  
  // Helper for testing
  clear(): void {
    this.workflows.clear();
    this.nameIndex.clear();
  }
  
  // Helper to get count
  count(): number {
    return this.workflows.size;
  }

  /**
   * v4: 拿过滤后的全局总数（不应用 limit/offset）
   *
   * 与 list() 共享 tag 过滤逻辑，但忽略 limit/offset。
   * 支持单 tag (SQL 风格) 和多 tag AND。
   */
  countAll(options?: { tag?: string; tags?: string[]; taskId?: number; search?: string }): number {
    let workflows = Array.from(this.workflows.values());
    if (options?.tag) {
      workflows = workflows.filter(w => w.tags.includes(options.tag!));
    }
    if (options?.tags && options.tags.length > 0) {
      const required = options.tags;
      workflows = workflows.filter(w => required.every(t => w.tags.includes(t)));
    }
    if (options?.taskId !== undefined) {
      workflows = workflows.filter(w => w.metadata?.taskId === options.taskId);
    }
    // Mock 不实现 search filter（tests 也不依赖 mock 的 search 计数）
    return workflows.length;
  }

  /**
   * v2: in-memory 事务支持
   *
   * 通过快照/回滚实现：拷贝当前 state，函数成功则 commit，失败则恢复快照。
   */
  transaction<T>(fn: () => T): T {
    const workflowSnapshot = new Map(this.workflows);
    const nameIndexSnapshot = new Map(this.nameIndex);
    try {
      const result = fn();
      return result;
    } catch (e) {
      this.workflows.clear();
      workflowSnapshot.forEach((v, k) => this.workflows.set(k, v));
      this.nameIndex.clear();
      nameIndexSnapshot.forEach((v, k) => this.nameIndex.set(k, v));
      throw e;
    }
  }
}

// ==================== Mock WorkflowEngine ====================

export interface MockEngineCall {
  method: string;
  args: any[];
  result?: any;
  timestamp: number;
}

// Factory type for creating mock engines
export type MockEngineFactory = () => MockWorkflowEngine;

export class MockWorkflowEngine {
  calls: MockEngineCall[] = [];
  private sessionResults: Map<string, any> = new Map();
  private workflowName: string = '';
  
  constructor() {
    // No longer takes runRepository parameter
  }
  
  setWorkflowName(name: string): void {
    this.workflowName = name;
  }
  
  getWorkflowName(): string {
    return this.workflowName;
  }
  
  async createSession(
    workflowId: string,
    options?: { input?: Record<string, any>; workflowName?: string; workflowVersion?: string }
  ): Promise<string> {
    this.calls.push({
      method: 'createSession',
      args: [workflowId, options],
      timestamp: Date.now(),
    });
    
    const sessionId = `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionResults.set(sessionId, {
      status: 'running',
      output: null,
    });
    
    return sessionId;
  }
  
  async createRun(
    workflowNameOrDefinition: string | any,
    options?: { input?: Record<string, any>; debug?: boolean }
  ): Promise<string> {
    this.calls.push({
      method: 'createRun',
      args: [workflowNameOrDefinition, options],
      timestamp: Date.now(),
    });
    
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionResults.set(runId, {
      status: 'idle',
      output: null,
    });
    
    return runId;
  }
  
  async run(runId: string, options?: any): Promise<any> {
    this.calls.push({
      method: 'run',
      args: [runId, options],
      timestamp: Date.now(),
    });
    
    // Task #2086: workflow_run is unified to "call → wait for completion";
    // mock engine always returns a completed result (no fire-and-forget mode).
    this.sessionResults.set(runId, {
      status: 'completed',
      output: { result: 'mocked' },
    });
    
    return {
      runId,
      status: 'completed',
      output: { result: 'mocked' },
    };
  }
  
  async runWorkflow(workflow: any, options?: any): Promise<any> {
    this.calls.push({
      method: 'runWorkflow',
      args: [workflow, options],
      timestamp: Date.now(),
    });
    
    // Task #2086: workflow_run is unified to "call → wait for completion";
    // mock engine always returns a completed result.
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    return {
      runId,
      sessionId: runId,
      status: 'completed',
      output: { result: 'mocked' },
    };
  }
  
  async pause(sessionId: string): Promise<void> {
    this.calls.push({
      method: 'pause',
      args: [sessionId],
      timestamp: Date.now(),
    });
    
    this.sessionResults.set(sessionId, { status: 'paused' });
  }
  
  async resume(sessionId: string, options?: { userResponse?: string; pendingNodeId?: string; agentSessionId?: string }): Promise<any> {
    this.calls.push({
      method: 'resume',
      args: [sessionId, options],
      timestamp: Date.now(),
    });
    
    this.sessionResults.set(sessionId, { status: 'running' });
    
    return {
      sessionId,
      status: 'running',
    };
  }
  
  async stop(sessionId: string, reason?: string): Promise<void> {
    this.calls.push({
      method: 'stop',
      args: [sessionId, reason],
      timestamp: Date.now(),
    });
    
    this.sessionResults.set(sessionId, { status: 'stopped' });
  }
  
  async addNode(sessionId: string, nodeDefinition: any): Promise<void> {
    this.calls.push({
      method: 'addNode',
      args: [sessionId, nodeDefinition],
      timestamp: Date.now(),
    });
  }
  
  async removeNode(sessionId: string, nodeId: string): Promise<void> {
    this.calls.push({
      method: 'removeNode',
      args: [sessionId, nodeId],
      timestamp: Date.now(),
    });
  }
  
  // Helper for testing
  clearCalls(): void {
    this.calls = [];
  }
  
  getLastCall(): MockEngineCall | undefined {
    return this.calls[this.calls.length - 1];
  }
  
  getCallsByMethod(method: string): MockEngineCall[] {
    return this.calls.filter(c => c.method === method);
  }
}

// ==================== Mock NodeRegistry ====================

export class MockNodeRegistry {
  private nodes: Map<string, any> = new Map();
  
  register(type: string, factory: any): void {
    this.nodes.set(type, factory);
  }
  
  get(type: string): any {
    return this.nodes.get(type);
  }
  
  has(type: string): boolean {
    return this.nodes.has(type);
  }
  
  list(): string[] {
    return Array.from(this.nodes.keys());
  }
}
