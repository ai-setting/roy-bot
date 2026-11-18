import { describe, test, it, expect, beforeEach } from 'vitest';
import { TemplateResolver } from './template-resolver';
import type { NodeExecutionContext } from '../types';

describe('TemplateResolver', () => {
  let resolver: TemplateResolver;

  beforeEach(() => {
    resolver = new TemplateResolver({
      input: { query: 'weather', city: 'Beijing' },
      previousOutputs: new Map([
        ['fetch', { data: { temp: 25, condition: 'sunny', items: [1, 2, 3] } }],
        ['process', { result: 'processed', score: 0.95 }],
        ['agent', { result: { summary: 'Great day!', metadata: { source: 'weather-api' } }, metadata: { tokens: 100 } }],
      ]),
    });
  });

  describe('resolveString', () => {
    test('should return primitive values unchanged', () => {
      expect(resolver.resolveString('hello')).toBe('hello');
      expect(resolver.resolveString('123')).toBe('123');
      expect(resolver.resolveString('')).toBe('');
    });

    test('should resolve input references with prefix', () => {
      expect(resolver.resolveString('Query: {{input.query}}')).toBe('Query: weather');
      expect(resolver.resolveString('City: {{input.city}}')).toBe('City: Beijing');
    });

    test('should resolve nested input references', () => {
      resolver = new TemplateResolver({
        input: { user: { profile: { name: 'John' } } },
      });
      expect(resolver.resolveString('Name: {{input.user.profile.name}}')).toBe('Name: John');
    });

    test('should support inputs. as alias for input. (backward compatibility)', () => {
      // AgentNode used {{inputs.xxx}} syntax, this should still work
      expect(resolver.resolveString('Query: {{inputs.query}}')).toBe('Query: weather');
      expect(resolver.resolveString('City: {{inputs.city}}')).toBe('City: Beijing');
      expect(resolver.resolveString('Mixed: {{inputs.query}} and {{input.city}}')).toBe('Mixed: weather and Beijing');
    });

    test('should support nested inputs. alias', () => {
      resolver = new TemplateResolver({
        input: { user: { profile: { name: 'Alice' } } },
      });
      expect(resolver.resolveString('Name: {{inputs.user.profile.name}}')).toBe('Name: Alice');
    });

    test('should resolve node output with prefix', () => {
      expect(resolver.resolveString('Condition: {{nodes.fetch}}')).toBe('Condition: {"data":{"temp":25,"condition":"sunny","items":[1,2,3]}}');
      expect(resolver.resolveString('Temp: {{nodes.fetch.data.temp}}')).toBe('Temp: 25');
      expect(resolver.resolveString('Condition: {{nodes.fetch.data.condition}}')).toBe('Condition: sunny');
    });

    test('should resolve node output without prefix (backward compatibility)', () => {
      expect(resolver.resolveString('Temp: {{fetch.data.temp}}')).toBe('Temp: 25');
      expect(resolver.resolveString('Condition: {{fetch.data.condition}}')).toBe('Condition: sunny');
    });

    test('should resolve agent node result', () => {
      // Bare {{agent}} extracts the result field from AgentNode output format
      expect(resolver.resolveString('Summary: {{agent}}')).toBe('Summary: {"summary":"Great day!","metadata":{"source":"weather-api"}}');
      // Explicit {{agent.result}} also works
      expect(resolver.resolveString('Summary: {{agent.result.summary}}')).toBe('Summary: Great day!');
      // Can also access metadata directly
      expect(resolver.resolveString('Tokens: {{agent.metadata.tokens}}')).toBe('Tokens: 100');
    });

    test('should resolve multiple templates in one string', () => {
      expect(resolver.resolveString('Query: {{input.query}}, Condition: {{nodes.fetch.data.condition}}'))
        .toBe('Query: weather, Condition: sunny');
    });

    test('should leave unresolved templates as empty string (Task #2912 fix)', () => {
      // Task #2912: stringify() returns '' for undefined values instead of the
      // original template literal. This prevents downstream bash guards like
      // `[ -n "$SID_COOKIE_RAW" ]` from misrouting when an input field is absent.
      expect(resolver.resolveString('Missing: {{nodes.nonexistent}}')).toBe('Missing: ');
      expect(resolver.resolveString('Missing: {{nonexistent}}')).toBe('Missing: ');
    });

    test('should handle empty template', () => {
      expect(resolver.resolveString('Empty: {{}}')).toBe('Empty: {{}}');
    });
  });

  describe('resolveValue', () => {
    test('should resolve string values', () => {
      expect(resolver.resolveValue('Temperature: {{nodes.fetch.data.temp}}°C'))
        .toBe('Temperature: 25°C');
    });

    test('should resolve object values', () => {
      const result = resolver.resolveValue({
        query: '{{input.query}}',
        temp: '{{nodes.fetch.data.temp}}',
      });
      expect(result).toEqual({
        query: 'weather',
        temp: 25,  // Pure template references preserve original types
      });
    });

    test('should resolve array values', () => {
      const result = resolver.resolveValue([
        '{{input.query}}',
        '{{nodes.fetch.data.condition}}',
        'static',
      ]);
      expect(result).toEqual(['weather', 'sunny', 'static']);
    });

    test('should resolve nested structures', () => {
      const result = resolver.resolveValue({
        level1: {
          level2: '{{input.query}}',
          items: ['{{input.city}}', '{{nodes.fetch.data.temp}}'],
        },
      });
      expect(result).toEqual({
        level1: {
          level2: 'weather',
          items: ['Beijing', 25],  // Pure template references preserve original types
        },
      });
    });

    test('should handle null and undefined', () => {
      expect(resolver.resolveValue(null)).toBe(null);
      expect(resolver.resolveValue(undefined)).toBe(undefined);
    });
  });

  describe('containsTemplates', () => {
    test('should detect templates in strings', () => {
      expect(resolver.containsTemplates('{{input.query}}')).toBe(true);
      expect(resolver.containsTemplates('Query: {{input.query}}')).toBe(true);
      expect(resolver.containsTemplates('No templates')).toBe(false);
    });

    test('should return false for non-strings', () => {
      expect(resolver.containsTemplates(123 as any)).toBe(false);
      expect(resolver.containsTemplates(null as any)).toBe(false);
    });
  });

  describe('extractTemplates', () => {
    test('should extract all template references', () => {
      const templates = resolver.extractTemplates(
        'Query: {{input.query}}, Temp: {{nodes.fetch.data.temp}}'
      );
      expect(templates).toEqual(['{{input.query}}', '{{nodes.fetch.data.temp}}']);
    });

    test('should return empty array for strings without templates', () => {
      expect(resolver.extractTemplates('No templates')).toEqual([]);
    });
  });

  describe('fromContext', () => {
    test('should create resolver from NodeExecutionContext', () => {
      const context: NodeExecutionContext = {
        runId: 'run_123',
        sessionId: 'session_123',
        workflowName: 'test-workflow',
        nodeId: 'test-node',
        input: { key: 'value' },
        previousOutputs: new Map([['prev', { out: 'result' }]]),
        config: {},
        debug: false,
        eventBus: {} as any,
        nodeOutputs: new Map(),
        askUser: () => { throw new Error('askUser not implemented'); },
      };

      const contextResolver = TemplateResolver.fromContext(context);
      expect(contextResolver.resolveString('{{input.key}}')).toBe('value');
      expect(contextResolver.resolveString('{{prev.out}}')).toBe('result');
    });

    test('should prioritize workflowInput over input', () => {
      // Simulate non-entry node: only workflowInput is set, input is different
      const context: NodeExecutionContext = {
        runId: 'run_123',
        sessionId: 'session_123',
        workflowName: 'test-workflow',
        nodeId: 'fetch',
        // input is usually minimal for non-entry nodes
        input: { query: 'input-value' }, // Different from workflowInput
        // workflowInput contains the global workflow input
        workflowInput: { query: 'weather', city: 'Beijing' },
        previousOutputs: new Map(),
        config: {},
        debug: false,
        eventBus: {} as any,
        nodeOutputs: new Map(),
        askUser: () => { throw new Error('askUser not implemented'); },
      };

      const contextResolver = TemplateResolver.fromContext(context);
      // Should use workflowInput (priority), not input
      expect(contextResolver.resolveString('{{input.query}}')).toBe('weather');
      expect(contextResolver.resolveString('{{input.city}}')).toBe('Beijing');
      // If query was from input, it would be 'input-value', but it's 'weather' from workflowInput
    });

    test('should fallback to input when workflowInput is not set', () => {
      // Entry node: only input is set, workflowInput is undefined
      const context: NodeExecutionContext = {
        runId: 'run_123',
        sessionId: 'session_123',
        workflowName: 'test-workflow',
        nodeId: 'entry',
        input: { entryKey: 'entry-value', nested: { deep: 'deep-value' } },
        previousOutputs: new Map(),
        config: {},
        debug: false,
        eventBus: {} as any,
        nodeOutputs: new Map(),
        askUser: () => { throw new Error('askUser not implemented'); },
      };

      const contextResolver = TemplateResolver.fromContext(context);
      // Should fallback to input
      expect(contextResolver.resolveString('{{input.entryKey}}')).toBe('entry-value');
      expect(contextResolver.resolveString('{{input.nested.deep}}')).toBe('deep-value');
    });
  });
});


describe('TemplateResolver output path', () => {
  let outputResolver: any;

  beforeEach(() => {
    // TemplateResolver already imported above
    outputResolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([
        // Standard agent-style output: { result: actualValue, metadata: {...} }
        ['agent1', { result: 'agent-result-value', metadata: { source: 'test' } }],
        // Result with nested object
        ['agent2', { result: { data: 'nested-data', score: 95 }, metadata: {} }],
        // Non-agent-style output (no 'result' property)
        ['tool1', { data: 'direct-data', status: 'ok' }],
      ]),
    });
  });

  test('{{nodeId.output}} should auto-unwrap .result for agent-style output', () => {
    expect(outputResolver.resolveString('{{agent1.output}}')).toBe('agent-result-value');
  });

  test('{{nodeId.output}} should return full value when no .result exists', () => {
    const result = outputResolver.resolveString('{{tool1.output}}');
    expect(result).toBe(JSON.stringify({ data: 'direct-data', status: 'ok' }));
  });

  test('{{nodeId.output.xxx}} should navigate into stored value (no auto-unwrap)', () => {
    // For agent2, stored value is { result: { data: 'nested-data', score: 95 }, metadata: {} }
    // {{agent2.output.data}} → navigate: value['data'] is undefined (data is inside .result)
    // Task #2912: unresolved path now resolves to '' instead of the original template
    expect(outputResolver.resolveString('{{agent2.output.data}}')).toBe('');
  });

  test('{{nodeId.output.result}} should navigate into stored value at .result key', () => {
    // {{agent2.output.result}} → navigate: value['result'] = { data: 'nested-data', score: 95 }
    const result = outputResolver.resolveString('{{agent2.output.result}}');
    expect(result).toBe(JSON.stringify({ data: 'nested-data', score: 95 }));
  });

  test('{{nodeId.output.result.xxx}} should navigate deep into value', () => {
    // {{agent2.output.result.data}} → navigate: value['result']={...}, value['data']='nested-data'
    expect(outputResolver.resolveString('{{agent2.output.result.data}}')).toBe('nested-data');
  });

  test('{{nodeId.output}} should work with {{nodes.xxx.output}} prefix', () => {
    expect(outputResolver.resolveString('{{nodes.agent1.output}}')).toBe('agent-result-value');
  });

  test('{{nodeId.result}} should auto-unwrap .result (unchanged behavior)', () => {
    expect(outputResolver.resolveString('{{agent1.result}}')).toBe('agent-result-value');
  });

  test('{{nodeId.result.xxx}} should navigate into unwrapped result', () => {
    // {{agent2.result.data}} → auto-unwrap .result → { data: 'nested-data', score: 95 }, then .data = 'nested-data'
    expect(outputResolver.resolveString('{{agent2.result.data}}')).toBe('nested-data');
  });

  test('{{nodeId.output.metadata}} should access top-level metadata field', () => {
    // {{agent1.output.metadata}} → navigate: value['metadata'] = { source: 'test' }
    const result = outputResolver.resolveString('{{agent1.output.metadata}}');
    expect(result).toBe(JSON.stringify({ source: 'test' }));
  });

  test('{{nodeId.output.xxx}} should navigate ToolNode-style output with .output as real key', () => {
    // ToolNode output: stored value is { output: { choice: 'a' } }
    // {{check.output.choice}} → navigate: value['output'] = { choice: 'a' }, value['choice'] = 'a'
    const toolNodeResolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([
        ['check', { output: { choice: 'a' } }],
      ]),
    });
    expect(toolNodeResolver.resolveString('{{check.output.choice}}')).toBe('a');
  });

  test('{{nodeId.output.xxx.yyy}} should navigate deep ToolNode-style output', () => {
    const toolNodeResolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([
        ['check', { output: { nested: { value: 'deep' } } }],
      ]),
    });
    expect(toolNodeResolver.resolveString('{{check.output.nested.value}}')).toBe('deep');
  });
});
describe('TemplateResolver Edge Cases', () => {
  test('should handle complex nested paths', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { a: { b: { c: { d: 'deep value' } } } }],
      ]),
    });

    expect(resolver.resolveString('{{node.a.b.c.d}}')).toBe('deep value');
  });

  test('should handle arrays in path', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { items: [{ name: 'item1' }, { name: 'item2' }] }],
      ]),
    });

    expect(resolver.resolveString('{{node.items.0.name}}')).toBe('item1');
    expect(resolver.resolveString('{{node.items.1.name}}')).toBe('item2');
  });

  test('should handle special characters in values', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { special: 'value with "quotes" and \'apostrophes\'' }],
      ]),
    });

    expect(resolver.resolveString('{{node.special}}')).toBe('value with "quotes" and \'apostrophes\'');
  });

  test('should handle numeric values', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { count: 42, ratio: 0.5, negative: -10 }],
      ]),
    });

    expect(resolver.resolveString('Count: {{node.count}}')).toBe('Count: 42');
    expect(resolver.resolveString('Ratio: {{node.ratio}}')).toBe('Ratio: 0.5');
    expect(resolver.resolveString('Negative: {{node.negative}}')).toBe('Negative: -10');
  });

  test('should handle boolean values', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { active: true, deleted: false }],
      ]),
    });

    expect(resolver.resolveString('Active: {{node.active}}')).toBe('Active: true');
    expect(resolver.resolveString('Deleted: {{node.deleted}}')).toBe('Deleted: false');
  });

  test('should handle empty previousOutputs map', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map(),
    });

    // Task #2912: undefined values now resolve to '' instead of original template
    expect(resolver.resolveString('{{node.output}}')).toBe('');
    expect(resolver.resolveString('Missing: {{nodes.nodeId}}')).toBe('Missing: ');
  });

  test('should handle null values in chain', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { a: null }],
      ]),
    });

    // Task #2912: undefined values (from null.a.b traversal) now resolve to ''
    expect(resolver.resolveString('{{node.a.b}}')).toBe('');
  });

  test('should handle undefined intermediate values', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map([
        ['node', { a: undefined }],
      ]),
    });

    // Task #2912: undefined values now resolve to ''
    expect(resolver.resolveString('{{node.a.b}}')).toBe('');
  });

  test('should handle missing node', () => {
    const resolver = new TemplateResolver({
      previousOutputs: new Map(),
    });

    // Task #2912: undefined values now resolve to ''
    expect(resolver.resolveString('Value: {{missing.value}}')).toBe('Value: ');
  });
});

describe('TemplateResolver resolveAndValidate', () => {
  let resolver: TemplateResolver;

  beforeEach(() => {
    resolver = new TemplateResolver({
      input: { query: 'weather', city: 'Beijing' },
      previousOutputs: new Map([
        ['fetch', { data: { temp: 25, condition: 'sunny' } }],
      ]),
    });
  });

  test('should return resolved value and no unresolved for valid input', () => {
    const result = resolver.resolveAndValidate('Query: {{input.query}}');
    
    expect(result.resolved).toBe('Query: weather');
    expect(result.unresolved).toEqual([]);
  });

  test('should return unresolved list for templates that cannot be resolved', () => {
    const result = resolver.resolveAndValidate('Missing: {{input.nonexistent}} and {{nodes.missing.value}}');
    
    expect(result.resolved).toBe('Missing: {{input.nonexistent}} and {{nodes.missing.value}}');
    expect(result.unresolved).toContain('{{input.nonexistent}}');
    expect(result.unresolved).toContain('{{nodes.missing.value}}');
  });

  test('should resolve objects and track unresolved nested paths', () => {
    const result = resolver.resolveAndValidate({
      query: '{{input.query}}',
      missing: '{{input.nonexistent}}',
    });
    
    expect(result.resolved).toEqual({
      query: 'weather',
      missing: '{{input.nonexistent}}',
    });
    expect(result.unresolved).toContain('{{input.nonexistent}}');
  });

  test('should resolve arrays and track unresolved items', () => {
    const result = resolver.resolveAndValidate([
      '{{input.city}}',
      '{{input.missing}}',
    ]);
    
    expect(result.resolved).toEqual(['Beijing', '{{input.missing}}']);
    expect(result.unresolved).toContain('{{input.missing}}');
  });

  test('should handle mixed text and templates', () => {
    const result = resolver.resolveAndValidate('Hello {{input.query}} in {{input.city}}');
    
    expect(result.resolved).toBe('Hello weather in Beijing');
    expect(result.unresolved).toEqual([]);
  });

  test('should handle multiple unresolved templates', () => {
    const result = resolver.resolveAndValidate('{{a}} {{b}} {{c}}');
    
    expect(result.resolved).toBe('{{a}} {{b}} {{c}}');
    expect(result.unresolved).toHaveLength(3);
    expect(result.unresolved).toContain('{{a}}');
    expect(result.unresolved).toContain('{{b}}');
    expect(result.unresolved).toContain('{{c}}');
  });
});

describe('TemplateResolver resolveStrict', () => {
  let resolver: TemplateResolver;

  beforeEach(() => {
    resolver = new TemplateResolver({
      input: { query: 'weather' },
      previousOutputs: new Map([
        ['fetch', { data: { temp: 25 } }],
      ]),
    });
  });

  test('should return resolved value when all templates are resolved', () => {
    const result = resolver.resolveStrict('Query: {{input.query}}');
    expect(result).toBe('Query: weather');
  });

  test('should throw TemplateUnresolvedError when unresolved templates exist', () => {
    expect(() => resolver.resolveStrict('Missing: {{input.nonexistent}}'))
      .toThrow('Unresolved variable');
  });

  test('should throw error with first unresolved template and proper reason', () => {
    try {
      resolver.resolveStrict('{{a}} and {{b}}');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.name).toBe('TemplateUnresolvedError');
      // Should contain the first unresolved template
      expect(error.unresolved).toContain('{{a}}');
      // Error context should have the reason
      expect(error.context.reason).toBe('node_not_found');
    }
  });

  test('should throw error with nodeId and reason for node not found', () => {
    try {
      resolver.resolveStrict('Missing node: {{nodes.nonexistent}}', 'testNode');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.name).toBe('TemplateUnresolvedError');
      expect(error.context.reason).toBe('node_not_found');
      // nodeId should be the referenced node (not found), not the executing node
      expect(error.context.nodeId).toBe('nonexistent');
      expect(error.unresolved).toContain('{{nodes.nonexistent}}');
    }
  });

  test('should throw error with nodeId and reason for unresolved variable', () => {
    try {
      resolver.resolveStrict('Missing: {{input.nonexistent}}', 'testNode');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.name).toBe('TemplateUnresolvedError');
      expect(error.context.reason).toBe('unresolved_variable');
      expect(error.unresolved).toContain('{{input.nonexistent}}');
    }
  });

  test('should work with objects', () => {
    const result = resolver.resolveStrict({ query: '{{input.query}}' });
    expect(result).toEqual({ query: 'weather' });
  });

  test('should throw for unresolved nested template in object', () => {
    expect(() => resolver.resolveStrict({ missing: '{{input.nonexistent}}' }))
      .toThrow('Unresolved variable');
  });

  test('should throw for unresolved template in array', () => {
    expect(() => resolver.resolveStrict(['{{input.query}}', '{{input.missing}}']))
      .toThrow('Unresolved variable');
  });
});

describe('evaluateCondition', () => {
  it('should return true for true literal', () => {
    const resolver = new TemplateResolver({ input: {}, previousOutputs: new Map() });
    expect(resolver.evaluateCondition('true')).toBe(true);
  });

  it('should return false for false literal', () => {
    const resolver = new TemplateResolver({ input: {}, previousOutputs: new Map() });
    expect(resolver.evaluateCondition('false')).toBe(false);
  });

  it('should evaluate equality comparison', () => {
    const resolver = new TemplateResolver({ 
      input: { value: 1 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.value}} == 1')).toBe(true);
    expect(resolver.evaluateCondition('{{input.value}} == 2')).toBe(false);
  });

  it('should evaluate greater than comparison', () => {
    const resolver = new TemplateResolver({ 
      input: { count: 5 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.count}} > 3')).toBe(true);
    expect(resolver.evaluateCondition('{{input.count}} > 10')).toBe(false);
  });

  it('should evaluate AND operator', () => {
    const resolver = new TemplateResolver({ 
      input: { a: true, b: true }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.a}} && {{input.b}}')).toBe(true);
  });

  it('should evaluate OR operator', () => {
    const resolver = new TemplateResolver({ 
      input: { a: true, b: false }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.a}} || {{input.b}}')).toBe(true);
  });

  it('should evaluate inequality comparison', () => {
    const resolver = new TemplateResolver({ 
      input: { value: 1 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.value}} != 2')).toBe(true);
    expect(resolver.evaluateCondition('{{input.value}} != 1')).toBe(false);
  });

  it('should evaluate less than comparison', () => {
    const resolver = new TemplateResolver({ 
      input: { count: 5 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.count}} < 10')).toBe(true);
    expect(resolver.evaluateCondition('{{input.count}} < 3')).toBe(false);
  });

  it('should evaluate greater than or equal comparison', () => {
    const resolver = new TemplateResolver({ 
      input: { count: 5 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.count}} >= 5')).toBe(true);
    expect(resolver.evaluateCondition('{{input.count}} >= 6')).toBe(false);
  });

  it('should evaluate less than or equal comparison', () => {
    const resolver = new TemplateResolver({ 
      input: { count: 5 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.count}} <= 5')).toBe(true);
    expect(resolver.evaluateCondition('{{input.count}} <= 4')).toBe(false);
  });

  it('should evaluate negation operator', () => {
    const resolver = new TemplateResolver({ 
      input: { flag: false }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('!{{input.flag}}')).toBe(true);
  });

  it('should evaluate complex conditions with multiple operators', () => {
    const resolver = new TemplateResolver({ 
      input: { a: 5, b: 3 }, 
      previousOutputs: new Map() 
    });
    expect(resolver.evaluateCondition('{{input.a}} > 3 && {{input.b}} < 5')).toBe(true);
  });

  it('should evaluate node output in conditions', () => {
    const resolver = new TemplateResolver({ 
      input: {}, 
      previousOutputs: new Map([
        ['fetch', { status: 'success' }]
      ]) 
    });
    expect(resolver.evaluateCondition('{{nodes.fetch.status}} == "success"')).toBe(true);
  });

  describe('flattened json agent node output', () => {
    const verifyOutput = {
      result: { passed: false, feedback: 'missing token' },
      passed: false,
      feedback: 'missing token',
      metadata: { outputMode: 'json' },
    };

    function resolverWithVerify() {
      return new TemplateResolver({
        input: {},
        previousOutputs: new Map([['verify', verifyOutput]]),
      });
    }

    it('should evaluate flattened boolean fields in conditions', () => {
      const resolver = resolverWithVerify();
      expect(resolver.evaluateCondition('{{nodes.verify.passed}} == false')).toBe(true);
      expect(resolver.evaluateCondition('{{nodes.verify.passed}} == true')).toBe(false);
      expect(resolver.evaluateCondition('{{nodes.verify.result.passed}} == false')).toBe(true);
    });

    it('should resolve pure templates with correct primitive types', () => {
      const resolver = resolverWithVerify();
      expect(resolver.resolveValue('{{nodes.verify.passed}}')).toBe(false);
      expect(resolver.resolveValue('{{nodes.verify.feedback}}')).toBe('missing token');
      expect(resolver.resolveValue('{{nodes.verify.result.passed}}')).toBe(false);
      expect(resolver.resolveValue('{{nodes.verify.result.feedback}}')).toBe('missing token');
    });

    it('should stringify flattened fields in interpolated strings', () => {
      const resolver = resolverWithVerify();
      expect(resolver.resolveString('verify passed={{nodes.verify.passed}}')).toBe(
        'verify passed=false'
      );
      expect(resolver.resolveString('reason: {{nodes.verify.feedback}}')).toBe(
        'reason: missing token'
      );
    });

    it('should resolve nested path under result wrapper', () => {
      const resolver = resolverWithVerify();
      expect(resolver.resolveValue('{{nodes.verify.result}}')).toEqual({
        passed: false,
        feedback: 'missing token',
      });
    });

    it('should return undefined for missing flattened field paths', () => {
      const resolver = resolverWithVerify();
      expect(resolver.resolveValue('{{nodes.verify.nonexistent}}')).toBeUndefined();
    });
  });

  // Task #2912: stringify() should return '' for undefined input fields,
  // not the original template string. This caused downstream bash guards
  // like `[ -n "$SID_COOKIE_RAW" ]` to incorrectly evaluate as truthy
  // when the field was absent, leading to misrouted cookie fallback paths.
  //
  // NOTE: stringify() is invoked through resolveString() (template substitution),
  // NOT through resolveValue() (which returns raw values). The "regression"
  // tests below exercise resolveString to confirm stringify's behavior on
  // non-undefined values is unchanged.
  describe('stringify: undefined behavior (Task #2912 fix)', () => {
    test('should return empty string when input field is undefined', () => {
      const r = new TemplateResolver({ input: { foo: 'bar' } });
      expect(r.resolveString('{{input.baz}}')).toBe('');
    });

    test('should return empty string when nested input field is undefined', () => {
      const r = new TemplateResolver({ input: { outer: { foo: 'bar' } } });
      expect(r.resolveString('{{input.outer.missing}}')).toBe('');
    });

    test('should return empty string when interpolated in a larger string', () => {
      const r = new TemplateResolver({ input: { present: 'X' } });
      // 'a={{input.missing}}-b={{input.present}}-c' where missing=undefined and present='X'
      // Before fix: 'a={{input.missing}}-b=X-c'  (stringify returned original template)
      // After fix:  'a=-b=X-c'                  (stringify returns '' for undefined)
      expect(r.resolveString('a={{input.missing}}-b={{input.present}}-c')).toBe(
        'a=-b=X-c'
      );
    });

    test('should NOT change behavior for null values (returns "null")', () => {
      const r = new TemplateResolver({ input: { foo: null } });
      expect(r.resolveString('{{input.foo}}')).toBe('null');
    });

    test('should NOT change behavior for string values (returns string)', () => {
      const r = new TemplateResolver({ input: { foo: 'bar' } });
      expect(r.resolveString('{{input.foo}}')).toBe('bar');
    });

    test('should NOT change behavior for zero/number values', () => {
      const r = new TemplateResolver({ input: { count: 0, ratio: 0.5 } });
      expect(r.resolveString('{{input.count}}')).toBe('0');
      expect(r.resolveString('{{input.ratio}}')).toBe('0.5');
    });

    test('should NOT change behavior for boolean values', () => {
      const r = new TemplateResolver({ input: { flag: false, on: true } });
      expect(r.resolveString('{{input.flag}}')).toBe('false');
      expect(r.resolveString('{{input.on}}')).toBe('true');
    });

    test('should NOT change behavior for object values (JSON stringify)', () => {
      const r = new TemplateResolver({ input: { obj: { a: 1 } } });
      expect(r.resolveString('{{input.obj}}')).toBe('{"a":1}');
    });
  });
});
