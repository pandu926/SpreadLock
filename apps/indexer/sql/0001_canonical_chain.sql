CREATE TABLE IF NOT EXISTS chain_blocks (
  chain_id bigint NOT NULL, number numeric(78,0) NOT NULL, hash text NOT NULL,
  parent_hash text NOT NULL, timestamp numeric(78,0) NOT NULL, canonical boolean NOT NULL,
  PRIMARY KEY(chain_id,hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS chain_blocks_canonical_height ON chain_blocks(chain_id,number) WHERE canonical;
CREATE TABLE IF NOT EXISTS chain_checkpoints (
  chain_id bigint PRIMARY KEY, number numeric(78,0) NOT NULL, hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chain_logs (
  chain_id bigint NOT NULL, block_number numeric(78,0) NOT NULL, block_hash text NOT NULL,
  transaction_hash text NOT NULL, log_index integer NOT NULL, address text NOT NULL,
  topics jsonb NOT NULL, data text NOT NULL, event_name text, args jsonb,
  canonical boolean NOT NULL, confirmed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(chain_id,block_hash,transaction_hash,log_index)
);
CREATE INDEX IF NOT EXISTS chain_logs_canonical_range ON chain_logs(chain_id,block_number,log_index) WHERE canonical;
CREATE INDEX IF NOT EXISTS chain_logs_args_account ON chain_logs((args->>'account')) WHERE canonical;
CREATE TABLE IF NOT EXISTS chain_projection_journal (
  id bigserial PRIMARY KEY, chain_id bigint NOT NULL, block_hash text NOT NULL,
  intent_id text NOT NULL, before_status text NOT NULL, after_status text NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_incidents (
  id bigserial PRIMARY KEY, chain_id bigint NOT NULL, kind text NOT NULL,
  details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
ALTER TABLE chain_incidents ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
