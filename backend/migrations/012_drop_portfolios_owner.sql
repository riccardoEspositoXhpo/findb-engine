-- Migration 012: drop portfolios.owner (replaced by ownership_overrides, 011).
-- Apply only AFTER the Cloud Run job runs code that no longer reads the column (aggregates.js from commit 7c77d13 on):
-- dropping it first broke the deployed job and, with it, the CI dry run that gates the deploy.
ALTER TABLE public.portfolios DROP COLUMN IF EXISTS owner;
