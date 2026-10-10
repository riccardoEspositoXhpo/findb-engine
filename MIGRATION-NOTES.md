# FINDB SCHEMA DIVERGENCE LOG (October 2026)

- [CATALOG] Centralized (breakdown, sector) into physical table `breakdown_catalog`.
- [FK_BREAKDOWNS] `lookthrough_data`, `portfolio_breakdowns`, `aggregate_breakdowns`, `security_breakdowns` enforce Composite FK on `(breakdown, sector)`.
- [SCHEDULE] Normalized `valuation_frequency` into 2 separate columns (`valuation_frequency` + `valuation_day`) with strict CHECK constraint on both `portfolios` and `security_master`.
- [SECURITY_PROXY] `security_master.risk_proxy` is a self-referencing foreign key to `security_master(security_id)` (ON DELETE SET NULL).
- [INTEGRITY] Replaced JS float handling with PostgreSQL `NUMERIC` + range CHECKs (`weight >= 0 AND weight <= 100`, `end_date > start_date`).
- [PORTFOLIO_ENUMS] Enforced strict CHECK constraints on `portfolios.portfolio_type` and `portfolios.fiscal_regime`.
- [AUDIT-DEFAULTS] `portfolios.inception_date` defaults to `CURRENT_DATE`.
- [AUDIT-TIMESTAMPS] Added `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` to all tables for operational batch tracing (omitted in legacy GAS).
- [AGGREGATES-BREAKDOWN-SCOPE] Renamed `aggregates.breakdowns` to `aggregates.breakdown_scope` with strict `CHECK (breakdown_scope IN ('NONE', 'ALL', 'LT_ONLY'))` (was an open string in GAS).
- [WEIGHT-STANDARDIZATION] Uniformati tutti i pesi a percentuale base 100. `positions.weight` passa da frazione [0, 1] a percentuale [-100, 100] per coerenza totale con `breakdowns.weight`.
- [EVENTS-PK] Introdotto `event_id` autoincrementale come Primary Key tecnica su `events` al posto della chiave composita legacy a 6 campi di GAS.
- [JSONB-METADATA] `events.event_metadata` passa da stringa JSON serializzata su Sheet a tipo nativo PostgreSQL `JSONB`. 
- [ENUM-VALUATION-FREQUENCY] Definito tipo nativo PostgreSQL `valuation_frequency_enum` con valori ('DLY', 'BIZ', 'WKL', 'MTH', 'ONE'), sostituendo le stringhe aperte di GAS e formalizzando il supporto ai flussi una tantum ('ONE').
- [TABLE-CURRENCIES] Creata tabella anagrafica `currencies`. Tutti i campi valuta (`portfolios.currency`, `aggregates.currency`, `security_master.currency`, `transactions.counter_currency`, `transactions.fee_currency`) ora hanno vincolo `REFERENCES currencies(currency_code) ON DELETE RESTRICT`.
- [UNIFIED-FX-RATES] Unificati i fogli storici `fxRateDaily` e `cryptoRateDaily` nella singola tabella normalizzata `fx_rates` con coppie (`base_currency`, `quote_currency`).
- [MARKET_VALUE_EUR] new column everywhere lel