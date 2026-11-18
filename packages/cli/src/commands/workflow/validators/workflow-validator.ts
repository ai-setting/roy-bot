/**
 * @fileoverview Workflow-level validator
 */

import { ValidationErrorType, type ValidationResult, type RawWorkflowDefinition, type RawNodeDefinition, type ValidationError, type RawWorkflowInput } from './types';
import { getNodeValidator, getSupportedNodeTypes } from './node-validator-factory';
import { validateTemplateContracts as validateTemplateContractsCore } from '@ai-setting/roy-bot-core/env/workflow/utils';

/**
 * Workflow validator - validates both structure and nodes
 */
export class WorkflowValidator {
  /**
   * Validate a raw workflow definition
   */
  validate(workflow: RawWorkflowDefinition): ValidationResult {
    const errors: ValidationError[] = [];
    
    // 1. Structure validation
    const structureErrors = this.validateStructure(workflow);
    errors.push(...structureErrors);
    
    // If structure is invalid, skip node validation
    if (structureErrors.length > 0) {
      return {
        valid: false,
        errors,
        workflowName: typeof workflow.name === 'string' ? workflow.name : undefined,
      };
    }
    
    // 2. Node validation
    const nodes = workflow.nodes || [];
    const nodeIds = new Set<string>();
    const nodeErrors = this.validateNodes(nodes, nodeIds);
    errors.push(...nodeErrors);
    
    // 3. Dependency validation
    const depErrors = this.validateDependencies(nodes, nodeIds);
    errors.push(...depErrors);
    
    // 4. Template reference validation
    const templateErrors = this.validateTemplateReferences(nodes, nodeIds);
    errors.push(...templateErrors);

    // 4b. Template-reference **contract** validation (Task #4298).
    //     Catches field-name/source-type mismatches that the node-existence
    //     check above cannot see — e.g. `{{nodes.<toolNode>.result}}` (tool
    //     nodes expose `.output`; `.result` silently resolves to an empty
    //     string and the run still reports success).
    const contractErrors = this.collectTemplateContractErrors(workflow, nodes);
    errors.push(...contractErrors);
    
    // 5. Bug 2 Fix: Workflow input validation
    // Only validate inputs if explicitly defined (backward compatibility)
    const inputErrors = this.validateWorkflowInputs(nodes, workflow.inputs);
    errors.push(...inputErrors);
    
    return {
      valid: errors.length === 0,
      errors,
      workflowName: workflow.name as string,
      nodeCount: nodes.length,
    };
  }
  
  /**
   * Validate workflow structure
   */
  private validateStructure(workflow: RawWorkflowDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // Check name
    if (!workflow.name || typeof workflow.name !== 'string' || !workflow.name.trim()) {
      errors.push({
        type: ValidationErrorType.MISSING_REQUIRED_FIELD,
        description: 'Workflow name is missing or empty',
        expected: 'name must be a non-empty string',
        actual: String(workflow.name),
        fix: 'Add a "name" field to the workflow, e.g., name: "my-workflow"',
      });
    }
    
    // Check nodes
    if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
      errors.push({
        type: ValidationErrorType.EMPTY_NODES,
        description: 'Workflow nodes is missing or not an array',
        expected: 'nodes must be an array of node definitions',
        actual: String(workflow.nodes),
        fix: 'Add a "nodes" array to the workflow',
      });
      return errors;
    }
    
    if (workflow.nodes.length === 0) {
      errors.push({
        type: ValidationErrorType.EMPTY_NODES,
        description: 'Workflow nodes array is empty',
        expected: 'nodes must contain at least one node',
        actual: '[]',
        fix: 'Add at least one node to the workflow',
      });
    }
    
    return errors;
  }
  
  /**
   * Validate all nodes
   */
  private validateNodes(nodes: RawNodeDefinition[], nodeIds: Set<string>): ValidationError[] {
    const errors: ValidationError[] = [];
    const seenIds = new Set<string>();
    
    for (const node of nodes) {
      // Check for duplicate IDs
      if (node.id) {
        if (seenIds.has(node.id)) {
          errors.push({
            type: ValidationErrorType.DUPLICATE_NODE_ID,
            description: `Duplicate node ID found: "${node.id}"`,
            expected: 'Each node must have a unique ID',
            actual: `ID "${node.id}" appears multiple times`,
            fix: `Rename one of the nodes with ID "${node.id}" to a unique value`,
            nodeId: node.id,
          });
        }
        seenIds.add(node.id);
        nodeIds.add(node.id);
      }
      
      // Validate node type
      if (!node.type) {
        errors.push({
          type: ValidationErrorType.MISSING_REQUIRED_FIELD,
          description: 'Node type is missing',
          expected: `type must be one of: ${getSupportedNodeTypes().join(', ')}`,
          actual: 'undefined',
          fix: `Add a "type" field to the node, e.g., type: "tool"`,
          nodeId: node.id,
        });
        continue;
      }
      
      // Get validator for node type
      const validator = getNodeValidator(node.type);
      if (!validator) {
        errors.push({
          type: ValidationErrorType.INVALID_NODE_TYPE,
          description: `Unknown node type: "${node.type}"`,
          expected: `type must be one of: ${getSupportedNodeTypes().join(', ')}`,
          actual: String(node.type),
          fix: `Change type to one of: ${getSupportedNodeTypes().join(', ')}`,
          nodeId: node.id,
        });
        continue;
      }
      
      // Validate with type-specific validator
      const nodeErrors = validator.validate(node);
      errors.push(...nodeErrors);
    }
    
    return errors;
  }
  
  /**
   * Validate node dependencies
   */
  private validateDependencies(nodes: RawNodeDefinition[], nodeIds: Set<string>): ValidationError[] {
    const errors: ValidationError[] = [];
    
    for (const node of nodes) {
      if (!node.depends_on || !Array.isArray(node.depends_on)) continue;
      
      for (const depId of node.depends_on) {
        if (!nodeIds.has(depId)) {
          errors.push({
            type: ValidationErrorType.INVALID_REFERENCE,
            description: `depends_on references non-existent node`,
            expected: 'All node IDs in depends_on must exist in workflow',
            actual: `depends_on: ["${depId}"], but "${depId}" not found`,
            fix: `Remove "${depId}" from depends_on or create a node with that ID`,
            nodeId: node.id,
          });
        }
      }
    }
    
    // Check for circular dependencies
    const circularErrors = this.detectCircularDependencies(nodes);
    errors.push(...circularErrors);
    
    return errors;
  }
  
  /**
   * Validate template references in node configs
   * 
   * Extracts all template references like {{nodes.xxx.output}}, {{xxx.output}}, ${xxx.output}
   * and validates that the referenced node IDs exist in the workflow.
   */
  /**
   * Layer-2 template-reference **contract** validation (Task #4298).
   *
   * Delegates to the shared core validator
   * (`@ai-setting/roy-bot-core/env/workflow/utils` → `validateTemplateContracts`)
   * so the CLI and the `workflow_validate` / `workflow_add` tools enforce the
   * exact same node-output contract table.
   *
   * Only `error`-severity findings become CLI validation errors; `warning` /
   * `info` findings stay advisory (the CLI has no channel for those yet).
   *
   * Why this exists: the node-existence check above happily accepts
   * `{{nodes.<toolNode>.result}}` — the node exists, so it passes — yet at
   * runtime the engine resolves it to an empty string (tool nodes expose
   * `.output`, not `.result`) and the workflow still reports `completed`.
   */
  private collectTemplateContractErrors(
    workflow: RawWorkflowDefinition,
    nodes: RawNodeDefinition[],
  ): ValidationError[] {
    if (nodes.length === 0) return [];

    try {
      const findings = validateTemplateContractsCore({
        ...(workflow as unknown as Record<string, unknown>),
        nodes,
      } as unknown);

      return findings
        .filter((f) => f.severity === "error")
        .map((f) => ({
          type: ValidationErrorType.INVALID_TEMPLATE_REFERENCE,
          // Prefix with the rule tag so the CLI output is greppable and matches
          // the wording produced by the core validator / workflow_validate tool.
          description: `[template-contract:${f.rule}] ${f.message}`,
          expected: "Template field must match the source node's output contract",
          actual: `Template "${f.template}" references a field the source node (${f.sourceNodeType ?? "?"}) does not expose`,
          fix: f.suggestion
            ? `Change it to "${f.suggestion}"`
            : "Use the source node's declared output field (see node output contracts)",
          nodeId: f.nodeId,
          template: f.template,
          referencedNodeId: f.sourceNodeId,
        }));
    } catch {
      // Defensive: contract validation must never break the CLI validator.
      return [];
    }
  }

  private validateTemplateReferences(nodes: RawNodeDefinition[], nodeIds: Set<string>): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // Template reference patterns:
    // 1. {{nodes.nodeId}} or {{nodes.nodeId.path}} or {{nodes.nodeId.path.more}}
    // 2. {{nodeId}} or {{nodeId.path}} (bare node reference)
    // 3. ${nodes.nodeId} or ${nodes.nodeId.path} (dollar-style)
    // 4. ${nodeId} or ${nodeId.path} (dollar-style bare)
    // 5. {{input.key}} - workflow input, not a node reference
    
    const templatePatterns = [
      /\{\{nodes\.([a-zA-Z_][a-zA-Z0-9_-]*)(?:\.[^}]+)?\}\}/g,  // {{nodes.xxx}} or {{nodes.xxx.yyy}}
      /\{\{([a-zA-Z_][a-zA-Z0-9_-]*)(?:\.[^}]+)?\}\}/g,          // {{xxx}} or {{xxx.yyy}} (not input or nodes)
      /\$\{nodes\.([a-zA-Z_][a-zA-Z0-9_-]*)(?:\.[^}]+)?\}/g,     // ${nodes.xxx} or ${nodes.xxx.yyy}
      /\$\{([a-zA-Z_][a-zA-Z0-9_-]*)(?:\.[^}]+)?\}/g,            // ${xxx} or ${xxx.yyy}
    ];
    
    for (const node of nodes) {
      if (!node.id || !node.config) continue;
      
      // Get all config values as strings to search for templates
      const configStr = JSON.stringify(node.config);
      
      // Find all template references
      const foundRefs = new Set<string>();
      
      for (const pattern of templatePatterns) {
        pattern.lastIndex = 0;  // Reset regex state
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(configStr)) !== null) {
          // Skip 'input' and 'nodes' keywords
          const refId = match[1];
          if (refId !== 'input' && refId !== 'nodes') {
            foundRefs.add(refId);
          }
        }
      }
      
      // Check each reference against node IDs
      for (const refId of foundRefs) {
        if (!nodeIds.has(refId)) {
          // Check if there's a similar node ID (hyphen/underscore mismatch)
          const normalizedRef = refId.includes('-') 
            ? refId.replace(/-/g, '_') 
            : refId.replace(/_/g, '-');
          
          let fix: string;
          if (nodeIds.has(normalizedRef)) {
            fix = `Change "${refId}" to "${normalizedRef}" to match the existing node ID`;
          } else {
            // Find all existing node IDs that are similar (for suggestions)
            const similarIds = Array.from(nodeIds).filter(id => {
              const n1 = id.replace(/-/g, '_').replace(/_/g, '-');
              const n2 = refId.replace(/-/g, '_').replace(/_/g, '-');
              return n1 === n2;
            });
            
            if (similarIds.length > 0) {
              fix = `Change "${refId}" to one of: ${similarIds.join(', ')}`;
            } else {
              fix = `Remove "${refId}" or create a node with that ID`;
            }
          }
          
          errors.push({
            type: ValidationErrorType.INVALID_TEMPLATE_REFERENCE,
            description: `Template references non-existent node: "${refId}"`,
            expected: `Referenced node ID must exist in the workflow`,
            actual: `Template references "${refId}" but this node does not exist`,
            fix,
            nodeId: node.id,
            template: `{{${refId}}}`,
            referencedNodeId: refId,
          });
        }
      }
    }
    
    return errors;
  }
  
  /**
   * Detect circular dependencies using DFS
   */
  private detectCircularDependencies(nodes: RawNodeDefinition[]): ValidationError[] {
    const errors: ValidationError[] = [];
    const nodeMap = new Map<string, RawNodeDefinition>();
    
    for (const node of nodes) {
      if (node.id) nodeMap.set(node.id, node);
    }
    
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const dfs = (nodeId: string, path: string[]): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      
      const node = nodeMap.get(nodeId);
      if (!node) return false;
      
      for (const depId of node.depends_on || []) {
        if (!visited.has(depId)) {
          if (dfs(depId, [...path, depId])) return true;
        } else if (recursionStack.has(depId)) {
          errors.push({
            type: ValidationErrorType.CIRCULAR_DEPENDENCY,
            description: 'Circular dependency detected',
            expected: 'Workflow should be a DAG (no cycles)',
            actual: `Cycle: ${[...path, depId].join(' → ')} → ${depId}`,
            fix: 'Remove the circular dependency by changing depends_on references',
            nodeId,
          });
          return true;
        }
      }
      
      recursionStack.delete(nodeId);
      return false;
    };
    
    for (const node of nodes) {
      if (node.id && !visited.has(node.id)) {
        dfs(node.id, [node.id]);
      }
    }
    
    return errors;
  }
  
  /**
   * Bug 2 Fix: Validate workflow inputs and input template references
   *
   * Checks:
   * 1. Required inputs are defined with defaults or referenced inputs are defined
   * 2. All {{input.xxx}} template references have corresponding input definitions
   *    (unless they have a default filter like {{input.xxx | default('value')}})
   * 
   * Note: Only validates if workflow has an explicit 'inputs' array defined.
   * If 'inputs' is not defined (backward compatibility), skips validation.
   */
  private validateWorkflowInputs(nodes: RawNodeDefinition[], inputs: RawWorkflowInput[] | undefined): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // If workflow doesn't define inputs, skip validation (backward compatibility)
    if (!inputs || !Array.isArray(inputs)) {
      return errors;
    }
    
    const definedInputs = new Set(inputs.map(i => i.name));

    // Extract all input template references
    const inputTemplatePattern = /\{\{input\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
    const dollarInputPattern = /\$\{input\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
    const referencedInputs = new Set<string>();

    for (const node of nodes) {
      if (!node.config) continue;
      const configStr = JSON.stringify(node.config);

      // Find {{input.xxx}} references
      let match: RegExpExecArray | null;
      inputTemplatePattern.lastIndex = 0;
      while ((match = inputTemplatePattern.exec(configStr)) !== null) {
        referencedInputs.add(match[1]);
      }

      // Find ${input.xxx} references
      dollarInputPattern.lastIndex = 0;
      while ((match = dollarInputPattern.exec(configStr)) !== null) {
        referencedInputs.add(match[1]);
      }
    }

    // Check each referenced input
    for (const ref of referencedInputs) {
      // Skip if defined in inputs
      if (definedInputs.has(ref)) continue;

      // Check if has default filter
      const hasDefault = this.inputHasDefaultFilter(ref, nodes);
      if (hasDefault) continue;

      // Undefined input reference without default
      errors.push({
        type: ValidationErrorType.UNDEFINED_INPUT_REFERENCE,
        description: `Template references undefined input: "${ref}"`,
        expected: `Define "${ref}" in workflow inputs array or use default filter`,
        actual: `{{input.${ref}}}`,
        fix: `Add "${ref}" to the inputs array, e.g.: inputs: [{ name: "${ref}", type: "string", required: true }]`,
      });
    }

    return errors;
  }

  /**
   * Check if an input reference has a default filter
   * e.g., {{input.symbol | default('AAPL')}} has default filter
   */
  private inputHasDefaultFilter(inputName: string, nodes: RawNodeDefinition[]): boolean {
    for (const node of nodes) {
      if (!node.config) continue;
      const configStr = JSON.stringify(node.config);

      // Check for default filter pattern in the config string
      // JSON.stringify escapes quotes, so we look for:
      // - "input.symbol|default" followed by anything until ")"
      // The pattern "default(" followed by ")" indicates a default filter
      
      // Match patterns like:
      // - "input.symbol|default(\"AAPL\")" 
      // - 'input.symbol|default("AAPL")'
      // - "input.symbol | default(\"value\")"
      const defaultFilterRegex = new RegExp(
        'input\\.' + inputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|\\s*default\\s*\\(',
        'g'
      );

      if (defaultFilterRegex.test(configStr)) {
        return true;
      }
    }

    return false;
  }
}
