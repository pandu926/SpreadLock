CREATE TABLE IF NOT EXISTS app_challenges (
  id uuid PRIMARY KEY, owner text NOT NULL, signer text NOT NULL, chain_id bigint NOT NULL,
  message text NOT NULL, role text NOT NULL CHECK (role IN ('owner','keeper')),
  authorization_id text, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS app_challenges_expiry ON app_challenges(expires_at);
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash text PRIMARY KEY, owner text NOT NULL, signer text NOT NULL, chain_id bigint NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','keeper')), authorization_id text, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS app_baskets (
  id text PRIMARY KEY, account text NOT NULL, owner text NOT NULL, chain_id bigint NOT NULL,
  name text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(chain_id,account)
);
CREATE INDEX IF NOT EXISTS app_baskets_owner ON app_baskets(owner,chain_id,id);
CREATE TABLE IF NOT EXISTS app_keeper_authorizations (
  id text PRIMARY KEY, owner text NOT NULL, keeper text NOT NULL, chain_id bigint NOT NULL,
  accounts text[] NOT NULL, valid_until numeric(78,0) NOT NULL,
  nonce numeric(78,0) NOT NULL, signature text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL, last_heartbeat_at timestamptz,
  UNIQUE(owner,chain_id,nonce)
);
CREATE INDEX IF NOT EXISTS app_keeper_authorizations_owner ON app_keeper_authorizations(owner,chain_id);
CREATE TABLE IF NOT EXISTS app_intents (
  id text PRIMARY KEY, owner text NOT NULL, account text NOT NULL, chain_id bigint NOT NULL,
  executor text NOT NULL, body jsonb NOT NULL, signature text NOT NULL,
  status text NOT NULL CHECK(status IN ('WAITING','ELIGIBLE','SUBMITTED','MINED','CONFIRMED','CANCEL_REQUESTED','CANCELLED','EXPIRED','INVALIDATED','SUSPENDED')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS app_intents_owner ON app_intents(owner,chain_id,id);
CREATE INDEX IF NOT EXISTS app_intents_keeper ON app_intents(executor,chain_id,status,id);
CREATE INDEX IF NOT EXISTS app_intents_account ON app_intents(account,chain_id);
CREATE TABLE IF NOT EXISTS app_executions (
  id uuid PRIMARY KEY, intent_id text NOT NULL REFERENCES app_intents(id), chain_id bigint NOT NULL,
  tx_hash text NOT NULL, status text NOT NULL, block_number numeric(78,0), block_hash text,
  receipt jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(chain_id,tx_hash)
);
CREATE INDEX IF NOT EXISTS app_executions_intent ON app_executions(intent_id,id);
CREATE TABLE IF NOT EXISTS app_audit (
  id bigserial PRIMARY KEY, owner text, action text NOT NULL, entity_id text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS app_jobs (
  id uuid PRIMARY KEY, kind text NOT NULL, dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','done','failed')),
  run_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
  locked_by text, locked_until timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_jobs_ready ON app_jobs(status,run_at);
