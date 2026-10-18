-- Migration 004: Comprehensive Numeric Precision & Production Storage Optimization

-- 1. Optimizing fx_rates Primary Key layout for fast latest/date lookups
ALTER TABLE public.fx_rates DROP CONSTRAINT IF EXISTS pk_fx_rates;
ALTER TABLE public.fx_rates ADD CONSTRAINT pk_fx_rates PRIMARY KEY (base_currency, quote_currency, date);
DROP INDEX IF EXISTS public.idx_fx_rates_pair_date_desc;

-- 2. Comprehensive Type Migration to DOUBLE PRECISION (float8) across ALL financial tables


-- security_master numeric attributes
ALTER TABLE public.security_master 
  ALTER COLUMN face TYPE DOUBLE PRECISION,
  ALTER COLUMN coupon TYPE DOUBLE PRECISION;

-- portfolios numeric attributes
ALTER TABLE public.portfolios 
  ALTER COLUMN balance TYPE DOUBLE PRECISION;

-- prices
ALTER TABLE public.prices 
  ALTER COLUMN price TYPE DOUBLE PRECISION;

-- fx_rates
ALTER TABLE public.fx_rates 
  ALTER COLUMN rate TYPE DOUBLE PRECISION;

-- positions
ALTER TABLE public.positions 
  ALTER COLUMN quantity TYPE DOUBLE PRECISION,
  ALTER COLUMN price TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_local TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_base TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_eur TYPE DOUBLE PRECISION,
  ALTER COLUMN weight TYPE DOUBLE PRECISION;

-- nav & aggregate_nav
ALTER TABLE public.nav 
  ALTER COLUMN nav TYPE DOUBLE PRECISION,
  ALTER COLUMN nav_eur TYPE DOUBLE PRECISION;

ALTER TABLE public.aggregate_nav 
  ALTER COLUMN nav TYPE DOUBLE PRECISION,
  ALTER COLUMN nav_eur TYPE DOUBLE PRECISION;

-- events & recurring_flows
ALTER TABLE public.events 
  ALTER COLUMN quantity TYPE DOUBLE PRECISION,
  ALTER COLUMN price TYPE DOUBLE PRECISION,
  ALTER COLUMN fees_override TYPE DOUBLE PRECISION;

ALTER TABLE public.recurring_flows 
  ALTER COLUMN interest_rate TYPE DOUBLE PRECISION,
  ALTER COLUMN total_amount TYPE DOUBLE PRECISION,
  ALTER COLUMN payment TYPE DOUBLE PRECISION,
  ALTER COLUMN interest TYPE DOUBLE PRECISION,
  ALTER COLUMN principal TYPE DOUBLE PRECISION,
  ALTER COLUMN tax TYPE DOUBLE PRECISION,
  ALTER COLUMN outstanding_amount TYPE DOUBLE PRECISION;

-- breakdowns (security, portfolio, aggregate, lookthrough)
ALTER TABLE public.security_breakdowns 
  ALTER COLUMN weight TYPE DOUBLE PRECISION;

ALTER TABLE public.portfolio_breakdowns 
  ALTER COLUMN weight TYPE DOUBLE PRECISION;

ALTER TABLE public.aggregate_breakdowns 
  ALTER COLUMN weight TYPE DOUBLE PRECISION;

ALTER TABLE public.lookthrough_data 
  ALTER COLUMN weight TYPE DOUBLE PRECISION;

-- performance tables
ALTER TABLE public.security_performance 
  ALTER COLUMN price_return TYPE DOUBLE PRECISION,
  ALTER COLUMN income_return TYPE DOUBLE PRECISION,
  ALTER COLUMN total_return TYPE DOUBLE PRECISION;

ALTER TABLE public.portfolio_performance 
  ALTER COLUMN price_return TYPE DOUBLE PRECISION,
  ALTER COLUMN income_return TYPE DOUBLE PRECISION,
  ALTER COLUMN trade_return TYPE DOUBLE PRECISION,
  ALTER COLUMN fx_return TYPE DOUBLE PRECISION,
  ALTER COLUMN fee_return TYPE DOUBLE PRECISION,
  ALTER COLUMN residual TYPE DOUBLE PRECISION,
  ALTER COLUMN total_return TYPE DOUBLE PRECISION;

ALTER TABLE public.portfolio_nav_return 
  ALTER COLUMN nav_pnl TYPE DOUBLE PRECISION,
  ALTER COLUMN nav_return TYPE DOUBLE PRECISION;

ALTER TABLE public.aggregate_performance 
  ALTER COLUMN price_return TYPE DOUBLE PRECISION,
  ALTER COLUMN income_return TYPE DOUBLE PRECISION,
  ALTER COLUMN trade_return TYPE DOUBLE PRECISION,
  ALTER COLUMN fx_return TYPE DOUBLE PRECISION,
  ALTER COLUMN fee_return TYPE DOUBLE PRECISION,
  ALTER COLUMN residual TYPE DOUBLE PRECISION,
  ALTER COLUMN total_return TYPE DOUBLE PRECISION;

ALTER TABLE public.aggregate_nav_return 
  ALTER COLUMN nav_pnl TYPE DOUBLE PRECISION,
  ALTER COLUMN nav_return TYPE DOUBLE PRECISION;

-- risk matrices
ALTER TABLE public.security_risk 
  ALTER COLUMN value TYPE DOUBLE PRECISION;

ALTER TABLE public.portfolio_risk 
  ALTER COLUMN value TYPE DOUBLE PRECISION;

ALTER TABLE public.aggregate_risk 
  ALTER COLUMN value TYPE DOUBLE PRECISION;

-- transactions & capital_flows
ALTER TABLE public.transactions 
  ALTER COLUMN quantity TYPE DOUBLE PRECISION,
  ALTER COLUMN transaction_price TYPE DOUBLE PRECISION,
  ALTER COLUMN fee TYPE DOUBLE PRECISION,
  ALTER COLUMN fee_value_base TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_local TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_base TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_eur TYPE DOUBLE PRECISION;

ALTER TABLE public.capital_flows 
  ALTER COLUMN quantity TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_local TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_base TYPE DOUBLE PRECISION,
  ALTER COLUMN market_value_eur TYPE DOUBLE PRECISION;

