-- Migration 005: Enforce Explicit Foreign Key Naming with ON UPDATE CASCADE & ON DELETE RESTRICT

BEGIN;

-- ============================================================================
-- STEP 1: DROP ALL EXISTING FOREIGN KEYS ON TARGET DOMAIN TABLES
-- ============================================================================
DO $$
DECLARE
    r RECORD;
    target_tables TEXT[] := ARRAY[
        'security_master', 'portfolios', 'aggregates', 'aggregate_tree',
        'events', 'recurring_flows', 'fx_rates', 'prices', 'positions',
        'nav', 'aggregate_nav', 'lookthrough_data', 'security_breakdowns',
        'portfolio_breakdowns', 'aggregate_breakdowns', 'security_performance',
        'portfolio_performance', 'portfolio_nav_return', 'aggregate_performance',
        'aggregate_nav_return', 'security_risk', 'portfolio_risk',
        'aggregate_risk', 'transactions', 'capital_flows'
    ];
BEGIN
    FOR r IN (
        SELECT conrelid::regclass AS table_name, conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND connamespace = 'public'::regnamespace
          AND conrelid::regclass::text = ANY(target_tables)
    ) LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I;', r.table_name, r.conname);
    END LOOP;
END $$;

-- ============================================================================
-- STEP 2: RECREATE MASTER DATA FOREIGN KEYS
-- ============================================================================

-- security_master
ALTER TABLE public.security_master
    ADD CONSTRAINT fk_security_master_risk_proxy
        FOREIGN KEY (risk_proxy) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    ADD CONSTRAINT fk_security_master_currency
        FOREIGN KEY (currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- portfolios
ALTER TABLE public.portfolios
    ADD CONSTRAINT fk_portfolios_currency
        FOREIGN KEY (currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregates
ALTER TABLE public.aggregates
    ADD CONSTRAINT fk_aggregates_currency
        FOREIGN KEY (currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregate_tree (Mapping table: CASCADE allowed on parent removal)
ALTER TABLE public.aggregate_tree
    ADD CONSTRAINT fk_aggregate_tree_parent
        FOREIGN KEY (parent_id) REFERENCES public.aggregates(aggregate_id)
        ON UPDATE CASCADE ON DELETE CASCADE;

-- ============================================================================
-- STEP 3: RECREATE LEDGER & FLOWS FOREIGN KEYS
-- ============================================================================

-- events
ALTER TABLE public.events
    ADD CONSTRAINT fk_events_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_events_source_portfolio
        FOREIGN KEY (source_portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    ADD CONSTRAINT fk_events_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- recurring_flows
ALTER TABLE public.recurring_flows
    ADD CONSTRAINT fk_recurring_flows_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_recurring_flows_linked_portfolio
        FOREIGN KEY (linked_portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE SET NULL;

-- transactions
ALTER TABLE public.transactions
    ADD CONSTRAINT fk_transactions_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_transactions_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_transactions_fee_currency
        FOREIGN KEY (fee_currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_transactions_counter_currency
        FOREIGN KEY (counter_currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- capital_flows
ALTER TABLE public.capital_flows
    ADD CONSTRAINT fk_capital_flows_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_capital_flows_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- ============================================================================
-- STEP 4: RECREATE TIME-SERIES & VALUATION FOREIGN KEYS
-- ============================================================================

-- fx_rates
ALTER TABLE public.fx_rates
    ADD CONSTRAINT fk_fx_rates_base_ccy
        FOREIGN KEY (base_currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_fx_rates_quote_ccy
        FOREIGN KEY (quote_currency) REFERENCES public.currencies(currency_code)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- prices
ALTER TABLE public.prices
    ADD CONSTRAINT fk_prices_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- positions
ALTER TABLE public.positions
    ADD CONSTRAINT fk_positions_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_positions_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- nav
ALTER TABLE public.nav
    ADD CONSTRAINT fk_nav_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregate_nav
ALTER TABLE public.aggregate_nav
    ADD CONSTRAINT fk_aggregate_nav_aggregate
        FOREIGN KEY (aggregate_id) REFERENCES public.aggregates(aggregate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- ============================================================================
-- STEP 5: RECREATE BREAKDOWN TABLES FOREIGN KEYS
-- ============================================================================

-- lookthrough_data
ALTER TABLE public.lookthrough_data
    ADD CONSTRAINT fk_lookthrough_data_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_lookthrough_data_catalog
        FOREIGN KEY (breakdown, sector) REFERENCES public.breakdown_catalog(breakdown, sector)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- security_breakdowns
ALTER TABLE public.security_breakdowns
    ADD CONSTRAINT fk_security_breakdowns_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_security_breakdowns_catalog
        FOREIGN KEY (breakdown, sector) REFERENCES public.breakdown_catalog(breakdown, sector)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- portfolio_breakdowns
ALTER TABLE public.portfolio_breakdowns
    ADD CONSTRAINT fk_portfolio_breakdowns_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_portfolio_breakdowns_catalog
        FOREIGN KEY (breakdown, sector) REFERENCES public.breakdown_catalog(breakdown, sector)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregate_breakdowns
ALTER TABLE public.aggregate_breakdowns
    ADD CONSTRAINT fk_aggregate_breakdowns_aggregate
        FOREIGN KEY (aggregate_id) REFERENCES public.aggregates(aggregate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT fk_aggregate_breakdowns_catalog
        FOREIGN KEY (breakdown, sector) REFERENCES public.breakdown_catalog(breakdown, sector)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- ============================================================================
-- STEP 6: RECREATE PERFORMANCE & RETURN FOREIGN KEYS
-- ============================================================================

-- security_performance
ALTER TABLE public.security_performance
    ADD CONSTRAINT fk_security_performance_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- portfolio_performance
ALTER TABLE public.portfolio_performance
    ADD CONSTRAINT fk_portfolio_performance_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- portfolio_nav_return
ALTER TABLE public.portfolio_nav_return
    ADD CONSTRAINT fk_portfolio_nav_return_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregate_performance
ALTER TABLE public.aggregate_performance
    ADD CONSTRAINT fk_aggregate_performance_aggregate
        FOREIGN KEY (aggregate_id) REFERENCES public.aggregates(aggregate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregate_nav_return
ALTER TABLE public.aggregate_nav_return
    ADD CONSTRAINT fk_aggregate_nav_return_aggregate
        FOREIGN KEY (aggregate_id) REFERENCES public.aggregates(aggregate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- ============================================================================
-- STEP 7: RECREATE RISK METRICS FOREIGN KEYS
-- ============================================================================

-- security_risk
ALTER TABLE public.security_risk
    ADD CONSTRAINT fk_security_risk_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- portfolio_risk
ALTER TABLE public.portfolio_risk
    ADD CONSTRAINT fk_portfolio_risk_portfolio
        FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(portfolio_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- aggregate_risk
ALTER TABLE public.aggregate_risk
    ADD CONSTRAINT fk_aggregate_risk_aggregate
        FOREIGN KEY (aggregate_id) REFERENCES public.aggregates(aggregate_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

COMMIT;