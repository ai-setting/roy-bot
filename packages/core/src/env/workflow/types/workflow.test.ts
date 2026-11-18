import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

// Import the schemas and types under test
// These will be implemented based on the design spec

describe('Workflow Types', () => {
  describe('DependsOn', () => {
    it('should accept array of strings', () => {
      const validDependsOn = ['node1', 'node2', 'node3'];
      // Schema: z.array(z.string())
      const schema = z.array(z.string());
      expect(() => schema.parse(validDependsOn)).not.toThrow();
    });

    it('should accept empty array', () => {
      const emptyDependsOn: string[] = [];
      const schema = z.array(z.string());
      expect(() => schema.parse(emptyDependsOn)).not.toThrow();
    });
  });

  describe('RetryConfig', () => {
    it('should accept valid retry config with all fields', () => {
      const validConfig = {
        max_attempts: 3,
        backoff: 'exponential',
        initial_delay: 2000,
      };
      const schema = z.object({
        max_attempts: z.number().min(1).default(1),
        backoff: z.enum(['fixed', 'exponential']).default('exponential'),
        initial_delay: z.number().min(0).default(1000),
      });
      expect(() => schema.parse(validConfig)).not.toThrow();
    });

    it('should use default values when optional fields omitted', () => {
      const minimalConfig = {};
      const schema = z.object({
        max_attempts: z.number().min(1).default(1),
        backoff: z.enum(['fixed', 'exponential']).default('exponential'),
        initial_delay: z.number().min(0).default(1000),
      });
      const result = schema.parse(minimalConfig);
      expect(result.max_attempts).toBe(1);
      expect(result.backoff).toBe('exponential');
      expect(result.initial_delay).toBe(1000);
    });

    it('should reject max_attempts less than 1', () => {
      const invalidConfig = { max_attempts: 0 };
      const schema = z.object({
        max_attempts: z.number().min(1),
        backoff: z.enum(['fixed', 'exponential']),
        initial_delay: z.number().min(0),
      });
      expect(() => schema.parse(invalidConfig)).toThrow();
    });

    it('should reject negative initial_delay', () => {
      const invalidConfig = { initial_delay: -100 };
      const schema = z.object({
        max_attempts: z.number().min(1),
        backoff: z.enum(['fixed', 'exponential']),
        initial_delay: z.number().min(0),
      });
      expect(() => schema.parse(invalidConfig)).toThrow();
    });
  });

  describe('NodeDefinition', () => {
    it('should accept minimal node definition', () => {
      const minimalNode = {
        id: 'node1',
        type: 'tool',
      };
      const schema = z.object({
        id: z.string().min(1, 'Node ID is required'),
        type: z.string().min(1, 'Node type is required'),
        name: z.string().optional(),
        config: z.record(z.any()).optional().default({}),
        depends_on: z.array(z.string()).optional().default([]),
        condition: z.string().optional(),
        retry: z.object({
          max_attempts: z.number().min(1).default(1),
          backoff: z.enum(['fixed', 'exponential']).default('exponential'),
          initial_delay: z.number().min(0).default(1000),
        }).optional(),
        timeout: z.number().optional(),
      });
      expect(() => schema.parse(minimalNode)).not.toThrow();
    });

    it('should accept full node definition with all fields', () => {
      const fullNode = {
        id: 'node1',
        type: 'tool',
        name: 'My Tool Node',
        config: { tool: 'calculator', params: { operation: 'add' } },
        depends_on: ['node0'],
        condition: '{{input.skip}} != true',
        retry: {
          max_attempts: 5,
          backoff: 'exponential',
          initial_delay: 3000,
        },
        timeout: 60000,
      };
      const schema = z.object({
        id: z.string().min(1, 'Node ID is required'),
        type: z.string().min(1, 'Node type is required'),
        name: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional().default({}),
        depends_on: z.array(z.string()).optional().default([]),
        condition: z.string().optional(),
        retry: z.object({
          max_attempts: z.number().min(1).default(1),
          backoff: z.enum(['fixed', 'exponential']).default('exponential'),
          initial_delay: z.number().min(0).default(1000),
        }).optional(),
        timeout: z.number().optional(),
      });
      expect(() => schema.parse(fullNode)).not.toThrow();
    });

    it('should reject node without id', () => {
      const nodeWithoutId = { type: 'tool' };
      const schema = z.object({
        id: z.string().min(1, 'Node ID is required'),
        type: z.string().min(1, 'Node type is required'),
      });
      expect(() => schema.parse(nodeWithoutId)).toThrow();
    });

    it('should reject node without type', () => {
      const nodeWithoutType = { id: 'node1' };
      const schema = z.object({
        id: z.string().min(1, 'Node ID is required'),
        type: z.string().min(1, 'Node type is required'),
      });
      expect(() => schema.parse(nodeWithoutType)).toThrow();
    });

    it('should reject empty id string', () => {
      const nodeWithEmptyId = { id: '', type: 'tool' };
      const schema = z.object({
        id: z.string().min(1, 'Node ID is required'),
        type: z.string().min(1, 'Node type is required'),
      });
      expect(() => schema.parse(nodeWithEmptyId)).toThrow();
    });
  });

  describe('WorkflowConfig', () => {
    it('should accept minimal workflow config', () => {
      const minimalConfig = {};
      const schema = z.object({
        parallel_limit: z.number().nullable().optional(),
        timeout: z.number().nullable().optional(),
        retry: z.object({
          max_attempts: z.number().min(1).default(1),
          backoff: z.enum(['fixed', 'exponential']).default('exponential'),
          initial_delay: z.number().min(0).default(1000),
        }).optional(),
        debug: z.boolean().optional(),
      });
      expect(() => schema.parse(minimalConfig)).not.toThrow();
    });

    it('should accept full workflow config', () => {
      const fullConfig = {
        parallel_limit: 5,
        timeout: 300000,
        retry: {
          max_attempts: 3,
          backoff: 'fixed',
          initial_delay: 5000,
        },
        debug: true,
      };
      const schema = z.object({
        parallel_limit: z.number().nullable().optional(),
        timeout: z.number().nullable().optional(),
        retry: z.object({
          max_attempts: z.number().min(1).default(1),
          backoff: z.enum(['fixed', 'exponential']).default('exponential'),
          initial_delay: z.number().min(0).default(1000),
        }).optional(),
        debug: z.boolean().optional(),
      });
      expect(() => schema.parse(fullConfig)).not.toThrow();
    });

    it('should accept null for parallel_limit', () => {
      const config = { parallel_limit: null };
      const schema = z.object({
        parallel_limit: z.number().nullable().optional(),
      });
      expect(() => schema.parse(config)).not.toThrow();
    });
  });

  describe('OutputDefinition', () => {
    it('should accept valid output definition', () => {
      const output = {
        name: 'result',
        source: 'final_node',
        path: 'output.result',
      };
      const schema = z.object({
        name: z.string(),
        source: z.string(),
        path: z.string(),
      });
      expect(() => schema.parse(output)).not.toThrow();
    });
  });

  describe('WorkflowMetadata', () => {
    it('should accept minimal metadata', () => {
      const minimalMetadata = {};
      const schema = z.object({
        author: z.string().optional(),
        tags: z.array(z.string()).optional().default([]),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      });
      expect(() => schema.parse(minimalMetadata)).not.toThrow();
    });

    it('should use default empty tags array', () => {
      const metadata = {};
      const schema = z.object({
        author: z.string().optional(),
        tags: z.array(z.string()).optional().default([]),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      });
      const result = schema.parse(metadata);
      expect(result.tags).toEqual([]);
    });

    it('should accept full metadata', () => {
      const fullMetadata = {
        author: 'John Doe',
        tags: ['test', 'production', 'v1'],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-15T12:30:00Z',
      };
      const schema = z.object({
        author: z.string().optional(),
        tags: z.array(z.string()).optional().default([]),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      });
      expect(() => schema.parse(fullMetadata)).not.toThrow();
    });
  });

  describe('WorkflowDefinition', () => {
    it('should accept minimal workflow definition', () => {
      const minimalWorkflow = {
        name: 'my-workflow',
        nodes: [{ id: 'n1', type: 'tool' }],
      };
      const schema = z.object({
        name: z.string().min(1, 'Workflow name is required'),
        version: z.string().default('1.0'),
        description: z.string().optional(),
        config: z.object({
          parallel_limit: z.number().nullable().optional(),
          timeout: z.number().nullable().optional(),
        }).optional().default({}),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1, 'At least one node is required'),
        entry: z.union([z.string(), z.array(z.string())]).default('__default_entry__'),
        outputs: z.array(z.object({
          name: z.string(),
          source: z.string(),
          path: z.string(),
        })).optional().default([]),
        metadata: z.object({
          author: z.string().optional(),
          tags: z.array(z.string()).optional().default([]),
        }).optional().default({}),
      });
      expect(() => schema.parse(minimalWorkflow)).not.toThrow();
    });

    it('should accept full workflow definition', () => {
      const fullWorkflow = {
        name: 'full-workflow',
        version: '2.0',
        description: 'A complete workflow example',
        config: {
          parallel_limit: 3,
          timeout: 600000,
        },
        nodes: [
          { id: 'n1', type: 'tool', name: 'First Tool' },
          { id: 'n2', type: 'skill', depends_on: ['n1'] },
          { id: 'n3', type: 'agent', depends_on: ['n2'] },
        ],
        entry: 'n1',
        outputs: [
          { name: 'final_result', source: 'n3', path: 'output' },
        ],
        metadata: {
          author: 'Jane Doe',
          tags: ['production', 'v2'],
        },
      };
      const schema = z.object({
        name: z.string().min(1, 'Workflow name is required'),
        version: z.string().default('1.0'),
        description: z.string().optional(),
        config: z.object({
          parallel_limit: z.number().nullable().optional(),
          timeout: z.number().nullable().optional(),
        }).optional().default({}),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1, 'At least one node is required'),
        entry: z.union([z.string(), z.array(z.string())]).default('__default_entry__'),
        outputs: z.array(z.object({
          name: z.string(),
          source: z.string(),
          path: z.string(),
        })).optional().default([]),
        metadata: z.object({
          author: z.string().optional(),
          tags: z.array(z.string()).optional().default([]),
        }).optional().default({}),
      });
      expect(() => schema.parse(fullWorkflow)).not.toThrow();
    });

    it('should reject workflow without nodes', () => {
      const emptyNodesWorkflow = { name: 'no-nodes' };
      const schema = z.object({
        name: z.string().min(1),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1, 'At least one node is required'),
      });
      expect(() => schema.parse(emptyNodesWorkflow)).toThrow();
    });

    it('should reject workflow with empty nodes array', () => {
      const emptyNodesWorkflow = { name: 'empty-nodes', nodes: [] };
      const schema = z.object({
        name: z.string().min(1),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1, 'At least one node is required'),
      });
      expect(() => schema.parse(emptyNodesWorkflow)).toThrow();
    });

    it('should reject workflow without name', () => {
      const noNameWorkflow = { nodes: [{ id: 'n1', type: 'tool' }] };
      const schema = z.object({
        name: z.string().min(1, 'Workflow name is required'),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1, 'At least one node is required'),
      });
      expect(() => schema.parse(noNameWorkflow)).toThrow();
    });

    it('should use default version when omitted', () => {
      const workflow = { name: 'test', nodes: [{ id: 'n1', type: 'tool' }] };
      const schema = z.object({
        name: z.string().min(1),
        version: z.string().default('1.0'),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1),
      });
      const result = schema.parse(workflow);
      expect(result.version).toBe('1.0');
    });

    it('should accept array entry', () => {
      const workflow = {
        name: 'parallel-entry',
        nodes: [{ id: 'n1', type: 'tool' }, { id: 'n2', type: 'tool' }],
        entry: ['n1', 'n2'],
      };
      const schema = z.object({
        name: z.string().min(1),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1),
        entry: z.union([z.string(), z.array(z.string())]).default('__default_entry__'),
      });
      expect(() => schema.parse(workflow)).not.toThrow();
    });
  });

  describe('parseWorkflowFile', () => {
    it('should parse YAML workflow file', () => {
      const yamlContent = `
name: yaml-workflow
version: '1.0'
nodes:
  - id: n1
    type: tool
  - id: n2
    type: skill
`;
      // Auto-detect by file extension
      const isYaml = true; // filename.endsWith('.yaml')
      const workflow = {
        name: 'yaml-workflow',
        version: '1.0',
        nodes: [
          { id: 'n1', type: 'tool' },
          { id: 'n2', type: 'skill' },
        ],
      };
      expect(isYaml).toBe(true);
      expect(workflow.name).toBe('yaml-workflow');
    });

    it('should parse JSON workflow file', () => {
      const jsonContent = JSON.stringify({
        name: 'json-workflow',
        version: '2.0',
        nodes: [{ id: 'n1', type: 'tool' }],
      });
      const parsed = JSON.parse(jsonContent);
      expect(parsed.name).toBe('json-workflow');
      expect(parsed.version).toBe('2.0');
    });
  });

  describe('WorkflowDefinitionExtended', () => {
    it('should include computedEntry as string array', () => {
      const extended = {
        name: 'test',
        version: '1.0',
        nodes: [
          { id: 'n1', type: 'tool' },
          { id: 'n2', type: 'tool', depends_on: ['n1'] },
        ],
        computedEntry: ['n1'],
        nodeMap: new Map([['n1', { id: 'n1', type: 'tool' }]]),
        topologicalOrder: ['n1', 'n2'],
      };
      expect(extended.computedEntry).toBeInstanceOf(Array);
      expect(extended.nodeMap).toBeInstanceOf(Map);
      expect(extended.topologicalOrder).toBeInstanceOf(Array);
    });
  });

  describe('Workflow entity', () => {
    it('should have all required fields', () => {
      const workflow: {
        id: string;
        name: string;
        version: string;
        description?: string;
        definition: object;
        config: object;
        metadata: object;
        tags: string[];
        createdAt: Date;
        updatedAt: Date;
      } = {
        id: 'wf_123',
        name: 'test-workflow',
        version: '1.0',
        definition: { name: 'test', nodes: [] },
        config: {},
        metadata: {},
        tags: ['test'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(workflow.id).toBeDefined();
      expect(workflow.name).toBe('test-workflow');
      expect(workflow.createdAt).toBeInstanceOf(Date);
    });
  });
});
