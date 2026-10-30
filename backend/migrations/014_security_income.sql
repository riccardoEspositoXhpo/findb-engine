-- Migration 014: security income + security performance recompute window
-- 1. security_income: cash distributions per unit of an ETF / STOCK, keyed on the ex-dividend date (the day the price
--    drops by it and the market convention for total return: MSCI / S&P total-return indices, GIPS accrual). Fetched
--    nightly from the security's price source (marketData.calculateSecurityIncome: EODHD /api/div, Yahoo chart
--    events), history from EODHD + the GAS income tab (Polygon) for securities no longer priced. amount = raw
--    (unadjusted) amount per unit in `currency`, like the prices we store.
-- 2. security_performance / portfolio_performance / portfolio_nav_return / *_breakdowns.created_at: when a row was last written, so
--    the nightly run restarts from the earliest price / income / nav / ledger row written since (same pattern as ROLL
--    and aggregates; the aggregate tables have it since 001).

CREATE TABLE IF NOT EXISTS public.security_income (
    security_id TEXT NOT NULL REFERENCES public.security_master(security_id) ON DELETE CASCADE,
    ex_date DATE NOT NULL,
    pay_date DATE,
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_security_income PRIMARY KEY (security_id, ex_date),
    CONSTRAINT chk_security_income_amount CHECK (amount > 0)
);

ALTER TABLE public.security_performance ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.portfolio_performance ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.portfolio_nav_return ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.security_breakdowns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.portfolio_breakdowns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.aggregate_breakdowns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- RLS like every other table (001)
ALTER TABLE public.security_income ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_authenticated" ON public.security_income;
CREATE POLICY "allow_all_authenticated" ON public.security_income FOR ALL TO authenticated USING (true) WITH CHECK (true);
