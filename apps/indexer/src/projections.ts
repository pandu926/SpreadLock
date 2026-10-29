import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DecodedLog } from './types.js';

export const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);

async function setStatus(client: PoolClient, chainId: number, blockHash: string, id: string, status: string): Promise<void> {
  const row = (await client.query('SELECT status FROM app_intents WHERE chain_id=$1 AND id=$2 FOR UPDATE', [chainId, id])).rows[0];
  if (!row || row.status === status) return;
  if (status !== 'MINED' && ['MINED', 'CONFIRMED'].includes(row.status as string)) return;
  await client.query('INSERT INTO chain_projection_journal(chain_id,block_hash,intent_id,before_status,after_status) VALUES($1,$2,$3,$4,$5)', [chainId, blockHash, id, row.status, status]);
  await client.query('UPDATE app_intents SET status=$1,updated_at=now() WHERE chain_id=$2 AND id=$3', [status, chainId, id]);
}

export async function applyProjections(client: PoolClient, chainId: number, logs: DecodedLog[]): Promise<void> {
  const appPresent = (await client.query("SELECT to_regclass('app_intents') AS name")).rows[0]?.name;
  if (!appPresent) return; // Indexer may be installed before the API migration.
  const executions = new Set(logs.filter(l => l.eventName === 'IntentExecuted')
    .map(l => `${l.transactionHash.toLowerCase()}:${String(l.args!.account).toLowerCase()}`));
  for (const log of logs) {
    const args = log.args;
    if (!args) continue;
    if (log.eventName === 'IntentExecuted') {
      const id = String(args.intentHash).toLowerCase();
      await setStatus(client, chainId, log.blockHash, id, 'MINED');
      const exists = (await client.query('SELECT id FROM app_intents WHERE chain_id=$1 AND id=$2', [chainId, id])).rowCount;
      if (exists) await client.query(`INSERT INTO app_executions(id,intent_id,chain_id,tx_hash,status,block_number,block_hash,receipt,created_at,updated_at)
        VALUES($1,$2,$3,$4,'MINED',$5,$6,$7,now(),now()) ON CONFLICT(chain_id,tx_hash,intent_id) DO UPDATE
        SET status='MINED',block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,receipt=EXCLUDED.receipt,updated_at=now()`,
      [randomUUID(), id, chainId, log.transactionHash.toLowerCase(), log.blockNumber.toString(), log.blockHash.toLowerCase(), log.receipt ? json(log.receipt) : null]);
    } else if (log.eventName === 'NoncesInvalidated') {
      const rows = await client.query(`SELECT id,body FROM app_intents WHERE chain_id=$1 AND account=$2
        AND (body->>'epoch')::numeric=$3 AND status NOT IN('MINED','CONFIRMED','CANCELLED','INVALIDATED') FOR UPDATE`,
      [chainId, String(args.account).toLowerCase(), String(args.epoch)]);
      const word = BigInt(String(args.word)); const mask = BigInt(String(args.mask));
      for (const row of rows.rows) {
        const nonce = BigInt(String((row.body as Record<string, unknown>).nonce));
        if (nonce >> 8n === word && (mask & (1n << (nonce & 255n))) !== 0n) await setStatus(client, chainId, log.blockHash, row.id as string, 'CANCELLED');
      }
    } else if (log.eventName === 'EpochAdvanced' || log.eventName === 'AuthorizationChanged') {
      const rows = await client.query(`SELECT id FROM app_intents WHERE chain_id=$1 AND account=$2
        AND (body->>'epoch')::numeric < $3 AND status NOT IN('MINED','CONFIRMED','CANCELLED','INVALIDATED') FOR UPDATE`,
      [chainId, log.address.toLowerCase(), String(args.epoch)]);
      for (const row of rows.rows) await setStatus(client, chainId, log.blockHash, row.id as string, 'INVALIDATED');
    } else if (log.eventName === 'RevisionAdvanced') {
      const rows = await client.query(`SELECT id FROM app_intents WHERE chain_id=$1 AND account=$2
        AND (body->>'expectedRevision')::numeric < $3 AND status NOT IN('MINED','CONFIRMED','CANCELLED','INVALIDATED') FOR UPDATE`,
      [chainId, log.address.toLowerCase(), String(args.revision)]);
      for (const row of rows.rows) await setStatus(client, chainId, log.blockHash, row.id as string, 'INVALIDATED');
    } else if (log.eventName === 'AccountLiquidated' || (log.eventName === 'PositionUpdated' &&
      !executions.has(`${log.transactionHash.toLowerCase()}:${String(args.account).toLowerCase()}`))) {
      const account = String(args.account).toLowerCase();
      const rows = await client.query(`SELECT id FROM app_intents WHERE chain_id=$1 AND account=$2
        AND status IN('WAITING','ELIGIBLE','SUBMITTED','CANCEL_REQUESTED') FOR UPDATE`, [chainId, account]);
      for (const row of rows.rows) await setStatus(client, chainId, log.blockHash, row.id as string, 'SUSPENDED');
    }
  }
}

export async function undoProjections(client: PoolClient, chainId: number, orphanHashes: string[]): Promise<void> {
  if (!orphanHashes.length) return;
  const rows = await client.query(`SELECT * FROM chain_projection_journal WHERE chain_id=$1 AND block_hash=ANY($2::text[]) ORDER BY id DESC`, [chainId, orphanHashes]);
  for (const row of rows.rows) {
    // Preserve a newer API-side cancellation request; only undo our own projection.
    await client.query(`UPDATE app_intents SET status=$1,updated_at=now() WHERE chain_id=$2 AND id=$3
      AND (status=$4 OR (status='CONFIRMED' AND $4='MINED'))`, [row.before_status, chainId, row.intent_id, row.after_status]);
  }
  const appPresent = (await client.query("SELECT to_regclass('app_executions') AS name")).rows[0]?.name;
  if (appPresent) await client.query(`UPDATE app_executions SET status='ORPHANED',block_hash=NULL,block_number=NULL,updated_at=now()
    WHERE chain_id=$1 AND block_hash=ANY($2::text[])`, [chainId, orphanHashes]);
  await client.query('DELETE FROM chain_projection_journal WHERE chain_id=$1 AND block_hash=ANY($2::text[])', [chainId, orphanHashes]);
}
