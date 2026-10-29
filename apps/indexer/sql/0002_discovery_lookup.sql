-- Discovery reads must scale with created accounts/pools, not all financial logs.
-- Canonical=false rows remain in raw history but do not affect watched addresses.
CREATE INDEX IF NOT EXISTS chain_logs_canonical_discovery
  ON chain_logs(chain_id,event_name) INCLUDE(args)
  WHERE canonical AND event_name IN ('AccountCreated','PoolConfigured');

-- Confirmation only visits the short pending suffix and never rewrites old rows.
CREATE INDEX IF NOT EXISTS chain_logs_pending_confirmation
  ON chain_logs(chain_id,block_number)
  WHERE canonical AND NOT confirmed;
