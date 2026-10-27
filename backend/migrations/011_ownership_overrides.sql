-- Migration 011: ownership_overrides (replaces portfolios.owner)
-- Every portfolio is the user's, 100%, unless this table says otherwise. Rows are change points: for a portfolio and
-- a date, the latest row with start_date <= date gives the user's share (my_share, 0-100); no row = 100%.
-- Joint account: my_share 50. A portfolio that is only the co-owner's: my_share 0 from its first day. Back to the
-- user alone: a new row with my_share 100 (old rows are never closed or edited, so no overlaps).
-- Aggregates (src/aggregates.js) apply the share of the day they compute, so history and recomputes stay right.

CREATE TABLE IF NOT EXISTS public.ownership_overrides (
    portfolio_id TEXT NOT NULL REFERENCES public.portfolios(portfolio_id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    my_share NUMERIC NOT NULL,
    co_owner TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_ownership_overrides PRIMARY KEY (portfolio_id, start_date),
    CONSTRAINT chk_ownership_overrides_share CHECK (my_share BETWEEN 0 AND 100)
);

-- TRADE_REPUBLIC became a joint account (50/50 with my girlfriend); counted as joint from 2026-01-01 (user)
INSERT INTO public.ownership_overrides (portfolio_id, start_date, my_share, notes)
VALUES ('TRADE_REPUBLIC', '2026-01-01', 50, 'Joint account with my girlfriend')
ON CONFLICT DO NOTHING;

ALTER TABLE public.portfolios DROP COLUMN IF EXISTS owner;
