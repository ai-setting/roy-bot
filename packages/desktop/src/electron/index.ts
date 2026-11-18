/**
 * @fileoverview Electron Module
 * 
 * Electron-specific adapters and utilities for desktop environment.
 */

// Types
export * from './types';

// Adapters
export { DesktopEnvironmentAdapter, getDefaultAdapter } from './DesktopEnvironmentAdapter';
export type { DesktopEnvironmentAdapterConfig } from './DesktopEnvironmentAdapter';
