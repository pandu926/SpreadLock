import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Hex } from 'viem';
import type { ExecutionReceipt, OutboxEntry, SignedIntent } from './types.js';

type Row = Record<string, string | number | null>;
export class KeeperStore {
  readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intents(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(hash TEXT PRIMARY KEY,intent_hash TEXT NOT NULL REFERENCES intents(hash),
        raw_tx TEXT NOT NULL,nonce INTEGER NOT NULL,reserved_wei TEXT NOT NULL,day TEXT NOT NULL,
        state TEXT NOT NULL,created_at INTEGER NOT NULL,last_broadcast_at INTEGER,
        actual_wei TEXT,charged_day TEXT,receipt_status TEXT);
      DROP INDEX IF EXISTS one_pending;
      CREATE UNIQUE INDEX one_pending ON outbox((1)) WHERE state NOT IN ('CONFIRMED','REPLACED');
      CREATE TABLE IF NOT EXISTS budgets(day TEXT PRIMARY KEY,spent_wei TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intent_due ON intents(status,next_at);`);
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  bind(identity: string): void {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('identity') as Row | undefined;
    if (row && row.value !== identity) throw new Error('Keeper database belongs to another deployment or signer');
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('identity', identity);
  }
  putIntent(envelope: SignedIntent, now: number): void {
    this.db.prepare('INSERT OR IGNORE INTO intents(hash,payload,seen_at) VALUES (?,?,?)')
      .run(envelope.hash, JSON.stringify(envelope), now);
  }
  due(now: number): SignedIntent[] {
    return (this.db.prepare("SELECT payload FROM intents WHERE status='ACTIVE' AND next_at<=? ORDER BY seen_at,hash LIMIT 100")
      .all(now) as Row[]).map(row => JSON.parse(row.payload as string) as SignedIntent);
  }
  defer(hash: Hex, now: number, code: string, permanent = false): void {
    const row = this.db.prepare('SELECT attempts FROM intents WHERE hash=?').get(hash) as Row | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const delay = [1000, 2000, 4000, 8000, 30000][Math.min(attempts - 1, 4)]!;
    this.db.prepare('UPDATE intents SET attempts=?,next_at=?,last_error=?,status=? WHERE hash=?')
      .run(attempts, now + delay, code, permanent ? 'SUSPENDED' : 'ACTIVE', hash);
  }
  finish(hash: Hex, status = 'DONE'): void {
    this.db.prepare('UPDATE intents SET status=? WHERE hash=?').run(status, hash);
  }
  spend(day: string): bigint {
    const row = this.db.prepare('SELECT spent_wei FROM budgets WHERE day=?').get(day) as Row | undefined;
    return BigInt((row?.spent_wei as string | undefined) ?? '0');
  }
  private changeSpend(day: string, delta: bigint): void {
    const next = this.spend(day) + delta;
    if (next < 0n) throw new Error('Invalid budget accounting');
    this.db.prepare('INSERT INTO budgets(day,spent_wei) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET spent_wei=excluded.spent_wei')
      .run(day, next.toString());
  }
  enqueue(entry: OutboxEntry, limit: bigint): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.pending()) throw new Error('Another transaction is pending');
      if (this.spend(entry.day) + entry.reservedWei > limit) throw new Error('Daily gas budget exhausted');
      this.db.prepare(`INSERT INTO outbox(hash,intent_hash,raw_tx,nonce,reserved_wei,day,state,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(entry.hash, entry.intentHash, entry.rawTransaction, entry.nonce,
        entry.reservedWei.toString(), entry.day, entry.state, entry.createdAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending(): OutboxEntry | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE state NOT IN ('CONFIRMED','REPLACED') ORDER BY created_at LIMIT 1").get() as Row | undefined;
    return row ? this.outboxRow(row) : undefined;
  }
  recentConfirmed(limit = 8): OutboxEntry[] {
    return (this.db.prepare("SELECT * FROM outbox WHERE state='CONFIRMED' ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[]).map(row => this.outboxRow(row));
  }
  markBroadcast(hash: Hex, now: number): void {
    this.db.prepare("UPDATE outbox SET state='BROADCAST',last_broadcast_at=? WHERE hash=? AND state!='MINED' AND state!='CONFIRMED'")
      .run(now, hash);
  }
  receipt(hash: Hex, receipt: ExecutionReceipt, now: number, confirmed: boolean): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM outbox WHERE hash=?').get(hash) as Row | undefined;
      if (!row) throw new Error('Unknown outbox transaction');
      this.selectWinner(this.outboxRow(row));
      const day = new Date(now).toISOString().slice(0, 10);
      const actual = receipt.gasUsed * receipt.effectiveGasPrice;
      // The same signed transaction can be re-included in another block with a
      // different base fee without an intervening "not found" RPC response.
      // Charge the delta on its original accounting day so replay stays
      // idempotent and a later unmine refunds exactly the stored amount.
      this.changeSpend((row.charged_day as string | null) ?? day,
        actual - BigInt((row.actual_wei as string | null) ?? '0'));
      this.db.prepare(`UPDATE outbox SET state=?,actual_wei=?,charged_day=COALESCE(charged_day,?),receipt_status=? WHERE hash=?`)
        .run(confirmed ? 'CONFIRMED' : 'MINED', actual.toString(), day, receipt.status, hash);
      if (confirmed && receipt.status === 'success') this.finish(row.intent_hash as Hex);
      if (confirmed && receipt.status === 'reverted') this.defer(row.intent_hash as Hex, now, 'TRANSACTION_REVERTED');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unmine(hash: Hex): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM outbox WHERE hash=?').get(hash) as Row | undefined;
      if (!row) throw new Error('Unknown outbox transaction');
      if (row.actual_wei !== null) this.changeSpend(row.charged_day as string, -BigInt(row.actual_wei as string));
      this.db.prepare("UPDATE outbox SET state='BROADCAST',actual_wei=NULL,charged_day=NULL,receipt_status=NULL WHERE hash=?").run(hash);
      this.db.prepare("UPDATE intents SET status='ACTIVE' WHERE hash=?").run(row.intent_hash!);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  family(entry: OutboxEntry): OutboxEntry[] {
    return (this.db.prepare('SELECT * FROM outbox WHERE intent_hash=? AND nonce=? ORDER BY created_at DESC').all(entry.intentHash,entry.nonce) as Row[]).map(r=>this.outboxRow(r));
  }
  private selectWinner(entry:OutboxEntry):void {
    this.db.prepare("UPDATE outbox SET state='REPLACED' WHERE intent_hash=? AND nonce=? AND hash!=? AND state!='CONFIRMED'").run(entry.intentHash,entry.nonce,entry.hash);
  }
  replace(previous:OutboxEntry,next:OutboxEntry,limit:bigint):void {
    if(previous.nonce!==next.nonce||previous.intentHash!==next.intentHash)throw new Error('Replacement must preserve intent and nonce');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.spend(next.day)+next.reservedWei>limit)throw new Error('Daily gas budget exhausted');
      this.db.prepare("UPDATE outbox SET state='REPLACED' WHERE hash=? AND state IN ('PREPARED','BROADCAST')").run(previous.hash);
      this.db.prepare('INSERT INTO outbox(hash,intent_hash,raw_tx,nonce,reserved_wei,day,state,created_at) VALUES (?,?,?,?,?,?,?,?)').run(next.hash,next.intentHash,next.rawTransaction,next.nonce,next.reservedWei.toString(),next.day,'PREPARED',next.createdAt);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  envelope(hash:Hex):SignedIntent|undefined {
    const r=this.db.prepare('SELECT payload FROM intents WHERE hash=?').get(hash) as Row|undefined;
    return r?JSON.parse(r.payload as string) as SignedIntent:undefined;
  }
  private outboxRow(row: Row): OutboxEntry {
    return { hash: row.hash as Hex, intentHash: row.intent_hash as Hex, rawTransaction: row.raw_tx as Hex,
      nonce: Number(row.nonce), reservedWei: BigInt(row.reserved_wei as string), day: row.day as string,
      state: row.state as OutboxEntry['state'], createdAt: Number(row.created_at),
      lastBroadcastAt: row.last_broadcast_at === null ? null : Number(row.last_broadcast_at) };
  }
}
