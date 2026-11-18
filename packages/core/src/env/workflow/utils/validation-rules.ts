/**
 * Validation Rules for Workflow Recovery
 * 
 * Defines types for validation errors, results, and recovery plans.
 */

// ==================== Validation Error Types ====================

/**
 * Validation error types for workflow recovery
 */
export enum ValidationErrorType {
  /** Variable referenced by node input is missing */
  MISSING_VARIABLE = 'MISSING_VARIABLE',
  
  /** Parallel branch is incomplete */
  INCOMPLETE_PARALLEL = 'INCOMPLETE_PARALLEL',
  
  /** Condition branch cannot be determined */
  AMBIGUOUS_BRANCH = 'AMBIGUOUS_BRANCH',
  
  /** Loop state is lost */
  LOOP_STATE_LOST = 'LOOP_STATE_LOST',
  
  /** Nested workflow state is invalid */
  NESTED_WORKFLOW_INVALID = 'NESTED_WORKFLOW_INVALID',
  
  /** Node execution state is inconsistent */
  NODE_STATE_INCONSISTENT = 'NODE_STATE_INCONSISTENT',
  
  /** Critical dependency is missing */
  MISSING_DEPENDENCY = 'MISSING_DEPENDENCY',
}

// ==================== Suggested Actions ====================

/**
 * Suggested actions for recovery
 */
export enum SuggestedAction {
  /** Re-run the workflow from the beginning */
  RE_RUN = 'RE_RUN',
  
  /** Confirm with user before proceeding */
  CONFIRM = 'CONFIRM',
  
  /** Skip the problematic node */
  SKIP = 'SKIP',
  
  /** Provide the missing value */
  PROVIDE_VALUE = 'PROVIDE_VALUE',
  
  /** Ignore the warning and proceed */
  IGNORE = 'IGNORE',
}

// ==================== Validation Error ====================

/**
 * Validation error detail
 */
export interface ValidationError {
  /** Error type */
  type: ValidationErrorType;
  
  /** Node ID where error occurred */
  nodeId: string;
  
  /** Human-readable error description */
  description: string;
  
  /** Suggested action to resolve */
  suggestedAction: SuggestedAction;
  
  /** Additional context information */
  context?: Record<string, unknown>;
}

// ==================== Validation Result ====================

/**
 * Result of validation
 */
export interface ValidationResult {
  /** Whether the workflow can be safely resumed */
  isValid: boolean;
  
  /** List of validation errors */
  errors: ValidationError[];
  
  /** List of warnings (non-critical issues) */
  warnings: string[];
}

// ==================== Recovery Plan ====================

/**
 * Recovery plan for resuming a workflow
 */
export interface RecoveryPlan {
  /** Whether the workflow can be resumed */
  canResume: boolean;
  
  /** Node ID where execution should resume */
  resumePoint: string;
  
  /** List of completed node IDs */
  completedNodes: string[];
  
  /** List of pending node IDs */
  pendingNodes: string[];
  
  /** List of node IDs that will be skipped */
  skippedNodes: string[];
  
  /** Validation errors encountered */
  validationErrors: ValidationError[];
  
  /** Human-readable summary */
  summary: string;
}

// ==================== Execution State ====================

/**
 * Execution state of a workflow
 */
export interface ExecutionState {
  /** Set of completed node IDs */
  completedNodes: Set<string>;
  
  /** Set of in-progress node IDs */
  inProgressNodes: Set<string>;
  
  /** Set of pending node IDs */
  pendingNodes: Set<string>;
  
  /** Map of node ID to output */
  nodeOutputs: Map<string, unknown>;
  
  /** Map of node ID to input */
  nodeInputs: Map<string, unknown>;
  
  /** Map of variable name to value */
  variables: Map<string, unknown>;
  
  /** Loop iteration counts */
  loopCounts: Map<string, number>;
}
