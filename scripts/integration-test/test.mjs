/**
 * Integration test for @ai-setting/roy-bot-*
 * Tests that published packages can be installed and used correctly
 */

const results = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.push({ name, status: 'FAIL', error: err.message });
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   Error: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

console.log('═══════════════════════════════════════════');
console.log('  Roy Agent Packages Integration Test');
console.log('═══════════════════════════════════════════\n');

// ============================================
// Test 1: @ai-setting/roy-bot-core
// ============================================
console.log('📦 Testing @ai-setting/roy-bot-core...\n');

test('core: AgentComponent exists', async () => {
  const { AgentComponent } = await import('@ai-setting/roy-bot-core');
  assert(typeof AgentComponent === 'function', 'AgentComponent should be a constructor');
});

test('core: WorkflowEngine exists', async () => {
  const { WorkflowEngine } = await import('@ai-setting/roy-bot-core');
  assert(typeof WorkflowEngine === 'function', 'WorkflowEngine should be a constructor');
});

test('core: OTelTracerProvider exists', async () => {
  const { OTelTracerProvider } = await import('@ai-setting/roy-bot-core');
  assert(typeof OTelTracerProvider === 'function', 'OTelTracerProvider should be a constructor');
});

// ============================================
// Test 2: @ai-setting/roy-bot-coder-harness
// ============================================
console.log('\n📦 Testing @ai-setting/roy-bot-coder-harness...\n');

test('coder-harness: LSPPlugin exists', async () => {
  const { LSPPlugin } = await import('@ai-setting/roy-bot-coder-harness');
  assert(typeof LSPPlugin === 'function', 'LSPPlugin should be a constructor');
});

test('coder-harness: getLanguageId function', async () => {
  const { getLanguageId } = await import('@ai-setting/roy-bot-coder-harness');
  assert(getLanguageId('test.ts') === 'typescript', 'should return typescript for .ts');
  assert(getLanguageId('test.js') === 'javascript', 'should return javascript for .js');
});

// ============================================
// Test 3: @ai-setting/roy-bot-cli
// ============================================
console.log('\n📦 Testing @ai-setting/roy-bot-cli...\n');

test('cli: runCli function exists', async () => {
  const { runCli } = await import('@ai-setting/roy-bot-cli');
  assert(typeof runCli === 'function', 'runCli should be a function');
});

test('cli: ActCommand exists', async () => {
  const { ActCommand } = await import('@ai-setting/roy-bot-cli');
  assert(typeof ActCommand === 'function', 'ActCommand should be a constructor');
});

// ============================================
// Summary
// ============================================
console.log('\n═══════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
