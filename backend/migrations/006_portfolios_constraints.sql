-- Migration 006: Portfolios constraint fixes (found while loading the GAS portfolios sheet)
-- 1. portfolio_type: allow 'Cryptocurrency Investment' (GAS uses it for the crypto risk calendar and crypto tax)
-- 2. valuation_method: restrict to known methods (NULL = history only, never valued, e.g. GAS "FAKE")
-- 3. linked_portfolio: self-referencing FK
-- 4. closed_date cannot precede inception_date
-- Closed portfolios keep valuation_frequency NULL: closed_date is the source of truth for "inactive".

ALTER TABLE public.portfolios DROP CONSTRAINT IF EXISTS chk_portfolios_type;
ALTER TABLE public.portfolios
    ADD CONSTRAINT chk_portfolios_type CHECK (
        portfolio_type IS NULL OR portfolio_type IN (
            'Cash',
            'Pension',
            'Traditional Investment',
            'Cryptocurrency Investment',
            'Alternative Investment',
            'Liability',
            'Real Estate Investment',
            'Real Assets',
            'Other'
        )
    );

ALTER TABLE public.portfolios
    ADD CONSTRAINT chk_portfolios_valuation_method CHECK (
        valuation_method IS NULL OR valuation_method IN (
            'ROLL',
            'BALANCE',
            'FILE',
            'RECURRING_FLOWS',
            'CUSTOM'
        )
    );

ALTER TABLE public.portfolios
    ADD CONSTRAINT fk_portfolios_linked_portfolio
        FOREIGN KEY (linked_portfolio) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.portfolios
    ADD CONSTRAINT chk_portfolios_dates CHECK (
        closed_date IS NULL OR closed_date >= inception_date
    );
