/**
 * Test file to verify desktop package scaffold is properly configured
 * Updated for Electron migration: tests Electron structure instead of Tauri
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DESKTOP_PACKAGE_ROOT = path.resolve(__dirname, '..');

describe('Desktop Package Scaffold', () => {
  const expectedFiles = [
    // Frontend
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'tailwind.config.js',
    'index.html',
    'src/main.tsx',
    'src/styles/globals.css',
    'src/App.tsx',
    // Electron
    'electron/tsconfig.json',
    'electron/src/main.ts',
    'electron/src/preload.ts',
    'electron/src/environment.ts',
    'electron-builder.json',
  ];

  describe('Required files exist', () => {
    for (const file of expectedFiles) {
      it(`should have ${file}`, () => {
        const filePath = path.join(DESKTOP_PACKAGE_ROOT, file);
        expect(fs.existsSync(filePath), `File ${file} should exist`).toBe(true);
      });
    }
  });

  describe('package.json validation', () => {
    let packageJson: Record<string, unknown>;

    beforeAll(() => {
      const pkgPath = path.join(DESKTOP_PACKAGE_ROOT, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      packageJson = JSON.parse(content);
    });

    it('should have required dependencies', () => {
      const deps = packageJson.dependencies as Record<string, string>;
      expect(deps).toHaveProperty('react');
      expect(deps).toHaveProperty('react-dom');
      expect(deps).toHaveProperty('zustand');
    });

    it('should have electron dependency', () => {
      const devDeps = packageJson.devDependencies as Record<string, string>;
      expect(devDeps).toHaveProperty('electron');
      expect(devDeps).toHaveProperty('electron-builder');
    });

    it('should reference @ai-setting/roy-bot-core', () => {
      const deps = packageJson.dependencies as Record<string, string>;
      expect(deps).toHaveProperty('@ai-setting/roy-bot-core');
    });

    it('should have main entry for Electron', () => {
      expect(packageJson).toHaveProperty('main');
      // 当前实现：main 指向 .js (ESM bundle，build-preload.js 输出)
      // 备注：ES module 包可以指向 .js 入口，Electron 14+ 支持
      expect(packageJson.main).toBe('electron/dist/main.js');
    });
  });

  describe('tsconfig.json validation', () => {
    let tsconfig: Record<string, unknown>;

    beforeAll(() => {
      const configPath = path.join(DESKTOP_PACKAGE_ROOT, 'tsconfig.json');
      const content = fs.readFileSync(configPath, 'utf-8');
      tsconfig = JSON.parse(content);
    });

    it('should have paths alias @/*', () => {
      const paths = tsconfig.compilerOptions as Record<string, unknown>;
      expect(paths.paths).toHaveProperty('@/*');
    });
  });

  describe('electron-builder.json validation', () => {
    let builderConfig: Record<string, unknown>;

    beforeAll(() => {
      const configPath = path.join(DESKTOP_PACKAGE_ROOT, 'electron-builder.json');
      const content = fs.readFileSync(configPath, 'utf-8');
      builderConfig = JSON.parse(content);
    });

    it('should have appId and productName', () => {
      expect(builderConfig).toHaveProperty('appId');
      expect(builderConfig).toHaveProperty('productName');
    });

    it('should include electron/dist in files', () => {
      const files = builderConfig.files as string[];
      expect(files).toContain('electron/dist/**/*');
    });

    it('should have bundle configuration', () => {
      expect(builderConfig).toHaveProperty('mac');
      expect(builderConfig).toHaveProperty('linux');
      expect(builderConfig).toHaveProperty('win');
    });
  });
});
