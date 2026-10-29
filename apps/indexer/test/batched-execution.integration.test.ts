import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Hex } from 'viem';
import { migrate } from '../../../packages/db/src/migrate.js';
import { PgIndexerStore } from '../src/pg-store.js';
import type { DecodedLog, Header } from '../src/types.js';

const database = process.env.TEST_DATABASE_URL;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const account = '0x0000000000000000000000000000000000000001';
const header = (n: number): Header => ({ number: BigInt(n), hash: h(n), parentHash: h(n - 1), timestamp: BigInt(n) });
const executionLog = (intent: number, index: number, block: number, tx = 100): DecodedLog => ({
  address: account, blockNumber: BigInt(block), blockHash: h(block), transactionHash: h(tx), logIndex: index,
  topics: [], data: '0x', eventName: 'IntentExecuted', args: { intentHash: h(intent), account },
  receipt: { transactionHash: h(tx), blockHash: h(block), status: 'success' },
});

describe.skipIf(!database)('batched canonical execution lifecycle', () => {
  const schema = `batched_execution_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let pool: Pool; let store: PgIndexerStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: database }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
    await migrate(pool); store = new PgIndexerStore(pool); await store.migrate(); await store.initialize(50383, header(0));
    for (const intent of [10, 11]) await pool.query(`INSERT INTO app_intents
      (id,owner,account,chain_id,executor,body,signature,status,created_at,updated_at)
      VALUES($1,$2,$2,50383,$2,'{}','0x','WAITING',now(),now())`, [h(intent), account]);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  it('projects, confirms, rolls back and re-includes every intent in the same transaction', async () => {
    const events = [executionLog(10, 0, 1), executionLog(11, 1, 1)];
    await store.append(50383, header(1), [...events, ...events]);
    expect((await pool.query('SELECT * FROM app_executions')).rowCount).toBe(2);
    expect((await pool.query('SELECT * FROM chain_logs')).rowCount).toBe(2);
    await store.confirm(50383, 1n);
    expect((await pool.query("SELECT * FROM app_intents WHERE status='CONFIRMED'")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM app_executions WHERE status='CONFIRMED'")).rowCount).toBe(2);
    const ids = (await pool.query('SELECT id FROM app_executions ORDER BY id')).rows;
    await store.rollback(50383, 0n);
    expect((await pool.query("SELECT * FROM app_intents WHERE status='WAITING'")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM app_executions WHERE status='ORPHANED'")).rowCount).toBe(2);
    await store.append(50383, header(1), []);
    await store.append(50383, header(2), [executionLog(10, 0, 2), executionLog(11, 1, 2)]);
    await store.confirm(50383, 2n);
    expect((await pool.query("SELECT * FROM app_intents WHERE status='CONFIRMED'")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM app_executions WHERE status='CONFIRMED'")).rowCount).toBe(2);
    expect((await pool.query('SELECT id FROM app_executions ORDER BY id')).rows).toEqual(ids);
    expect((await pool.query('SELECT * FROM chain_logs WHERE canonical')).rowCount).toBe(2);
    expect((await pool.query('SELECT * FROM chain_logs WHERE NOT canonical')).rowCount).toBe(2);
  });
  it('confirms older mined executions before pruning their canonical recovery headers', async () => {
    await pool.query(`INSERT INTO app_intents
      (id,owner,account,chain_id,executor,body,signature,status,created_at,updated_at)
      VALUES($1,$2,$2,50383,$2,'{}','0x','WAITING',now(),now())`, [h(12), account]);
    await store.append(50383, header(3), [executionLog(12, 0, 3, 101)]);
    await pool.query(`INSERT INTO chain_blocks(chain_id,number,hash,parent_hash,timestamp,canonical)
      SELECT 50383,n,'0x'||lpad(to_hex(n),64,'0'),'0x'||lpad(to_hex(n-1),64,'0'),n,true
      FROM generate_series(4,1000) n`);
    await pool.query('UPDATE chain_checkpoints SET number=1000,hash=$1 WHERE chain_id=50383', [h(1000)]);
    await store.confirm(50383, 1000n);
    expect((await pool.query('SELECT status FROM app_intents WHERE id=$1', [h(12)])).rows[0]?.status).toBe('CONFIRMED');
    expect((await pool.query('SELECT status,receipt FROM app_executions WHERE intent_id=$1', [h(12)])).rows[0])
      .toMatchObject({ status: 'CONFIRMED', receipt: { transactionHash: h(101) } });
    expect(await store.block(50383, 3n)).toBeNull();
  });
});
