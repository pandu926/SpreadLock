import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { Address, Hex } from 'viem';
import { applyProjections, json, undoProjections } from './projections.js';
import type { Checkpoint, DecodedLog, Header, IndexerStore, WatchedAddress } from './types.js';

export class PgIndexerStore implements IndexerStore {
  constructor(readonly pool: Pool) {}
  async migrate(): Promise<void> {
    const directory = process.env.INDEXER_MIGRATIONS_DIRECTORY ?? 'apps/indexer/sql';
    const statements = await Promise.all(['0001_canonical_chain.sql','0002_discovery_lookup.sql']
      .map(file => readFile(resolve(directory,file),'utf8')));
    await this.transaction(0, async client => { for (const sql of statements) await client.query(sql); });
  }
  async checkpoint(chainId: number): Promise<Checkpoint | null> {
    const row = (await this.pool.query('SELECT number,hash FROM chain_checkpoints WHERE chain_id=$1', [chainId])).rows[0];
    return row ? { number: BigInt(row.number as string), hash: row.hash as Hex } : null;
  }
  async block(chainId: number, number: bigint): Promise<Header | null> {
    const row = (await this.pool.query('SELECT * FROM chain_blocks WHERE chain_id=$1 AND number=$2 AND canonical', [chainId, number.toString()])).rows[0];
    return row ? { number, hash: row.hash as Hex, parentHash: row.parent_hash as Hex, timestamp: BigInt(row.timestamp as string) } : null;
  }
  async initialize(chainId: number, block: Header): Promise<void> {
    await this.transaction(chainId, async client => {
      const exists = (await client.query('SELECT 1 FROM chain_checkpoints WHERE chain_id=$1', [chainId])).rowCount;
      if (exists) return;
      await this.insertBlock(client, chainId, block);
      await client.query('INSERT INTO chain_checkpoints(chain_id,number,hash) VALUES($1,$2,$3)', [chainId, block.number.toString(), block.hash.toLowerCase()]);
    });
  }
  async watched(chainId: number): Promise<WatchedAddress[]> {
    const rows = await this.pool.query(`SELECT DISTINCT args->>'account' AS address,'account' AS role FROM chain_logs
      WHERE chain_id=$1 AND canonical AND event_name='AccountCreated'
      UNION SELECT DISTINCT args->>'pool' AS address,'pool' AS role FROM chain_logs
      WHERE chain_id=$1 AND canonical AND event_name='PoolConfigured'`, [chainId]);
    return rows.rows.filter(row => /^0x[0-9a-fA-F]{40}$/.test(String(row.address)))
      .map(row => ({ address: row.address as Address, role: row.role as 'account' | 'pool' }));
  }
  async append(chainId: number, block: Header, logs: DecodedLog[]): Promise<void> {
    await this.transaction(chainId, async client => {
      const row = (await client.query('SELECT * FROM chain_checkpoints WHERE chain_id=$1 FOR UPDATE', [chainId])).rows[0];
      if (!row || BigInt(row.number as string) + 1n !== block.number || String(row.hash).toLowerCase() !== block.parentHash.toLowerCase()) throw new Error('Noncontiguous block does not extend durable checkpoint');
      if (logs.some(log => log.blockHash.toLowerCase() !== block.hash.toLowerCase() || log.blockNumber !== block.number)) throw new Error('Log does not belong to block');
      await this.insertBlock(client, chainId, block);
      for (const log of logs) await client.query(`INSERT INTO chain_logs(chain_id,block_number,block_hash,transaction_hash,log_index,address,topics,data,event_name,args,canonical)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) ON CONFLICT(chain_id,block_hash,transaction_hash,log_index) DO UPDATE SET canonical=true,confirmed=false`,
      [chainId, block.number.toString(), log.blockHash.toLowerCase(), log.transactionHash.toLowerCase(), log.logIndex, log.address.toLowerCase(), json(log.topics), log.data, log.eventName, log.args ? json(log.args) : null]);
      await applyProjections(client, chainId, logs);
      await client.query('UPDATE chain_checkpoints SET number=$1,hash=$2,updated_at=now() WHERE chain_id=$3', [block.number.toString(), block.hash.toLowerCase(), chainId]);
    });
  }
  async rollback(chainId: number, ancestor: bigint): Promise<void> {
    await this.transaction(chainId, async client => {
      const anchor = (await client.query('SELECT hash FROM chain_blocks WHERE chain_id=$1 AND number=$2 AND canonical', [chainId, ancestor.toString()])).rows[0];
      if (!anchor) throw new Error('Rollback ancestor is not stored as canonical');
      const orphans = await client.query('SELECT hash FROM chain_blocks WHERE chain_id=$1 AND number>$2 AND canonical ORDER BY number DESC', [chainId, ancestor.toString()]);
      const hashes = orphans.rows.map(row => row.hash as string);
      await undoProjections(client, chainId, hashes);
      await client.query('UPDATE chain_logs SET canonical=false,confirmed=false WHERE chain_id=$1 AND block_hash=ANY($2::text[])', [chainId, hashes]);
      await client.query('UPDATE chain_blocks SET canonical=false WHERE chain_id=$1 AND hash=ANY($2::text[])', [chainId, hashes]);
      await client.query('UPDATE chain_checkpoints SET number=$1,hash=$2,updated_at=now() WHERE chain_id=$3', [ancestor.toString(), anchor.hash, chainId]);
    });
  }
  async confirm(chainId: number, through: bigint): Promise<void> {
    if (through < 0n) return;
    await this.transaction(chainId, async client => {
      await client.query('UPDATE chain_logs SET confirmed=true WHERE chain_id=$1 AND block_number<=$2 AND canonical AND NOT confirmed', [chainId, through.toString()]);
      const appPresent = (await client.query("SELECT to_regclass('app_executions') AS name")).rows[0]?.name;
      if (appPresent) {
        // Confirm while canonical headers still exist. A long backfill may include
        // newly mined executions older than the bounded recovery window.
        const updated = await client.query(`UPDATE app_executions e SET status='CONFIRMED',updated_at=now() WHERE e.chain_id=$1
          AND e.block_number<=$2 AND e.status='MINED' AND EXISTS(SELECT 1 FROM chain_blocks b WHERE b.chain_id=e.chain_id AND b.hash=e.block_hash AND b.canonical)
          RETURNING e.intent_id`, [chainId, through.toString()]);
        for (const row of updated.rows) await client.query("UPDATE app_intents SET status='CONFIRMED',updated_at=now() WHERE id=$1 AND status='MINED'", [row.intent_id]);
      }
      // Only the bounded reorg window needs full block headers/journals. Preserve
      // raw logs, receipts and execution history; never prune financial evidence.
      const pruneBefore=through-512n;
      if(pruneBefore>0n){
        await client.query('DELETE FROM chain_projection_journal WHERE chain_id=$1 AND block_hash IN (SELECT hash FROM chain_blocks WHERE chain_id=$1 AND number<$2)',[chainId,pruneBefore.toString()]);
        await client.query('DELETE FROM chain_blocks WHERE chain_id=$1 AND number<$2',[chainId,pruneBefore.toString()]);
      }
    });
  }
  async incident(chainId: number, kind: string, details: Record<string, unknown>): Promise<void> {
    await this.pool.query('INSERT INTO chain_incidents(chain_id,kind,details) VALUES($1,$2,$3)', [chainId, kind, json(details)]);
  }
  private async insertBlock(client: PoolClient, chainId: number, block: Header): Promise<void> {
    await client.query(`INSERT INTO chain_blocks(chain_id,number,hash,parent_hash,timestamp,canonical) VALUES($1,$2,$3,$4,$5,true)
      ON CONFLICT(chain_id,hash) DO UPDATE SET canonical=true`, [chainId, block.number.toString(), block.hash.toLowerCase(), block.parentHash.toLowerCase(), block.timestamp.toString()]);
  }
  private async transaction<T>(chainId: number, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(73486,$1)', [chainId]); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
