/**
 * @fileoverview Workflow Storage Module
 * 
 * Re-exports all storage components for the workflow component.
 * 
 * Note: After session-based refactoring, workflow runs are now managed via SessionComponent.
 * The workflows table is still used for storing workflow definitions.
 */

// SQLite database utilities
export {
  getDatabase,
  closeDatabase,
  initializeTables,
  getDatabasePath,
  resetDatabase,
  initDatabase,
  type BunDatabase,
} from './sqlite';

// Workflow Repository
export {
  WorkflowRepository,
  rowToWorkflow,
  migrateEmptyTagsToDefault,
  type WorkflowRow,
  type ListWorkflowsOptions,
  type UpdateWorkflowOptions,
} from './workflow-repo';

// v2: Tag Repository
export {
  TagRepository,
  type TagInfo,
} from './tag-repo';
