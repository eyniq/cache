import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'concurrency',
          include: ['test/concurrency/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Timing-sensitive: run files one by one so event-loop measurements are not disturbed.
          fileParallelism: false,
        },
      },
    ],
  },
});
