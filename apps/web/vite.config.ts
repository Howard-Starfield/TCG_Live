import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const core = (file: string) => fileURLToPath(new URL(`../../packages/core/src/${file}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Use core's TypeScript source directly; the server consumes its built output instead.
    alias: [
      { find: /^@tcg-live\/core\/fixtures$/, replacement: core('fixtures.ts') },
      { find: /^@tcg-live\/core$/, replacement: core('index.ts') }
    ]
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.TCG_ADMIN_API ?? 'http://127.0.0.1:3000', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    css: false
  }
});
