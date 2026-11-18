/**
 * @fileoverview NodeRegistry - Registry for creating Node instances
 * 
 * NodeRegistry manages node creation from NodeDefinition instances.
 * It provides:
 * - Built-in node types: tool, skill, agent, workflow
 * - Custom node type registration via factory functions
 * - Node creation based on node type
 */

import type { Node, NodeDefinition, NodeExecutionContext } from '../types/index';
import { EventBus } from './event-bus';
import { ToolNode } from '../nodes/tool-node';
import type { ToolRegistry } from '../nodes/tool-node';
import { SkillNode } from '../nodes/skill-node';
import type { SkillRegistry } from '../nodes/skill-node';
import { AgentNode } from '../nodes/agent-node';
import type { AgentRunner } from '../nodes/agent-node';
import { AgentComponentAdapter } from '../nodes/agent-component-adapter';
import { WorkflowNode } from '../nodes/workflow-node';
import type { WorkflowRunner } from '../nodes/workflow-node';

// AgentComponent 类型（可选依赖）
import type { AgentComponent } from '../../agent/agent-component';
import type { SessionComponent } from '../../session/session-component';
import { AskUserNode } from '../nodes/ask-user-node';
import { PythonCallNode } from '../nodes/python-call-node';
import { TracedAs } from '../../log-trace/decorator';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * NodeRegistry initialization options
 */
export interface NodeRegistryOptions {
  /** Registry for looking up tools */
  toolRegistry?: ToolRegistry;
  /** Registry for looking up skills */
  skillRegistry?: SkillRegistry;
  /** AgentComponent for executing agent nodes (auto-creates adapter) */
  agentComponent?: AgentComponent;
  /** Explicit AgentRunner (takes precedence over agentComponent) */
  agentRunner?: AgentRunner;
  /** Runner for executing workflow nodes */
  workflowRunner?: WorkflowRunner;
  /** Session component for agent session management */
  sessionComponent?: SessionComponent;
  /** @deprecated Use agentRunner instead */
  agentRunner2?: AgentRunner;
}

/**
 * NodeContext for node creation
 * 
 * Context information passed to node factories when creating nodes.
 */
export interface NodeContext {
  /** Run ID for this workflow execution */
  runId: string;
  /** Workflow name */
  workflowName: string;
  /** Event bus for workflow events */
  eventBus: EventBus;
  /** Debug mode flag */
  debug: boolean;
}

/**
 * NodeFactory function type
 * 
 * Factory function that creates a Node instance from a NodeDefinition.
 */
export type NodeFactory = (
  definition: NodeDefinition,
  context: NodeContext
) => Node;

// ============================================================================
// NodeRegistry Class
// ============================================================================

/**
 * NodeRegistry
 * 
 * Registry for creating Node instances from NodeDefinition.
 * 
 * Features:
 * - Built-in node types: tool, skill, agent, workflow
 * - Custom node type registration via factory functions
 * - Node creation based on node type
 * 
 * @example
 * ```typescript
 * const registry = new NodeRegistry(
 *   toolRegistry,
 *   skillRegistry,
 *   agentRunner,
 *   workflowRunner
 * );
 * 
 * // Register custom node type
 * registry.register('custom', (definition, context) => {
 *   return new CustomNode(definition);
 * });
 * 
 * // Create node from definition
 * const node = registry.createNode(definition);
 * ```
 */
export class NodeRegistry {
  /** Map of registered node factories by type */
  private factories: Map<string, NodeFactory> = new Map();
  
  /** Tool registry for looking up tools */
  private toolRegistry?: ToolRegistry;
  
  /** Skill registry for looking up skills */
  private skillRegistry?: SkillRegistry;
  
  /** Agent runner for executing agent nodes */
  private agentRunner?: AgentRunner;
  
  /** Workflow runner for executing workflow nodes */
  private workflowRunner?: WorkflowRunner;
  
  /** AgentComponent adapter (auto-created if agentComponent is provided) */
  private agentComponentAdapter?: AgentComponentAdapter;
  
  /** Session component for agent session management */
  private sessionComponent?: SessionComponent;

  /**
   * Create a new NodeRegistry
   * 
   * @param options - Registry options
   * @param options.toolRegistry - Registry for looking up tools (optional)
   * @param options.skillRegistry - Registry for looking up skills (optional)
   * @param options.agentComponent - AgentComponent for executing agent nodes (optional, auto-creates adapter)
   * @param options.agentRunner - Explicit AgentRunner (takes precedence over agentComponent)
   * @param options.workflowRunner - Runner for executing workflow nodes (optional)
   * @param options.sessionComponent - Session component for agent session management (optional)
   */
  constructor(options?: NodeRegistryOptions) {
    const {
      toolRegistry,
      skillRegistry,
      agentComponent,
      agentRunner,
      workflowRunner,
      sessionComponent,
    } = options ?? {};
    
    // Store registries
    this.toolRegistry = toolRegistry;
    this.skillRegistry = skillRegistry;
    this.workflowRunner = workflowRunner;
    this.sessionComponent = sessionComponent;
    
    // Create AgentRunner: 
    // 1. Use explicit agentRunner if provided
    // 2. Otherwise, auto-create from agentComponent if provided
    if (agentRunner) {
      this.agentRunner = agentRunner;
      // If agentRunner is an AgentComponentAdapter, set session component
      if (agentRunner.setSessionComponent && sessionComponent) {
        agentRunner.setSessionComponent(sessionComponent);
      }
    } else if (agentComponent) {
      this.agentComponentAdapter = new AgentComponentAdapter(
        agentComponent,
        {},
        sessionComponent
      );
      this.agentRunner = this.agentComponentAdapter;
    }
    
    // Register built-in node types
    this.registerBuiltInTypes();
  }
  
  /**
   * Get the AgentComponentAdapter if available
   */
  getAgentAdapter(): AgentComponentAdapter | undefined {
    return (this as any).agentComponentAdapter;
  }
  
  /**
   * Get the AgentRunner
   */
  getAgentRunner(): AgentRunner | undefined {
    return (this as any).agentRunner;
  }
  
  /**
   * Get the SessionComponent
   */
  getSessionComponent(): SessionComponent | undefined {
    return (this as any).sessionComponent;
  }

  /**
   * Register built-in node types
   */
  private registerBuiltInTypes(): void {
    // Register 'tool' node type
    this.factories.set('tool', (definition) => {
      if (!this.toolRegistry) {
        throw new Error('ToolRegistry is required for tool nodes');
      }
      return new ToolNode(definition, this.toolRegistry);
    });

    // Register 'skill' node type
    this.factories.set('skill', (definition) => {
      if (!this.skillRegistry) {
        throw new Error('SkillRegistry is required for skill nodes');
      }
      return new SkillNode(definition, this.skillRegistry);
    });

    // Register 'agent' node type
    this.factories.set('agent', (definition) => {
      if (!this.agentRunner) {
        throw new Error('AgentRunner is required for agent nodes');
      }
      return new AgentNode(definition, this.agentRunner);
    });

    // Register 'workflow' node type
    this.factories.set('workflow', (definition) => {
      if (!this.workflowRunner) {
        throw new Error('WorkflowRunner is required for workflow nodes');
      }
      return new WorkflowNode(definition, this.workflowRunner);
    });

    // Register 'ask_user' node type
    this.factories.set('ask_user', (definition) => {
      return new AskUserNode(definition);
    });

    // Register 'python_call' node type (Task #1998)
    // Decouples workflows from hardcoded paths like .venv/bin/python scripts/*.py
    // by invoking a Python function (module.fn) via a clean subprocess call.
    this.factories.set('python_call', (definition) => {
      return new PythonCallNode(definition);
    });
  }

  /**
   * Register a custom node factory
   * 
   * @param type - Node type identifier
   * @param factory - Factory function to create nodes of this type
   */
  register(type: string, factory: NodeFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * Check if a node type is registered
   * 
   * @param type - Node type identifier
   * @returns True if the type is registered
   */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * List all registered node types
   * 
   * @returns Array of registered type names
   */
  list(): string[] {
    return Array.from(this.factories.keys());
  }

  /**
   * Create a Node instance from a NodeDefinition
   * 
   * @param definition - Node definition
   * @param context - Node context (optional, for future use)
   * @returns Node instance
   * @throws Error if the node type is not registered
   */
  @TracedAs("workflow.node-registry.createNode", { recordParams: false, recordResult: false })
  createNode(definition: NodeDefinition, context?: NodeContext): Node {
    const factory = this.factories.get(definition.type);

    if (!factory) {
      const availableTypes = this.list().join(', ');
      throw new Error(
        `Unknown node type: ${definition.type}. Available types: ${availableTypes}`
      );
    }

    return factory(definition, context!);
  }
}
