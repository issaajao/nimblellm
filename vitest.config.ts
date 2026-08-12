import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process-level entrypoints: both call process.exit and are verified by
      // being run, not by unit tests. Counting them only dilutes the signal
      // from the code that tests can actually reach.
      exclude: ['src/bin/**', 'src/scripts/**'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
