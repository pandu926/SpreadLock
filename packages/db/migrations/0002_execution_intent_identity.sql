-- A transaction may execute multiple signed intents (for example through an
-- ERC1271 owner/aggregator). Preserve all existing execution IDs and receipts.
ALTER TABLE app_executions
  DROP CONSTRAINT IF EXISTS app_executions_chain_id_tx_hash_key;
DROP INDEX IF EXISTS app_executions_chain_tx;
CREATE UNIQUE INDEX app_executions_chain_tx_intent
  ON app_executions(chain_id, tx_hash, intent_id);
