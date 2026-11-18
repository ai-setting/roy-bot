/**
 * @fileoverview WorkflowValidator tests
 */

import { describe, it, expect } from 'vitest';
import { WorkflowValidator } from './workflow-validator';
import { ValidationErrorType } from './types';

describe('WorkflowValidator', () => {
  const validator = new WorkflowValidator();
  
  describe('structure validation', () => {
    it('should fail when name is missing', () => {
      const result = validator.validate({
        nodes: [{ id: 'node-1', type: 'tool', config: { tool: 'echo' } }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe(ValidationErrorType.MISSING_REQUIRED_FIELD);
    });
    
    it('should fail when nodes is empty', () => {
      const result = validator.validate({ name: 'test' });
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe(ValidationErrorType.EMPTY_NODES);
    });
    
    it('should pass valid workflow', () => {
      const result = validator.validate({
        name: 'test-workflow',
        version: '1.0',
        nodes: [
          { id: 'node-1', type: 'tool', config: { tool: 'echo', message: 'hello' } },
        ],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
  
  describe('node validation', () => {
    it('should validate tool node', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [{ id: 'node-1', type: 'tool', config: {} }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.nodeId === 'node-1')).toBe(true);
    });
    
    it('should detect agent node using agentName instead of agent_type', () => {
      // 常见错误：使用 agentName 而不是 agent_type
      const result = validator.validate({
        name: 'test',
        nodes: [{
          id: 'agent-1',
          type: 'agent',
          config: {
            agentName: 'my-agent',  // 错误：应该是 agent_type
            prompt: 'hello world'
          }
        }],
      });
      expect(result.valid).toBe(false);
      // 应该有 MISSING_REQUIRED_FIELD 错误
      expect(result.errors.some(e => 
        e.type === ValidationErrorType.MISSING_REQUIRED_FIELD && 
        e.description.includes('agent_type')
      )).toBe(true);
    });
    
    it('should pass agent node with correct agent_type field', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [{
          id: 'agent-1',
          type: 'agent',
          config: {
            agent_type: 'general',  // 正确：使用 agent_type
            prompt: 'hello world'
          }
        }],
      });
      expect(result.valid).toBe(true);
    });
  });
  
  describe('dependency validation', () => {
    it('should fail on invalid reference', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          { id: 'node-1', type: 'tool', config: { tool: 'echo' }, depends_on: ['non-existent'] },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === ValidationErrorType.INVALID_REFERENCE)).toBe(true);
    });
    
    it('should fail on circular dependency', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          { id: 'node-1', type: 'tool', config: { tool: 'echo' }, depends_on: ['node-2'] },
          { id: 'node-2', type: 'tool', config: { tool: 'echo' }, depends_on: ['node-1'] },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === ValidationErrorType.CIRCULAR_DEPENDENCY)).toBe(true);
    });
  });

  describe('template reference validation', () => {
    it('should pass when template references existing node', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: { tool: 'echo', message: 'hello' }
          },
          {
            id: 'step-two',
            type: 'tool',
            config: { tool: 'echo', message: '{{step-one.output}}' },
            depends_on: ['step-one']
          },
        ],
      });
      expect(result.valid).toBe(true);
      expect(result.errors.some(e => e.type === ValidationErrorType.INVALID_TEMPLATE_REFERENCE)).toBe(false);
    });

    it('should fail when template references non-existent node', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step-two',
            type: 'tool',
            config: { tool: 'echo', message: '{{non-existent-node.output}}' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const templateError = result.errors.find(e => e.type === ValidationErrorType.INVALID_TEMPLATE_REFERENCE);
      expect(templateError).toBeDefined();
      expect(templateError?.referencedNodeId).toBe('non-existent-node');
      expect(templateError?.fix).toContain('non-existent-node');
    });

    it('should fail when template uses nodes.xxx syntax with non-existent node', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step-two',
            type: 'tool',
            config: { tool: 'echo', message: '{{nodes.missing-step.output}}' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const templateError = result.errors.find(e => e.type === ValidationErrorType.INVALID_TEMPLATE_REFERENCE);
      expect(templateError).toBeDefined();
    });

    it('should detect similar node ID with hyphen/underscore mismatch', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step_one',  // underscore
            type: 'tool',
            config: { tool: 'echo', message: 'hello' }
          },
          {
            id: 'step-two',
            type: 'tool',
            config: { tool: 'echo', message: '{{step-one.output}}' },  // hyphen
          },
        ],
      });
      expect(result.valid).toBe(false);
      const templateError = result.errors.find(e => e.type === ValidationErrorType.INVALID_TEMPLATE_REFERENCE);
      expect(templateError).toBeDefined();
      expect(templateError?.fix).toContain('step_one');
    });

    it('should pass when template references workflow input', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: { tool: 'echo', message: '{{input.userName}}' },
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('should pass when using $-style template syntax', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: { tool: 'echo', message: 'hello' }
          },
          {
            id: 'step-two',
            type: 'tool',
            config: { tool: 'echo', message: '${step-one.output}' },
            depends_on: ['step-one']
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('should fail when $-style template references non-existent node', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'step-two',
            type: 'tool',
            config: { tool: 'echo', message: '${missing-step.output}' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const templateError = result.errors.find(e => e.type === ValidationErrorType.INVALID_TEMPLATE_REFERENCE);
      expect(templateError).toBeDefined();
      expect(templateError?.referencedNodeId).toBe('missing-step');
    });

    it('should handle nested template references in complex configs', () => {
      const result = validator.validate({
        name: 'test',
        nodes: [
          {
            id: 'fetch-data',
            type: 'tool',
            config: { tool: 'http-request', url: 'https://api.example.com' }
          },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'transform',
              data: {
                source: '{{fetch-data.output.body}}',
                format: '{{input.format}}',
                missing: '{{non-existent.output}}'
              }
            },
            depends_on: ['fetch-data']
          },
        ],
      });
      expect(result.valid).toBe(false);
      const templateError = result.errors.find(e => 
        e.type === ValidationErrorType.INVALID_TEMPLATE_REFERENCE &&
        e.referencedNodeId === 'non-existent'
      );
      expect(templateError).toBeDefined();
    });
  });

  // TDD RED: Bug 2 - Workflow Input Validation
  describe('workflow input validation', () => {
    it('should pass when workflow with inputs has all required inputs defined', () => {
      const result = validator.validate({
        name: 'test-workflow',
        inputs: [
          { name: 'stockCode', type: 'string', required: true },
          { name: 'dateRange', type: 'string', required: false },
        ],
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: {
              tool: 'echo',
              message: '{{input.stockCode}}'
            }
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('should fail when workflow references undefined input without default filter', () => {
      const result = validator.validate({
        name: 'stock-workflow',
        inputs: [],  // No inputs defined
        nodes: [
          {
            id: 'search',
            type: 'tool',
            config: {
              tool: 'mcp_exa_web_search_exa',
              input: {
                query: '{{input.stockCode}}'  // References undefined input
              }
            }
          },
        ],
      });
      expect(result.valid).toBe(false);
      const undefinedError = result.errors.find(e =>
        e.type === ValidationErrorType.UNDEFINED_INPUT_REFERENCE
      );
      expect(undefinedError).toBeDefined();
      expect(undefinedError?.description).toContain('stockCode');
    });

    it('should pass when input reference uses default filter', () => {
      const result = validator.validate({
        name: 'test-workflow',
        inputs: [],  // No inputs defined
        nodes: [
          {
            id: 'search',
            type: 'tool',
            config: {
              tool: 'echo',
              message: '{{input.symbol | default("AAPL")}}'  // Has default filter
            }
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('should warn when required input has no default and is referenced', () => {
      const result = validator.validate({
        name: 'test-workflow',
        inputs: [
          { name: 'requiredParam', type: 'string', required: true },  // No default!
        ],
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: {
              tool: 'echo',
              message: '{{input.requiredParam}}'
            }
          },
        ],
      });
      // Should pass validation but might have warnings
      expect(result.valid).toBe(true);
    });

    it('should detect all undefined input references', () => {
      const result = validator.validate({
        name: 'test-workflow',
        inputs: [
          { name: 'definedInput', type: 'string', required: true },
        ],
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: {
              tool: 'echo',
              message: '{{input.definedInput}}'  // Defined
            }
          },
          {
            id: 'step-two',
            type: 'tool',
            config: {
              tool: 'echo',
              data: {
                a: '{{input.undefined1}}',  // Undefined
                b: '{{input.undefined2}}',   // Undefined
                c: '{{input.definedInput}}' // Defined
              }
            }
          },
        ],
      });
      expect(result.valid).toBe(false);
      const undefinedErrors = result.errors.filter(e =>
        e.type === ValidationErrorType.UNDEFINED_INPUT_REFERENCE
      );
      expect(undefinedErrors.length).toBe(2);
      expect(undefinedErrors.some(e => e.description?.includes('undefined1'))).toBe(true);
      expect(undefinedErrors.some(e => e.description?.includes('undefined2'))).toBe(true);
    });

    it('should handle nested input template references', () => {
      const result = validator.validate({
        name: 'test-workflow',
        inputs: [],
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: {
              tool: 'echo',
              data: {
                nested: {
                  deep: {
                    value: '{{input.missing}}'
                  }
                }
              }
            }
          },
        ],
      });
      expect(result.valid).toBe(false);
      const undefinedError = result.errors.find(e =>
        e.type === ValidationErrorType.UNDEFINED_INPUT_REFERENCE &&
        e.description?.includes('missing')
      );
      expect(undefinedError).toBeDefined();
    });

    it('should handle $ input style template references', () => {
      const result = validator.validate({
        name: 'test-workflow',
        inputs: [],
        nodes: [
          {
            id: 'step-one',
            type: 'tool',
            config: {
              tool: 'echo',
              message: '${input.undefinedSymbol}'
            }
          },
        ],
      });
      expect(result.valid).toBe(false);
      const undefinedError = result.errors.find(e =>
        e.type === ValidationErrorType.UNDEFINED_INPUT_REFERENCE
      );
      expect(undefinedError).toBeDefined();
    });
  });

  // Task #1998: workflow portability — Python function-call node
  describe('python_call node validation', () => {
    it('passes when module + function + args are valid', () => {
      const result = validator.validate({
        name: 'test-workflow',
        nodes: [
          {
            id: 'py-step',
            type: 'python_call',
            config: {
              module: 'investment_strategy.scripts.market_timing',
              function: 'run',
              args: { base_top_n: 20 },
              timeout: 60000,
            },
          },
        ],
      });
      expect(result.errors.filter(e => e.nodeId === 'py-step')).toHaveLength(0);
    });

    it('fails when module is missing', () => {
      const result = validator.validate({
        name: 'test-workflow',
        nodes: [
          {
            id: 'py-step',
            type: 'python_call',
            config: { function: 'run' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const moduleError = result.errors.find(
        e => e.nodeId === 'py-step' && /module/i.test(e.description)
      );
      expect(moduleError).toBeDefined();
    });

    it('fails when function is missing', () => {
      const result = validator.validate({
        name: 'test-workflow',
        nodes: [
          {
            id: 'py-step',
            type: 'python_call',
            config: { module: 'investment_strategy.x' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const fnError = result.errors.find(
        e => e.nodeId === 'py-step' && /function/i.test(e.description)
      );
      expect(fnError).toBeDefined();
    });

    it('fails when module path is invalid (dotted identifier regex)', () => {
      const result = validator.validate({
        name: 'test-workflow',
        nodes: [
          {
            id: 'py-step',
            type: 'python_call',
            config: { module: '1bad.module', function: 'run' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const moduleError = result.errors.find(
        e => e.nodeId === 'py-step' && /module/i.test(e.description)
      );
      expect(moduleError).toBeDefined();
    });

    it('fails when function name is invalid', () => {
      const result = validator.validate({
        name: 'test-workflow',
        nodes: [
          {
            id: 'py-step',
            type: 'python_call',
            config: { module: 'pkg.x', function: 'os.system' },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const fnError = result.errors.find(
        e => e.nodeId === 'py-step' && /function/i.test(e.description)
      );
      expect(fnError).toBeDefined();
    });

    it('fails when timeout is non-positive', () => {
      const result = validator.validate({
        name: 'test-workflow',
        nodes: [
          {
            id: 'py-step',
            type: 'python_call',
            config: { module: 'pkg.x', function: 'run', timeout: -1 },
          },
        ],
      });
      expect(result.valid).toBe(false);
      const timeoutError = result.errors.find(
        e => e.nodeId === 'py-step' && /timeout/i.test(e.description)
      );
      expect(timeoutError).toBeDefined();
    });
  });
});

// ============================================================================
// Task #4298 — Layer-2 template-reference CONTRACT validation in the CLI
// ============================================================================
describe("WorkflowValidator — template-reference contracts (Task #4298)", () => {
  it("flags {{nodes.<toolNode>.result}} as an error (the wheels-validate bug)", () => {
    const v = new WorkflowValidator();
    const result = v.validate({
      name: "wheels-like",
      nodes: [
        { id: "run-validation-tests", type: "tool", config: { tool: "bash", command: "echo ok" } },
        {
          id: "report-results",
          type: "agent",
          depends_on: ["run-validation-tests"],
          config: { agent_type: "general", prompt: "tests: {{nodes.run-validation-tests.result}}" },
        },
      ],
    } as any);
    expect(result.valid).toBe(false);
    const hit = result.errors.find((e) => e.template === "{{nodes.run-validation-tests.result}}");
    expect(hit).toBeDefined();
    expect(hit!.description).toContain("R2-result-on-non-agent");
    expect(hit!.fix).toContain("{{nodes.run-validation-tests.output}}");
    expect(hit!.nodeId).toBe("report-results");
    expect(hit!.referencedNodeId).toBe("run-validation-tests");
  });

  it("passes the same workflow once .result is corrected to .output", () => {
    const v = new WorkflowValidator();
    const result = v.validate({
      name: "fixed",
      nodes: [
        { id: "run-validation-tests", type: "tool", config: { tool: "bash", command: "echo ok" } },
        {
          id: "report-results",
          type: "agent",
          depends_on: ["run-validation-tests"],
          config: { agent_type: "general", prompt: "tests: {{nodes.run-validation-tests.output}}" },
        },
      ],
    } as any);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("keeps .result valid on agent nodes (idiom must not break)", () => {
    const v = new WorkflowValidator();
    const result = v.validate({
      name: "agent-idiom",
      nodes: [
        { id: "a", type: "agent", config: { agent_type: "general", prompt: "hi" } },
        { id: "b", type: "agent", depends_on: ["a"], config: { agent_type: "general", prompt: "{{nodes.a.result}}" } },
      ],
    } as any);
    expect(result.valid).toBe(true);
  });

  it("does NOT downgrade advisory-only findings (warnings) into CLI errors", () => {
    const v = new WorkflowValidator();
    const result = v.validate({
      name: "agent-schema-advisory",
      nodes: [
        {
          id: "judge",
          type: "agent",
          config: {
            agent_type: "general",
            prompt: "x",
            output: { mode: "json", schema: { type: "object", properties: { verdict: { type: "string" } } } },
          },
        },
        { id: "use", type: "agent", depends_on: ["judge"], config: { agent_type: "general", prompt: "{{nodes.judge.nope}}" } },
      ],
    } as any);
    expect(result.valid).toBe(true);
  });
});
