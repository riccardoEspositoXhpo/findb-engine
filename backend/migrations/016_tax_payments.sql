-- Migration 016: declared tax paid + REALIZED_TAX (user, 2026-10-30)
-- 1. tax_payments: one row per tax year settled through the tax return (DICHIARATIVO / DICHIARATIVO_CRYPTO capital
--    gains + IVAFE), written by the TAX_PAID event handler (events stay an inbox, this is the record). amount_eur is
--    optional (what was actually paid, for reference): REALIZED_TAX drops the year's estimate on paid_on whatever it
--    was. History by the user's convention: each year paid in September of the next (actual days unknown: the 30th).
-- 2. REALIZED_TAX: liability portfolio valued by taxes.run (one negative DEBT_EUR line a day = the declared tax owed and
--    not yet paid), under DEBT.

CREATE TABLE IF NOT EXISTS public.tax_payments (
    tax_year INTEGER NOT NULL,
    paid_on DATE NOT NULL,
    amount_eur NUMERIC,
    portfolio_id TEXT REFERENCES public.portfolios(portfolio_id) ON DELETE SET NULL,  -- the account it was paid from
    event_id BIGINT REFERENCES public.events(event_id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_tax_payments PRIMARY KEY (tax_year)
);

-- RLS like every other table (001): the engine (postgres) bypasses it, the API needs an authenticated user
ALTER TABLE public.tax_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_authenticated" ON public.tax_payments;
CREATE POLICY "allow_all_authenticated" ON public.tax_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.tax_payments (tax_year, paid_on, portfolio_id, notes) VALUES
  (2023, '2024-09-30', 'FIDEURAM', 'history: paid in September of the next year (user convention, day unknown)'),
  (2024, '2025-09-30', 'FIDEURAM', 'history: paid in September of the next year (user convention, day unknown)'),
  (2025, '2026-09-30', 'FIDEURAM', 'history: paid in September of the next year (user convention, day unknown)')
ON CONFLICT (tax_year) DO NOTHING;

INSERT INTO public.portfolios (portfolio_id, portfolio_name, portfolio_type, performance, valuation_frequency, valuation_method,
  inception_date, liquidation_time_standard, liquidation_time_urgent, currency, ivafe_taxable)
SELECT 'REALIZED_TAX', 'Declared Tax Owed (not yet paid)', 'Liability', false, 'DLY', 'CUSTOM', '2023-01-01',
  liquidation_time_standard, liquidation_time_urgent, 'EUR', false
FROM public.portfolios WHERE portfolio_id = 'UNREALIZED_TAX'
ON CONFLICT (portfolio_id) DO NOTHING;

INSERT INTO public.aggregate_tree (parent_id, child_id, child_type)
SELECT 'DEBT', 'REALIZED_TAX', 'PORTFOLIO'
WHERE NOT EXISTS (SELECT 1 FROM public.aggregate_tree WHERE child_id = 'REALIZED_TAX');
