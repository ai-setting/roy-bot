#!/usr/bin/env node
/**
 * Build Electron main process and preload scripts using Bun's bundler.
 * 
 * - Main/Environment: ESM (.js)
 * - Preload: CommonJS (.cjs)
 * 
 * Bun's Bundler is used here because esbuild native binary is blocked on Windows (EPERM).
 */
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'dist');

const external = ['electron', '@ai-setting/roy-bot-core', 'better-sqlite3'];

async function build() {
  console.log('Building electron source with Bun bundler...');

  // Build ESM files
  const esmResult = await Bun.build({
    entrypoints: [
      path.join(srcDir, 'environment.ts'),
      path.join(srcDir, 'desktop-component.ts'),
      path.join(srcDir, 'desktop-component-registration.ts'),
      path.join(srcDir, 'main.ts'),
    ],
    outdir: outDir,
    target: 'node',
    format: 'esm',
    sourcemap: 'external',
    external,
    naming: '[name].js',
  });

  for (const error of esmResult.logs) {
    console.error('  [ESM Error]', error);
  }
  console.log(`✓ ${esmResult.outputs.length} ESM file(s) built`);

  // Build preload as CJS
  const cjsResult = await Bun.build({
    entrypoints: [
      path.join(srcDir, 'preload.ts'),
    ],
    outdir: outDir,
    target: 'node',
    format: 'cjs',
    sourcemap: 'external',
    external: ['electron'],
    naming: 'preload.cjs',
  });

  for (const error of cjsResult.logs) {
    console.error('  [CJS Error]', error);
  }
  console.log(`✓ ${cjsResult.outputs.length} CJS file(s) built`);

  console.log('\nBuild complete!');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
