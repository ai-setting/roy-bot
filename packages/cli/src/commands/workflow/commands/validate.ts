/**
 * @fileoverview Workflow validate command
 */

import { CommandModule } from 'yargs';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { WorkflowValidator } from '../validators/workflow-validator';
import type { RawWorkflowDefinition, ValidationError } from '../validators/types';

export interface WorkflowValidateOptions {
  input?: string;
  yaml?: string;
  json?: boolean;
}

/**
 * Parse workflow from various input formats
 */
async function parseWorkflowInput(input?: string, yamlStr?: string): Promise<RawWorkflowDefinition> {
  // Helper to parse YAML
  const parseYaml = async (content: string): Promise<RawWorkflowDefinition> => {
    const YAML = await import('yaml');
    return YAML.parse(content) as RawWorkflowDefinition;
  };
  
  // From file path
  if (input && !yamlStr) {
    try {
      const content = readFileSync(input, 'utf-8');
      return await parseYaml(content);
    } catch (error: any) {
      throw new Error(`Failed to read file "${input}": ${error.message}`);
    }
  }
  
  // From --yaml flag
  if (yamlStr) {
    try {
      return await parseYaml(yamlStr);
    } catch (error: any) {
      throw new Error(`Failed to parse YAML: ${error.message}`);
    }
  }
  
  // From workflow ID (requires database lookup)
  if (input && !input.includes(':') && !input.includes('-')) {
    // TODO: Load from database if needed
    throw new Error('Workflow ID lookup not implemented yet. Please use file path or --yaml flag.');
  }
  
  throw new Error('Please provide workflow input: file path, --yaml string, or workflow ID');
}

/**
 * Render validation result
 */
function renderResult(result: ReturnType<WorkflowValidator['validate']>, options: WorkflowValidateOptions): void {
  // JSON output
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  
  // Text output
  if (result.valid) {
    console.log(chalk.green('\n✅ Workflow validation PASSED\n'));
    console.log(chalk.bold(`Workflow: ${result.workflowName}`));
    console.log(`Nodes: ${result.nodeCount}`);
    
    // List valid nodes
    console.log('\nValid nodes:');
    // Since we don't track valid nodes separately, we just show the count
    console.log(chalk.green('  ✓ All nodes passed validation'));
  } else {
    console.log(chalk.red(`\n❌ Workflow validation FAILED (${result.errors.length} errors found)\n`));
    
    result.errors.forEach((error: ValidationError, index: number) => {
      console.log(chalk.red(`[Error ${index + 1}/${result.errors.length}]${error.nodeId ? ` Node "${error.nodeId}"` : ''}`));
      console.log(`  ${chalk.bold('Type:')} ${error.type}`);
      console.log(`  ${chalk.bold('Description:')} ${error.description}`);
      console.log(`  ${chalk.bold('Expected:')} ${error.expected}`);
      console.log(`  ${chalk.bold('Actual:')} ${error.actual}`);
      console.log(`  ${chalk.green('Fix:')} ${error.fix}`);
      console.log();
    });
  }
}

/**
 * WorkflowValidateCommand - Validate workflow YAML
 */
export const WorkflowValidateCommand: CommandModule<object, WorkflowValidateOptions> = {
  command: 'validate [input]',
  describe: 'Validate workflow YAML syntax and node configurations',
  
  builder: (yargs) =>
    yargs
      .positional('input', {
        describe: 'Workflow file path or workflow ID',
        type: 'string',
      })
      .option('yaml', {
        describe: 'YAML content string (alternative to positional input)',
        type: 'string',
        alias: 'y',
      })
      .option('json', {
        describe: 'Output in JSON format',
        type: 'boolean',
        alias: 'j',
      }),
  
  async handler(args) {
    const options = args as WorkflowValidateOptions;
    
    try {
      // Parse input
      const workflow = await parseWorkflowInput(options.input, options.yaml);
      if (!workflow) {
        console.error(chalk.red('Failed to parse workflow input'));
        process.exit(1);
      }
      
      // Validate
      const validator = new WorkflowValidator();
      const result = validator.validate(workflow);
      
      // Render result
      renderResult(result, options);
      
      // Exit with appropriate code
      process.exit(result.valid ? 0 : 1);
    } catch (error: any) {
      console.error(chalk.red(`\nError: ${error.message}`));
      process.exit(1);
    }
  },
};
