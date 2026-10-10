/// <reference types="vitest" />

import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    /* for example, use global to avoid globals imports (describe, test, expect): */
    // globals: true,
    coverage: {
      reporter: ['text', 'json-summary', 'json', 'lcov'],
      reportOnFailure: true,
      // Just below the current coverage, so a drop fails the run
      thresholds: {
        statements: 98,
        branches: 98,
        functions: 97,
        lines: 99,
      },
    }
  }
});