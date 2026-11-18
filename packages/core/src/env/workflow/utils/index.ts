/**
 * Workflow Utilities
 */

export { TemplateResolver, resolveTemplates, resolveTemplateString } from './template-resolver';
export type { TemplateResolverOptions, ResolvedValue } from './template-resolver';

// Node ID utilities
export { getFromMapWithNormalization } from './node-id-utils';

// Shared validateWorkflowDefinition helper (wraps DAGManager.validate + template contracts)
export {
  validateWorkflowDefinition,
  type ValidateWorkflowResult,
  type ValidateWorkflowOptions,
} from './validate-workflow-definition';

// Template-reference contract validation (Task #4298)
export {
  validateTemplateContracts,
  getTemplateContractErrors,
  getTemplateContractWarnings,
  formatTemplateContractFindings,
  type TemplateContractFinding,
  type TemplateContractRule,
  type TemplateContractSeverity,
} from './template-contract-validator';
export {
  NODE_OUTPUT_CONTRACTS,
  VIRTUAL_OUTPUT_FIELD,
  RESULT_INVALID_NODE_TYPES,
  getNodeOutputContract,
  hasClosedOutputContract,
  getAgentDeclaredJsonFields,
  type NodeOutputContract,
} from './node-output-contracts';

// Recovery utilities
export { RecoveryValidator } from './recovery-validator';
export { ExecutionStateBuilder } from './execution-state';
export {
  ValidationErrorType,
  SuggestedAction,
} from './validation-rules';
export type {
  ValidationError,
  ValidationResult,
  RecoveryPlan,
  ExecutionState,
} from './validation-rules';

// Sanitizer (Task #2926): persist shell-script bug fixes at write time.
export {
  sanitizeWorkflowDefinition,
  sanitizeShellScript,
} from './workflow-sanitize';
