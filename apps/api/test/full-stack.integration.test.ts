import {describe,it} from 'vitest';
// Import runs the exact CLI/service integration harness under the coverage worker.
// Requires a dedicated disposable TEST_DATABASE_URL and prebuilt Foundry artifacts.
describe.skipIf(!process.env.TEST_DATABASE_URL)('complete eight-leg service integration',()=>{
 it('authenticates, executes and confirms an eight-leg open and close through PostgreSQL/API/keeper/indexer',async()=>{await import('../../../scripts/e2e.js');},120000);
});
