-- Migration 009: scheduled_events (replaces the hardcoded GAS AUTO_EVENTS config in local.gs)
-- A template event + a schedule. Each night, rows active on the date whose schedule runs that day generate a real
-- event in `events` (the same doesItRunToday logic as portfolios). Changing an amount = close the row with end_date
-- and open a new one, so history is kept.
-- Active when start_date <= date AND (end_date IS NULL OR date < end_date), same convention as recurring_flows.

CREATE TABLE IF NOT EXISTS scheduled_events (
    scheduled_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_desc TEXT NOT NULL,

    -- Event template (same meaning as the events columns)
    event_type TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    source_portfolio_id TEXT,
    security_id TEXT,
    quantity DOUBLE PRECISION NOT NULL,
    price DOUBLE PRECISION,
    event_notes TEXT,
    event_metadata JSONB,

    -- Schedule (native engine schedule, as on portfolios)
    valuation_frequency valuation_frequency_enum NOT NULL,
    valuation_day INT,
    start_date DATE NOT NULL,
    end_date DATE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_scheduled_events_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_scheduled_events_source_portfolio
        FOREIGN KEY (source_portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_scheduled_events_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT chk_scheduled_events_schedule CHECK (is_valid_valuation_schedule(valuation_frequency, valuation_day)),
    CONSTRAINT chk_scheduled_events_dates CHECK (end_date IS NULL OR end_date > start_date)
);

-- Same RLS setup as every other table (001)
ALTER TABLE scheduled_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_authenticated" ON scheduled_events;
CREATE POLICY "allow_all_authenticated" ON scheduled_events FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- events.processed_at: when the event was turned into ledger rows (NULL = still to process, any date).
-- Replaces GAS "process only events dated today": unprocessed events of any date are picked up.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Ledger lineage: every transaction / capital flow written by an event points to it (NULL = not from an event,
-- e.g. broker imports). Reprocessing an event rewrites exactly its own rows; deleting an event removes them.
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS event_id BIGINT
    REFERENCES public.events(event_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.capital_flows ADD COLUMN IF NOT EXISTS event_id BIGINT
    REFERENCES public.events(event_id) ON UPDATE CASCADE ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_transactions_event ON public.transactions (event_id);
CREATE INDEX IF NOT EXISTS idx_capital_flows_event ON public.capital_flows (event_id);
