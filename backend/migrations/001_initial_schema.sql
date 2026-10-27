-- VALIDATION functions and ENUMS 

DO $$ BEGIN
    CREATE TYPE valuation_frequency_enum AS ENUM ('DLY', 'BIZ', 'WKL', 'MTH', 'ONE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;


CREATE OR REPLACE FUNCTION is_valid_valuation_schedule(freq valuation_frequency_enum, day_val INT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (
        (freq IN ('DLY', 'BIZ', 'ONE') AND day_val IS NULL) OR
        (freq = 'WKL' AND day_val BETWEEN 0 AND 6) OR
        (freq = 'MTH' AND day_val BETWEEN 1 AND 31)
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $$ BEGIN
    CREATE TYPE transaction_type_enum AS ENUM ('BUY', 'SELL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;



-- HELPER TABLES

-- List of Breakdowns and Sectors
CREATE TABLE IF NOT EXISTS breakdown_catalog (
    breakdown TEXT NOT NULL,
    sector TEXT NOT NULL,
    CONSTRAINT pk_breakdown_catalog PRIMARY KEY (breakdown, sector)
);



-- List of Currencies
CREATE TABLE IF NOT EXISTS currencies (
    currency_code VARCHAR(10) PRIMARY KEY,
    currency_name VARCHAR(100),
    type VARCHAR(20) NOT NULL CHECK (type IN ('FIAT', 'CRYPTO', 'STABLECOIN')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- MASTER tables

-- security_master
CREATE TABLE IF NOT EXISTS security_master (
    security_id TEXT PRIMARY KEY,
    security_description TEXT NOT NULL,
    risk_proxy TEXT REFERENCES security_master(security_id) ON DELETE SET NULL,
    currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    valuation_frequency valuation_frequency_enum DEFAULT 'DLY',
    valuation_day INT,
    source TEXT,
    source_id TEXT,
    stablecoin TEXT,
    price_pct BOOLEAN NOT NULL DEFAULT FALSE,
    face NUMERIC(15, 4),
    issue_date DATE,
    coupon NUMERIC(10, 4),
    coupon_frequency TEXT,
    maturity DATE,
    exchange TEXT,
    market CHAR(2) NOT NULL DEFAULT 'EU',
    italy_exposure BOOLEAN NOT NULL DEFAULT FALSE,
    asset_type TEXT NOT NULL,
    asset_class TEXT NOT NULL, 
    region TEXT NOT NULL,
    asset_classification TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_sec_valuation_schedule CHECK (
        is_valid_valuation_schedule(valuation_frequency, valuation_day)
    )
);



-- Master Portafogli
CREATE TABLE IF NOT EXISTS portfolios (
    portfolio_id TEXT PRIMARY KEY,
    portfolio_name TEXT,
    portfolio_type TEXT,
    linked_portfolio TEXT,
    source TEXT,
    balance NUMERIC,
    performance BOOLEAN NOT NULL DEFAULT FALSE,
    valuation_frequency valuation_frequency_enum DEFAULT 'DLY',
    valuation_day INT,
    valuation_method TEXT DEFAULT 'ROLL',
    fiscal_regime TEXT,
    inception_date DATE NOT NULL DEFAULT current_date,
    closed_date DATE,
    liquidation_time_standard TEXT,
    liquidation_time_urgent TEXT,
    currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    ivafe_taxable BOOLEAN NOT NULL DEFAULT FALSE,
    -- XHPO = mine, JOINT = co-owned 50/50 with my girlfriend (her own portfolios would get her code). No history:
    -- aggregates count a JOINT portfolio at 50% for its whole life (decided 2026-10-27, amounts small)
    owner TEXT NOT NULL DEFAULT 'XHPO',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_portfolios_type CHECK (
        portfolio_type IS NULL OR portfolio_type IN (
            'Cash', 
            'Pension', 
            'Traditional Investment', 
            'Alternative Investment', 
            'Liability', 
            'Real Estate Investment', 
            'Real Assets', 
            'Other'
        )
    ),
    CONSTRAINT chk_portfolios_fiscal_regime CHECK (
        fiscal_regime IS NULL OR fiscal_regime IN (
            'AMMINISTRATO',
            'DICHIARATIVO',
            'DICHIARATIVO_CRYPTO'
        )
    ),
    CONSTRAINT chk_ptf_valuation_schedule CHECK (
        is_valid_valuation_schedule(valuation_frequency, valuation_day)
    )
);



-- Tabella Master Aggregati
CREATE TABLE IF NOT EXISTS aggregates (
    aggregate_id TEXT PRIMARY KEY,
    aggregate_name TEXT,
    currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    breakdown_scope TEXT DEFAULT 'ALL'
    CONSTRAINT chk_aggregates_breakdown_scope CHECK (
        breakdown_scope IN ('NONE', 'ALL', 'LT_ONLY')
    )

);


-- Tabella Albero Aggregati
CREATE TABLE IF NOT EXISTS aggregate_tree (
    parent_id TEXT NOT NULL REFERENCES aggregates(aggregate_id) ON DELETE CASCADE,
    child_id TEXT NOT NULL,
    child_type TEXT NOT NULL,
    CONSTRAINT pk_aggregate_tree PRIMARY KEY (parent_id, child_id),
    CONSTRAINT chk_aggregate_tree_child_type CHECK (child_type IN ('PORTFOLIO', 'AGGREGATE'))
);

-- Indice per ottimizzare la risoluzione ricorsiva dell'albero (getConstituentPortfolios)
CREATE INDEX IF NOT EXISTS idx_aggregate_tree_parent_id 
ON aggregate_tree (parent_id);



-- 1. Tabella Events (Event-Driven Ledger per flussi, compravendite e movimenti)
CREATE TABLE IF NOT EXISTS events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date DATE NOT NULL,
    event_type TEXT NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    source_portfolio_id TEXT REFERENCES portfolios(portfolio_id) ON DELETE SET NULL,
    security_id TEXT REFERENCES security_master(security_id) ON DELETE RESTRICT,
    quantity NUMERIC NOT NULL DEFAULT 0,
    price NUMERIC,
    process_date DATE,
    location TEXT,
    fees_override NUMERIC,
    event_notes TEXT,
    event_metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_lookup 
ON events (portfolio_id, date DESC);

-- 2. Tabella Recurring Flows (Mutui, Piani di Accumulo e Rateizzazioni)
CREATE TABLE IF NOT EXISTS recurring_flows (
    recurring_flow_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    eval_date DATE,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    linked_portfolio_id TEXT REFERENCES portfolios(portfolio_id) ON DELETE SET NULL,
    payment_desc TEXT,
    valuation_frequency valuation_frequency_enum NOT NULL DEFAULT 'MTH',
    interest_rate NUMERIC,
    total_amount NUMERIC,
    payment NUMERIC,
    interest NUMERIC,
    principal NUMERIC,
    tax NUMERIC,
    outstanding_amount NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_recurring_flows_payment CHECK (abs(payment - (principal + interest)) < 0.005)
);



-- FX RATES

-- Unified fx_rates table (Forex + Crypto)
CREATE TABLE IF NOT EXISTS fx_rates (
    date DATE NOT NULL,
    base_currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    quote_currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    rate NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_fx_rates PRIMARY KEY (date, base_currency, quote_currency),
    CONSTRAINT chk_fx_rates_rate_positive CHECK (rate > 0)
);

-- Speed up sort index
CREATE INDEX IF NOT EXISTS idx_fx_rates_pair_date_desc 
ON fx_rates (base_currency, quote_currency, date DESC);




-- VALUATIONS

-- Daily Security Prices
CREATE TABLE IF NOT EXISTS prices (
    date DATE NOT NULL,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE CASCADE,
    price NUMERIC(18, 4) NOT NULL,
    -- when the row was written (replace = delete + insert, so a rewrite refreshes it): ROLL re-rolls the portfolios
    -- holding a security from the date of a price written after their last run
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_prices PRIMARY KEY (date, security_id),
    CONSTRAINT chk_prices_price_non_negative CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_prices_sec_date_desc 
ON prices (security_id, date DESC);


-- Tabella Time-Series: Positions
CREATE TABLE IF NOT EXISTS positions (
    date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE RESTRICT,
    quantity NUMERIC NOT NULL,
    price NUMERIC NOT NULL,
    market_value_local NUMERIC NOT NULL,
    market_value_base NUMERIC NOT NULL,
    market_value_eur NUMERIC NOT NULL,
    weight NUMERIC NOT NULL,
    CONSTRAINT pk_positions PRIMARY KEY (date, portfolio_id, security_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_ptf_date_desc 
ON positions (portfolio_id, date DESC, security_id);


-- Tabella Time-Series: NAV (Portafoglio)
CREATE TABLE IF NOT EXISTS nav (
    date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    nav NUMERIC NOT NULL,
    nav_eur NUMERIC NOT NULL,
    -- when the row was written: max(created_at) of a portfolio = its last ROLL run (see valuation.getRollStartDate)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_nav PRIMARY KEY (date, portfolio_id)
);

CREATE INDEX IF NOT EXISTS idx_nav_ptf_date_desc 
ON nav (portfolio_id, date DESC);

-- Tabella Time-Series: Aggregate NAV (Aggregati)
CREATE TABLE IF NOT EXISTS aggregate_nav (
    date DATE NOT NULL,
    aggregate_id TEXT NOT NULL REFERENCES aggregates(aggregate_id) ON DELETE CASCADE,
    nav NUMERIC NOT NULL,
    nav_eur NUMERIC NOT NULL,
    CONSTRAINT pk_aggregate_nav PRIMARY KEY (date, aggregate_id)
);


CREATE INDEX IF NOT EXISTS idx_aggregate_nav_agg_date_desc 
ON aggregate_nav (aggregate_id, date DESC);



-- BREAKDOWN DATA

-- 3. Security Lookthrough Data (Fund/ETF internal allocations)
CREATE TABLE IF NOT EXISTS lookthrough_data (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE CASCADE,
    breakdown TEXT NOT NULL,
    sector TEXT NOT NULL,
    weight NUMERIC NOT NULL,
    CONSTRAINT pk_lookthrough_data PRIMARY KEY (start_date, security_id, breakdown, sector),
    CONSTRAINT chk_lookthrough_dates CHECK (end_date > start_date),
    CONSTRAINT fk_lookthrough_catalog FOREIGN KEY (breakdown, sector) 
        REFERENCES breakdown_catalog (breakdown, sector)
);

-- Compressed Brick Timelines for Security Breakdowns
CREATE TABLE IF NOT EXISTS security_breakdowns (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE CASCADE,
    breakdown TEXT NOT NULL,
    sector TEXT NOT NULL,
    weight NUMERIC NOT NULL,
    CONSTRAINT pk_security_breakdowns PRIMARY KEY (start_date, security_id, breakdown, sector),
    CONSTRAINT chk_sec_breakdowns_dates CHECK (end_date > start_date),
    CONSTRAINT fk_sec_breakdowns_catalog FOREIGN KEY (breakdown, sector) 
        REFERENCES breakdown_catalog (breakdown, sector)
);

CREATE INDEX IF NOT EXISTS idx_sec_breakdowns_lookup 
ON security_breakdowns (security_id, breakdown, start_date, end_date);


-- 1. Mattonelle Temporali dei Breakdown a livello di Portafoglio
CREATE TABLE IF NOT EXISTS portfolio_breakdowns (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    breakdown TEXT NOT NULL,
    sector TEXT NOT NULL,
    weight NUMERIC NOT NULL,
    CONSTRAINT pk_portfolio_breakdowns PRIMARY KEY (start_date, portfolio_id, breakdown, sector),
    CONSTRAINT chk_ptf_breakdowns_dates CHECK (end_date > start_date),
    CONSTRAINT fk_ptf_breakdowns_catalog FOREIGN KEY (breakdown, sector) 
        REFERENCES breakdown_catalog (breakdown, sector)
);

CREATE INDEX IF NOT EXISTS idx_ptf_breakdowns_lookup 
ON portfolio_breakdowns (portfolio_id, breakdown, start_date, end_date);


-- 2. Mattonelle Temporali dei Breakdown a livello di Aggregato
CREATE TABLE IF NOT EXISTS aggregate_breakdowns (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    aggregate_id TEXT NOT NULL REFERENCES aggregates(aggregate_id) ON DELETE CASCADE,
    breakdown TEXT NOT NULL,
    sector TEXT NOT NULL,
    weight NUMERIC NOT NULL,
    CONSTRAINT pk_aggregate_breakdowns PRIMARY KEY (start_date, aggregate_id, breakdown, sector),
    CONSTRAINT chk_agg_breakdowns_dates CHECK (end_date > start_date),
    CONSTRAINT fk_agg_breakdowns_catalog FOREIGN KEY (breakdown, sector) 
        REFERENCES breakdown_catalog (breakdown, sector)
);

CREATE INDEX IF NOT EXISTS idx_agg_breakdowns_lookup 
ON aggregate_breakdowns (aggregate_id, breakdown, start_date, end_date);



-- PERFORMANCE DATA

-- Security Daily/Periodic Performance Returns
CREATE TABLE IF NOT EXISTS security_performance (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE CASCADE,
    price_return NUMERIC DEFAULT 0,
    income_return NUMERIC DEFAULT 0,
    total_return NUMERIC DEFAULT 0,
    CONSTRAINT pk_security_performance PRIMARY KEY (start_date, end_date, security_id),
    CONSTRAINT chk_sec_perf_dates CHECK (end_date > start_date),
    CONSTRAINT chk_sec_perf_sum CHECK (abs((price_return + income_return) - total_return) < 0.00001)
);

-- 1. Portfolio Performance (con scomposizione e quadratura additiva)
CREATE TABLE IF NOT EXISTS portfolio_performance (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    price_return NUMERIC NOT NULL DEFAULT 0,
    income_return NUMERIC NOT NULL DEFAULT 0,
    trade_return NUMERIC NOT NULL DEFAULT 0,
    fx_return NUMERIC NOT NULL DEFAULT 0,
    fee_return NUMERIC NOT NULL DEFAULT 0,
    residual NUMERIC NOT NULL DEFAULT 0,
    total_return NUMERIC NOT NULL DEFAULT 0,
    CONSTRAINT pk_portfolio_performance PRIMARY KEY (start_date, end_date, portfolio_id),
    CONSTRAINT chk_ptf_perf_dates CHECK (end_date > start_date),
    CONSTRAINT chk_ptf_perf_sum CHECK (
        abs((price_return + income_return + trade_return + fx_return + fee_return + residual) - total_return) < 0.0001
    )
);

CREATE INDEX IF NOT EXISTS idx_ptf_perf_lookup 
ON portfolio_performance (portfolio_id, end_date DESC, start_date);

-- 2. Portfolio NAV Return (semplice variazione NAV nominale e PnL)
CREATE TABLE IF NOT EXISTS portfolio_nav_return (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    nav_pnl NUMERIC NOT NULL DEFAULT 0,
    nav_return NUMERIC NOT NULL DEFAULT 0,
    CONSTRAINT pk_portfolio_nav_return PRIMARY KEY (start_date, end_date, portfolio_id),
    CONSTRAINT chk_ptf_nav_ret_dates CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_ptf_nav_ret_lookup 
ON portfolio_nav_return (portfolio_id, end_date DESC, start_date);

-- 3. Aggregate Performance (scomposizione consolidata)
CREATE TABLE IF NOT EXISTS aggregate_performance (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    aggregate_id TEXT NOT NULL REFERENCES aggregates(aggregate_id) ON DELETE CASCADE,
    price_return NUMERIC NOT NULL DEFAULT 0,
    income_return NUMERIC NOT NULL DEFAULT 0,
    trade_return NUMERIC NOT NULL DEFAULT 0,
    fx_return NUMERIC NOT NULL DEFAULT 0,
    fee_return NUMERIC NOT NULL DEFAULT 0,
    residual NUMERIC NOT NULL DEFAULT 0,
    total_return NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_aggregate_performance PRIMARY KEY (start_date, end_date, aggregate_id),
    CONSTRAINT chk_agg_perf_dates CHECK (end_date > start_date),
    CONSTRAINT chk_agg_perf_sum CHECK (
        abs((price_return + income_return + trade_return + fx_return + fee_return + residual) - total_return) < 0.0001
    )
);

CREATE INDEX IF NOT EXISTS idx_agg_perf_lookup 
ON aggregate_performance (aggregate_id, end_date DESC, start_date);

-- 4. Aggregate NAV Return (variazione NAV nominale aggregata)
CREATE TABLE IF NOT EXISTS aggregate_nav_return (
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    aggregate_id TEXT NOT NULL REFERENCES aggregates(aggregate_id) ON DELETE CASCADE,
    nav_pnl NUMERIC NOT NULL DEFAULT 0,
    nav_return NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_aggregate_nav_return PRIMARY KEY (start_date, end_date, aggregate_id),
    CONSTRAINT chk_agg_nav_ret_dates CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_agg_nav_ret_lookup 
ON aggregate_nav_return (aggregate_id, end_date DESC, start_date);


-- RISK DATA
-- Security Risk Matrix
CREATE TABLE IF NOT EXISTS security_risk (
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    metric TEXT NOT NULL,
    value NUMERIC(5,2) NOT NULL,
    CONSTRAINT pk_security_risk PRIMARY KEY (security_id, date, metric)
);

CREATE INDEX IF NOT EXISTS idx_security_risk_sec_date_desc 
ON security_risk (security_id, date DESC);


-- Portfolio Risk Matrix
CREATE TABLE IF NOT EXISTS portfolio_risk (
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    metric TEXT NOT NULL,
    value NUMERIC(5,2) NOT NULL,
    CONSTRAINT pk_portfolio_risk PRIMARY KEY (portfolio_id, date, metric)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_risk_sec_date_desc 
ON portfolio_risk (portfolio_id, date DESC);


-- Aggregate Risk Matrix
CREATE TABLE IF NOT EXISTS aggregate_risk (
    aggregate_id TEXT NOT NULL REFERENCES aggregates(aggregate_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    metric TEXT NOT NULL,
    value NUMERIC(5,2) NOT NULL,
    CONSTRAINT pk_aggrgate_risk PRIMARY KEY (aggregate_id, date, metric)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_risk_sec_date_desc 
ON portfolio_risk (portfolio_id, date DESC);


-- TRANSACTIONS AND FLOWS   

-- Ledger Transazioni
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id BIGINT,
    date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE RESTRICT,
    transaction_type transaction_type_enum NOT NULL,
    quantity NUMERIC NOT NULL,
    transaction_price NUMERIC NOT NULL,
    fee_currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    fee NUMERIC NOT NULL DEFAULT 0,
    fee_value_base NUMERIC NOT NULL DEFAULT 0,
    counter_currency TEXT NOT NULL REFERENCES currencies(currency_code) ON DELETE RESTRICT,
    market_value_local NUMERIC NOT NULL,
    market_value_base NUMERIC NOT NULL,
    market_value_eur NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_lookup 
ON transactions (portfolio_id, date DESC, security_id);

-- 3. Tabella Capital Flows (senza ENUM, puro TEXT flessibile)
CREATE TABLE IF NOT EXISTS capital_flows (
    capital_flow_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id BIGINT,
    date DATE NOT NULL,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    capital_flow_type TEXT NOT NULL,
    security_id TEXT NOT NULL REFERENCES security_master(security_id) ON DELETE RESTRICT,
    quantity NUMERIC NOT NULL,
    market_value_local NUMERIC NOT NULL,
    market_value_base NUMERIC NOT NULL,
    market_value_eur NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_flows_lookup 
ON capital_flows (portfolio_id, date DESC, capital_flow_type);


-- ============================================================================
-- FINDB ROW LEVEL SECURITY (RLS) & POLICIES SETUP
-- Enables RLS across all schema tables and grants full access to authenticated users
-- ============================================================================

DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY[
        -- Master Data & Gerarchie
        'currencies',
        'breakdown_catalog',
        'security_master',
        'portfolios',
        'aggregates',
        'aggregate_tree',
        
        -- Time-Series & Prezzi
        'prices',
        'fx_rates',
        'positions',
        'nav',
        'aggregate_nav',
        
        -- Transazioni & Flussi
        'transactions',
        'capital_flows',
        'events',
        'recurring_flows',
        
        -- Breakdowns & Lookthrough
        'security_breakdowns',
        'portfolio_breakdowns',
        'aggregate_breakdowns',
        'lookthrough_data',
        
        -- Performance & Nav Return
        'security_performance',
        'portfolio_performance',
        'portfolio_nav_return',
        'aggregate_performance',
        'aggregate_nav_return',
        
        -- Risk Data
        'security_risk',
        'portfolio_risk',
        'aggregate_risk'

    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        -- 1. Verifica che la tabella esista ed abilita RLS
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl AND table_schema = 'public') THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
            
            -- 2. Ricrea la policy permissiva al 100% per gli utenti autenticati
            EXECUTE format('DROP POLICY IF EXISTS "allow_all_authenticated" ON %I;', tbl);
            EXECUTE format(
                'CREATE POLICY "allow_all_authenticated" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
                tbl
            );
        END IF;
    END LOOP;
END $$;
