import { bigint, bigserial, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const chainId = () => bigint('chain_id', { mode:'number' }).notNull();
const createdAt = () => timestamp('created_at', { withTimezone:true }).notNull();
export const baskets = pgTable('app_baskets', {
  id:text('id').primaryKey(), account:text('account').notNull(), owner:text('owner').notNull(),
  chainId:chainId(), name:text('name').notNull(), createdAt:createdAt(),
},t=>[uniqueIndex('app_baskets_chain_account').on(t.chainId,t.account)]);
export const intents = pgTable('app_intents', {
  id:text('id').primaryKey(),owner:text('owner').notNull(),account:text('account').notNull(),
  chainId:chainId(),executor:text('executor').notNull(),body:jsonb('body').notNull(),
  signature:text('signature').notNull(),status:text('status').notNull(),createdAt:createdAt(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[index('app_intents_owner').on(t.owner,t.chainId,t.id)]);
export const authorizations=pgTable('app_keeper_authorizations',{
  id:text('id').primaryKey(),owner:text('owner').notNull(),keeper:text('keeper').notNull(),chainId:chainId(),
  accounts:text('accounts').array().notNull(),validUntil:numeric('valid_until',{precision:78,scale:0}).notNull(),
  nonce:numeric('nonce',{precision:78,scale:0}).notNull(),signature:text('signature').notNull(),
  revokedAt:timestamp('revoked_at',{withTimezone:true}),createdAt:createdAt(),
  lastHeartbeatAt:timestamp('last_heartbeat_at',{withTimezone:true}),
},t=>[uniqueIndex('app_keeper_authorizations_owner_nonce').on(t.owner,t.chainId,t.nonce)]);
export const challenges=pgTable('app_challenges',{
  id:uuid('id').primaryKey(),owner:text('owner').notNull(),signer:text('signer').notNull(),chainId:chainId(),
  message:text('message').notNull(),role:text('role').notNull(),authorizationId:text('authorization_id'),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),consumedAt:timestamp('consumed_at',{withTimezone:true}),
});
export const sessions=pgTable('app_sessions',{
  tokenHash:text('token_hash').primaryKey(),owner:text('owner').notNull(),signer:text('signer').notNull(),chainId:chainId(),
  role:text('role').notNull(),authorizationId:text('authorization_id'),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
});
export const executions=pgTable('app_executions',{
  id:uuid('id').primaryKey(),intentId:text('intent_id').notNull().references(()=>intents.id),chainId:chainId(),
  txHash:text('tx_hash').notNull(),status:text('status').notNull(),blockNumber:numeric('block_number',{precision:78,scale:0}),
  blockHash:text('block_hash'),receipt:jsonb('receipt'),createdAt:createdAt(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[uniqueIndex('app_executions_chain_tx_intent').on(t.chainId,t.txHash,t.intentId)]);
export const audit=pgTable('app_audit',{
  id:bigserial('id',{mode:'bigint'}).primaryKey(),owner:text('owner'),action:text('action').notNull(),
  entityId:text('entity_id').notNull(),metadata:jsonb('metadata').notNull(),createdAt:createdAt(),
});
export const jobs=pgTable('app_jobs',{
  id:uuid('id').primaryKey(),kind:text('kind').notNull(),dedupeKey:text('dedupe_key').notNull().unique(),
  payload:jsonb('payload').notNull(),status:text('status').notNull(),runAt:timestamp('run_at',{withTimezone:true}).notNull(),
  attempts:integer('attempts').notNull(),lockedBy:text('locked_by'),lockedUntil:timestamp('locked_until',{withTimezone:true}),
  lastError:text('last_error'),createdAt:createdAt(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
});
