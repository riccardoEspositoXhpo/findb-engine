-- Migration 010: ledger provenance (transactions + capital_flows)
-- GAS had one ID column doing two jobs badly: a per-portfolio max+1 counter (not unique) and the broker's id
-- (hashed to a number with FNV for Kraken). Engine: the identity PK is the row id (GAS ID is not imported), and
-- 1. external_id becomes TEXT: the broker's real id as is (Kraken refids are strings), NULL when there is none
-- 2. source (NOT NULL): who wrote the row: EVENT (events.js, with event_id), GAS (history import), IBKR, KRAKEN,
--    CRYPTO_COM...
-- 3. unique (source, portfolio_id, external_id) when external_id is set: re-importing the same broker file / ledger
--    can never duplicate rows (what event_id does for events)

ALTER TABLE public.transactions ALTER COLUMN external_id TYPE TEXT USING external_id::text;
ALTER TABLE public.transactions ADD COLUMN source TEXT NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_external
    ON public.transactions (source, portfolio_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE public.capital_flows ALTER COLUMN external_id TYPE TEXT USING external_id::text;
ALTER TABLE public.capital_flows ADD COLUMN source TEXT NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_capital_flows_external
    ON public.capital_flows (source, portfolio_id, external_id) WHERE external_id IS NOT NULL;
