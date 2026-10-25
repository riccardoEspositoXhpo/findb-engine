-- Migration 008: recurring_flows fixes (found while mapping the GAS recurringFlows sheet)
-- 1. Drop the wrong CHECK (principal + interest + tax = total_amount): total_amount is the whole loan, not the
--    instalment, so every real row was rejected. It was declared twice under two names. Also removed from 001.
-- 2. security_id: instrument the amounts are in (DEBT_EUR for loans, CASH_EUR for receivables), used for currency.
-- 3. Natural PK (portfolio_id, payment_desc, eval_date) replaces the identity recurring_flow_id: one row per payment
--    per evaluation date (same idea as the GAS replacement key), and upserts work on it.
-- Frequency is the native valuation_frequency_enum (MTH, ONE...): no translation of the old MONTHLY / ADHOC labels.

ALTER TABLE public.recurring_flows DROP CONSTRAINT IF EXISTS chk_rec_flow_amount_sum;
ALTER TABLE public.recurring_flows DROP CONSTRAINT IF EXISTS chk_rec_flow_payment_sum;

ALTER TABLE public.recurring_flows
    ADD COLUMN security_id TEXT NOT NULL,
    ADD CONSTRAINT fk_recurring_flows_security
        FOREIGN KEY (security_id) REFERENCES public.security_master(security_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.recurring_flows DROP CONSTRAINT recurring_flows_pkey;
ALTER TABLE public.recurring_flows DROP COLUMN recurring_flow_id;
ALTER TABLE public.recurring_flows
    ADD CONSTRAINT pk_recurring_flows PRIMARY KEY (portfolio_id, payment_desc, eval_date);
