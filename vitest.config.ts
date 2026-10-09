import { defineConfig } from 'vitest/config';
import { ucsaCoreIife } from './apps/docs/vite-plugins/ucsa-core-iife.js';

export default defineConfig({
  // Provides `virtual:ucsa-core-iife` for the docs sandbox when tests run from the repo root.
  plugins: [ucsaCoreIife()],
  test: {
    // jsdom suites cold-start slowly; the 5s default times out on a loaded machine.
    testTimeout: 15000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/.git/**',
    ],
  },
});
