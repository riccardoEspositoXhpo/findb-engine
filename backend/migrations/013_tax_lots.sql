-- Migration 013: position lots + tax items (src/taxes.js, replaces GAS transferredLots / openLots / closedLots / taxLots)
-- 1. lot_transfers: which ASSETOUT feeds which ASSETIN, flow to flow (GAS matched transferredLots by DATE + SECURITY +
--    QUANTITY). taxes.js pairs new transfers itself (AUTO: same security, other portfolio, ASSETIN 0-5 days after,
--    quantity within 1%) and never touches existing rows: a wrong pair is fixed by hand and marked MANUAL.
-- 2. open_lots: one row per holding (portfolio x security) today: quantity, cost, average price, valued at today's
--    positions; rebuilt every night from the whole ledger.
-- 3. closed_lots: one row per realization (asset -> cash / stablecoin). ENGINE rows are rebuilt every night, MANUAL
--    rows are kept (BINANCE_FUTURES, computed by hand in GAS).
--    The cost of a sale (cost_method): weighted average cost for securities (art. 68 c.6 TUIR, what the brokers
--    withhold on), LIFO for crypto; taxes.js keeps one lot per purchase in memory only.
-- 4. tax_items: per tax year (or flow block) and portfolio, REDDITI_* / REALIZED / UNREALIZED / IVAFE / estimates,
--    rebuilt nightly.

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

-- open_lots PK = (portfolio_id, security_id), closed_lots PK = (portfolio_id, sale_id). Same left side (orig_*: what was paid, buy fee included),
-- then current_* / unrealized_* for open lots, sale_* / realized_* for closed ones. Prices per unit and _base values in
-- the portfolio currency; _eur at the fx of the acquisition (orig) / of the day (current, sale). Rates in %.
CREATE TABLE IF NOT EXISTS public.open_lots (
    date DATE NOT NULL,                           -- day the current values refer to (the run)
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES public.security_master(security_id) ON DELETE CASCADE,
    cost_method TEXT,                             -- AVG (weighted average cost) / LIFO (crypto)
    quantity NUMERIC NOT NULL,
    orig_price NUMERIC,                           -- average price paid (crypto: of the LIFO lots still open)
    orig_value_base NUMERIC,
    orig_value_eur NUMERIC,
    current_price NUMERIC,
    current_value_base NUMERIC,
    current_value_eur NUMERIC,
    unrealized_pnl_base NUMERIC,
    unrealized_pnl_eur NUMERIC,
    unrealized_return_pct NUMERIC,
    tax_rate NUMERIC,
    est_tax_eur NUMERIC,                          -- max(unrealized_pnl_eur, 0) x tax_rate: the whole holding sold today
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_open_lots PRIMARY KEY (portfolio_id, security_id)
);

CREATE TABLE IF NOT EXISTS public.closed_lots (
    sale_date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES public.security_master(security_id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL,                        -- the sale: T<transaction_id> of the SELL (M<n> for MANUAL rows)
    cost_method TEXT,                             -- AVG / LIFO (NULL on MANUAL rows)
    quantity NUMERIC NOT NULL,
    orig_price NUMERIC,
    orig_value_base NUMERIC,
    orig_value_eur NUMERIC,
    sale_price NUMERIC,
    sale_value_base NUMERIC,                      -- gross
    sale_value_eur NUMERIC,
    sale_fee_base NUMERIC,                        -- the sale's commission
    realized_pnl_base NUMERIC,                    -- sale value - fee - orig value
    realized_pnl_eur NUMERIC,
    realized_return_pct NUMERIC,
    tax_rate NUMERIC,
    taxable_gain_eur NUMERIC,                     -- sale_value_eur - orig_value_eur (gross, like the Directa notes)
    sold_for TEXT,                                -- what came back: CASH_EUR, USDT...
    source TEXT NOT NULL DEFAULT 'ENGINE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_closed_lots PRIMARY KEY (portfolio_id, sale_id),
    CONSTRAINT chk_closed_lots_source CHECK (source IN ('ENGINE', 'MANUAL'))
);

-- tax_items: start_date / end_date = the year (Jan 1 - Dec 31), or for the IVAFE portfolios' START / MAX / END_NAV and
-- DAYS_HELD the flow block (split at every CASHIN / CASHOUT / ASSETIN / ASSETOUT: the commercialista's RW periods)
CREATE TABLE IF NOT EXISTS public.tax_items (
    tax_year INTEGER NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    value_eur NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_tax_items PRIMARY KEY (tax_year, portfolio_id, item, start_date)
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
