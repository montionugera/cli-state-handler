import { defineConfig } from 'vitest/config';
import { ucsaCoreIife } from './apps/docs/vite-plugins/ucsa-core-iife.js';
import { joyAlias } from './apps/docs/joy-alias.js';

export default defineConfig({
  // Provides `virtual:ucsa-core-iife` for the docs sandbox when tests run from the repo root.
  plugins: [ucsaCoreIife()],
  // apps/docs tests also run from the root; they need the Joymify design system aliases.
  resolve: { dedupe: ['react', 'react-dom'], alias: joyAlias },
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
