import type {
  WorkflowDefinition,
  NodeDefinition,
  WorkflowDefinitionExtended,
  LoopGuardConfig,
} from '../types';
import { LoopGuardConfigSchema } from '../types';
import type { EdgeDefinition } from '../types/edge';
import { TracedAs } from '../../log-trace/decorator';

/**
 * DAG Analysis Result
 */
export interface DAGAnalysis {
  /** 入口节点（无依赖） */
  entryNodes: string[];
  /** 出口节点（无下游） */
  exitNodes: string[];
  /** 按层级组织的节点，用于并行执行 */
  levels: string[][];
  /** 每个节点的依赖 */
  dependencies: Map<string, string[]>;
  /** 每个节点的下游 */
  dependents: Map<string, string[]>;
  /** 关键路径 */
  criticalPath: string[];
}

/**
 * DAG Manager
 * 
 * Manages Directed Acyclic Graph (DAG) operations for workflow execution.
 * Provides analysis, topological sorting, and validation of workflow structures.
 * 
 * Supports two modes:
 * - DAG mode (default): enforces acyclic graph, throws on cycles
 * - Loop mode (allowCycles=true): allows cycles for workflow loops
 */
export class DAGManager {
  private workflow: WorkflowDefinition;
  private nodeMap: Map<string, NodeDefinition>;
  private extendedDefinition: WorkflowDefinitionExtended | null = null;
  private cachedAnalysis: DAGAnalysis | null = null;
  /** Allow cycles in the workflow (for loop/cycle support) */
  private allowCycles: boolean;

  /**
   * @param workflow - The workflow definition
   * @param options - Options
   * @param options.allowCycles - If true, allows cycles in the workflow (for loop support)
   */
  constructor(workflow: WorkflowDefinition, options?: { allowCycles?: boolean }) {
    // Validate basic structure
    if (!workflow.nodes || workflow.nodes.length === 0) {
      throw new Error('At least one node is required');
    }

    this.workflow = workflow;
    this.nodeMap = new Map();
    this.allowCycles = options?.allowCycles ?? false;
    
    // Build node map
    for (const node of workflow.nodes) {
      if (node.id === '') {
        throw new Error('Node ID cannot be empty');
      }
      if (this.nodeMap.has(node.id)) {
        throw new Error(`Duplicate node ID: ${node.id}`);
      }
      this.nodeMap.set(node.id, node);
    }
  }

  /**
   * Get extended workflow definition with computed properties
   */
  getExtendedDefinition(): WorkflowDefinitionExtended {
    if (this.extendedDefinition) {
      return this.extendedDefinition;
    }

    const analysis = this.analyze();
    
    this.extendedDefinition = {
      ...this.workflow,
      computedEntry: analysis.entryNodes,
      nodeMap: this.nodeMap,
      topologicalOrder: this.getTopologicalOrder(),
    };

    return this.extendedDefinition;
  }

  /**
   * Analyze the DAG structure
   */
  analyze(): DAGAnalysis {
    if (this.cachedAnalysis) {
      return this.cachedAnalysis;
    }

    // Compute dependencies map
    const dependencies = this.buildDependenciesMap();
    
    // Compute dependents map (reverse of dependencies)
    const dependents = this.buildDependentsMap(dependencies);
    
    // Find entry nodes (no incoming edges)
    const entryNodes = this.findEntryNodes(dependencies);
    
    // Find exit nodes (no outgoing edges)
    const exitNodes = this.findExitNodes(dependents);
    
    // Compute levels for parallel execution
    const levels = this.computeLevels(dependencies);
    
    // Find critical path
    const criticalPath = this.findCriticalPath(levels, dependencies);

    this.cachedAnalysis = {
      entryNodes,
      exitNodes,
      levels,
      dependencies,
      dependents,
      criticalPath,
    };

    return this.cachedAnalysis;
  }

  /**
   * Build a map of node dependencies
   */
  private buildDependenciesMap(): Map<string, string[]> {
    const dependencies = new Map<string, string[]>();
    
    // 1. Initialize from explicit depends_on
    for (const node of this.workflow.nodes) {
      const deps = node.depends_on || [];
      dependencies.set(node.id, [...deps]);
    }
    
    // 2. Derive dependencies from ALL edges (both conditional and unconditional).
    //    An edge A → B means B depends on A for execution ordering.
    //    To avoid creating cycles (e.g., loop-back edges like verify → plan),
    //    we skip edges whose target 'to' is already reachable from 'from'
    //    via existing dependencies (i.e., adding this edge would create a cycle).
    if (this.workflow.edges) {
      for (const edge of this.workflow.edges) {
        const targetDeps = dependencies.get(edge.to);
        if (!targetDeps) continue;
        if (targetDeps.includes(edge.from)) continue;
        
        // Check if edge.to is already reachable from edge.from via existing deps.
        // If so, adding edge.from as a dependency of edge.to would create a cycle → skip.
        // Example: edge verify → plan. If plan is already reachable from verify
        // (via existing deps), adding verify → plan would create a cycle.
        if (!this.isReachable(edge.from, edge.to, dependencies)) {
          targetDeps.push(edge.from);
        }
      }
    }
    
    return dependencies;
  }

  /**
   * Check if 'target' is reachable from 'source' by following existing dependencies (BFS).
   */
  private isReachable(source: string, target: string, dependencies: Map<string, string[]>): boolean {
    if (source === target) return true;
    const visited = new Set<string>();
    const queue = [source];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = dependencies.get(current) || [];
      for (const dep of deps) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
    return false;
  }

  /**
   * Build a map of node dependents (reverse of dependencies)
   */
  private buildDependentsMap(dependencies: Map<string, string[]>): Map<string, string[]> {
    const dependentsMap = new Map<string, string[]>();
    
    // Initialize all nodes with empty dependents
    for (const nodeId of dependencies.keys()) {
      dependentsMap.set(nodeId, []);
    }
    
    // Populate dependents
    for (const [nodeId, deps] of dependencies.entries()) {
      for (const dep of deps) {
        const nodeDependents = dependentsMap.get(dep) || [];
        nodeDependents.push(nodeId);
        dependentsMap.set(dep, nodeDependents);
      }
    }
    
    return dependentsMap;
  }

  /**
   * Find entry nodes (nodes with no dependencies)
   */
  private findEntryNodes(dependencies: Map<string, string[]>): string[] {
    const entryNodes: string[] = [];
    
    for (const [nodeId, deps] of dependencies.entries()) {
      if (deps.length === 0) {
        entryNodes.push(nodeId);
      }
    }
    
    return entryNodes;
  }

  /**
   * Find exit nodes (nodes with no dependents)
   */
  private findExitNodes(dependents: Map<string, string[]>): string[] {
    const exitNodes: string[] = [];
    
    for (const [nodeId, deps] of dependents.entries()) {
      if (deps.length === 0) {
        exitNodes.push(nodeId);
      }
    }
    
    return exitNodes;
  }

  /**
   * Compute levels for parallel execution
   * Nodes at the same level can be executed in parallel
   */
  private computeLevels(dependencies: Map<string, string[]>): string[][] {
    const levels: string[][] = [];
    const assigned = new Set<string>();
    const nodeLevels = new Map<string, number>();
    
    // Build dependents map for efficient lookup
    const dependentsMap = this.buildDependentsMap(dependencies);
    
    // Calculate level for each node (BFS from entry nodes)
    const entryNodes = this.findEntryNodes(dependencies);
    
    // Initialize entry nodes at level 0
    const queue: Array<{ nodeId: string; level: number }> = [];
    for (const entry of entryNodes) {
      queue.push({ nodeId: entry, level: 0 });
      nodeLevels.set(entry, 0);
    }
    
    // BFS to compute levels
    while (queue.length > 0) {
      const { nodeId, level } = queue.shift()!;
      
      if (assigned.has(nodeId)) {
        // Update to maximum level if already assigned
        const currentLevel = nodeLevels.get(nodeId) || 0;
        if (level > currentLevel) {
          nodeLevels.set(nodeId, level);
        }
        continue;
      }
      
      assigned.add(nodeId);
      nodeLevels.set(nodeId, level);
      
      // Add dependents to queue with level + 1
      const dependentsOfNode = dependentsMap.get(nodeId) || [];
      for (const dependent of dependentsOfNode) {
        if (!assigned.has(dependent)) {
          queue.push({ nodeId: dependent, level: level + 1 });
        }
      }
    }
    
    // Handle nodes not reachable from entry nodes (shouldn't happen in valid DAG)
    for (const nodeId of dependencies.keys()) {
      if (!nodeLevels.has(nodeId)) {
        nodeLevels.set(nodeId, 0);
      }
    }
    
    // Group nodes by level
    const maxLevel = Math.max(...nodeLevels.values(), 0);
    for (let i = 0; i <= maxLevel; i++) {
      levels.push([]);
    }
    
    for (const [nodeId, level] of nodeLevels.entries()) {
      levels[level].push(nodeId);
    }
    
    return levels;
  }

  /**
   * Find critical path (longest path through the DAG)
   */
  private findCriticalPath(levels: string[][], dependencies: Map<string, string[]>): string[] {
    if (levels.length === 0) {
      return [];
    }
    
    // DP: longest path ending at each node
    const longestPath = new Map<string, { length: number; path: string[] }>();
    
    // Process nodes in reverse topological order
    const allNodes: string[] = [];
    for (const level of levels) {
      allNodes.push(...level);
    }
    
    for (const nodeId of allNodes) {
      const deps = dependencies.get(nodeId) || [];
      
      if (deps.length === 0) {
        longestPath.set(nodeId, { length: 1, path: [nodeId] });
      } else {
        let maxLength = 0;
        let maxPath: string[] = [];
        
        for (const dep of deps) {
          const depInfo = longestPath.get(dep);
          if (depInfo && depInfo.length > maxLength) {
            maxLength = depInfo.length;
            maxPath = depInfo.path;
          }
        }
        
        longestPath.set(nodeId, { 
          length: maxLength + 1, 
          path: [...maxPath, nodeId] 
        });
      }
    }
    
    // Find the longest path
    let maxLength = 0;
    let criticalPath: string[] = [];
    
    for (const [, info] of longestPath.entries()) {
      if (info.length > maxLength) {
        maxLength = info.length;
        criticalPath = info.path;
      }
    }
    
    return criticalPath;
  }

  /**
   * Get topological order using Kahn's algorithm
   */
  getTopologicalOrder(): string[] {
    const dependencies = this.buildDependenciesMap();
    const dependents = this.buildDependentsMap(dependencies);
    
    // Calculate in-degree for each node
    const inDegree = new Map<string, number>();
    for (const nodeId of dependencies.keys()) {
      inDegree.set(nodeId, dependencies.get(nodeId)?.length || 0);
    }
    
    // Start with nodes that have no dependencies
    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }
    
    const result: string[] = [];
    
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);
      
      // Reduce in-degree for dependents
      const nodeDependents = dependents.get(nodeId) || [];
      for (const dependent of nodeDependents) {
        const currentDegree = inDegree.get(dependent) || 0;
        inDegree.set(dependent, currentDegree - 1);
        
        if (currentDegree - 1 === 0) {
          queue.push(dependent);
        }
      }
    }
    
    return result;
  }

  /**
   * Get nodes that are ready to execute (dependencies met and not completed)
   */
  getReadyNodes(completedNodes: Set<string>): string[] {
    const dependencies = this.buildDependenciesMap();
    const ready: string[] = [];
    
    for (const nodeId of dependencies.keys()) {
      // Skip already completed nodes
      if (completedNodes.has(nodeId)) {
        continue;
      }
      
      // Check if all dependencies are completed
      if (this.areDependenciesMet(nodeId, completedNodes)) {
        ready.push(nodeId);
      }
    }
    
    return ready;
  }

  /**
   * Check if all dependencies for a node are completed
   * Uses the computed dependency map (which includes edges-derived dependencies)
   */
  @TracedAs('workflow.dag-manager.areDependenciesMet', {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  areDependenciesMet(nodeId: string, completedNodes: Set<string>): boolean {
    const analysis = this.analyze();
    const deps = analysis.dependencies.get(nodeId);
    if (!deps) {
      return true;
    }
    
    for (const dep of deps) {
      if (!completedNodes.has(dep)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Check if the workflow contains a cycle
   */
  isCyclic(): boolean {
    const dependencies = this.buildDependenciesMap();
    
    // Try to get topological order
    const order = this.getTopologicalOrderInternal(dependencies);
    
    // If we can't include all nodes, there's a cycle
    return order.length !== this.workflow.nodes.length;
  }

  /**
   * Internal topological sort that detects cycles
   */
  private getTopologicalOrderInternal(dependencies: Map<string, string[]>): string[] {
    const dependents = this.buildDependentsMap(dependencies);
    
    // Calculate in-degree for each node
    const inDegree = new Map<string, number>();
    for (const nodeId of dependencies.keys()) {
      inDegree.set(nodeId, dependencies.get(nodeId)?.length || 0);
    }
    
    // Start with nodes that have no dependencies
    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }
    
    const result: string[] = [];
    
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);
      
      // Reduce in-degree for dependents
      const nodeDependents = dependents.get(nodeId) || [];
      for (const dependent of nodeDependents) {
        const currentDegree = inDegree.get(dependent) || 0;
        inDegree.set(dependent, currentDegree - 1);
        
        if (currentDegree - 1 === 0) {
          queue.push(dependent);
        }
      }
    }
    
    return result;
  }

  /**
   * Validate the workflow
   * @param options - Validation options
   * @param options.skipCycleCheck - Skip cycle detection (used when allowCycles is enabled)
   */
  validate(options?: { skipCycleCheck?: boolean }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Check for duplicate node IDs
    const nodeIds = new Set<string>();
    for (const node of this.workflow.nodes) {
      if (node.id === '') {
        errors.push('Node ID cannot be empty');
        continue;
      }
      
      if (nodeIds.has(node.id)) {
        errors.push(`Duplicate node ID: ${node.id}`);
      }
      nodeIds.add(node.id);
    }
    
    // Check for missing dependencies
    for (const node of this.workflow.nodes) {
      const deps = node.depends_on || [];
      for (const dep of deps) {
        if (!nodeIds.has(dep)) {
          errors.push(`Node '${node.id}' depends on non-existent node '${dep}'`);
        }
      }
    }
    
    // Check for cycles (skip if allowCycles is enabled or explicitly requested)
    if (!this.allowCycles && !options?.skipCycleCheck && this.isCyclic()) {
      errors.push('Workflow contains a cycle');
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Add a new node to the workflow dynamically
   * 
   * @param node - The node definition to add
   * @throws Error if a node with the same ID already exists
   * @throws Error if the node depends on a non-existent node
   * @throws Error if adding this node would create a cycle
   */
  addNode(node: NodeDefinition): void {
    // Validate node ID
    if (!node.id || node.id.trim() === '') {
      throw new Error('Node ID cannot be empty');
    }
    
    // Check for duplicate node ID
    if (this.nodeMap.has(node.id)) {
      throw new Error(`Node with ID '${node.id}' already exists`);
    }
    
    // Check for missing dependencies
    const deps = node.depends_on || [];
    for (const dep of deps) {
      if (!this.nodeMap.has(dep)) {
        throw new Error(`Cannot add node '${node.id}': depends on non-existent node '${dep}'`);
      }
    }
    
    // Temporarily add the node and check for cycles
    const originalNodes = [...this.workflow.nodes];
    this.workflow.nodes.push(node);
    
    if (this.isCyclic()) {
      // Revert if it creates a cycle
      this.workflow.nodes = originalNodes;
      throw new Error(`Cannot add node '${node.id}': would create a cycle in the workflow`);
    }
    
    // Add to node map
    this.nodeMap.set(node.id, node);
    
    // Clear cached analysis since the DAG has changed
    this.cachedAnalysis = null;
    this.extendedDefinition = null;
  }

  /**
   * Remove a node from the workflow dynamically
   * 
   * @param nodeId - The ID of the node to remove
   * @throws Error if the node doesn't exist
   * @throws Error if other nodes depend on this node
   */
  removeNode(nodeId: string): void {
    // Check if node exists
    if (!this.nodeMap.has(nodeId)) {
      throw new Error(`Node '${nodeId}' does not exist`);
    }
    
    // Check if any nodes depend on this node
    const dependents = this.getDependents(nodeId);
    if (dependents.length > 0) {
      throw new Error(`Cannot remove node '${nodeId}': other nodes depend on it: ${dependents.join(', ')}`);
    }
    
    // Remove from workflow nodes array
    this.workflow.nodes = this.workflow.nodes.filter(n => n.id !== nodeId);
    
    // Remove from node map
    this.nodeMap.delete(nodeId);
    
    // Clear cached analysis since the DAG has changed
    this.cachedAnalysis = null;
    this.extendedDefinition = null;
  }

  /**
   * Get direct dependents of a node (nodes that depend on this node)
   */
  getDependents(nodeId: string): string[] {
    const analysis = this.analyze();
    return analysis.dependents.get(nodeId) || [];
  }

  /**
   * Get downstream nodes on paths from `fromNodeId` toward `untilNodeId` (inclusive).
   * Used to cascade-reset completed nodes when a back-edge re-enters `fromNodeId`.
   */
  getDownstreamUntil(fromNodeId: string, untilNodeId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue = [...this.getDependents(fromNodeId)];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      result.push(nodeId);

      if (nodeId === untilNodeId) {
        continue;
      }

      for (const dependent of this.getDependents(nodeId)) {
        if (!visited.has(dependent)) {
          queue.push(dependent);
        }
      }
    }

    return result;
  }

  /**
   * Get the workflow definition (current state)
   */
  getDefinition(): WorkflowDefinition {
    return this.workflow;
  }

  /**
   * Get a node by ID
   */
  getNode(nodeId: string): NodeDefinition | undefined {
    return this.nodeMap.get(nodeId);
  }

  /**
   * Get the loop_guard config block for a node, or undefined if the node
   * has none. The returned object is the normalized LoopGuardConfig
   * (defaults already applied) that the engine can consume directly.
   *
   * Task #2283 — engine-side back-edge progress guard.
   *
   * Defensive contract: if `config.loop_guard` is missing, malformed, or
   * fails LoopGuardConfigSchema.safeParse, this method returns undefined
   * rather than throwing. Callers can therefore use a simple `if (guard)`
   * check to opt into the guard logic without try/catch.
   */
  getLoopGuard(nodeId: string): LoopGuardConfig | undefined {
    const node = this.nodeMap.get(nodeId);
    if (!node) return undefined;

    const config = (node.config ?? {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(config, 'loop_guard')) {
      return undefined;
    }
    const raw = config.loop_guard;
    if (raw === null || raw === undefined) return undefined;

    const parsed = LoopGuardConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  }

  /**
   * Get all node IDs
   */
  getNodeIds(): string[] {
    return Array.from(this.nodeMap.keys());
  }

  /**
   * Get the number of nodes in the workflow
   */
  getNodeCount(): number {
    return this.nodeMap.size;
  }

  /**
   * Build explicit edges from nodes with inline condition
   * Also derives implicit edges from depends_on if not already defined
   * @param explicitEdges - Array of explicit edge definitions from workflow
   * @returns Combined array of explicit and derived edges
   */
  buildEdges(explicitEdges: EdgeDefinition[] = []): EdgeDefinition[] {
    const derivedEdges: EdgeDefinition[] = [];
    const explicitEdgeSet = new Set(
      explicitEdges.map(e => `${e.from}->${e.to}`)
    );
    
    // 从 depends_on 构建隐式边
    for (const node of this.workflow.nodes) {
      const deps = node.depends_on || [];
      for (const dep of deps) {
        const edgeKey = `${dep}->${node.id}`;
        // 检查是否已有显式边
        if (!explicitEdgeSet.has(edgeKey)) {
          derivedEdges.push({ from: dep, to: node.id });
        }
      }
    }
    
    return [...explicitEdges, ...derivedEdges];
  }
}
