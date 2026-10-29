import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts'],
    maxWorkers: 2,
    testTimeout: 15000,
    coverage: { provider: 'v8', include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/main.ts', '**/*.test.ts', '**/types.ts'], reporter: ['text', 'json-summary'] },
  },
});
