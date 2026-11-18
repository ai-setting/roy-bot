/**
 * Execution State Builder
 *
 * Builds execution state from session messages and workflow definition.
 */

import { TracedAs } from '../../log-trace/decorator';
// Task #2283: 用 `import type` 让 bundler tree-shake type-only imports
// WorkflowDefinition / SessionMessage 都是 interface, 没有运行时 export
import type { WorkflowDefinition } from '../types';
import type { SessionMessage } from '../../session/types';
import type { ExecutionState } from './validation-rules';

/**
 * Builder for constructing ExecutionState from session data
 */
export class ExecutionStateBuilder {
  
  // ExecutionState 含 nodeInputs / nodeOutputs（可能 MB 级）→ 不入库
  @TracedAs("recovery.builder.build", { recordParams: true, recordResult: false, log: true })
  build(messages: SessionMessage[], definition: WorkflowDefinition): ExecutionState {
    const state: ExecutionState = {
      completedNodes: new Set<string>(),
      inProgressNodes: new Set<string>(),
      pendingNodes: new Set<string>(),
      nodeOutputs: new Map<string, unknown>(),
      nodeInputs: new Map<string, unknown>(),
      variables: new Map<string, unknown>(),
      loopCounts: new Map<string, number>(),
    };
    
    // Parse messages to build state
    this.parseMessages(messages, state);
    
    // Build DAG from definition to determine pending nodes
    this.buildPendingNodes(definition, state);
    
    return state;
  }
  
  /**
   * Parse session messages to extract node states and outputs
   */
  @TracedAs("recovery.builder.parseMessages", { recordParams: true, recordResult: true, log: true })
  private parseMessages(messages: SessionMessage[], state: ExecutionState): void {
    let lastCallNodeId: string | null = null;
    let lastCallInput: unknown = null;
    
    for (const msg of messages) {
      const metadata = msg.metadata as Record<string, unknown> | undefined;
      const msgType = metadata?.type as string | undefined;
      
      switch (msgType) {
        case 'workflow.node.call': {
          const nodeId = metadata?.workflowNodeId as string | undefined;
          if (nodeId) {
            lastCallNodeId = nodeId;
            lastCallInput = this.extractInput(msg);
            
            // Mark as in-progress (might be completed later)
            state.inProgressNodes.add(nodeId);
            state.nodeInputs.set(nodeId, lastCallInput);
          }
          break;
        }
        
        case 'workflow.node.result': {
          if (lastCallNodeId) {
            // Node completed successfully
            state.inProgressNodes.delete(lastCallNodeId);
            state.completedNodes.add(lastCallNodeId);
            
            // Extract output
            const output = this.extractOutput(msg);
            state.nodeOutputs.set(lastCallNodeId, output);
            
            // Extract variables from output
            this.extractVariables(output, state);
            
            lastCallNodeId = null;
            lastCallInput = null;
          }
          break;
        }
        
        case 'workflow.node.interrupt': {
          if (lastCallNodeId) {
            // Node interrupted - still in progress
            state.inProgressNodes.add(lastCallNodeId);
          }
          break;
        }
        
        case 'workflow.node.resume': {
          // User resumed after interrupt
          if (lastCallNodeId) {
            state.inProgressNodes.add(lastCallNodeId);
          }
          break;
        }
      }
    }
    
    // If there's still a lastCallNodeId in progress without result, keep it as in-progress
    // This means the workflow was interrupted mid-execution
  }
  
  /**
   * Build pending nodes from workflow definition
   */
  @TracedAs("recovery.builder.buildPendingNodes", { recordParams: true, recordResult: true, log: true })
  private buildPendingNodes(definition: WorkflowDefinition, state: ExecutionState): void {
    const nodeIds = new Set((definition.nodes || []).map(n => n.id));
    const allNodeIds = Array.from(nodeIds);
    
    // Determine entry nodes
    const entryNodes = this.getEntryNodes(definition);
    
    // For each entry node, traverse the DAG and mark nodes as pending
    // if they are reachable from an in-progress node and not completed
    for (const entryNode of entryNodes) {
      if (!state.completedNodes.has(entryNode)) {
        this.markPendingFromNode(entryNode, definition, state);
      }
    }
    
    // Also check if any completed node has unexecuted children
    for (const completedId of state.completedNodes) {
      const children = this.getDirectChildren(completedId, definition);
      for (const childId of children) {
        if (!state.completedNodes.has(childId) && !state.inProgressNodes.has(childId)) {
          state.pendingNodes.add(childId);
        }
      }
    }
  }
  
  /**
   * Get entry nodes from workflow definition
   */
  private getEntryNodes(definition: WorkflowDefinition): string[] {
    const entry = definition.entry;
    if (!entry) {
      return [];
    }
    
    if (Array.isArray(entry)) {
      return entry;
    }
    
    return [entry];
  }
  
  /**
   * Mark all nodes as pending starting from a given node
   */
  private markPendingFromNode(
    startNodeId: string,
    definition: WorkflowDefinition,
    state: ExecutionState
  ): void {
    const visited = new Set<string>();
    const queue: string[] = [startNodeId];
    
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      
      if (visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);
      
      // Only add to pending if not completed
      if (!state.completedNodes.has(nodeId)) {
        state.pendingNodes.add(nodeId);
      }
      
      // Queue children
      const children = this.getDirectChildren(nodeId, definition);
      for (const childId of children) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }
  }
  
  /**
   * Get direct children of a node
   */
  private getDirectChildren(nodeId: string, definition: WorkflowDefinition): string[] {
    // Note: In the actual definition, edges might use 'source' and 'target'
    // but for now we need to check both possible formats
    const edges = (definition as any).edges || (definition as any).connections || [];
    
    return edges
      .filter((edge: any) => edge.source === nodeId || edge.from === nodeId)
      .map((edge: any) => edge.target || edge.to);
  }
  
  /**
   * Extract input from a workflow.node.call message
   */
  private extractInput(msg: SessionMessage): unknown {
    try {
      // Try parsing as JSON
      return JSON.parse(msg.content);
    } catch {
      return msg.content;
    }
  }
  
  /**
   * Extract output from a workflow.node.result message
   */
  private extractOutput(msg: SessionMessage): unknown {
    try {
      // Try parsing as JSON
      return JSON.parse(msg.content);
    } catch {
      return msg.content;
    }
  }
  
  /**
   * Extract variables from node output and add to state
   */
  private extractVariables(output: unknown, state: ExecutionState): void {
    if (!output || typeof output !== 'object') {
      return;
    }
    
    const outputObj = output as Record<string, unknown>;
    
    // Add each top-level property as a potential variable
    for (const [key, value] of Object.entries(outputObj)) {
      // Skip internal properties
      if (key.startsWith('_') || key.startsWith('$')) {
        continue;
      }
      
      // Add to variables if not already set
      if (!state.variables.has(key)) {
        state.variables.set(key, value);
      }
    }
  }
}
