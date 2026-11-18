/**
 * Test Fixtures - Workflow Definitions for Integration Tests
 */

import type { WorkflowDefinition } from './types';

// Helper to create workflow fixtures without strict type checking
function createWorkflow<T extends object>(def: T): T {
  return def;
}

/**
 * Simple single-node workflow for basic testing
 */
export const singleNodeWorkflow = createWorkflow({
  name: 'single-node-test',
  version: '1.0.0',
  description: 'A simple single-node workflow for testing',
  nodes: [
    {
      id: 'node-1',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Hello from single-node workflow'
        }
      }
    }
  ],
  entry: 'node-1'
});

/**
 * Sequential workflow with three steps
 */
export const sequentialWorkflow = createWorkflow({
  name: 'sequential-test',
  version: '1.0.0',
  description: 'Three-step sequential workflow',
  nodes: [
    {
      id: 'step-1',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Step 1'
        }
      }
    },
    {
      id: 'step-2',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Step 2'
        }
      },
      depends_on: ['step-1']
    },
    {
      id: 'step-3',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Step 3'
        }
      },
      depends_on: ['step-2']
    }
  ],
  entry: 'step-1'
});

/**
 * Parallel workflow with two branches
 */
export const parallelWorkflow = createWorkflow({
  name: 'parallel-test',
  version: '1.0.0',
  description: 'Parallel execution workflow with two branches',
  nodes: [
    {
      id: 'start',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Start'
        }
      }
    },
    {
      id: 'branch-a',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Branch A'
        }
      },
      depends_on: ['start']
    },
    {
      id: 'branch-b',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Branch B'
        }
      },
      depends_on: ['start']
    },
    {
      id: 'merge',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Merge'
        }
      },
      depends_on: ['branch-a', 'branch-b']
    }
  ],
  entry: 'start'
});

/**
 * Diamond workflow - classic DAG pattern
 *     start
 *    /     \
 *  left   right
 *    \     /
 *     merge
 *      |
 *     end
 */
export const diamondWorkflow = createWorkflow({
  name: 'diamond-test',
  version: '1.0.0',
  description: 'Diamond pattern workflow',
  nodes: [
    {
      id: 'start',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Diamond Start'
        }
      }
    },
    {
      id: 'left',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Left Branch'
        }
      },
      depends_on: ['start']
    },
    {
      id: 'right',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Right Branch'
        }
      },
      depends_on: ['start']
    },
    {
      id: 'merge',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Merge'
        }
      },
      depends_on: ['left', 'right']
    },
    {
      id: 'end',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Diamond End'
        }
      },
      depends_on: ['merge']
    }
  ],
  entry: 'start'
});

/**
 * Workflow with conditional execution
 */
export const conditionalWorkflow = createWorkflow({
  name: 'conditional-test',
  version: '1.0.0',
  description: 'Workflow with conditional branching',
  nodes: [
    {
      id: 'input',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'input'
        }
      }
    },
    {
      id: 'check',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Check'
        }
      },
      depends_on: ['input']
    },
    {
      id: 'action-a',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Action A'
        }
      },
      depends_on: ['check']
    },
    {
      id: 'action-b',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Action B'
        }
      },
      depends_on: ['check']
    }
  ],
  entry: 'input'
});

/**
 * Complex multi-level workflow
 */
export const complexWorkflow = createWorkflow({
  name: 'complex-test',
  version: '1.0.0',
  description: 'Complex multi-level workflow',
  nodes: [
    {
      id: 'level1-a',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Level 1 A'
        }
      }
    },
    {
      id: 'level1-b',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Level 1 B'
        }
      }
    },
    {
      id: 'level2-a',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Level 2 A'
        }
      },
      depends_on: ['level1-a']
    },
    {
      id: 'level2-b',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Level 2 B'
        }
      },
      depends_on: ['level1-a', 'level1-b']
    },
    {
      id: 'level3',
      type: 'tool',
      config: {
        tool_name: 'echo',
        tool_args: {
          message: 'Level 3'
        }
      },
      depends_on: ['level2-a', 'level2-b']
    }
  ],
  entry: ['level1-a', 'level1-b']
});

/**
 * Workflow that should fail (tool error)
 */
export const failingWorkflow = createWorkflow({
  name: 'failing-test',
  version: '1.0.0',
  description: 'Workflow that intentionally fails',
  nodes: [
    {
      id: 'fail-node',
      type: 'tool',
      config: {
        tool_name: 'nonexistent-tool',
        tool_args: {}
      }
    }
  ],
  entry: 'fail-node'
});

/**
 * Workflow with timeout (long running)
 */
export const longRunningWorkflow = createWorkflow({
  name: 'long-running-test',
  version: '1.0.0',
  description: 'Workflow with long running node',
  nodes: [
    {
      id: 'sleep-node',
      type: 'tool',
      config: {
        tool_name: 'bash',
        tool_args: {
          command: 'sleep 5 && echo "done"'
        }
      }
    }
  ],
  entry: 'sleep-node'
});

/**
 * All test workflows collection
 */
export const testWorkflows = {
  singleNode: singleNodeWorkflow,
  sequential: sequentialWorkflow,
  parallel: parallelWorkflow,
  diamond: diamondWorkflow,
  conditional: conditionalWorkflow,
  complex: complexWorkflow,
  failing: failingWorkflow,
  longRunning: longRunningWorkflow
};
