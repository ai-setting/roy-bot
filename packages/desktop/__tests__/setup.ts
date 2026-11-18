/**
 * Vitest Setup File
 * Initialize jsdom environment for React component testing
 * 
 * NOTE: This file is loaded before any test files.
 * jsdom environment should provide window/document, but we ensure
 * they're properly available for all tests.
 */

// Create a basic JSDOM instance if not in jsdom environment
// (This is a fallback - normally vitest handles this)

import { JSDOM } from 'jsdom';

// Create JSDOM instance with a basic HTML document
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});

// Set up all browser globals on globalThis
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).navigator = dom.window.navigator;
(global as any).HTMLElement = dom.window.HTMLElement;
(global as any).Element = dom.window.Element;
(global as any).Node = dom.window.Node;
(global as any).Text = dom.window.Text;
(global as any).Event = dom.window.Event;
(global as any).CustomEvent = dom.window.CustomEvent;
(global as any).History = dom.window.History;
(global as any).Location = dom.window.Location;
(global as any).matchMedia = dom.window.matchMedia?.bind(dom.window) ?? (() => ({ matches: false, media: '', onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));

// Add localStorage mock
const storage: Record<string, string> = {};
(global as any).localStorage = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value; },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach(k => delete storage[k]); },
  key: (index: number) => Object.keys(storage)[index] ?? null,
  get length() { return Object.keys(storage).length; },
};

// Add sessionStorage mock
const sessionStorage: Record<string, string> = {};
(global as any).sessionStorage = {
  getItem: (key: string) => sessionStorage[key] ?? null,
  setItem: (key: string, value: string) => { sessionStorage[key] = value; },
  removeItem: (key: string) => { delete sessionStorage[key]; },
  clear: () => { Object.keys(sessionStorage).forEach(k => delete sessionStorage[k]); },
  key: (index: number) => Object.keys(sessionStorage)[index] ?? null,
  get length() { return Object.keys(sessionStorage).length; },
};

// Add fetch mock
(global as any).fetch = async () => {
  throw new Error('fetch not implemented in test environment');
};

// Add requestAnimationFrame mock
(global as any).requestAnimationFrame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16);
(global as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

// Add URL mock
(global as any).URL = dom.window.URL;
(global as any).URLSearchParams = dom.window.URLSearchParams;
