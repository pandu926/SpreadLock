import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrate } from './migrate.js';
import { PgStore } from './pg-store.js';
import type { Execution, StoredIntent } from './types.js';

const database = process.env.TEST_DATABASE_URL;
const owner = '0x1111111111111111111111111111111111111111' as const;
const now = Date.now();
const makeIntent = (id: string): StoredIntent => ({ id, owner, account: owner, executor: owner, chainId: 50383,
  body: {}, signature: '0x', status: 'WAITING', createdAt: now, updatedAt: now });
const makeExecution = (intentId: string): Execution => ({ id: randomUUID(), intentId, chainId: 50383,
  txHash: '0xab', status: 'SUBMITTED', blockNumber: null, blockHash: null, receipt: null, createdAt: now, updatedAt: now });

describe.skipIf(!database)('execution identity upgrade and concurrency', () => {
  const schema = `execution_identity_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let store: PgStore; let original: Execution;
  beforeAll(async () => {
    admin = new Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(database!); url.searchParams.set('options', `-c search_path=${schema}`);
    store = new PgStore(url.toString());
    // Start from the released schema with existing financial evidence.
    await store.pool.query(await readFile('packages/db/migrations/0001_initial.sql', 'utf8'));
    await store.putIntent(makeIntent('legacy'));
    original = makeExecution('legacy');
    await store.pool.query(`INSERT INTO app_executions
      (id,intent_id,chain_id,tx_hash,status,block_number,block_hash,receipt,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [original.id, original.intentId, original.chainId,
      original.txHash, original.status, null, null, null, new Date(now), new Date(now)]);
    await migrate(store.pool);
  });
  afterAll(async () => {
    await store?.close();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  it('preserves legacy execution fields and IDs when migration is repeated', async () => {
    await migrate(store.pool);
    expect(await store.listExecutions(owner, 50383, undefined, undefined, 10)).toEqual([original]);
  });
  it('records a distinct execution for each intent in the same transaction', async () => {
    await store.putIntent(makeIntent('second'));
    const second = makeExecution('second');
    expect(await store.putExecution(second)).toEqual(second);
    const executions = await store.listExecutions(owner, 50383, undefined, undefined, 10);
    expect(executions.map(row => row.intentId).sort()).toEqual(['legacy', 'second']);
  });
  it('deduplicates concurrent reports by chain, transaction and intent without replacing evidence', async () => {
    await store.putIntent(makeIntent('concurrent'));
    const execution = { ...makeExecution('concurrent'), txHash: '0xcd' as const };
    const rows = await Promise.all(Array.from({ length: 20 }, () => store.putExecution({ ...execution, id: randomUUID() })));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect((await store.pool.query('SELECT * FROM app_executions WHERE intent_id=$1', ['concurrent'])).rowCount).toBe(1);
  });
  it('releases the migration connection when an advisory unlock acknowledgement is lost', async () => {
    const client = await store.pool.connect(); let released = false;
    const faultPool = { connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.startsWith('SELECT pg_advisory_unlock')) throw new Error('unlock acknowledgement lost');
        return result;
      },
      release: () => { released = true; client.release(); },
    }) } as unknown as Pool;
    await expect(migrate(faultPool)).resolves.toBeUndefined(); expect(released).toBe(true);
    await migrate(store.pool);
  });
});
