import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['**/*.integration.test.ts'], maxWorkers: 1, testTimeout: 120000 } });
