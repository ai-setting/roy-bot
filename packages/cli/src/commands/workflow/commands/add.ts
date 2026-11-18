/**
 * @fileoverview Workflow Add Command
 * 
 * Add a new workflow from file or natural language description
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderWorkflowAdded, renderNodesList } from '../renderers';
import { WorkflowValidator } from '../validators/workflow-validator';
import { validateWorkflowDefinition } from '@ai-setting/roy-bot-core/env/workflow/utils';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import type { WorkflowService, WorkflowDefinition } from '@ai-setting/roy-bot-core/env/workflow/service';
import type { AgentComponent } from '@ai-setting/roy-bot-core';

/**
 * Parse workflow file content (YAML or JSON)
 * Uses WorkflowDefinitionSchema to ensure default values are applied
 */
async function parseWorkflowContent(content: string, filename: string): Promise<WorkflowDefinition> {
  const isYaml = filename.endsWith('.yaml') || filename.endsWith('.yml');
  const isJson = filename.endsWith('.json');
  
  let definition: WorkflowDefinition;
  
  if (isYaml) {
    // Dynamic import for YAML parser
    const yaml = await import('yaml');
    const parsed = yaml.parse(content);
    // Use WorkflowDefinitionSchema to apply defaults
    const { WorkflowDefinitionSchema } = await import('@ai-setting/roy-bot-core/env/workflow/types');
    definition = WorkflowDefinitionSchema.parse(parsed);
  } else if (isJson) {
    const parsed = JSON.parse(content);
    const { WorkflowDefinitionSchema } = await import('@ai-setting/roy-bot-core/env/workflow/types');
    definition = WorkflowDefinitionSchema.parse(parsed);
  } else {
    // Auto-detect: try JSON first, then YAML
    try {
      const parsed = JSON.parse(content);
      const { WorkflowDefinitionSchema } = await import('@ai-setting/roy-bot-core/env/workflow/types');
      definition = WorkflowDefinitionSchema.parse(parsed);
    } catch {
      const yaml = await import('yaml');
      const parsed = yaml.parse(content);
      const { WorkflowDefinitionSchema } = await import('@ai-setting/roy-bot-core/env/workflow/types');
      definition = WorkflowDefinitionSchema.parse(parsed);
    }
  }
  
  return definition;
}

/**
 * Parse YAML from agent output
 */
function parseYamlFromAgentOutput(output: string): WorkflowDefinition | null {
  // 提取 YAML 代码块
  const yamlMatch = output.match(/```yaml\n?([\s\S]*?)\n?```/) ||
                    output.match(/```\n?([\s\S]*?)\n?```/) ||
                    output.match(/(\|[\s\S]*?)(?:\n\n|$)/);
  
  const yamlContent = yamlMatch?.[1] || output;
  
  try {
    const YAML = require('yaml');
    const parsed = YAML.parse(yamlContent);
    
    // 验证必要字段
    if (!parsed.name || !parsed.nodes || !Array.isArray(parsed.nodes)) {
      return null;
    }
    
    // Use WorkflowDefinitionSchema to apply defaults
    const { WorkflowDefinitionSchema } = require('@ai-setting/roy-bot-core/env/workflow/types');
    const definition = WorkflowDefinitionSchema.parse(parsed);
    
    return definition;
  } catch {
    return null;
  }
}

export interface WorkflowAddOptions {
  name?: string;
  file?: string;
  desc?: string;
  description?: string;
  tags?: string[];
  taskId?: number;
  force?: boolean;
  validate?: boolean;
  config?: string;
}

/**
 * WorkflowAddCommand - Add a new workflow
 */
export const WorkflowAddCommand: CommandModule<object, object> = {
  command: 'add',
  describe: '添加新的 Workflow（支持文件或自然语言描述）',

  builder: (yargs) =>
    yargs
      .option('name', {
        alias: 'n',
        describe: 'Workflow 名称',
        type: 'string',
      })
      .option('file', {
        alias: 'f',
        describe: 'Workflow 定义文件 (YAML/JSON)',
        type: 'string',
      })
      .option('desc', {
        alias: 'd',
        describe: '自然语言描述（将使用 AI 生成 Workflow）',
        type: 'string',
      })
      .option('description', {
        describe: 'Workflow 描述（仅用于 --file 模式）',
        type: 'string',
      })
      .option('tags', {
        alias: 't',
        describe:
          'Tags (1-3 required). Select from existing tag pool when possible. ' +
          'Run "roy-bot workflow tag list" first to see available tags. ' +
          'Supports both --tags "a,b,c" and --tags a --tags b --tags c forms.',
        type: 'array',
        string: true,
      })
      .option('task-id', {
        alias: 'i',
        describe: '关联任务 ID',
        type: 'number',
      })
      .option('force', {
        describe: '覆盖已存在的 Workflow',
        type: 'boolean',
        default: false,
      })
      .option('validate', {
        describe: '保存前验证 Workflow',
        type: 'boolean',
        default: true,
      })
      .option('config', {
        describe: '配置文件路径',
        type: 'string',
      })
      .epilogue(`提示：
  - 模版变量建议不加空格: {{nodeId.field}} 即可，{{ nodeId.field }}（带空格）也能通过自动兼容
  - 输出节点请使用 echo tool 的 message 参数：
      tool: echo
      message: "{{nodeId.field}}"
    不要用 bash tool + command 输出多行内容（shell 会执行失败）。`),

  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const workflowComponent = env.getComponent('workflow') as any;

      if (!workflowComponent) {
        output.error('WorkflowComponent not available');
        process.exit(1);
      }

      const service = workflowComponent.getService() as WorkflowService;

      let definition: WorkflowDefinition | null;
      let workflowName: string;

      // Mode 1: File input
      if (a.file) {
        const filePath = path.resolve(a.file);
        if (!fs.existsSync(filePath)) {
          output.error(`File not found: ${filePath}`);
          process.exit(1);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        definition = await parseWorkflowContent(content, filePath);
        workflowName = a.name || definition.name as string || path.basename(filePath);

        // Validate if requested
        if (a.validate) {
          output.log(chalk.blue('🔍 Validating workflow...'));

          // Layer 1: DAG-level check (shared with workflow_add tool)
          // Catches structural errors early with clear message.
          const dagResult = validateWorkflowDefinition(definition);
          if (!dagResult.valid) {
            output.error(`\n❌ Workflow validation FAILED (${dagResult.errors.length} errors found)`);
            dagResult.errors.forEach((msg, i) => {
              output.error(`[Error ${i + 1}/${dagResult.errors.length}] ${msg}`);
            });
            process.exit(1);
          }

          // Layer 2: Rich per-node checks (node types, template references, etc.)
          // Cast to `any` because the validator's expected type is `RawWorkflowDefinition`
          // (a loose pre-parse shape) while `definition` is the parsed `WorkflowDefinition`.
          const validator = new WorkflowValidator();
          const result = validator.validate(definition as any);

          if (!result.valid) {
            output.error(`\n❌ Workflow validation FAILED (${result.errors.length} errors found)`);
            result.errors.forEach((error, i) => {
              output.error(`[Error ${i + 1}/${result.errors.length}]${error.nodeId ? ` Node "${error.nodeId}"` : ''}`);
              output.error(`  Type: ${error.type}`);
              output.error(`  Description: ${error.description}`);
              output.error(`  Fix: ${error.fix}\n`);
            });
            process.exit(1);
          }
          output.log(chalk.green('✅ Workflow validation passed\n'));
        }
      }
      // Mode 2: Natural language description
      else if (a.desc) {
        output.log(chalk.blue('🤖 Generating workflow from description...\n'));
        
        // Get AgentComponent
        const agentComponent = env.getComponent('agent') as AgentComponent;
        if (!agentComponent) {
          output.error('AgentComponent not available');
          process.exit(1);
        }

        // The 'workflow-extract' agent is a built-in agent, registered automatically
        // by AgentRegistry.registerWorkflowExtractAgent() during environment init.
        // No manual registration needed.
        if (!agentComponent.getAgent('workflow-extract')) {
          output.error("Built-in 'workflow-extract' agent is not available. " +
            "This usually means the environment was not fully initialized.");
          process.exit(1);
        }

        // Build prompt for workflow-extract
        const prompt = `## 任务
请根据以下描述，构建一个可复用的 Workflow。
使用迭代式流程：生成 YAML → validate 验证 → 修正错误 → 重复直到通过验证。

## Workflow 描述
${a.desc}

## 重要提醒
1. 先用 \`roy-bot workflow nodes\` 查看可用的节点类型
2. 生成的 YAML 必须通过 \`roy-bot workflow validate --yaml "<yaml>"\` 验证
3. 验证通过后才输出最终 YAML`;

        // Run workflow-extract agent
        output.log(chalk.gray('Running workflow-extract agent...'));
        const result = await agentComponent.run('workflow-extract', prompt);
        const agentOutput = result.finalText || '';
        
        // Parse YAML from agent output
        definition = parseYamlFromAgentOutput(agentOutput);
        if (definition === null) {
          output.error('Failed to parse workflow from agent output');
          output.log(chalk.gray('\nAgent output:\n' + agentOutput.slice(0, 500)));
          process.exit(1);
        }
        
        workflowName = a.name || definition.name as string;

        // Validate the generated workflow
        if (a.validate) {
          output.log(chalk.blue('\n🔍 Validating generated workflow...'));

          // Layer 1: DAG-level check (shared with workflow_add tool)
          const dagResult = validateWorkflowDefinition(definition);
          if (!dagResult.valid) {
            output.error(`\n❌ Generated workflow validation FAILED (${dagResult.errors.length} errors found)`);
            dagResult.errors.forEach((msg, i) => {
              output.error(`[Error ${i + 1}/${dagResult.errors.length}] ${msg}`);
            });
            output.log(chalk.yellow('请修正描述后重新尝试，或使用 --file 选项直接提供 YAML'));
            process.exit(1);
          }

          // Layer 2: Rich per-node checks (node types, template references, etc.)
          // Cast to `any` because the validator's expected type is `RawWorkflowDefinition`
          // while `definition` is the parsed `WorkflowDefinition`.
          const validator = new WorkflowValidator();
          const result = validator.validate(definition as any);

          if (!result.valid) {
            output.error(`\n❌ Generated workflow validation FAILED (${result.errors.length} errors found)`);
            result.errors.forEach((error, i) => {
              output.error(`[Error ${i + 1}/${result.errors.length}]${error.nodeId ? ` Node "${error.nodeId}"` : ''}`);
              output.error(`  Type: ${error.type}`);
              output.error(`  Description: ${error.description}`);
              output.error(`  Fix: ${error.fix}\n`);
            });
            output.log(chalk.yellow('请修正描述后重新尝试，或使用 --file 选项直接提供 YAML'));
            process.exit(1);
          }
          output.log(chalk.green('✅ Generated workflow validation passed\n'));
        }
        
        // Show generated YAML
        const yaml = await import('yaml');
        output.log(chalk.gray('--- Generated YAML ---'));
        output.log(yaml.stringify(definition));
        output.log(chalk.gray('------------------------\n'));
      }
      else {
        output.error('Please provide --file or --desc option');
        output.error('Usage: roy-bot workflow add --file <path> | --desc "<description>"');
        process.exit(1);
      }

      // Parse tags: 支持 --tags "a,b,c" 或 --tags a --tags b --tags c 两种形式
      // yargs 在 yargs-parser 配置了 array 模式时会传 string[]，否则 string
      function parseTags(input: unknown): string[] | undefined {
        if (input === undefined || input === null) return undefined;
        const list: string[] = [];
        if (Array.isArray(input)) {
          for (const item of input) {
            if (typeof item === 'string') {
              // 逗号分隔的字符串也可再展开
              for (const t of item.split(',')) {
                const trimmed = t.trim();
                if (trimmed) list.push(trimmed);
              }
            }
          }
        } else if (typeof input === 'string') {
          for (const t of input.split(',')) {
            const trimmed = t.trim();
            if (trimmed) list.push(trimmed);
          }
        }
        return list.length > 0 ? list : undefined;
      }
      const tags = parseTags(a.tags);

      // Validate tags - required with 1-3 count
      if (!tags || tags.length === 0) {
        output.error('❌ --tags is required.');
        output.error('   Please provide 1-3 tags using --tags "tag1,tag2,tag3"');
        output.error('   Example: roy-bot workflow add --file my.yaml --tags "ai,ml,etl"');
        process.exit(1);
      }
      if (tags.length > 3) {
        output.error(`❌ Too many tags: received ${tags.length}, maximum is 3.`);
        output.error('   Please reduce to 1-3 tags using --tags "tag1,tag2,tag3"');
        output.error('   Example: roy-bot workflow add --file my.yaml --tags "ai,ml,etl"');
        process.exit(1);
      }

      // Create workflow
      const workflow = await service.createWorkflow(definition, {
        tags,
        taskId: a.taskId,
        force: a.force,
      });

      output.log(renderWorkflowAdded(workflow));

      // Show nodes summary
      output.log(chalk.bold('\n📊 Nodes Summary:'));
      output.log(renderNodesList(definition.nodes));

      output.log(chalk.green(`\n✅ Workflow '${workflowName}' added successfully`));
    } catch (error: any) {
      if (error.message?.includes('already exists') && !a.force) {
        output.error(`Workflow already exists. Use --force to overwrite.`);
        output.error(`Error: ${error.message}`);
      } else {
        output.error(`Failed to add workflow: ${error}`);
      }
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
