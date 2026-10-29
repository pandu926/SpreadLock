import type { Pool } from 'pg';
import type { ChainClient, Header } from './types.js';

export interface ReadinessOptions {
  rpc: Pick<ChainClient, 'chainId' | 'head' | 'block'>;
  confirmations: number;
  now?: () => number;
}
export interface ReadinessMetrics {
  headBlock: string;
  checkpointBlock: string;
  lagBlocks: string;
  lagSeconds: string;
  heartbeatAgeSeconds: number;
}
export interface ReadinessResult { ready: boolean; reasons: string[]; metrics?: ReadinessMetrics }
const unavailable = (reason: string): ReadinessResult => ({ ready: false, reasons: [reason] });
const unsigned = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const validHeader = (header: Header, height: bigint) => header.number === height && validHash(header.hash)
  && typeof header.timestamp === 'bigint' && header.timestamp >= 0n;

/** Entry-only gate. A fresh heartbeat alone cannot prove that backfill or RPC is current. */
export async function compatibilityReady(pool: Pool, chainId: number, options?: ReadinessOptions): Promise<ReadinessResult> {
  if (options && (!Number.isInteger(options.confirmations) || options.confirmations < 1 || options.confirmations > 256))
    return unavailable('READINESS_CONFIGURATION_INVALID');
  let row;
  try {
    const schema = await pool.query("SELECT to_regclass('chain_checkpoints') AS checkpoints,to_regclass('chain_incidents') AS incidents,to_regclass('chain_blocks') AS blocks");
    if (!schema.rows[0]?.checkpoints || !schema.rows[0]?.incidents || !schema.rows[0]?.blocks)
      return unavailable('INDEXER_NOT_INITIALIZED');
    // One PostgreSQL statement gives checkpoint, canonical header and incidents one MVCC snapshot.
    const snapshot = await pool.query(`SELECT c.number::text,c.hash,b.timestamp::text,
      EXTRACT(EPOCH FROM (statement_timestamp()-c.updated_at))::text AS heartbeat_age_seconds,
      ARRAY(SELECT DISTINCT kind FROM chain_incidents WHERE chain_id=$1 AND resolved_at IS NULL
        AND kind IN('DEEP_REORG','IMPLEMENTATION_CHANGED') ORDER BY kind) AS incident_kinds
      FROM (SELECT 1) anchor LEFT JOIN chain_checkpoints c ON c.chain_id=$1
      LEFT JOIN chain_blocks b ON b.chain_id=c.chain_id AND b.number=c.number AND b.hash=c.hash AND b.canonical`, [chainId]);
    row = snapshot.rows[0];
  } catch {
    return unavailable('INDEXER_UNAVAILABLE');
  }
  const reasons: string[] = Array.isArray(row?.incident_kinds) ? row.incident_kinds.map(String) : [];
  const finish = (extra: string[] = [], metrics?: ReadinessMetrics): ReadinessResult => {
    const all = [...new Set([...reasons, ...extra])];
    return { ready: all.length === 0, reasons: all, ...(metrics ? { metrics } : {}) };
  };
  if (!row || !unsigned(row.number) || !validHash(row.hash) || !unsigned(row.timestamp)
    || row.heartbeat_age_seconds === null || row.heartbeat_age_seconds === undefined
    || !Number.isFinite(Number(row.heartbeat_age_seconds)) || Number(row.heartbeat_age_seconds) < 0)
    return finish(['INDEXER_NOT_INITIALIZED']);
  const heartbeatAgeSeconds = Number(row.heartbeat_age_seconds);
  if (heartbeatAgeSeconds > 60) reasons.push('INDEXER_NOT_INITIALIZED');
  if (!options) return finish(['HEAD_UNAVAILABLE']);
  const checkpointNumber = BigInt(row.number), checkpointTimestamp = BigInt(row.timestamp);
  try {
    if (await options.rpc.chainId() !== chainId) return finish(['CHAIN_MISMATCH']);
    const headNumber = await options.rpc.head();
    if (typeof headNumber !== 'bigint' || headNumber < 0n) return finish(['HEAD_UNAVAILABLE']);
    if (headNumber < checkpointNumber) return finish(['RPC_BEHIND_CHECKPOINT']);
    const head = await options.rpc.block(headNumber);
    if (!validHeader(head, headNumber)) return finish(['HEAD_UNAVAILABLE']);
    const checkpoint = headNumber === checkpointNumber ? head : await options.rpc.block(checkpointNumber);
    if (!validHeader(checkpoint, checkpointNumber)) return finish(['HEAD_UNAVAILABLE']);
    if (checkpoint.hash.toLowerCase() !== row.hash.toLowerCase() || checkpoint.timestamp !== checkpointTimestamp)
      return finish(['CHECKPOINT_NOT_CANONICAL']);
    // Detect an intervening branch change rather than mixing two RPC histories.
    if (headNumber !== checkpointNumber) {
      const checkedHead = await options.rpc.block(headNumber);
      if (!validHeader(checkedHead, headNumber)) return finish(['HEAD_UNAVAILABLE']);
      if (checkedHead.hash.toLowerCase() !== head.hash.toLowerCase() || checkedHead.timestamp !== head.timestamp)
        return finish(['HEAD_CHANGED']);
    }
    const nowMs = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return finish(['READINESS_CONFIGURATION_INVALID']);
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));
    const lagBlocks = headNumber - checkpointNumber, lagSeconds = head.timestamp - checkpointTimestamp;
    if (head.timestamp > nowSeconds + 5n || lagSeconds < 0n) reasons.push('HEAD_TIME_INVALID');
    if (nowSeconds - head.timestamp > 30n) reasons.push('HEAD_STALE');
    if (lagBlocks > BigInt(options.confirmations + 64)) reasons.push('INDEXER_BLOCK_LAG');
    if (lagSeconds > 30n) reasons.push('INDEXER_TIME_LAG');
    return finish([], { headBlock: headNumber.toString(), checkpointBlock: checkpointNumber.toString(),
      lagBlocks: lagBlocks.toString(), lagSeconds: lagSeconds.toString(), heartbeatAgeSeconds });
  } catch {
    return finish(['HEAD_UNAVAILABLE']);
  }
}
