import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';
import { WorkflowValidator } from './workflow-validator';
import type { } from './types';

const YAML_PATH = resolve(__dirname, '../../../../../../examples/a-stock-screener-v0.6.0.yaml');

type ParsedNode = {
  id?: string;
  type?: string;
  config?: Record<string, unknown>;
};

type ParsedWorkflow = {
  name?: string;
  nodes?: ParsedNode[];
} & Record<string, unknown>;

describe('a-stock-screener-v0.6.0.yaml structural portability', () => {
  function readWorkflow(): { raw: string; workflow: ParsedWorkflow } {
    const raw = readFileSync(YAML_PATH, 'utf8');
    return { raw, workflow: yaml.parse(raw) as ParsedWorkflow };
  }

  it('parses and passes workflow validation', () => {
    const { workflow } = readWorkflow();
    const result = new WorkflowValidator().validate(workflow);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('contains no hard-coded virtualenv Python script path', () => {
    const { raw } = readWorkflow();

    expect(raw).not.toContain('.venv/bin/python');
  });

  it('declares module and function for every python_call node', () => {
    const { workflow } = readWorkflow();
    const pythonNodes = (workflow.nodes ?? []).filter(
      (node) => node.type === 'python_call',
    );

    expect(pythonNodes).toHaveLength(9);
    for (const node of pythonNodes) {
      expect(typeof node.config?.module).toBe('string');
      expect(node.config?.module).toMatch(/^investment_strategy\./);
      expect(typeof node.config?.function).toBe('string');
    }
  });
});
