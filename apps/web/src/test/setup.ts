// Vitest setup: jest-dom matchers, RTL cleanup, and DOM shims jsdom lacks (React Flow and motion need them).
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

class ResizeObserverShim implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON: () => ({}) };
    this.callback([{ target, contentRect: rect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverShim;

class DOMMatrixShim {
  m22: number;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? '');
    this.m22 = scale ? Number(scale[1]) : 1;
  }
}
(globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DOMMatrixShim;
(globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= DOMMatrixShim;

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  });
}

// jsdom has no layout; give elements a stable box so measuring libraries do not divide by zero.
for (const key of ['offsetWidth', 'offsetHeight'] as const) {
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)?.get?.toString().includes('800')) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => (key === 'offsetWidth' ? 800 : 600) });
  }
}
