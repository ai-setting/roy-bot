import { z } from 'zod';

/**
 * Edge Definition Schema
 * Represents a directed edge between two nodes with optional condition
 */
export const EdgeDefinitionSchema = z.object({
  from: z.string().min(1, 'Edge source node ID is required'),
  to: z.string().min(1, 'Edge target node ID is required'),
  when: z.string().optional(),  // Condition expression
});

export type EdgeDefinition = z.infer<typeof EdgeDefinitionSchema>;

/** Result of evaluating outgoing edges after a node completes */
export interface EdgeProcessingResult {
  /** Node IDs that should be started */
  toStart: string[];
  /** Node IDs re-entered from completed state (back-edges) */
  reEntries: string[];
  /** Nodes skipped due to false edge conditions */
  skipped: Array<{ nodeId: string; reason: string }>;
  /** Nodes reset for re-entry (includes downstream cascade) */
  resetNodes: string[];
}
