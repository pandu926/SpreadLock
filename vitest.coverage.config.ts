import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['packages/**/*.test.ts','apps/**/*.test.ts'],maxWorkers:1,testTimeout:120000,coverage:{provider:'v8',include:['packages/*/src/**/*.ts','apps/*/src/**/*.ts'],exclude:['**/*.test.ts','**/*.d.ts'],reporter:['text','json-summary','lcov']}}});
