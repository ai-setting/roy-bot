import { DAGManager } from './dag-manager';
// Task #2281: 用 `import type` 让 bundler tree-shake type-only imports
// 之前 `import { EdgeDefinition, EdgeProcessingResult }` 在编译后保留为
// runtime import — EdgeDefinition/EdgeProcessingResult 都是 interface 没有运行时 export,
// 导致 cli 打包后运行抛 "Export named 'EdgeProcessingResult' not found"。
// 这是一个 pre-existing 编译/打包问题,这里修复让 ink REPL 集成测试可以跑通。
import type { EdgeDefinition, EdgeProcessingResult } from '../types/edge';
import { TemplateResolver } from '../utils/template-resolver';
import { createLogger } from '../../log-trace/logger';
import { TracedAs } from '../../log-trace/decorator';

const logger = createLogger('workflow.scheduler');

/**
 * Scheduler Options
 */
export interface SchedulerOptions {
  /** Maximum number of nodes that can run in parallel. null = unlimited */
  parallelLimit: number | null;
}

/**
 * Scheduler State
 */
export interface SchedulerState {
  /** Nodes that have not been started yet */
  pending: string[];
  /** Nodes that are ready to execute (dependencies met, not started) */
  ready: string[];
  /** Nodes that are currently running */
  running: string[];
  /** Nodes that have completed successfully */
  completed: string[];
  /** Nodes that have failed */
  failed: string[];
  /** Nodes that were skipped (not executed) */
  skipped: string[];
}

/**
 * Scheduler
 * 
 * Determines which nodes are ready to execute based on:
 * - DAG dependencies
 * - Parallel execution limit
 * - Node completion status
 * 
 * The scheduler tracks the state of all nodes and manages the execution queue.
 */
export class Scheduler {
  private dagManager: DAGManager;
  private options: SchedulerOptions;
  
  // Node state tracking
  private pending: Set<string> = new Set();
  private ready: Set<string> = new Set();
  private running: Set<string> = new Set();
  private completed: Set<string> = new Set();
  private failed: Set<string> = new Set();
  private skipped: Set<string> = new Set();

  /**
   * Create a new Scheduler
   * @param dagManager - The DAG manager for the workflow
   * @param options - Scheduler options
   */
  constructor(dagManager: DAGManager, options?: Partial<SchedulerOptions>) {
    this.dagManager = dagManager;
    // Use explicit undefined check to preserve null as valid value
    const parallelLimit = options?.parallelLimit;
    this.options = {
      parallelLimit: parallelLimit === undefined ? 1 : parallelLimit,
    };
    
    // Initialize pending set with all nodes
    const analysis = dagManager.analyze();
    for (const nodeId of analysis.dependencies.keys()) {
      this.pending.add(nodeId);
    }
    
    // Calculate initial ready nodes
    this.updateReadyNodes(new Set());
  }

  /**
   * Get nodes that are ready to execute
   * Ready nodes are those whose dependencies are met and are not already running/completed/failed
   * @param completedNodes - Set of completed node IDs (external tracking)
   */
  @TracedAs('workflow.scheduler.getReadyNodes', {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  getReadyNodes(completedNodes: Set<string>): string[] {
    // Calculate all completed nodes (including those tracked internally)
    const allCompleted = new Set(completedNodes);
    for (const nodeId of this.completed) {
      allCompleted.add(nodeId);
    }
    
    // Get ready nodes from DAG manager
    const readyFromDag = this.dagManager.getReadyNodes(allCompleted);
    
    // Filter out nodes that are already running, completed, failed, or skipped
    // Also ensure the node is in pending or ready state (not already processed)
    const ready: string[] = [];
    for (const nodeId of readyFromDag) {
      const isProcessed = this.running.has(nodeId) || 
                          this.completed.has(nodeId) || 
                          this.failed.has(nodeId) ||
                          this.skipped.has(nodeId);
      
      if (!isProcessed) {
        ready.push(nodeId);
      }
    }
    
    // Sort for deterministic order
    return ready.sort();
  }

  /**
   * Get the number of currently running nodes
   */
  getRunningCount(): number {
    return this.running.size;
  }

  /**
   * Check if more nodes can be started based on the parallel limit
   */
  canStartMore(): boolean {
    // null means unlimited
    if (this.options.parallelLimit === null) {
      return true;
    }
    
    if (this.options.parallelLimit <= 0) {
      return false;
    }
    
    return this.running.size < this.options.parallelLimit;
  }

  /**
   * Mark a node as started
   * @param nodeId - The node ID
   */
  @TracedAs("workflow.scheduler.markStarted", { recordParams: true, recordResult: false })
  markStarted(nodeId: string): void {
    // Only track if not already running
    if (!this.running.has(nodeId)) {
      this.running.add(nodeId);
      this.ready.delete(nodeId);
      this.pending.delete(nodeId);
    }
  }
  
  /**
   * Check if a node is currently running
   * @param nodeId - The node ID
   */
  isRunning(nodeId: string): boolean {
    return this.running.has(nodeId);
  }
  
  /**
   * Check if a node has completed
   * @param nodeId - The node ID
   */
  isCompleted(nodeId: string): boolean {
    return this.completed.has(nodeId);
  }
  
  /**
   * Check if a node has failed
   * @param nodeId - The node ID
   */
  isFailed(nodeId: string): boolean {
    return this.failed.has(nodeId);
  }
  
  /**
   * Check if a node is in pending state
   * @param nodeId - The node ID
   */
  isPending(nodeId: string): boolean {
    return this.pending.has(nodeId);
  }
  
  /**
   * Check if a node is ready to execute
   * @param nodeId - The node ID
   */
  isReady(nodeId: string): boolean {
    return this.ready.has(nodeId);
  }

  /**
   * Mark a node as completed successfully
   * @param nodeId - The node ID (or '__end__' to mark workflow as completed)
   */
  @TracedAs("workflow.scheduler.markCompleted", { recordParams: true, recordResult: false })
  markCompleted(nodeId: string): void {
    // Handle __end__ special case - just mark internal state, don't add to completed set
    if (nodeId === '__end__' || nodeId === '__END__') {
      logger.debug(`[Scheduler] Workflow marked as completed via __end__`);
      return;
    }
    
    // Remove from other states
    this.running.delete(nodeId);
    this.ready.delete(nodeId);
    this.pending.delete(nodeId);
    this.failed.delete(nodeId);
    this.skipped.delete(nodeId);
    
    // Add to completed
    this.completed.add(nodeId);
  }

  /**
   * Mark a node as failed
   * @param nodeId - The node ID
   */
  @TracedAs("workflow.scheduler.markFailed", { recordParams: true, recordResult: false })
  markFailed(nodeId: string): void {
    // Remove from any other state
    this.running.delete(nodeId);
    this.ready.delete(nodeId);
    this.pending.delete(nodeId);
    this.completed.delete(nodeId);
    this.skipped.delete(nodeId);
    
    // Add to failed
    this.failed.add(nodeId);
  }

  /**
   * Mark a node as skipped (not executed)
   * @param nodeId - The node ID
   */
  markSkipped(nodeId: string): void {
    if (this.running.has(nodeId)) {
      this.running.delete(nodeId);
    }
    if (this.ready.has(nodeId)) {
      this.ready.delete(nodeId);
    }
    if (this.pending.has(nodeId)) {
      this.pending.delete(nodeId);
    }
    this.skipped.add(nodeId);
  }

  /**
   * Clear skipped state so a node can be scheduled again
   */
  unmarkSkipped(nodeId: string): void {
    if (!this.skipped.has(nodeId)) {
      return;
    }
    this.skipped.delete(nodeId);
    this.pending.add(nodeId);
  }

  /**
   * Reset a node so it can be re-executed (loop / back-edge re-entry)
   */
  resetNodeForReEntry(nodeId: string): void {
    this.running.delete(nodeId);
    this.completed.delete(nodeId);
    this.failed.delete(nodeId);
    this.skipped.delete(nodeId);
    this.ready.delete(nodeId);
    this.pending.add(nodeId);
  }

  /**
   * Reset the scheduler state
   * Clears all running, completed, failed, and skipped nodes
   */
  reset(): void {
    this.running.clear();
    this.completed.clear();
    this.failed.clear();
    this.skipped.clear();
    
    // Rebuild pending and ready from DAG analysis
    const analysis = this.dagManager.analyze();
    
    this.pending.clear();
    this.ready.clear();
    
    for (const nodeId of analysis.dependencies.keys()) {
      this.pending.add(nodeId);
    }
    
    this.updateReadyNodes(new Set());
  }

  /**
   * Get the current state of the scheduler
   */
  getState(): SchedulerState {
    // Rebuild ready set based on current state
    this.updateReadyNodes(new Set());
    
    return {
      pending: Array.from(this.pending).sort(),
      ready: Array.from(this.ready).sort(),
      running: Array.from(this.running).sort(),
      completed: Array.from(this.completed).sort(),
      failed: Array.from(this.failed).sort(),
      skipped: Array.from(this.skipped).sort(),
    };
  }

  /**
   * Mark multiple nodes as completed from restored state
   * Used during workflow resume to prevent re-executing completed nodes
   * @param nodeIds - Array of node IDs that were completed
   */
  markCompletedFromRestore(nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      this.markCompleted(nodeId);
    }
  }

  /**
   * Update the ready set based on completed nodes
   */
  private updateReadyNodes(completedNodes: Set<string>): void {
    const allCompleted = new Set(completedNodes);
    for (const nodeId of this.completed) {
      allCompleted.add(nodeId);
    }
    
    // Get all node IDs
    const analysis = this.dagManager.analyze();
    const allNodeIds = Array.from(analysis.dependencies.keys());
    
    // Clear and rebuild ready set
    this.ready.clear();
    
    for (const nodeId of allNodeIds) {
      // Skip if already in some terminal or transitional state
      if (this.running.has(nodeId) || 
          this.completed.has(nodeId) || 
          this.failed.has(nodeId) ||
          this.skipped.has(nodeId)) {
        continue;
      }
      
      // Check if dependencies are met
      if (this.dagManager.areDependenciesMet(nodeId, allCompleted)) {
        this.ready.add(nodeId);
      }
    }
  }

  /**
   * Get the parallel limit
   */
  getParallelLimit(): number | null {
    return this.options.parallelLimit;
  }

  /**
   * Update the parallel limit
   * @param limit - New parallel limit (null for unlimited)
   */
  setParallelLimit(limit: number | null): void {
    this.options.parallelLimit = limit;
  }

  /**
   * Get outgoing edges from a node
   * @param nodeId - Source node ID
   * @param edges - Array of edge definitions
   * @returns Array of outgoing edges
   */
  getOutgoingEdges(nodeId: string, edges: EdgeDefinition[]): EdgeDefinition[] {
    return edges.filter(edge => edge.from === nodeId);
  }

  /**
   * Evaluate and process edges after a node completes
   * @param completedNodeId - The node that just completed
   * @param edges - Array of edge definitions
   * @param templateResolver - Template resolver for condition evaluation
   * @param loopEnabled - Whether to allow re-entry of completed nodes (for loop/cycle support)
   * @returns Array of nodes that should be started
   */
  @TracedAs('workflow.scheduler.processEdgesAfterCompletion', {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  processEdgesAfterCompletion(
    completedNodeId: string,
    edges: EdgeDefinition[],
    templateResolver: TemplateResolver,
    loopEnabled?: boolean
  ): EdgeProcessingResult {
    const result: EdgeProcessingResult = {
      toStart: [],
      reEntries: [],
      skipped: [],
      resetNodes: [],
    };

    // Check if completed node has inline condition
    const completedNode = this.dagManager.getNode(completedNodeId);
    if (completedNode?.condition) {
      const conditionMet = templateResolver.evaluateCondition(completedNode.condition);
      if (!conditionMet) {
        for (const edge of this.getOutgoingEdges(completedNodeId, edges)) {
          this.markSkipped(edge.to);
          result.skipped.push({
            nodeId: edge.to,
            reason: `Inline condition false on node "${completedNodeId}"`,
          });
        }
        return result;
      }
    }

    const outgoingEdges = this.getOutgoingEdges(completedNodeId, edges);
    
    for (const edge of outgoingEdges) {
      const conditionMet = !edge.when || templateResolver.evaluateCondition(edge.when);

      if (conditionMet) {
        // Condition flipped true — allow previously skipped node to run again
        if (this.skipped.has(edge.to)) {
          this.unmarkSkipped(edge.to);
        }

        const isReEntry = loopEnabled && this.completed.has(edge.to);
        const canStart = loopEnabled
          ? !this.running.has(edge.to) && !this.failed.has(edge.to)
          : !this.completed.has(edge.to) && !this.running.has(edge.to) && !this.failed.has(edge.to);

        if (canStart) {
          if (isReEntry) {
            const downstream = this.dagManager.getDownstreamUntil(edge.to, completedNodeId);
            for (const nodeId of downstream) {
              this.resetNodeForReEntry(nodeId);
              result.resetNodes.push(nodeId);
            }
            this.resetNodeForReEntry(edge.to);
            result.resetNodes.push(edge.to);
            result.reEntries.push(edge.to);
            result.toStart.push(edge.to);
          } else {
            // Bug fix Task #2240: gate first-entry toStart on full depends_on set.
            // The edge `A → F` may fire when A completes even if F declares
            // depends_on=[A,B,C,D] and B/C/D haven't completed yet. Defer this
            // push; engine.scheduleAvailableNodes() will re-pick F via
            // getReadyNodes() once the remaining siblings finish.
            const completedSoFar = new Set(this.completed);
            completedSoFar.add(completedNodeId);
            if (this.dagManager.areDependenciesMet(edge.to, completedSoFar)) {
              result.toStart.push(edge.to);
            }
          }
        }
      } else {
        if (!this.skipped.has(edge.to)) {
          result.skipped.push({
            nodeId: edge.to,
            reason: edge.when ? `Edge condition false: ${edge.when}` : 'Edge condition false',
          });
        }
        this.markSkipped(edge.to);
      }
    }
    
    return result;
  }
}
