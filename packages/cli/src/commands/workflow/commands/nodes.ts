/**
 * @fileoverview Workflow Nodes Command
 *
 * List all built-in node types with their input/output descriptions
 */

import { CommandModule } from 'yargs';
import chalk from 'chalk';

export interface WorkflowNodesOptions {
  type?: string;
}

/**
 * Node type definition
 */
export interface NodeDefinition {
  name: string;
  type: string;
  description: string;
  inputs: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  output: string;
  example?: string;
}

/**
 * Common parameters supported by all node types
 */
const COMMON_PARAMS = [
  {
    name: 'depends_on',
    type: 'string[]',
    required: false,
    description: 'List of node IDs that must complete before this node runs',
  },
  {
    name: 'timeout',
    type: 'number',
    required: false,
    description: 'Execution timeout in milliseconds (default: 30000)',
  },
  {
    name: 'retry',
    type: 'object',
    required: false,
    description: 'Retry config: {max_attempts, backoff: "fixed"|"exponential", initial_delay}',
  },
];

/**
 * Built-in node type definitions
 */
export const BUILT_IN_NODES: NodeDefinition[] = [
  // =========================================================================
  // Tool Node
  // =========================================================================
  {
    name: 'ToolNode',
    type: 'tool',
    description:
      'Execute a registered tool. Tools are atomic operations that perform specific tasks like bash, file operations, or API calls. Supports template resolution for input values.',
    inputs: [
      {
        name: 'tool / toolName',
        type: 'string',
        required: true,
        description: 'Name of the registered tool to execute (e.g., bash, read-file, web-search)',
      },
      {
        name: 'input / args',
        type: 'object',
        required: false,
        description: 'Key-value pairs passed to the tool (use input or args key). Supports template strings like {{nodes.nodeId.output}}',
      },
      {
        name: 'command',
        type: 'string',
        required: false,
        description: 'Single command string (for bash tool with {command: "..."} signature). Supports templates.',
      },
      {
        name: 'message',
        type: 'string',
        required: false,
        description: 'Single message string (for echo tool with {message: "..."} signature). Supports templates.',
      },
    ],
    output: '{output: any, error?: Error, durationMs: number}',
    example: `# Example 1: Execute bash command
nodes:
  run-tests:
    type: tool
    config:
      tool: bash
      input:
        command: "npm test"

# Example 2: Read file with template reference
nodes:
  read-config:
    type: tool
    config:
      tool: read-file
      input:
        path: "{{input.configPath}}"

# Example 3: Web search
nodes:
  search:
    type: tool
    config:
      tool: web-search
      input:
        query: "AI news"
        numResults: 5`,
  },

  // =========================================================================
  // Skill Node
  // =========================================================================
  {
    name: 'SkillNode',
    type: 'skill',
    description:
      'Invoke a skill processor. Skills are higher-level operations that combine multiple tools and logic for complex tasks. Supports template resolution for input values.',
    inputs: [
      {
        name: 'skill',
        type: 'string',
        required: true,
        description: 'Name of the registered skill to invoke',
      },
      {
        name: 'input',
        type: 'object',
        required: false,
        description: 'Input parameters for the skill. Supports template strings like {{nodes.nodeId.output}}',
      },
    ],
    output: '{output: any, error?: Error, durationMs: number}',
    example: `# Example: Summarize text
nodes:
  summarize:
    type: skill
    config:
      skill: text-summarizer
      input:
        content: "{{nodes.fetch.output}}"
        maxLength: 200

# Example: Code review
nodes:
  review:
    type: skill
    config:
      skill: code-reviewer
      input:
        code: "{{input.code}}"
        language: "{{input.language}}"`,
  },

  // =========================================================================
  // Agent Node
  // =========================================================================
  {
    name: 'AgentNode',
    type: 'agent',
    description:
      'Run an AI agent with reasoning loop. Agents use LLM to reason, plan, and use tools for complex tasks. Supports workflow history for multi-agent collaboration. Prompt templates support {{input.key}} and {{nodes.nodeId.output}} interpolation.',
    inputs: [
      {
        name: 'agent_type',
        type: 'string',
        required: true,
        description: 'Agent type (e.g., general, research, coder, critic). Auto-registers if not found.',
      },
      {
        name: 'prompt',
        type: 'string',
        required: true,
        description: 'Prompt template (supports {{input.key}} and {{nodes.nodeId.output}} interpolation)',
      },
      {
        name: 'options',
        type: 'object',
        required: false,
        description: 'Execution options: {timeout?: number, model?: string}',
      },
      {
        name: 'system_prompt / systemPrompt',
        type: 'string',
        required: false,
        description: 'Custom system prompt for this agent (auto-generated if not provided)',
      },
    ],
    output: '{result: any, metadata: {tokens?: number, duration?: number}, workflowHistory: [...]}',
    example: `# Example: Research agent
nodes:
  analyze:
    type: agent
    config:
      agent_type: research
      prompt: |
        Based on the data: {{nodes.fetch.output}}
        Please analyze and provide insights.
      options:
        timeout: 60000
        model: "minimax"

# Example: Multi-agent with history
nodes:
  planner:
    type: agent
    config:
      agent_type: general
      prompt: "Plan the implementation for {{input.task}}"

  executor:
    type: agent
    config:
      agent_type: coder
      prompt: "Implement the plan: {{nodes.planner.output}}"
    depends_on:
      - planner`,
  },

  // =========================================================================
  // Workflow Node (Sub-workflow)
  // =========================================================================
  {
    name: 'WorkflowNode',
    type: 'workflow',
    description:
      'Execute a nested/sub workflow. Allows creating complex workflows by combining simpler ones. Supports template resolution for input values.',
    inputs: [
      {
        name: 'workflow_name',
        type: 'string',
        required: true,
        description: 'Name of the sub-workflow to execute',
      },
      {
        name: 'input',
        type: 'object',
        required: false,
        description: 'Input parameters for the sub-workflow. Supports template strings like {{nodes.nodeId.output}}',
      },
      {
        name: 'wait_complete',
        type: 'boolean',
        required: false,
        description: 'Whether to wait for sub-workflow completion (default: true)',
      },
    ],
    output: '{success: boolean, output?: any, error?: string, duration: number}',
    example: `# Example: Execute sub-workflow
nodes:
  data-process:
    type: workflow
    config:
      workflow_name: data-processor
      input:
        data: "{{nodes.fetch.output}}"

# Example: Sequential workflows
nodes:
  step1:
    type: workflow
    config:
      workflow_name: preprocessing
      input:
        raw: "{{input.data}}"

  step2:
    type: workflow
    config:
      workflow_name: analysis
      input:
        cleaned: "{{nodes.step1.output}}"
    depends_on:
      - step1`,
  },

  // =========================================================================
  // Condition Node
  // =========================================================================
  {
    name: 'ConditionNode',
    type: 'condition',
    description:
      'Evaluate a condition and decide workflow path. Supports boolean values, template expressions, and references to previous node outputs. Default to true if no condition specified.',
    inputs: [
      {
        name: 'condition',
        type: 'string | boolean',
        required: false,
        description: 'Condition to evaluate: boolean value, template {{nodeId.output.success}}, or template {{input.key}}. Defaults to true if not specified.',
      },
    ],
    output: '{success: boolean, condition: resolved_value}',
    example: `# Example: Check test results
nodes:
  run-tests:
    type: tool
    config:
      tool: bash
      input:
        command: "npm test"

  check-result:
    type: condition
    config:
      condition: "{{run-tests.output.success}}"
    depends_on:
      - run-tests

# Example: Check input value
nodes:
  validate:
    type: condition
    config:
      condition: "{{input.validate}}"
    depends_on: []`,
  },

  // =========================================================================
  // Merge Node
  // =========================================================================
  {
    name: 'MergeNode',
    type: 'merge',
    description:
      'Collect and merge outputs from multiple dependency nodes. Supports strategies: collect (default), first, last, merge.',
    inputs: [
      {
        name: 'strategy',
        type: 'string',
        required: false,
        description: 'Merge strategy: collect (default, returns map), first (returns first output), last (returns last output), merge (deep merge objects)',
      },
    ],
    output: '{strategy: string, results: any, count: number}',
    example: `# Example: Collect parallel results
nodes:
  parallel-fetch:
    type: merge
    config:
      strategy: collect
    depends_on:
      - fetch-user
      - fetch-orders
      - fetch-preferences

# Example: Get first successful result
nodes:
  first-success:
    type: merge
    config:
      strategy: first
    depends_on:
      - primary-source
      - backup-source

# Example: Merge objects
nodes:
  merge-data:
    type: merge
    config:
      strategy: merge
    depends_on:
      - metadata
      - content
      - analytics`,
  },

  // =========================================================================
  // Decorator Node
  // =========================================================================
  {
    name: 'DecoratorNode',
    type: 'decorator',
    description:
      'Execute a class method decorated with @Workflow or @NodeAs. Supports retry logic and timeout. Automatically extracts output from decorated methods.',
    inputs: [
      {
        name: '_methodName',
        type: 'string',
        required: true,
        description: 'Name of the decorated method to execute',
      },
      {
        name: '_instance',
        type: 'object',
        required: true,
        description: 'Class instance containing the decorated method',
      },
      {
        name: 'retry',
        type: 'object',
        required: false,
        description: 'Retry config: {max_attempts: number, backoff: "fixed"|"exponential", initial_delay: number}',
      },
    ],
    output: '{success: boolean, output?: any, error?: string, duration: number, metadata: {methodName: string}}',
    example: `# Example: Execute decorated method
nodes:
  process-data:
    type: decorator
    config:
      _methodName: "processData"
      _instance: "{{input.workflowInstance}}"
      timeout: 30000
      retry:
        max_attempts: 3
        backoff: exponential
        initial_delay: 1000
    depends_on:
      - fetch-data`,
  },
];

/**
 * Render node types table
 */
function renderNodeTypesTable(nodes: NodeDefinition[]): string {
  const lines: string[] = [];
  
  lines.push(chalk.bold('\n📦 Built-in Node Types\n'));
  lines.push('┌────────────┬────────────────────┬─────────────────────────────────────────────────────────────┐');
  lines.push('│ Type       │ Name                │ Description                                               │');
  lines.push('├────────────┼────────────────────┼─────────────────────────────────────────────────────────────┤');
  
  for (const node of nodes) {
    const type = node.type.padEnd(10);
    const name = node.name.padEnd(18);
    const desc = node.description.substring(0, 59).padEnd(59);
    lines.push(`│ ${type} │ ${name} │ ${desc} │`);
  }
  
  lines.push('└────────────┴────────────────────┴─────────────────────────────────────────────────────────────┘');
  
  return lines.join('\n');
}

/**
 * Render detailed node information
 */
function renderNodeDetail(node: NodeDefinition): string {
  const lines: string[] = [];
  
  lines.push(chalk.bold(`\n[${node.type}] ${node.name}`));
  lines.push(chalk.dim('─'.repeat(60)) + '\n');
  
  lines.push(chalk.bold('Description:'));
  lines.push(`  ${node.description}\n`);
  
  lines.push(chalk.bold('Configuration:'));
  lines.push('  type: "' + node.type + '"');
  lines.push('  config:');
  
  for (const input of node.inputs) {
    const required = input.required ? chalk.red('*') : ' ';
    lines.push(`    ${input.name} (${input.type})${required}`);
    lines.push(`      ${input.description}`);
  }
  
  lines.push(`\n${chalk.bold('Output:')} ${node.output}`);
  
  if (node.example) {
    lines.push(chalk.bold('\nExample:'));
    lines.push(chalk.gray('```yaml'));
    lines.push(node.example);
    lines.push(chalk.gray('```'));
  }
  
  return lines.join('\n');
}

/**
 * WorkflowNodesCommand - List built-in node types
 */
export const WorkflowNodesCommand: CommandModule<object, WorkflowNodesOptions> = {
  command: 'nodes [type]',
  describe: '列出所有内置节点类型及其配置说明',

  builder: (yargs) =>
    yargs.positional('type', {
      describe: '节点类型 (tool/skill/agent/workflow/condition/merge/decorator/end)',
      type: 'string',
    }),

  async handler(args) {
    const nodeType = (args as any).type?.toLowerCase();

    // List all node types
    if (!nodeType) {
      console.log(renderNodeTypesTable(BUILT_IN_NODES));
      console.log(
        chalk.gray('\nUse ') +
          chalk.cyan('roy-bot workflow nodes <type>') +
          chalk.gray(' for detailed information')
      );
      console.log(
        chalk.gray('Available types: ') +
          chalk.yellow(BUILT_IN_NODES.map((n) => n.type).join(', '))
      );
      return;
    }

    // Show specific node type
    const node = BUILT_IN_NODES.find((n) => n.type === nodeType);
    if (!node) {
      console.log(chalk.red(`\n❌ Unknown node type: ${nodeType}`));
      console.log(
        chalk.gray('Available types: ') +
          chalk.yellow(BUILT_IN_NODES.map((n) => n.type).join(', '))
      );
      process.exit(1);
    }

    console.log(renderNodeDetail(node));
  },
};
