-- Migration 013: position lots + tax items (src/taxes.js, replaces GAS transferredLots / openLots / closedLots / taxLots)
-- 1. lot_transfers: which ASSETOUT feeds which ASSETIN, flow to flow (GAS matched transferredLots by DATE + SECURITY +
--    QUANTITY). taxes.js pairs new transfers itself (AUTO: same security, other portfolio, ASSETIN 0-5 days after,
--    quantity within 1%) and never touches existing rows: a wrong pair is fixed by hand and marked MANUAL.
-- 2. open_lots: LIFO lots held today, one per purchase, valued at today's positions; rebuilt every night from the
--    whole ledger.
-- 3. closed_lots: the lots used up by each realization (asset -> cash / stablecoin), one per lot. ENGINE rows are
--    rebuilt every night, MANUAL rows are kept (BINANCE_FUTURES, computed by hand in GAS).
-- 4. tax_items: per tax year and portfolio, REDDITI_* / REALIZED / UNREALIZED / IVAFE / estimates, rebuilt nightly.

CREATE TABLE IF NOT EXISTS public.lot_transfers (
    assetout_flow_id BIGINT NOT NULL REFERENCES public.capital_flows(capital_flow_id) ON DELETE CASCADE,
    assetin_flow_id BIGINT NOT NULL REFERENCES public.capital_flows(capital_flow_id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'AUTO',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_lot_transfers PRIMARY KEY (assetout_flow_id),
    CONSTRAINT uq_lot_transfers_in UNIQUE (assetin_flow_id),
    CONSTRAINT chk_lot_transfers_source CHECK (source IN ('AUTO', 'MANUAL'))
);

-- open_lots and closed_lots mirror each other: one row per purchase (lot_id), a closed lot is the piece of an open lot
-- a sale (sale_id) used up (same lot_id / acquired_date / orig_price); a lot sold in two goes is two closed rows.
-- open_lots PK = (portfolio_id, lot_id), closed_lots PK = (portfolio_id, sale_id, lot_id): they join on lot_id. Same left side (orig_*: what was paid, buy fee included),
-- then current_* / unrealized_* for open lots, sale_* / realized_* for closed ones. Prices per unit and _base values in
-- the portfolio currency; _eur at the fx of the acquisition (orig) / of the day (current, sale). Rates in %.
CREATE TABLE IF NOT EXISTS public.open_lots (
    date DATE NOT NULL,                           -- day the current values refer to (the run)
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES public.security_master(security_id) ON DELETE CASCADE,
    lot_id TEXT NOT NULL,                         -- the purchase: T<transaction_id> / F<capital_flow_id>, kept through transfers
    acquired_date DATE NOT NULL,
    acquired_via TEXT NOT NULL,                   -- BUY, SWAP, VEST, STAKING, REWARDS, ADJUST_IN, ASSETIN...
    quantity NUMERIC NOT NULL,
    orig_price NUMERIC,
    orig_value_base NUMERIC,
    orig_value_eur NUMERIC,
    current_price NUMERIC,
    current_value_base NUMERIC,
    current_value_eur NUMERIC,
    unrealized_pnl_base NUMERIC,
    unrealized_pnl_eur NUMERIC,
    unrealized_return_pct NUMERIC,
    tax_rate NUMERIC,
    est_tax_eur NUMERIC,                          -- max(unrealized_pnl_eur, 0) x tax_rate
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_open_lots PRIMARY KEY (portfolio_id, lot_id)
);

CREATE TABLE IF NOT EXISTS public.closed_lots (
    sale_date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES public.security_master(security_id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL,                        -- the sale: T<transaction_id> of the SELL (M<n> for MANUAL rows)
    lot_id TEXT NOT NULL,                         -- the open lot this piece came from
    acquired_date DATE,
    acquired_via TEXT,
    quantity NUMERIC NOT NULL,
    orig_price NUMERIC,
    orig_value_base NUMERIC,
    orig_value_eur NUMERIC,
    sale_price NUMERIC,
    sale_value_base NUMERIC,                      -- gross
    sale_value_eur NUMERIC,
    sale_fee_base NUMERIC,                        -- the sale's commission, split by quantity
    realized_pnl_base NUMERIC,                    -- sale value - fee - orig value
    realized_pnl_eur NUMERIC,
    realized_return_pct NUMERIC,
    tax_rate NUMERIC,
    taxable_gain_eur NUMERIC,                     -- sale_value_eur - orig_value_eur (gross, like the Directa notes)
    sold_for TEXT,                                -- what came back: CASH_EUR, USDT...
    source TEXT NOT NULL DEFAULT 'ENGINE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_closed_lots PRIMARY KEY (portfolio_id, sale_id, lot_id),
    CONSTRAINT chk_closed_lots_source CHECK (source IN ('ENGINE', 'MANUAL'))
);

CREATE TABLE IF NOT EXISTS public.tax_items (
    tax_year INTEGER NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    value_eur NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_tax_items PRIMARY KEY (tax_year, portfolio_id, item)
);

-- RLS like every other table (001): the engine (postgres) bypasses it, the API needs an authenticated user
ALTER TABLE public.lot_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closed_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_authenticated" ON public.lot_transfers;
DROP POLICY IF EXISTS "allow_all_authenticated" ON public.open_lots;
DROP POLICY IF EXISTS "allow_all_authenticated" ON public.closed_lots;
DROP POLICY IF EXISTS "allow_all_authenticated" ON public.tax_items;
CREATE POLICY "allow_all_authenticated" ON public.lot_transfers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_authenticated" ON public.open_lots FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_authenticated" ON public.closed_lots FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_authenticated" ON public.tax_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
